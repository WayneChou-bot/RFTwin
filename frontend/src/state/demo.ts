/** §43.3 Local Demo Player — 播放 Python 引擎預產的確定性 fixture。
 *  前端只依模擬時間餵 snapshot／event 進同一個 Twin store 並插值，
 *  不重新判斷任何生產規則（不是第二套引擎）。
 *  資料：frontend/public/demo/（generate_demo.py 產生，與 Live 同 wire schema）。 */
import { setDemoAux } from "../panels/api";
import { useTwin } from "./store";

interface DemoData {
  manifest: { tick_ms: number; duration_seconds: number; demo_id: string };
  initial: any;                   // SnapshotMessage（含完整 history_minutes）
  snaps: any[];                   // 1 Hz 輕量 SnapshotMessage（history=[]）
  events: any[];                  // 有序 EventMessage
  patches: any[];                 // §50 有序 amr_patch（10 Hz）
}

let data: DemoData | null = null;          // 完整資料（含事件流）
let initialOnly: any = null;               // 快速首屏：先到的 initial snapshot
let heavyLoading: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let simTick = 0;
let baseTick = 0;                 // 播放時鐘以牆鐘推導（setInterval 節流也不失真）
let baseWall = 0;
let lastSpeed = 1;
let evIdx = 0;
let snapIdx = 0;
let patchIdx = 0;
let lastHistory: any[] = [];

function rebase(tick: number): void {
  baseTick = tick;
  baseWall = performance.now();
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** 串流分段解析——邊下載邊逐行 JSON.parse，每 YIELD_EVERY 行讓出
 *  主執行緒一次，避免 6 MB fixture 一次 text()+split()+parse 造成首載卡頓。
 *  無 ReadableStream（極舊瀏覽器）時退回整段解析。 */
const YIELD_EVERY = 40;
const yieldToMain = () => new Promise<void>((res) => setTimeout(res, 0));

async function fetchNdjson(url: string): Promise<any[]> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!r.body) {
    return (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const out: any[] = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sinceYield = 0;
  for (;;) {
    const { value, done } = await reader.read();
    buf += dec.decode(value ?? new Uint8Array(), { stream: !done });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) out.push(JSON.parse(line));
      if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await yieldToMain(); }
    }
    if (done) break;
  }
  if (buf.trim()) out.push(JSON.parse(buf));
  return out;
}

export function demoLoaded(): boolean {
  return data !== null || initialOnly !== null;
}

/** 載入 fixture（相對路徑 → 靜態託管也能用）；失敗回 false（無 demo 資料時安靜退化）。
 *  §43.11-1：initial snapshot（~50KB）先到先用 → 3 秒內有完整畫面；
 *  事件流／snapshots（較大）於背景載完後播放器才開始推進。 */
export async function loadDemo(): Promise<boolean> {
  if (data || initialOnly) return true;
  try {
    const [manifest, initial] = await Promise.all([
      fetchJson("demo/manifest.json"),
      fetchJson("demo/initial_snapshot.json"),
    ]);
    initialOnly = { manifest, initial };
    heavyLoading = Promise.all([
      fetchNdjson("demo/snapshots.ndjson"),
      fetchNdjson("demo/events.ndjson"),
      fetchJson("demo/panels.json"),
      fetchNdjson("demo/amr_patches.ndjson").catch(() => [] as any[]),   // §50（舊 fixture 無此檔亦可播）
    ]).then(([snaps, events, aux, patches]) => {
      data = { manifest, initial, snaps, events, patches };
      setDemoAux(aux);            // 資料分頁（Health/Quality/Energy/Flow）離線來源
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function applyInitial(): void {
  const init = (data ?? initialOnly)!.initial;
  const st = useTwin.getState();
  st.resetFeed();
  simTick = init.sim_tick;
  rebase(simTick);
  evIdx = 0;
  snapIdx = 0;
  patchIdx = 0;
  lastHistory = init.state.history_minutes;
  st.applySnapshot(init);
}

function step(): void {
  if (!data) return;
  const st = useTwin.getState();
  if (st.mode !== "LOCAL_DEMO") return;
  if (st.paused) { rebase(simTick); return; }                  // 暫停：凍結時鐘
  if (st.speed !== lastSpeed) { rebase(simTick); lastSpeed = st.speed; }
  simTick = baseTick + ((performance.now() - baseWall) / data.manifest.tick_ms) * st.speed;
  // 事件依序餵入（seq 連續，applyEvent 不會觸發 gap recovery）
  while (evIdx < data.events.length && data.events[evIdx].sim_tick <= simTick) {
    useTwin.getState().applyEvent(data.events[evIdx]);
    evIdx++;
  }
  // 只套用最新跨過的 snapshot；輕量 snapshot 沿用最近一次非空 history
  let target: any = null;
  while (snapIdx < data.snaps.length && data.snaps[snapIdx].sim_tick <= simTick) {
    target = data.snaps[snapIdx];
    snapIdx++;
  }
  if (target) {
    if (target.state.history_minutes.length === 0) {
      target = { ...target, state: { ...target.state, history_minutes: lastHistory } };
    } else {
      lastHistory = target.state.history_minutes;
    }
    useTwin.getState().applySnapshot(target);
  }
  // §50：AMR 10 Hz 增量依序套用（與 Live 同一條路徑）
  while (patchIdx < data.patches.length && data.patches[patchIdx].sim_tick <= simTick) {
    useTwin.getState().applyAmrPatch(data.patches[patchIdx]);
    patchIdx++;
  }
  // 播畢 → 從頭循環（§43.5 Timeline Reset；Replay 是確定性的，重播結果相同）
  if (snapIdx >= data.snaps.length && evIdx >= data.events.length) applyInitial();
}

export function startDemo(): void {
  if (timer || (!data && !initialOnly)) return;
  applyInitial();                              // 立即有完整畫面（凍結於 initial）
  const arm = () => { if (!timer) timer = setInterval(step, 100); };
  if (data) arm();
  else heavyLoading?.then(() => {              // 事件流載完才開始推進
    if (useTwin.getState().mode === "LOCAL_DEMO") arm();
  });
}

export function resetDemo(): void {
  if (!data) return;
  applyInitial();
}

export function stopDemo(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
