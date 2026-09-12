/** UI 面板（§27）— 全部數字來自 Twin snapshot，前端不得自行推導生產結果。 */
import { useEffect, useRef, useState } from "react";
import { getJson, postJson } from "./api";
import { dismissLivePrompt, goLive, simCommand, simSpeed, switchToDemo, useTwin,
         type ConnMode, type RenderMode } from "../state/store";
import { demoLoaded } from "../state/demo";
import { Bar, OeeRing, Sparkline, bucket, fmt, pct, sevColor, sevIcon, stDot } from "./widgets";
import { CAMERAS, CELL_TO_CAM, CctvView, analyzeCamera, cameraForEvent, type Cam } from "./Cctv";
import { cellName, t, tOpt, useLang, useT, type Msg, type TKey } from "../i18n";

/** 回傳 null = 成功；字串 = 後端拒絕原因（§49：如障礙物放置驗證 422）。 */
async function inject(failure_type: string, target_id: string, duration_sec?: number,
                      extra?: Record<string, number>): Promise<string | null> {
  if (useTwin.getState().mode === "LOCAL_DEMO") return t("live.required");
  try {
    const r = await fetch("/api/failures/inject", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ failure_type, target_id, duration_sec, ...(extra ?? {}) }) });
    if (r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return String(d.detail ?? `HTTP ${r.status}`);
  } catch { return "offline"; }
}
async function ackAlert(id: string) {
  await postJson(`/api/alerts/${id}/acknowledge`);
}

/* §52：自訂座標的障礙物——DEMO.md 第 4 條「放到 AMR 車身上看 422」需要
 * 能從 UI 指定 x／z／半徑；預設值取目前 AMR-01 的位置，一鍵示範驗證被拒。 */
function CustomObstacle({ onResult }: { onResult: (m: Msg) => void }) {
  const T = useT();
  const amr = useTwin((s) => s.amrLive["AMR-01"]);
  const [x, setX] = useState("");
  const [z, setZ] = useState("");
  const [r, setR] = useState("1.5");
  const [dur, setDur] = useState("90");
  const fill = () => { if (amr) { setX(amr.position[0].toFixed(1)); setZ(amr.position[1].toFixed(1)); } };
  const go = async () => {
    const xv = Number(x), zv = Number(z), rv = Number(r), dv = Number(dur);
    if ([xv, zv, rv, dv].some((v) => Number.isNaN(v))) { onResult({ key: "ob.nan" }); return; }
    const err = await inject("zone_obstacle", "custom", dv, { x: xv, z: zv, radius: rv });
    onResult(err ? { key: "ob.rejected", vars: { x: xv, z: zv, r: rv, err } }
      : { key: "ob.done", vars: { x: xv, z: zv, r: rv } });
  };
  return (
    <div className="customob">
      <div className="sub">{T("ob.sub")}</div>
      <div className="row">
        <input value={x} onChange={(e) => setX(e.target.value)} placeholder="x" aria-label={T("ob.x")} />
        <input value={z} onChange={(e) => setZ(e.target.value)} placeholder="z" aria-label={T("ob.z")} />
        <input value={r} onChange={(e) => setR(e.target.value)} placeholder={T("ob.phRadius")} aria-label={T("ob.radius")} />
        <input value={dur} onChange={(e) => setDur(e.target.value)} placeholder={T("ob.phSec")} aria-label={T("ob.duration")} />
        <button onClick={fill} title={T("ob.fill")}>@AMR-01</button>
        <button onClick={go}>{T("ob.place")}</button>
      </div>
    </div>
  );
}

function InjectTab() {
  const T = useT();
  // §56（Review）：回饋訊息存鍵＋變數（Msg），render 時才翻譯——切換語言後訊息立即跟著換；err 為引擎原文
  const [msg, setMsg] = useState<Msg>(null);
  const snap = useTwin((s) => s.snap);
  const runId = useTwin((s) => s.runId);
  useEffect(() => { setMsg(null); }, [runId]);    // §49：Reset 換 run → 清除殘留訊息
  const awaiting = snap?.state.cells.filter((c) => c.safety_awaiting_reset) ?? [];
  // Review：操作名稱也是字典鍵（labelKey），中文回饋不再混入英文 label；err 為引擎原文
  const fire = (labelKey: TKey, ft: string, id: string, dur?: number) => async () => {
    const err = await inject(ft, id, dur);
    setMsg(err ? { key: "inj.rejected", vars: { err }, labelKey } : { key: "inj.done", labelKey });
  };
  const B = (k: TKey, sub?: TKey) => <>{T(k)}{sub && <span>{T(sub)}</span>}</>;
  return (
    <div className="det">
      <div className="sect">{T("inj.title")}</div>
      <div className="injgrid">
        <button onClick={fire("inj.n.c03", "conveyor_jam", "C-03", 120)}>{B("inj.c03", "inj.c03s")}</button>
        <button onClick={fire("inj.n.r06", "tool_failure", "R-06", 180)}>{B("inj.r06", "inj.r06s")}</button>
        <button onClick={fire("inj.n.w01", "minor_stop", "W-01", 45)}>{B("inj.w01")}</button>
        <button onClick={fire("inj.n.c01", "conveyor_jam", "C-01", 90)}>{B("inj.c01")}</button>
        <button onClick={fire("inj.n.gate", "safety_gate_open", "CELL-WELDING", 60)}>{B("inj.gate", "inj.gates")}</button>
        <button onClick={fire("inj.n.amr1", "amr_fault", "AMR-01", 300)}>{B("inj.amr1", "inj.amr1s")}</button>
        <button onClick={fire("inj.n.comp", "compressor_fault", "COMPRESSOR", 90)}>{B("inj.comp", "inj.comps")}</button>
        <button onClick={fire("inj.n.lc", "light_curtain", "CELL-ASSEMBLY", 15)}>{B("inj.lc", "inj.lcs")}</button>
        <button onClick={fire("inj.n.estop", "emergency_stop", "CELL-MACHINE_TENDING")}>{B("inj.estop", "inj.estops")}</button>
        <button onClick={fire("inj.n.worker", "worker_in_zone", "CELL-WELDING", 20)}>{B("inj.worker", "inj.workers")}</button>
        <button onClick={fire("inj.n.sensor", "amr_obstacle", "AMR-02", 45)}>{B("inj.sensor", "inj.sensors")}</button>
        <button onClick={fire("inj.n.obW", "zone_obstacle", "corridor_west", 90)}>{B("inj.obW", "inj.obWs")}</button>
        <button onClick={fire("inj.n.obE", "zone_obstacle", "corridor_east", 90)}>{B("inj.obE", "inj.obEs")}</button>
        <button onClick={fire("inj.n.obS", "zone_obstacle", "supermarket_approach", 90)}>{B("inj.obS", "inj.obSs")}</button>
        <CustomObstacle onResult={setMsg} />
        <button onClick={async () => {
          await inject("amr_fault", "AMR-01", 900);
          await inject("amr_fault", "AMR-02", 900);
          setMsg({ key: "inj.dualDone" });
        }}>{B("inj.dual", "inj.duals")}</button>
      </div>
      {awaiting.length > 0 && (
        <>
          <div className="sect" style={{ color: "var(--critical)" }}>
            {T("inj.safety")}</div>
          <div className="injgrid">
            {awaiting.map((c) => (
              <button key={c.cell_id} onClick={async () => {
                await postJson("/api/safety/reset", { cell_id: c.cell_id });
                setMsg({ key: "inj.resetDone", vars: { id: c.cell_id } });
              }}>
                {T("inj.resetCell", { id: c.cell_id })}<span>{T("inj.resetCells")}</span>
              </button>))}
          </div>
        </>)}
      {msg && <div className="sub injmsg" style={{ marginTop: 8 }}>
        {T(msg.key, { ...(msg.vars ?? {}), ...(msg.labelKey ? { label: T(msg.labelKey) } : {}) })}</div>}
      <div className="sub" style={{ marginTop: 10 }}>
        {T("inj.note")}
      </div>
    </div>
  );
}

/* §51 派工 Decision Record（WareTwin 借鏡）：規則、選中理由、每台候選與落選原因。
 * 資料 = snapshot.state.dispatch_decisions（引擎環 20 筆；Local Demo 亦可看）。 */
function DispatchDecisions() {
  const T = useT();
  const decisions = useTwin((s) => s.snap?.state.dispatch_decisions ?? []);
  const [open, setOpen] = useState<string | null>(null);
  const rows = [...decisions].reverse().slice(0, 8);
  return (
    <>
      <div className="sect">{T("dd.title", { n: rows.length })}</div>
      <div className="declist">
        {rows.map((d) => (
          <div key={d.decision_id} className={"drow" + (d.chosen ? "" : " deferred")}
            onClick={() => setOpen(open === d.decision_id ? null : d.decision_id)}>
            <div className="dhead">
              <span className="time">{d.sim_time.slice(11, 19)}</span>
              <b>{d.task_id}</b> <span className="ttype">{d.task_type} → {d.target}</span>
              <span className={"chosen" + (d.chosen ? "" : " none")}>{d.chosen ?? "DEFERRED"}</span>
              <span className="wait">{T("dd.wait", { s: d.queue_wait_sec.toFixed(0) })}</span>
            </div>
            <div className="dreason">{d.reason}</div>
            {open === d.decision_id && (
              <div className="dcands">
                {d.candidates.map((c) => (
                  <div key={c.amr_id} className={"dc" + (c.rank === 1 ? " win" : "")}>
                    <div className="dcl"><b>{c.amr_id}</b> · {c.state} · {T("dd.toPickup", { d: c.distance_m.toFixed(1) })}
                      · {T("dd.batt")} {c.battery_percent.toFixed(0)}% · {T("dd.pref")} {c.pref_match ? "✓" : "–"} · {T("dd.rank")} {c.rank ?? "–"}</div>
                    <div className="dcr">{c.rejected_reason ?? T("dd.chosen")}</div>
                  </div>))}
              </div>)}
          </div>))}
        {rows.length === 0 && <div className="sub">{T("dd.none")}</div>}
      </div>
    </>
  );
}

function AuditTab() {
  const T = useT();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await getJson<any[]>("/api/audit?limit=40");
      if (!r) return;
      if (live) setRows([...r].reverse());
    };
    load();
    const t = setInterval(load, 2000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return (
    <div className="det">
      <DispatchDecisions />
      <div className="sect">{T("audit.title")}</div>
      <div className="auditlist">
        {rows.map((a, i) => (
          <div className="arow" key={i}>
            <span className="time">{String(a.sim_time).slice(11, 19)}</span>
            <span className={`actor ${a.actor}`}>{a.actor}</span>
            <span className="src">{a.source}</span>
            <span className="act">{a.action === "STATE_CHANGED"
              ? `${a.previous_state} → ${a.new_state}` : a.action}</span>
            {a.reason && <span className="rsn">{a.reason}</span>}
          </div>))}
        {rows.length === 0 && <div className="sub">{T("audit.none")}</div>}
      </div>
    </div>
  );
}

function WhatIfTab() {
  const T = useT();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [applied, setApplied] = useState(false);
  const run = (label: string, failure_type: string, target_id: string,
               duration_sec: number, horizon_min: number) => async () => {
    setBusy(true);
    try {
      const r = await postJson("/api/scenarios",
        { failure_type, target_id, duration_sec, horizon_min });
      if (r) { setRes(r); setApplied(false); }
    } finally { setBusy(false); }
  };
  const fmtD = (k: string, v: number) => {
    if (["oee", "availability", "performance", "quality"].includes(k))
      return `${(v * 100).toFixed(2)} pp`;
    return `${v > 0 ? "+" : ""}${v}`;
  };
  return (
    <div className="det">
      <div className="sect">{T("wi.title")}</div>
      <div className="injgrid">
        <button disabled={busy}
          onClick={run("R-09 fails 30 min", "tool_failure", "R-09", 1800, 30)}>
          {T("wi.r09")}<span>{T("wi.r09s")}</span></button>
        <button disabled={busy}
          onClick={run("R-06 fails 30 min", "tool_failure", "R-06", 1800, 30)}>
          {T("wi.r06")}<span>{T("wi.r06s")}</span></button>
        <button disabled={busy}
          onClick={run("C-03 jams 10 min", "conveyor_jam", "C-03", 600, 30)}>
          {T("wi.c03")}</button>
      </div>
      <CustomScenario busy={busy} run={run} />
      {busy && <div className="sub" style={{ marginTop: 8 }}>{T("wi.running")}</div>}
      {res && !busy && (
        <>
          {/* §50（WareTwin 借鏡）：12 項統一對照表 Baseline vs Scenario，方向感知的 ±／±% */}
          <div className="sect">{T("wi.table", { id: res.scenario_id, h: res.horizon_min })}</div>
          <table className="wtable"><thead><tr><th>{T("wi.metric")}</th><th>{T("wi.baseline")}</th><th>{T("wi.scenario")}</th><th>Δ</th></tr></thead>
            <tbody>
            {(res.metrics as { key: string; label: string; baseline: number; scenario: number;
                delta: number; delta_pct: number | null; better: boolean | null }[] ?? []).map((m) => {
              const pct = ["oee", "availability", "quality"].includes(m.key);
              const f = (v: number) => pct ? `${(v * 100).toFixed(1)}%` : String(v);
              const col = m.better === null ? "var(--muted)" : m.better ? "var(--good)" : "var(--serious)";
              const d = pct ? `${m.delta > 0 ? "+" : ""}${(m.delta * 100).toFixed(1)} pp`
                : `${m.delta > 0 ? "+" : ""}${m.delta}${m.delta_pct !== null ? ` (${m.delta_pct > 0 ? "+" : ""}${m.delta_pct}%)` : ""}`;
              return (<tr key={m.key}><td>{m.label}</td><td>{f(m.baseline)}</td><td>{f(m.scenario)}</td>
                <td style={{ color: col }}>{d}</td></tr>);
            })}
          </tbody></table>
          {res.first_divergence && (
            <div className="sub" title={T("wi.divTitle")}>
              {T("wi.div", { t: String(res.first_divergence.sim_time).slice(11, 19), tick: res.first_divergence.sim_tick,
                b: res.first_divergence.baseline_event ?? "—", s: res.first_divergence.scenario_event ?? "—" })}
            </div>)}
          <div className="sub">{T("wi.branch", { seq: res.branch_from.seq, b: res.baseline.run_id, s: res.scenario.run_id })}</div>
          <div className="sect">{T("wi.explanation")}</div>
          <div className="sub" style={{ color: "var(--ink-2)" }}>{res.explanation.summary}</div>
          <div className="injgrid" style={{ marginTop: 8 }}>
            <button disabled={applied} onClick={async () => {
              const r = await postJson(`/api/scenarios/${res.scenario_id}/apply`);
              if (r) setApplied(true);
            }}>{T("wi.apply")}<span>{T("wi.applys")}</span></button>
          </div>
          {applied && <div className="sub" style={{ color: "var(--good)" }}>{T("wi.applied", { id: res.scenario_id })}</div>}
        </>
      )}
    </div>
  );
}

function CopilotTab() {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [log, setLog] = useState<{ q: string; a: any }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getJson<string[]>("/api/copilot/suggestions").then((c) => c && setChips(c));
  }, []);
  const send = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true); setQ("");
    try {
      const a = await postJson("/api/copilot/query", { question });
      if (a) setLog((l) => [...l, { q: question, a }]);
    } finally { setBusy(false); }
  };
  return (
    <div className="det copilot">
      <div className="sect">{T("cp.title")}</div>
      <div className="chips">
        {chips.map((c) => { const q = tOpt(lang, `cpq.${c}`, c);   // §56：中文問法同樣由引擎意圖路由處理
          return <button key={c} onClick={() => send(q)}>{q}</button>; })}
      </div>
      <div className="chatlog">
        {log.map((m, i) => (
          <div key={i}>
            <div className="q">{T("cp.you")}{m.q}</div>
            <div className="a">
              <pre>{m.a.nl_text}</pre>
              <div className="meta">{T("cp.meta", { i: m.a.intent, src: m.a.nl_source })}
                {m.a.scenario_id ? ` · ${m.a.scenario_id}` : ""}</div>
            </div>
          </div>))}
        {busy && <div className="sub">{T("cp.analyzing")}</div>}
        {log.length === 0 && !busy &&
          <div className="sub">{T("cp.help")}</div>}
      </div>
      <div className="askrow">
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(q)}
          placeholder={T("cp.placeholder")} />
        <button onClick={() => send(q)} disabled={busy}>{T("cp.ask")}</button>
      </div>
    </div>
  );
}

function CustomScenario({ busy, run }: { busy: boolean;
  run: (l: string, ft: string, t: string, d: number, h: number) => () => Promise<void> }) {
  const T = useT();
  const [ft, setFt] = useState("tool_failure");
  const [target, setTarget] = useState("R-09");
  const [dur, setDur] = useState(30);
  const [hor, setHor] = useState(30);
  const targets = ft === "conveyor_jam" ? ["C-01", "C-02", "C-03"]
    : ft === "minor_stop"
      ? ["W-01", "W-02", "W-03", "W-04", "A-01", "A-02", "A-03", "A-04", "M-01", "M-02", "Q-01", "Q-02"]
      : ["R-01", "R-02", "R-03", "R-04", "R-05", "R-06", "R-07", "R-08", "R-09", "R-10", "R-11", "R-12"];
  return (
    <div className="cust">
      <div className="sect">{T("wi.custom")}</div>
      <div className="custrow">
        <select value={ft} onChange={(e) => { setFt(e.target.value); }}>
          <option value="tool_failure">{T("wi.toolFailure")}</option>
          <option value="conveyor_jam">{T("wi.jam")}</option>
          <option value="minor_stop">{T("wi.minor")}</option>
        </select>
        <select value={targets.includes(target) ? target : targets[0]}
          onChange={(e) => setTarget(e.target.value)}>
          {targets.map((t) => <option key={t}>{t}</option>)}
        </select>
        <label>{T("wi.failure")} <input type="number" min={1} max={240} value={dur}
          onChange={(e) => setDur(+e.target.value)} /> {T("wi.min")}</label>
        <label>{T("wi.horizon")} <input type="number" min={5} max={120} value={hor}
          onChange={(e) => setHor(+e.target.value)} /> {T("wi.min")}</label>
        <button disabled={busy} onClick={run(
          `${targets.includes(target) ? target : targets[0]} ${ft} ${dur}min`,
          ft, targets.includes(target) ? target : targets[0], dur * 60, hor)}>{T("wi.run")}</button>
      </div>
    </div>
  );
}

function RightTabs({ tab, setTab }:
  { tab: string; setTab: (t: "detail" | "inject" | "whatif" | "copilot" | "audit") => void }) {
  const T = useT();
  return (
    <div className="rtabs">
      {([["detail", "rt.detail"], ["inject", "rt.inject"], ["whatif", "rt.whatif"],
         ["copilot", "rt.copilot"], ["audit", "rt.audit"]] as const).map(([k, l]) => (
        <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{T(l)}</button>))}
    </div>
  );
}

/** §43.2 資料來源標示：LIVE 紅、LOCAL DEMO 藍、RECONNECTING/STALE 琥珀。 */
const MODE_BADGE: Record<ConnMode, [string, string]> = {
  CONNECTING: ["CONNECTING", "dim"], LIVE: ["LIVE", ""],
  RECONNECTING: ["RECONNECTING", "warn"], STALE: ["STALE", "warn"],
  LOCAL_DEMO: ["LOCAL DEMO", "demo"], SCHEMA_MISMATCH: ["SCHEMA ERROR", ""],
  ERROR: ["ERROR", ""],
};

function ModeBadge() {
  const mode = useTwin((s) => s.mode);
  const lastWall = useTwin((s) => s.lastSyncWall);
  const [l, cls] = MODE_BADGE[mode];
  const age = mode === "STALE" && lastWall
    ? ` — ${Math.round((Date.now() - lastWall) / 1000)}s` : "";
  return <span className={`live ${cls}`}><span className="dot" />{l}{age}</span>;
}

/** §43 連線橫幅：STALE 顯示最後同步時間、Backend 恢復時詢問是否切換。 */
export function ConnBanner() {
  const T = useT();
  const mode = useTwin((s) => s.mode);
  const livePrompt = useTwin((s) => s.livePrompt);
  const lastSim = useTwin((s) => s.lastSyncSim);
  if (livePrompt) {
    return (
      <div className="connbar prompt">
        {T("conn.available")}
        <button className="kpiex" onClick={() => void goLive()}>{T("conn.switchLive")}</button>
        <button className="kpiex" onClick={dismissLivePrompt}>{T("conn.stayDemo")}</button>
      </div>);
  }
  if (mode === "RECONNECTING" || mode === "STALE") {
    return (
      <div className="connbar warn">
        {T("conn.lost")}
        {lastSim ? T("conn.from", { t: lastSim.slice(11, 19) }) : ""}.
        {mode === "RECONNECTING" ? T("conn.reconnecting") : T("conn.stale")}
        {mode === "STALE" && demoLoaded() &&
          <button className="kpiex" onClick={switchToDemo}>{T("conn.switchDemo")}</button>}
      </div>);
  }
  if (mode === "SCHEMA_MISMATCH") {
    return <div className="connbar err">{T("conn.schema")}</div>;
  }
  if (mode === "LOCAL_DEMO") {
    return <div className="connbar demo">{T("conn.demo")}</div>;
  }
  return <div className="connbar off" />;
}

/** §37.2 Header：兩列（識別＋時間＋連線＋控制／功能分頁）。
 *  Full ≤96px、Compact ≤76px；環境資訊與 Rendering Mode 於 Compact 收入 More menu。 */
export function Header() {
  const T = useT();
  const { lang, setLang } = useLang();
  const { snap, connected, paused, speed, renderMode, setRenderMode, lastSeq,
          view, setView, resetting } = useTwin();
  const [, tick] = useState(0);
  const [more, setMore] = useState(false);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t); }, []);
  const env = snap?.state.environment;
  const modes = (
    <div className="modes">
      {(["high", "balanced", "performance"] as RenderMode[]).map((m) => (
        <button key={m} className={renderMode === m ? "on" : ""} aria-pressed={renderMode === m}
          onClick={() => setRenderMode(m)}>{T(`mode.${m}` as TKey)}</button>))}
    </div>);
  const langSwitch = (
    <div className="modes langsw" title={T("lang.title")} data-testid="langsw">
      {(["zh", "en"] as const).map((l) => (
        <button key={l} className={lang === l ? "on" : ""} lang={l === "zh" ? "zh-Hant" : "en"}
          aria-pressed={lang === l} onClick={() => setLang(l)}>{T(`lang.${l}` as TKey)}</button>))}
    </div>);
  return (
    <header>
      <div className="hrow">
        <div className="title">ROBOT FACTORY DIGITAL TWIN</div>
        <ModeBadge />
        <span className="hmeta"><span>{T("hdr.sim")} <b>{snap?.sim_time.slice(11, 19) ?? "--:--:--"}</b></span></span>
        <span className="hmeta sync" title={T("hdr.seqTitle")}>
          <span className="dot" style={{ background: connected ? "var(--good)" : "var(--critical)" }} />
          {T("hdr.seq")} <b>{fmt.format(lastSeq)}</b></span>
        <div className="hspace" />
        <div className="simctl">
          <button className={paused ? "" : "on"} title={T("hdr.run")}
            onClick={() => simCommand("start")}>▶</button>
          <button className={paused ? "on" : ""} title={T("hdr.pause")}
            onClick={() => simCommand("pause")}>⏸</button>
          {[1, 2, 5, 10].map((v) => (
            <button key={v} className={speed === v ? "on" : ""}
              onClick={() => simSpeed(v)}>{v}×</button>))}
          <button data-action="reset" title={resetting ? T("hdr.resetting") : T("hdr.reset")}
            className={resetting ? "busy" : ""} disabled={resetting}
            onClick={() => simCommand("reset")}>⟲</button>
        </div>
        <div className="hopt">{modes}</div>
        {langSwitch}
        <div className="moremenu">
          <button className="morebtn" onClick={() => setMore(!more)} title={T("hdr.more")}>⋯</button>
          {more && (
            <div className="menu" onMouseLeave={() => setMore(false)}>
              <div className="mi"><b>{snap?.state.line.name ?? "—"}</b></div>
              {env && <div className="mi sub">{env.temperature_c}°C · {env.humidity_percent}%
                {" "}· {env.system_status}</div>}
              <div className="mi sub">{T("hdr.runId", { id: snap?.run_id ?? "—" })}</div>
              <div className="mi">{modes}</div>
            </div>)}
        </div>
      </div>
      <div className="hrow">
        <nav className="tabs" role="tablist" aria-label={T("hdr.views")}>
          {(["3d", "flow", "health", "quality", "energy", "simulation"] as const)
            .map((k) => (
              <button key={k} type="button" role="tab" aria-selected={view === k}
                className={`tab ${view === k ? "on" : ""}`}
                onClick={() => setView(k)}>{T(`tab.${k}` as TKey)}</button>))}
        </nav>
        <div className="hspace" />
        <span className="hmeta hopt"><b>{snap?.state.line.name ?? "—"}</b></span>
        {env && <span className="hmeta hopt env">{env.temperature_c}°C · {env.humidity_percent}%</span>}
      </div>
    </header>
  );
}

export function LeftPanel() {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const snap = useTwin((s) => s.snap);
  const sel = useTwin((s) => s.selectedRobot);
  const select = useTwin((s) => s.selectRobot);
  if (!snap) return <section className="panel" />;
  const st = snap.state;
  const counts = { RUNNING: 0, WAIT: 0, ALERT: 0 };
  st.robots.forEach((r) => {
    if (r.status === "RUNNING") counts.RUNNING++;
    else if (r.status === "WAITING_MACHINE") counts.WAIT++;
    else if (["WARNING", "ERROR", "BLOCKED"].includes(r.status)) counts.ALERT++;
  });
  return (
    <section className="panel">
      <h2>{T("left.cells")}</h2>
      <div>
        {st.cells.map((c) => {
          const pb = (b: typeof c.input_buffer, tag: string) => {
            const cap = b.capacity ?? Math.max(b.occupancy, 1);
            const r = b.occupancy / cap;
            return (
              <div className="bufrow" key={tag}><span>{tag}</span>
                <div className={`buf ${r >= 0.85 ? "warn" : ""}`}>
                  <i style={{ width: `${Math.min(100, r * 100)}%` }} /></div>
                <span>{b.occupancy}{b.capacity ? `/${b.capacity}` : ""}</span></div>);
          };
          const rack = st.racks.find((r) => r.cell_id === c.cell_id);
          return (
            <div className="cell" key={c.cell_id}>
              <div className="row1">
                <span className="name">{cellName(lang, c.cell_id, c.name)}</span>
                {c.is_bottleneck && <span className="bneck">{T("left.bottleneck")}</span>}
                <span className={`chip st-${c.state}`}>{c.state}</span>
              </div>
              <div className="kv">
                <span>OEE <b>{pct(c.oee, 1)}</b></span>
                <span><b>{c.throughput_uph}</b> u/h</span>
                <span>{T("left.cycle")} <b>{c.avg_station_cycle_sec}s</b></span>
                <span><b>{c.active_stations}</b>/{c.stations.length} {T("left.act")}</span>
              </div>
              {pb(c.input_buffer, T("left.in"))}{pb(c.output_buffer, T("left.out"))}
              {rack && (
                <div className="bufrow" title={`${rack.sku} · ${T("left.reorder", { n: rack.reorder_point })}`
                  + (rack.reserved ? ` · ${T("left.enRoute", { n: rack.reserved })}` : "")}>
                  <span>{T("left.mat")}</span>
                  <div className={`buf ${rack.qty <= rack.reorder_point ? "warn" : ""}`}>
                    <i style={{ width: `${Math.min(100, rack.qty / rack.capacity * 100)}%`,
                      background: rack.qty <= 0 ? "var(--critical)"
                        : rack.material_low ? "var(--serious)" : "var(--aqua)" }} /></div>
                  <span style={{ color: rack.material_low ? "var(--serious)" : undefined }}>
                    {rack.qty}/{rack.capacity}{rack.reserved ? " ⇠" : ""}</span>
                </div>)}
            </div>);
        })}
      </div>
      <h2>{T("left.robots")}</h2>
      <div className="rsum">
        <div><div className="n">{st.robots.length}</div><div className="l">{T("left.total")}</div></div>
        <div><div className="n" style={{ color: "var(--good)" }}>{counts.RUNNING}</div><div className="l">{T("left.running")}</div></div>
        <div><div className="n" style={{ color: "var(--ink-2)" }}>{counts.WAIT}</div><div className="l">{T("left.wait")}</div></div>
        <div><div className="n" style={{ color: "var(--warning)" }}>{counts.ALERT}</div><div className="l">{T("left.alert")}</div></div>
      </div>
      <div className="robots">
        {st.robots.map((r) => (
          <button key={r.robot_id} type="button"
            className={`rb ${r.robot_id === sel ? "sel" : ""}`}
            aria-pressed={r.robot_id === sel}
            aria-label={T("left.selectRobot", { id: r.robot_id, status: r.status })}
            onClick={() => select(r.robot_id)}>
            {r.robot_id}<span className="dot" style={{ background: stDot(r.status) }} />
          </button>))}
      </div>
    </section>
  );
}

function CameraFeed({ active }: { active: boolean }) {
  const T = useT();
  const [feed, setFeed] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = async () => {
      const [r, m] = await Promise.all([
        getJson<any[]>("/api/inspection/recent?limit=4"),
        getJson("/api/vision/metrics"),
      ]);
      if (live && r) { setFeed(r); setMetrics(m); }
    };
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, [active]);
  if (!active) return <div className="placeholder" style={{ minHeight: 56 }}>{T("cam.none")}</div>;
  const latest = feed[0];
  if (!latest) return <div className="placeholder" style={{ minHeight: 56 }}>{T("cam.waiting")}</div>;
  return (
    <div className="camfeed">
      <div className="camimg">
        <img src={latest.image_url ?? `/api/inspection/${latest.part_id}/image.png`}
          alt={latest.part_id} />
        {latest.bbox && (
          <div className="bbox" style={{
            left: `${latest.bbox[0] * 100}%`, top: `${latest.bbox[1] * 100}%`,
            width: `${latest.bbox[2] * 100}%`, height: `${latest.bbox[3] * 100}%`,
          }} />)}
        <span className={`verdict ${latest.verdict}`}>{latest.verdict}</span>
      </div>
      <div className="caminfo">
        <div><b>{latest.part_id}</b> · {latest.predicted}
          {" "}({Math.round(latest.confidence * 100)}%)</div>
        <div className="sub">{T("cam.truth")}: {latest.ground_truth} ·
          {" "}{latest.agreement ? T("cam.agree") : T("cam.mismatch")} ·
          {" "}{latest.model_source} {latest.model_version}</div>
        {metrics && metrics.window > 0 && (
          <div className="sub">{T("cam.window", { n: metrics.window, p: Math.round((metrics.online_agreement ?? 0) * 100),
              fr: metrics.false_rejects, fa: metrics.false_accepts })}
            {metrics.model_meta?.held_out_accuracy &&
              T("cam.heldOut", { p: (metrics.model_meta.held_out_accuracy * 100).toFixed(1) })}
          </div>)}
        <div className="thumbs">
          {feed.slice(1).map((f) => (
            <img key={f.part_id}
              src={f.image_url ?? `/api/inspection/${f.part_id}/image.png`}
              title={`${f.part_id} ${f.predicted}`}
              style={{ outline: f.verdict === "FAIL" ? "1px solid var(--critical)" : "none" }} />))}
        </div>
      </div>
    </div>
  );
}

/** §38 Camera Panel：選 Robot → 該 Cell 的 Station Camera；支援 Prev/Next、
 *  Fullscreen、Analyze（規則式）、異常自動切換（可關閉）。CAM-QA-01 兼作
 *  Inspection Camera（ONNX feed + bbox overlay），其他為 CCTV PIP。 */
/** 影像／事件來源標示依連線模式，不得把 replay 或 stale 顯示成 live。 */
function sourceBadge(mode: string, connected: boolean) {
  if (mode === "LOCAL_DEMO")
    return { text: t("cam.replay"), cls: "demo", dot: "●REPLAY", dotColor: "var(--blue)" };
  if (mode === "STALE" || mode === "RECONNECTING")
    return { text: t("cam.lastSync", { mode }), cls: "warn", dot: "●STALE", dotColor: "var(--serious)" };
  if (mode === "LIVE" && connected)
    return { text: t("cam.live"), cls: "", dot: "●CONN", dotColor: "var(--good)" };
  return { text: t("cam.noSource"), cls: "dim", dot: "●WAIT", dotColor: "var(--muted)" };
}
function eventsSourceLabel(mode: string): string {
  return mode === "LOCAL_DEMO" ? t("src.replay")
    : mode === "STALE" || mode === "RECONNECTING" ? t("src.stale")
    : mode === "LIVE" ? t("src.live") : t("src.waiting");
}

function CameraPanel({ robotCell }: { robotCell: string }) {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const snap = useTwin((s) => s.snap);
  const connected = useTwin((s) => s.connected);
  const mode = useTwin((s) => s.mode);
  const feed = useTwin((s) => s.eventFeed);
  const [camId, setCamId] = useState<string>(CELL_TO_CAM[robotCell] ?? "CAM-AMR-01");
  const [auto, setAuto] = useState(true);
  const [full, setFull] = useState(false);
  // §56（Review）：存「分析當下的 snapshot state」，語言切換時以同一份 state 重算，不存翻好的字串
  const [analysis, setAnalysis] = useState<{ cam: Cam; state: unknown } | null>(null);
  useEffect(() => {
    setCamId(CELL_TO_CAM[robotCell] ?? "CAM-AMR-01");
    setAnalysis(null);
  }, [robotCell]);
  const lastSeen = useRef(0);                         // §38.3 異常自動切換：掃描新事件
  useEffect(() => {
    if (feed.length === 0) return;
    const fresh = feed.filter((e) => e.seq > lastSeen.current);
    lastSeen.current = feed[feed.length - 1].seq;
    if (!auto) return;
    for (let i = fresh.length - 1; i >= 0; i--) {     // 取最新的事故事件
      const target = cameraForEvent(fresh[i]);
      if (target) { setCamId(target); break; }
    }
  }, [feed, auto]);
  if (!snap) return null;
  const idx = Math.max(0, CAMERAS.findIndex((c) => c.id === camId));
  const cam = CAMERAS[idx];
  const step = (d: number) => {
    setCamId(CAMERAS[(idx + d + CAMERAS.length) % CAMERAS.length].id);
    setAnalysis(null);
  };
  const body = cam.id === "CAM-QA-01"
    ? <CameraFeed active />
    : <div className="cctv"><CctvView cam={cam} /></div>;
  const src = sourceBadge(mode, connected);
  const camName = tOpt(lang, `cam.name.${cam.id}`, cam.name);
  return (
    <div className="campanel">
      <div className="camhead">
        <span className={`rec ${src.cls}`}><i />{src.text}</span>
        <b>{cam.id}</b>
        <span className="sub">{camName}</span>
        <span className="hspace" />
        <span className="sub">{snap.sim_time.slice(11, 19)}</span>
        <span className="sub" style={{ color: src.dotColor }}>{src.dot}</span>
      </div>
      {body}
      <div className="camctl">
        <button onClick={() => step(-1)} title={T("cam.prev")}>◀</button>
        <button onClick={() => step(1)} title={T("cam.next")}>▶</button>
        <button onClick={() => setFull(true)} title={T("cam.full")}>⛶</button>
        <button title={T("cam.locate")}
          onClick={() => useTwin.getState().flyTo([cam.look[0], cam.look[2]])}>⌖</button>
        <button onClick={() => setAnalysis({ cam, state: snap.state })}>{T("cam.analyze")}</button>
        <label className="sub" style={{ marginLeft: "auto", cursor: "pointer" }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {" "}{T("cam.auto")}</label>
      </div>
      {analysis && <div className="sub camana">{analyzeCamera(analysis.cam, analysis.state, lang)}</div>}
      {full && (
        <div className="camfull" onClick={() => setFull(false)}>
          <div className="frame" onClick={(e) => e.stopPropagation()}>
            <div className="camhead">
              <span className={`rec ${src.cls}`}><i />{src.text}</span>
              <b>{cam.id}</b><span className="sub">{camName}</span>
              <span className="hspace" />
              <button onClick={() => step(-1)}>◀</button>
              <button onClick={() => step(1)}>▶</button>
              <button onClick={() => setFull(false)}>✕</button>
            </div>
            <div className="cctv big">
              {cam.id === "CAM-QA-01" ? <CameraFeed active /> : <CctvView cam={cam} big />}
            </div>
          </div>
        </div>)}
    </div>
  );
}

function usePdm(robotId: string) {
  const [row, setRow] = useState<any>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const rows = await getJson<any[]>("/api/maintenance");
      if (live && rows) setRow(rows.find((r: any) => r.robot_id === robotId) ?? null);
    };
    load();
    const t = setInterval(load, 10000);
    return () => { live = false; clearInterval(t); };
  }, [robotId]);
  return row;
}

export function RightPanel() {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const snap = useTwin((s) => s.snap);
  const sel = useTwin((s) => s.selectedRobot);
  const feed = useTwin((s) => s.eventFeed);
  const mode = useTwin((s) => s.mode);
  const pdm = usePdm(sel);
  const [tab, setTab] = useState<"detail" | "inject" | "whatif" | "copilot" | "audit">("detail");
  const r = snap?.state.robots.find((x) => x.robot_id === sel);
  if (!snap || !r) return <section className="panel" />;
  // §43.4：需要權威引擎的功能在 Local Demo 顯示明確停用說明（不是按了沒反應）
  if (tab !== "detail" && mode === "LOCAL_DEMO" &&
      ["inject", "whatif", "copilot", "audit"].includes(tab)) {
    return (
      <section className="panel">
        <RightTabs tab={tab} setTab={setTab} />
        <div className="det">
          {/* §51：派工 Decision Record 來自 snapshot（fixture 回放也有）→ demo 亦可看 */}
          {tab === "audit" && <DispatchDecisions />}
          <div className="placeholder" style={{ padding: 18, lineHeight: 1.7 }}>
            🔒 <b>{T("live.required")}</b><br />
            {T("live.explain")}
          </div>
        </div>
      </section>);
  }
  if (tab !== "detail") {
    return (
      <section className="panel">
        <RightTabs tab={tab} setTab={setTab} />
        {tab === "inject" ? <InjectTab /> : tab === "whatif" ? <WhatIfTab />
          : tab === "copilot" ? <CopilotTab /> : <AuditTab />}
      </section>
    );
  }
  return (
    <section className="panel">
      <RightTabs tab={tab} setTab={setTab} />
      <div className="det">
        <div className="head"><span className="id">{r.robot_id}</span>
          <span className={`chip st-${r.status}`}>{r.status}</span></div>
        <table><tbody>
          <tr><td>{T("det.cellStation")}</td><td>{r.cell_id.replace("CELL-", "")} · {r.station_id}</td></tr>
          <tr><td>{T("det.process")}</td><td>{r.process}</td></tr>
          <tr><td>{T("det.cycleState")}</td><td>{r.cycle_state} ({Math.round(r.cycle_progress * 100)}%)</td></tr>
          <tr><td>{T("det.cycleTarget")}</td><td>{r.cycle_time_sec}s / {r.target_cycle_time_sec}s</td></tr>
          <tr><td>{T("det.toolHealth")}</td><td>{r.tool_health_percent}%</td></tr>
          <tr><td>{T("det.energy")}</td><td>{r.energy_kw} kW</td></tr>
          <tr><td>{T("det.risk")}</td><td>{Math.round(r.maintenance_risk * 100)}%</td></tr>
          {pdm && <tr><td>{T("det.rul")}</td>
            <td>{pdm.rul_shifts != null ? T("det.shifts", { n: pdm.rul_shifts }) : "—"} ·
              {" "}{tOpt(lang, `win.${pdm.recommended_window}`, pdm.recommended_window)}</td></tr>}
          <tr><td>{T("det.alarm")}</td><td>{r.alarm_code ?? "—"}</td></tr>
        </tbody></table>
        <div className="sect">{T("det.joint")}</div>
        {r.joint_load_percent.map((v, i) => (
          <div className="jl" key={i}>
            <div className="lab"><span>J{i + 1}</span><span>{v}%</span></div>
            <div className="bar"><i className={v >= 85 ? "hot" : ""} style={{ width: `${v}%` }} /></div>
          </div>))}
        <div className="sect">{T("det.camera")}</div>
        <CameraPanel robotCell={r.cell_id} />
        <div className="sect">{T("det.events", { src: eventsSourceLabel(mode) })}</div>
        <div className="evfeed">
          {feed.slice(-6).reverse().map((e) => (
            <div key={e.seq}>#{e.seq} {e.sim_time.slice(11, 19)} {e.source_id} {e.event_type}</div>))}
          {feed.length === 0 && <div>{T("det.waitingEvents")}</div>}
        </div>
      </div>
    </section>
  );
}

/** §37.3：高度不足時 KPI Strip 收合為單列摘要卡，可展開為 overlay，不撐長頁面。 */
function useShortViewport(): boolean {
  const [short, setShort] = useState(
    () => window.matchMedia("(max-height: 799px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-height: 799px)");
    const on = (e: MediaQueryListEvent) => setShort(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return short;
}

export function Dashboard() {
  const T = useT();
  const snap = useTwin((s) => s.snap);
  const short = useShortViewport();
  const [expanded, setExpanded] = useState(false);
  if (!snap) return <div className="bottom" />;
  const st = snap.state;
  const k = st.kpis;
  const H = st.history_minutes;
  if (short && !expanded) {
    const unres = st.alerts.filter((a) => !a.resolved).length;
    return (
      <div className="kpibar">
        <span>{T("kpi.oee")} <b>{pct(k.oee.oee, 1)}</b></span>
        <span>{T("kpi.good")} <b>{fmt.format(k.good_units)}</b><i>/{fmt.format(k.target_good_units)}</i></span>
        <span>{T("kpi.rate")} <b>{k.throughput_uph} u/h</b></span>
        <span>{T("kpi.defect")} <b>{pct(k.defect_rate, 2)}</b></span>
        <span>{T("kpi.energy")} <b>{k.energy_kwh_total} kWh</b></span>
        <span>{T("kpi.alerts")} <b style={{ color: unres ? "var(--critical)" : "var(--ink)" }}>{unres}</b></span>
        <span className="hspace" />
        <button className="kpiex" onClick={() => setExpanded(true)}>{T("kpi.detail")}</button>
      </div>
    );
  }
  return (
    <div className={`bottom${short ? " overlay" : ""}`}>
      {short && <button className="kpiex close" onClick={() => setExpanded(false)}>{T("kpi.collapse")}</button>}
      <div className="tile"><h3>{T("kpi.oeeTitle")}</h3>
        <div className="oee-wrap">
          <OeeRing val={k.oee.oee} target={k.oee.target_oee} />
          <div className="apq">
            <Bar name={T("kpi.availability")} value={k.oee.availability} />
            <Bar name={T("kpi.performance")} value={k.oee.performance} />
            <Bar name={T("kpi.quality")} value={k.oee.quality} />
          </div>
        </div>
      </div>
      <div className="tile"><h3>{T("kpi.throughput")}</h3>
        <div className="hero">{fmt.format(k.good_units)} <span className="sub">{T("kpi.goodUnits")}</span></div>
        <div className="sub">{T("kpi.target", { n: fmt.format(k.target_good_units), r: k.throughput_uph })}</div>
        <Sparkline pts={bucket(H, 10, (sl) => sl.reduce((a, p) => a + p.good_units, 0) * 6)}
          fmtV={(v) => `${v.toFixed(0)} u/h`} />
      </div>
      <div className="tile"><h3>{T("kpi.defectRate")}</h3>
        <div className="hero">{pct(k.defect_rate, 2)}</div>
        <div className="sub">{T("kpi.fpy", { p: pct(k.first_pass_yield, 2), n: k.defect_units })}</div>
        <Sparkline color="var(--amber)"
          pts={bucket(H, 10, (sl) => sl.reduce((a, p) => a + p.defect_rate, 0) / sl.length * 100)}
          fmtV={(v) => `${v.toFixed(2)}%`} />
      </div>
      <div className="tile"><h3>{T("kpi.energy")}</h3>
        <div className="hero">{k.energy_kwh_total} <span className="sub">kWh</span></div>
        <div className="sub">{T("kpi.perUnit", { e: k.energy_kwh_per_unit, kw: k.energy_kw_current })}</div>
        <Sparkline color="var(--aqua)"
          pts={bucket(H, 10, (sl) => sl.reduce((a, p) => a + p.energy_kw, 0) / sl.length)}
          fmtV={(v) => `${v.toFixed(1)} kW`} />
      </div>
      <div className="tile"><h3>{T("kpi.alerts")} <span style={{ color: "var(--critical)" }}>
        {st.alerts.filter((a) => !a.resolved).length}</span></h3>
        <div className="alerts">
          {st.alerts.length === 0 && <div className="sub">{T("kpi.noAlerts")}</div>}
          {st.alerts.map((a) => (
            <div className="al" key={a.alert_id} style={{ opacity: a.resolved ? 0.45 : 1 }}>
              <span className="sev" style={{ color: sevColor(a.severity) }}><i>{sevIcon(a.severity)}</i></span>
              <div><div className="t">{a.title}{a.resolved ? T("kpi.resolved") : ""}</div>
                <div className="d">{a.detail}</div></div>
              <span className="time">{a.sim_time.slice(11, 16)}</span>
              {!a.acknowledged && !a.resolved &&
                <button className="ackbtn" onClick={() => ackAlert(a.alert_id)}>{T("kpi.ack")}</button>}
              {a.acknowledged && !a.resolved && <span className="sub">✓</span>}
            </div>))}
        </div>
      </div>
      <ExplanationTile />
    </div>
  );
}

function ExplanationTile() {
  const T = useT();
  const [x, setX] = useState<any>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await getJson("/api/explanation/latest");
      if (live && r) setX(r);
    };
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!x) return <div className="tile"><h3>{T("expl.title")}</h3></div>;
  return (
    <div className="tile"><h3>{T("expl.title")}
      <span className="sub" style={{ marginLeft: 6 }}>
        {T("expl.meta", { p: Math.round(x.confidence * 100) })}</span></h3>
      <div className="expl">
        <div className="t">{x.summary}</div>
        <div className="d">{x.primary_cause}</div>
        {x.recommended_actions.slice(0, 2).map((a: string, i: number) => (
          <div className="act" key={i}>→ {a}</div>))}
      </div>
    </div>
  );
}

export function Provenance() {
  const T = useT();
  const snap = useTwin((s) => s.snap);
  if (!snap) return null;
  const P = snap.provenance;
  return (
    <div className="prov">
      {T("prov", { run: P.run_id, seed: P.seed, params: P.parameter_set_id, hash: P.parameter_hash.slice(0, 17),
        schema: P.schema_version, engine: P.engine_version })}
    </div>
  );
}
