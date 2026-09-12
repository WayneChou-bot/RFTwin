/** Twin store + Connection Manager（§43）— 後端權威（ADR-001/004）：
 *  前端只保存最近的 snapshot 與事件，絕不自行決定生產結果。
 *  §43 模式機：CONNECTING → LIVE｜LOCAL_DEMO；LIVE 斷線 → RECONNECTING → STALE；
 *  LOCAL_DEMO = Python 引擎預產 fixture 的確定性 Replay（不是第二套引擎）。 */
import { create } from "zustand";
import { apiUrl, wsUrl } from "../config";
import type { EventMessage, SnapshotMessage, TwinEvent } from "../types";
import { demoLoaded, loadDemo, resetDemo, startDemo, stopDemo } from "./demo";

export type RenderMode = "high" | "balanced" | "performance";
export type ViewKey = "3d" | "flow" | "health" | "quality" | "energy" | "simulation";
export type ConnMode = "CONNECTING" | "LIVE" | "RECONNECTING" | "STALE"
  | "LOCAL_DEMO" | "SCHEMA_MISMATCH" | "ERROR";

/** §50 amr_patch wire：每台只帶變動欄位 */
export interface AmrLive {
  position: [number, number];
  route: number[][];
  route_progress: number;
  phase_progress: number;
  status: string;
  task_state: string;
  traffic_state: string;
  carrying?: string | null;
  battery_percent?: number;
  perception?: AmrPerceptionWire | null;     // §51
}
/** §51 感知層（引擎推導；前端只畫不算） */
export interface AmrPerceptionWire {
  state: "CLEAR" | "CAUTION" | "STOPPED";
  heading: number[];
  ahead_m?: number | null;
  nearest_m?: number | null;
  safe_m: number; clear_m: number; hard_stop_m: number; sense_m: number;
  obstacles: { kind: string; id: string; distance_m: number; bearing_deg: number;
    ref?: "center" | "edge"; radius_m?: number }[];
}
export interface AmrPatchMessage {
  type: "amr_patch"; run_id: string; sim_tick: number; sim_time: string;
  amrs: (Partial<AmrLive> & { amr_id: string })[];
}

const EXPECTED_SCHEMA = "1.0";
const HEALTH_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];   // §43.6
const DEMO_FALLBACK_MS = 3000;      // §43.11-1：3 秒內必須有完整畫面
const STALE_AFTER_MS = 15000;       // §43.7：LIVE 斷線多久後標記 STALE

interface TwinStore {
  snap: SnapshotMessage | null;
  snapReceivedAt: number;          // performance.now()，供動畫外插
  lastSeq: number;
  runId: string | null;
  connected: boolean;
  gapRecovering: boolean;
  eventFeed: TwinEvent[];          // 最近事件（顯示用）
  selectedRobot: string;
  flyRequest: number;
  flyTarget: [number, number] | null;   // §46 CCTV 反向定位：世界座標 FlyTo
  view: ViewKey;
  renderMode: RenderMode;
  paused: boolean;
  speed: number;
  controlSeq: number;              // §52 已套用的控制狀態序號（後端單調遞增）
  resyncs: number;                 // §51 visibilitychange 重抓次數（e2e 掛勾）
  lastResync: string | null;
  resetting: boolean;              // §47：Reset 進行中（Live pre-roll 需數秒）
  superseded: Set<string>;         // §49：已被 Reset 取代的 run（其 snapshot/event 一律丟棄）
  /** §50：AMR 10 Hz 增量（位置／進度／狀態）——只有 3D AMR 元件在 useFrame 讀，
   *  不觸發 React re-render；snapshot 每 1 s 仍會整份覆蓋一次。 */
  amrLive: Record<string, AmrLive>;
  amrLiveAt: number;
  amrLiveTick: number;
  applyAmrPatch: (m: AmrPatchMessage) => void;
  // ---- §43 connection state ----
  mode: ConnMode;
  lastSyncSim: string | null;      // 最後一次 Live 資料的 sim_time
  lastSyncWall: number | null;     // Date.now() of last live message
  livePrompt: boolean;             // Backend 可用，等使用者決定是否切換
  demoTouched: boolean;            // 使用者已操作 demo（§43.6：不自動切走）
  applySnapshot: (m: SnapshotMessage) => void;
  applyEvent: (m: EventMessage) => void;
  resetFeed: () => void;           // demo loop / 模式切換用
  setConnected: (v: boolean) => void;
  selectRobot: (id: string) => void;
  flyTo: (pos: [number, number]) => void;
  setView: (v: ViewKey) => void;
  setRenderMode: (m: RenderMode) => void;
  setSim: (paused: boolean, speed: number) => void;
}

export const useTwin = create<TwinStore>((set, get) => ({
  snap: null, snapReceivedAt: 0, lastSeq: 0, runId: null,
  connected: false, gapRecovering: false, eventFeed: [],
  selectedRobot: "R-06", flyRequest: 0, flyTarget: null, view: "3d", renderMode: "balanced",
  paused: false, speed: 1, controlSeq: 0, resyncs: 0, lastResync: null, resetting: false, superseded: new Set<string>(),
  amrLive: {}, amrLiveAt: 0, amrLiveTick: 0,
  mode: "CONNECTING", lastSyncSim: null, lastSyncWall: null,
  livePrompt: false, demoTouched: false,
  applySnapshot: (m) => set((s) => {
    // §49：被取代的 run 晚到的 snapshot 一律丟棄（Reset 競態不閃回）
    if (s.superseded.has(m.run_id)) return s;
    // 同一 run 內拒收比 lastSeq 舊的 snapshot（防多連線／StrictMode 下舊 socket 回寫）
    if (s.runId === m.run_id && m.seq < s.lastSeq) return s;
    const runChanged = !!s.runId && s.runId !== m.run_id;
    const superseded = runChanged ? new Set(s.superseded).add(s.runId!) : s.superseded;
    // §50：snapshot 亦覆蓋 amrLive（demo／無 patch 時仍有 1 Hz 位置；run 變更即整份取代）
    const amrLive: Record<string, AmrLive> = {};
    for (const a of m.state.amrs) {
      amrLive[a.amr_id] = { position: a.position as [number, number], route: (a.route ?? []) as number[][],
        route_progress: a.route_progress ?? 0, phase_progress: a.phase_progress,
        status: a.status, task_state: a.task_state, traffic_state: a.traffic_state ?? "CLEAR",
        carrying: a.carrying ?? null, battery_percent: a.battery_percent,
        perception: (a.perception ?? null) as AmrPerceptionWire | null };
    }
    // §51：Live snapshot 附後端控制狀態 → paused／speed 以後端為準（多分頁一致）；
    // 本分頁 Reset 進行中不套用（由 Reset 流程收尾決定）
    const ctl = m.control && !s.resetting && (m.control.seq ?? 0) >= s.controlSeq
      ? { paused: m.control.paused, speed: m.control.speed, controlSeq: m.control.seq ?? 0 } : {};
    return {
      ...ctl,
      snap: m, snapReceivedAt: performance.now(), lastSeq: m.seq, runId: m.run_id,
      superseded, amrLive, amrLiveAt: performance.now(), amrLiveTick: m.sim_tick,
      // run_id 改變 → 清空舊事件（ADR-004）
      eventFeed: runChanged ? [] : s.eventFeed,
      ...(s.mode === "LIVE" ? { lastSyncSim: m.sim_time, lastSyncWall: Date.now() } : {}),
    };
  }),
  applyAmrPatch: (m) => {
    const s = get();
    if (s.superseded.has(m.run_id)) return;
    if (s.runId && m.run_id !== s.runId) return;          // 不混用不同 run
    if (m.sim_tick < s.amrLiveTick) return;               // 亂序／舊資料丟棄
    const amrLive = { ...s.amrLive };
    for (const d of m.amrs) {
      const { amr_id, ...fields } = d;
      amrLive[amr_id] = { ...(amrLive[amr_id] ?? {}), ...fields } as AmrLive;
    }
    set({ amrLive, amrLiveAt: performance.now(), amrLiveTick: m.sim_tick });
  },
  applyEvent: (m) => {
    const s = get();
    if (s.superseded.has(m.run_id)) return;               // §49：被取代的 run
    if (s.runId && m.run_id !== s.runId) return;          // 不混用不同 run
    if (m.seq <= s.lastSeq) return;                        // 重複 → 忽略
    if (m.seq > s.lastSeq + 1) { recoverGap(); return; }   // gap → 補送（僅 LIVE）
    set({ lastSeq: m.seq, eventFeed: [...s.eventFeed.slice(-49), m.event],
          ...(s.mode === "LIVE" ? { lastSyncWall: Date.now() } : {}) });
  },
  resetFeed: () => set({ snap: null, lastSeq: 0, runId: null, eventFeed: [],
                         superseded: new Set<string>(), amrLive: {}, amrLiveTick: 0 }),
  setConnected: (v) => set({ connected: v }),
  selectRobot: (id) => set({ selectedRobot: id, flyTarget: null, flyRequest: Date.now(), view: "3d" }),
  flyTo: (pos) => set({ flyTarget: pos, flyRequest: Date.now(), view: "3d" }),
  setView: (v) => set({ view: v }),
  setRenderMode: (m) => set({ renderMode: m }),
  setSim: (paused, speed) => set({ paused, speed }),
}));

// §48 e2e／除錯掛勾：唯讀存取 store（不改變任何行為；測試用）
declare global { interface Window { __twin?: typeof useTwin } }
if (typeof window !== "undefined") window.__twin = useTwin;

// ================================================================ §43 Connection Manager
// 世代編號：start() 回傳 cleanup；StrictMode 重跑 effect 或 HMR 時，
// 舊 socket／timer 全部失效，不會出現多連線、重複事件或舊資料回寫。

let generation = 0;
let ws: WebSocket | null = null;
const timers: ReturnType<typeof setTimeout>[] = [];
let wsRetry = 0;

function later(gen: number, ms: number, fn: () => void): void {
  const t = setTimeout(() => { if (gen === generation) fn(); }, ms);
  timers.push(t);
}

export function start(): () => void {
  const gen = ++generation;
  wsRetry = 0;
  useTwin.setState({ mode: "CONNECTING", livePrompt: false, demoTouched: false });
  // §43.1：立即載入 Local Fixture；3 秒內未連上 Backend → LOCAL_DEMO
  void loadDemo().then((ok) => {
    if (gen !== generation || !ok) return;
    later(gen, DEMO_FALLBACK_MS, () => {
      if (useTwin.getState().mode === "CONNECTING") enterDemo(gen);
    });
  });
  void healthLoop(gen, 0);
  return () => {
    if (gen !== generation) return;
    generation++;
    timers.forEach(clearTimeout);
    timers.length = 0;
    ws?.close();
    ws = null;
    stopDemo();
  };
}

async function healthLoop(gen: number, attempt: number): Promise<void> {
  if (gen !== generation) return;
  const st = useTwin.getState();
  if (st.mode === "LIVE" || st.mode === "RECONNECTING") return;  // WS 自己會重連
  try {
    const r = await fetch(apiUrl("/api/health"));
    if (r.ok) {
      const h = await r.json();
      if (gen !== generation) return;
      if (h.schema_version !== EXPECTED_SCHEMA) {                // §43.11-9
        useTwin.setState({ mode: "SCHEMA_MISMATCH" });
      } else {
        const s2 = useTwin.getState();
        if (s2.mode === "LOCAL_DEMO" && s2.demoTouched) {
          useTwin.setState({ livePrompt: true });                // §43.6：詢問使用者
        } else {
          await goLive(gen);
          return;
        }
      }
    }
  } catch { /* 連線被拒/逾時 → 走下方立即-demo 判斷 */ }
  // Backend 不健康（拒連或非 2xx，如純靜態託管的 404）→ 立即進 demo，不等 3 秒
  if (gen === generation && useTwin.getState().mode === "CONNECTING") {
    void loadDemo().then((ok) => {
      if (ok && gen === generation &&
          useTwin.getState().mode === "CONNECTING") enterDemo(gen);
    });
  }
  const delay = HEALTH_BACKOFF_MS[Math.min(attempt, HEALTH_BACKOFF_MS.length - 1)];
  later(gen, delay, () => void healthLoop(gen, attempt + 1));
}

function enterDemo(gen: number): void {
  if (gen !== generation || !demoLoaded()) return;
  ws?.close();
  ws = null;
  startDemo();                                   // 內部 resetFeed + 套 initial snapshot
  useTwin.setState({ mode: "LOCAL_DEMO", connected: false });
}

export async function goLive(genArg?: number): Promise<void> {
  const gen = genArg ?? generation;
  if (gen !== generation) return;
  try {
    const r = await fetch(apiUrl("/api/runs/LIVE-001/snapshot"));
    if (!r.ok) throw new Error(`snapshot ${r.status}`);
    const snap = await r.json();
    if (gen !== generation) return;
    stopDemo();
    const st = useTwin.getState();
    st.resetFeed();
    useTwin.setState({ mode: "LIVE", livePrompt: false,
                       lastSyncSim: snap.sim_time, lastSyncWall: Date.now() });
    st.applySnapshot(snap);
    openWs(gen);
  } catch {
    if (gen !== generation) return;
    useTwin.setState({ mode: useTwin.getState().mode === "LIVE"
      ? "RECONNECTING" : useTwin.getState().mode });
    later(gen, 2000, () => void healthLoop(gen, 0));
  }
}

/** 使用者從 STALE／RECONNECTING 明確選擇切到 Local Demo（§43.7 不自動偷切）。 */
export function switchToDemo(): void {
  const gen = generation;
  useTwin.setState({ demoTouched: true });
  enterDemo(gen);
  void healthLoop(gen, 2);                       // 背景持續探測（之後以 prompt 詢問）
}

export function dismissLivePrompt(): void {
  useTwin.setState({ livePrompt: false, demoTouched: true });
  const gen = generation;
  later(gen, 30000, () => void healthLoop(gen, 4));   // 30s 後再詢問一次
}

function openWs(gen: number): void {
  if (gen !== generation) return;
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.onopen = () => {
    if (gen !== generation) { sock.close(); return; }
    wsRetry = 0;
    // 新連線 = 新的 run 世界（後端可能已重啟、run_id 重新編號）→ 取代名單歸零
    useTwin.setState({ superseded: new Set<string>(), controlSeq: 0 });   // §52：後端重啟 seq 會歸零
    const st = useTwin.getState();
    if (st.mode === "LOCAL_DEMO") {              // 使用者在 demo → 不搶畫面，只提示
      sock.close();
      useTwin.setState({ livePrompt: true, connected: false });
      return;
    }
    useTwin.setState({ connected: true, mode: "LIVE" });
  };
  sock.onmessage = (e) => {
    if (gen !== generation) return;
    const st = useTwin.getState();
    if (st.mode !== "LIVE") return;              // demo/STALE 中不套用 Live 資料
    const m = JSON.parse(e.data);
    if (m.type === "snapshot") st.applySnapshot(m);
    else if (m.type === "event") st.applyEvent(m);
    else if (m.type === "amr_patch") st.applyAmrPatch(m);   // §50 10 Hz
    else if (m.type === "control") {                        // §51 多分頁控制同步（後端權威）
      const seq = Number(m.control.seq ?? 0);
      if (!st.resetting && !st.superseded.has(m.run_id) && seq >= st.controlSeq) {
        st.setSim(!!m.control.paused, Number(m.control.speed) || st.speed);
        useTwin.setState({ controlSeq: seq });               // §52：擋掉晚到的舊 snapshot 控制狀態
      }
    }
  };
  sock.onclose = () => {
    if (gen !== generation) return;
    const st = useTwin.getState();
    useTwin.setState({ connected: false });
    if (st.mode === "LIVE") {                    // §43.7：保留最後 snapshot → RECONNECTING
      useTwin.setState({ mode: "RECONNECTING" });
      later(gen, STALE_AFTER_MS, () => {
        const s2 = useTwin.getState();
        if (s2.mode === "RECONNECTING") useTwin.setState({ mode: "STALE" });
      });
    }
    if (st.mode === "LIVE" || st.mode === "RECONNECTING" || st.mode === "STALE") {
      later(gen, Math.min(30000, 1000 * 2 ** wsRetry++), () => openWs(gen));
    }
  };
  sock.onerror = () => sock.close();
}

/** §51（WareTwin 借鏡）：分頁回前景 → 直接重抓權威 snapshot。瀏覽器對背景分頁節流
 *  WebSocket／timer，回前景時與其依 seq gap 逐步補送，不如一次整份取代（含控制狀態）。 */
export async function resyncSnapshot(reason = "visibility"): Promise<boolean> {
  const st = useTwin.getState();
  if (st.mode !== "LIVE" || st.resetting) return false;
  try {
    const r = await fetch(apiUrl("/api/runs/LIVE-001/snapshot"));
    if (!r.ok) return false;
    const m = await r.json();
    const cur = useTwin.getState();
    if (cur.runId && cur.runId !== m.run_id) {              // 背景期間別的分頁 Reset 過
      useTwin.setState({ superseded: new Set(cur.superseded).add(cur.runId) });
    }
    cur.applySnapshot(m);
    useTwin.setState({ resyncs: cur.resyncs + 1, lastResync: reason });
    return true;
  } catch { return false; }
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void resyncSnapshot("visibility");
  });
}

async function recoverGap(): Promise<void> {
  const st = useTwin.getState();
  if (st.mode !== "LIVE") return;                // demo 事件流連續；僅 LIVE 需補送
  if (st.gapRecovering || !st.runId) return;
  useTwin.setState({ gapRecovering: true });
  try {
    const r = await fetch(apiUrl(`/api/runs/${st.runId}/events?after_seq=${st.lastSeq}`));
    if (r.status === 410 || r.status === 404) {                 // §52：舊 run 已被 Reset 取代 → 換到現役 run
      await resyncSnapshot("run-superseded");
      return;
    }
    const d = await r.json();
    if (!d.complete) {                                          // 超出保留窗口 → 重取 snapshot
      const snap = await (await fetch(apiUrl(`/api/runs/${st.runId}/snapshot`))).json();
      useTwin.getState().applySnapshot(snap);
    } else {
      for (const ev of d.events) {
        const s = useTwin.getState();
        if (ev.seq === s.lastSeq + 1) {
          useTwin.setState({ lastSeq: ev.seq, eventFeed: [...s.eventFeed.slice(-49), ev] });
        }
      }
    }
  } catch { /* 連線又斷 → onclose 流程接手 */ } finally {
    useTwin.setState({ gapRecovering: false });
  }
}

// ---------------------------------------------------------------- 模擬控制
// LIVE → REST；LOCAL_DEMO → 本地播放器（§43.5 Play/Pause/速度/Reset）

export async function simCommand(cmd: "start" | "pause" | "reset"): Promise<void> {
  const st = useTwin.getState();
  if (st.mode === "LOCAL_DEMO") {
    useTwin.setState({ demoTouched: true });
    if (cmd === "reset") {
      resetDemo();
      st.setSim(false, st.speed);            // Reset 語意：回到起點並播放
    } else st.setSim(cmd === "pause", st.speed);
    return;
  }
  if (cmd === "reset") {
    /* §47 Live Reset 需重新 pre-roll（依硬體 3–10 秒）。
     * 期間顯示進行中狀態；完成後立刻取新 run 的 snapshot 套用（不等下一筆
     * 1 Hz 廣播），並解除暫停——使用者立即看到 sim 時鐘回到 shift start。 */
    if (st.resetting) return;
    // §49：重建期間畫面凍結（後端同步凍結舊 run 的 ticker）；完成後標記舊 run 為
    // 「已取代」，任何晚到的舊 run snapshot／event 一律丟棄（無閃回、無二次跳位）
    useTwin.setState({ resetting: true, paused: true });
    try {
      const r = await fetch(apiUrl("/api/simulation/reset"), { method: "POST" });
      const d = await r.json();
      const newRun: string = d.run_id ?? "LIVE-001";
      const cur = useTwin.getState();
      if (cur.runId && cur.runId !== newRun) {
        useTwin.setState({ superseded: new Set(cur.superseded).add(cur.runId) });
      }
      const snap = await (await fetch(apiUrl(`/api/runs/${newRun}/snapshot`))).json();
      useTwin.getState().applySnapshot(snap);
      useTwin.getState().setSim(false, useTwin.getState().speed);
    } catch {
      useTwin.getState().setSim(false, useTwin.getState().speed);   // offline：不留在暫停
    } finally {
      useTwin.setState({ resetting: false });
    }
    return;
  }
  try {
    await fetch(apiUrl(`/api/simulation/${cmd}`), { method: "POST" });
    st.setSim(cmd === "pause", st.speed);
  } catch { /* offline：按鈕無效但不噴錯 */ }
}

export async function simSpeed(value: number): Promise<void> {
  const st = useTwin.getState();
  if (st.mode === "LOCAL_DEMO") {
    useTwin.setState({ demoTouched: true });
    st.setSim(st.paused, value);
    return;
  }
  try {
    await fetch(apiUrl(`/api/simulation/speed?value=${value}`), { method: "POST" });
    st.setSim(st.paused, value);
  } catch { /* offline */ }
}

/** 顯示層外插：兩次 1 Hz snapshot 之間，讓 cycle_progress 平滑前進（§14.1 前端插值）。
 *  RECONNECTING／STALE 時凍結（§43.7：不得假裝仍在收到即時資料）。 */
export function extrapolatedProgress(
  progress: number, cycleSec: number, status: string, snapAt: number, paused: boolean,
  speed: number,
): number {
  const mode = useTwin.getState().mode;
  if (mode !== "LIVE" && mode !== "LOCAL_DEMO") return progress;
  if (paused || !["RUNNING", "WAITING_MACHINE", "BLOCKED"].includes(status)) return progress;
  if (status === "BLOCKED") return progress;                 // 完成但無法卸料 → 停在原位
  const elapsed = ((performance.now() - snapAt) / 1000) * speed;
  return Math.min(1, progress + elapsed / cycleSec);
}
