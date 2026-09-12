/** §41 Energy Dashboard — per-asset 能源帳（權威=引擎；總量=各資產積分之和）。
 *  KPI（§41.1）／時間圖含 Baseline·Demand Limit·事件標記·範圍切換（§41.2）／
 *  耗能拆解 by group·by cell（§41.3）／Top consumers·Idle waste·Drill-down（§41.4）／
 *  Energy Opportunity 附證據（§41.6）／Energy What-if 政策比較（§41.7）。
 *  Estimated Cost 與 CO₂e 依 §41.1 但書省略（未定義電價與排放係數）。 */
import { useMemo, useRef, useState } from "react";
import { useTwin } from "../state/store";
import { usePoll } from "./FlowView";
import { postJson } from "./api";
import { cellName, useLang, useT, type TKey } from "../i18n";

const GROUPS = ["robot", "cnc", "welding_controller", "vision", "conveyor", "amr", "charger",
  "auxiliary", "compressed_air", "hvac"];
const GROUP_COLOR: Record<string, string> = {
  robot: "#3987e5", cnc: "#b06fd8", welding_controller: "#e5a339",
  vision: "#199e70", conveyor: "#8a8a80", amr: "#4fc3f7", charger: "#c98500",
  auxiliary: "#5b5b56", compressed_air: "#5e9ea0", hvac: "#7d8fc9",
};
const CELL_COLOR: Record<string, string> = {
  "CELL-WELDING": "#e5a339", "CELL-ASSEMBLY": "#3987e5",
  "CELL-MACHINE_TENDING": "#b06fd8", "CELL-VISION_INSPECTION": "#199e70",
  INTRALOGISTICS: "#4fc3f7", AUXILIARY: "#5b5b56", FACILITY: "#5e9ea0",
};

/* ---------------- §41.2 主時間圖 ---------------- */
function PowerChart({ hist, baseline, limit, alerts }: {
  hist: any[]; baseline: number; limit: number; alerts: any[];
}) {
  const T = useT();
  const [range, setRange] = useState<15 | 60 | 0>(60);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const H = range === 0 ? hist : hist.slice(-range);
  const W = 640, HT = 168, padL = 40, padB = 22, padT = 10;
  const vals = H.map((h) => h.energy_kw);
  if (vals.length < 2) return <div className="sub">{T("en.collecting")}</div>;
  const hi = Math.max(...vals, limit) * 1.05, lo = 0;
  const xs = (i: number) => padL + (i * (W - padL - 10)) / (H.length - 1);
  const ys = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (HT - padT - padB);
  // 事件標記：alert sim_time "HH:MM" 對上 minute label
  const mIdx = new Map(H.map((h: any, i: number) => [h.sim_minute, i]));
  const marks = alerts
    .map((a) => ({ i: mIdx.get(a.sim_time.slice(11, 16)), t: a.title, sev: a.severity }))
    .filter((m) => m.i != null) as { i: number; t: string; sev: string }[];
  return (
    <div ref={ref} className="echart"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width * W;
        setHover(Math.max(0, Math.min(H.length - 1,
          Math.round((fx - padL) / (W - padL - 10) * (H.length - 1)))));
      }}>
      <div className="fsel" style={{ justifyContent: "flex-end" }}>
        {([[15, "en.15"], [60, "en.60"], [0, "en.shift"]] as const).map(([v, l]) => (
          <button key={v} className={range === v ? "on" : ""}
            onClick={() => setRange(v)}>{T(l)}</button>))}
      </div>
      <svg viewBox={`0 0 ${W} ${HT}`} style={{ width: "100%" }}>
        {[0, hi / 2, hi].map((v, i) => (
          <g key={i}>
            <line x1={padL} y1={ys(v)} x2={W - 10} y2={ys(v)} stroke="var(--line)"
              strokeWidth={0.6} />
            <text x={padL - 4} y={ys(v) + 3} textAnchor="end" fontSize={9}
              fill="var(--muted)">{v.toFixed(0)}</text>
          </g>))}
        <text x={12} y={HT / 2} fontSize={9} fill="var(--muted)"
          transform={`rotate(-90 12 ${HT / 2})`} textAnchor="middle">kW</text>
        {/* Baseline 與 Demand Limit（§41.2） */}
        <line x1={padL} y1={ys(baseline)} x2={W - 10} y2={ys(baseline)}
          stroke="var(--aqua)" strokeWidth={1} strokeDasharray="4 4" />
        <text x={W - 12} y={ys(baseline) - 3} textAnchor="end" fontSize={8.5}
          fill="var(--aqua)">{T("en.baseline", { kw: baseline })}</text>
        <line x1={padL} y1={ys(limit)} x2={W - 10} y2={ys(limit)}
          stroke="var(--critical)" strokeWidth={1} strokeDasharray="2 4" />
        <text x={W - 12} y={ys(limit) - 3} textAnchor="end" fontSize={8.5}
          fill="var(--critical)">{T("en.limit", { kw: limit })}</text>
        {/* Actual */}
        <polyline fill="none" stroke="var(--aqua)" strokeWidth={1.8}
          points={H.map((h: any, i: number) => `${xs(i)},${ys(h.energy_kw)}`).join(" ")} />
        {/* 事件標記 */}
        {marks.map((m, j) => (
          <g key={j}>
            <line x1={xs(m.i)} y1={padT} x2={xs(m.i)} y2={HT - padB}
              stroke={m.sev === "CRITICAL" || m.sev === "HIGH"
                ? "var(--critical)" : "var(--warning)"} strokeWidth={0.8} opacity={0.55} />
            <title>{m.t}</title>
          </g>))}
        {/* x 軸時間刻度 */}
        {[0, Math.floor((H.length - 1) / 2), H.length - 1].map((i) => (
          <text key={i} x={xs(i)} y={HT - 8} textAnchor="middle" fontSize={8.5}
            fill="var(--muted)">{H[i].sim_minute}</text>))}
        {hover != null && (
          <g>
            <circle cx={xs(hover)} cy={ys(H[hover].energy_kw)} r={3}
              fill="var(--aqua)" stroke="var(--panel)" strokeWidth={1.5} />
            <text x={xs(hover)} y={ys(H[hover].energy_kw) - 8} textAnchor="middle"
              fontSize={9.5} fill="var(--ink)">
              {H[hover].sim_minute} · {H[hover].energy_kw} kW</text>
          </g>)}
      </svg>
      <div className="sub" style={{ fontSize: 10 }}>
        {T("en.chartNote")}
      </div>
    </div>
  );
}

/* ---------------- §41.3 耗能拆解（水平堆疊條） ---------------- */
function StackBar({ title, items }: {
  title: string; items: { label: string; kwh: number; color: string }[];
}) {
  const total = items.reduce((a, b) => a + b.kwh, 0) || 1;
  return (
    <div className="ebreak">
      <div className="sect">{title}</div>
      <div className="ebar">
        {items.filter((x) => x.kwh > 0).map((x) => (
          <i key={x.label} style={{ width: `${(x.kwh / total) * 100}%`, background: x.color }}
            title={`${x.label}: ${x.kwh.toFixed(1)} kWh (${(x.kwh / total * 100).toFixed(0)}%)`} />))}
      </div>
      <div className="elegend">
        {items.filter((x) => x.kwh > 0.01).map((x) => (
          <span key={x.label}><i style={{ background: x.color }} />
            {x.label} <b>{x.kwh.toFixed(1)}</b></span>))}
      </div>
    </div>
  );
}

/* ---------------- §41.6 Opportunities ---------------- */
function Opportunities() {
  const T = useT();
  const opps = usePoll<any[]>("/api/energy/opportunities", 15000) ?? [];
  if (opps.length === 0) return null;
  return (
    <div>
      <div className="sect">{T("en.opps")}</div>
      {opps.map((o) => (
        <div className="eopp" key={o.id}>
          <div className="t">→ {o.action}
            <span className="conf">{T("en.conf", { p: Math.round(o.confidence * 100) })}
              {o.reversible ? T("en.reversible") : ""}{T("en.approval")}</span></div>
          <div className="ev">{o.evidence}{o.estimate_note ? ` (${o.estimate_note})` : ""}</div>
          <div className="kv">{T("en.saving")} <b>{T("en.kwhShift", { n: o.estimated_saving_kwh_shift })}</b> ·
            {" "}{T("en.impact", { v: o.throughput_impact })} ·
            {" "}{T("en.assets", { v: o.affected_assets.slice(0, 5).join(", ") + (o.affected_assets.length > 5 ? "…" : "") })}</div>
        </div>))}
    </div>
  );
}

/* ---------------- §41.7 Energy What-if ---------------- */
const POLICIES = ["robot_auto_standby", "conveyor_stop_when_starved", "cnc_standby"] as const;

function EnergyWhatIf() {
  const T = useT();
  const [sel, setSel] = useState<Set<string>>(new Set(["robot_auto_standby"]));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await postJson("/api/energy/whatif",
        { policies: [...sel], horizon_min: 15 });
      if (r) setRes(r);
    } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="sect">{T("en.whatif")}</div>
      <div className="ewi">
        {POLICIES.map((k) => (
          <label key={k}><input type="checkbox" checked={sel.has(k)}
            onChange={(e) => {
              const n = new Set(sel);
              e.target.checked ? n.add(k) : n.delete(k);
              setSel(n);
            }} /> {T(`en.p.${k}` as TKey)}</label>))}
        <button className="kpiex" disabled={busy || sel.size === 0} onClick={run}>
          {busy ? T("en.running") : T("en.runCompare")}</button>
      </div>
      {res && res.deltas && (
        <table className="vtable" style={{ maxWidth: 560, marginTop: 6 }}>
          <thead><tr><th></th><th>{T("en.h.energy")}</th><th>{T("en.h.peak")}</th><th>{T("en.h.good")}</th>
            <th>{T("en.h.oee")}</th><th>{T("en.h.upk")}</th></tr></thead>
          <tbody>
            <tr><td>{T("en.rowBaseline")}</td><td>{res.baseline.energy_kwh} kWh</td>
              <td>{res.baseline.peak_kw} kW</td><td>{res.baseline.good_units}</td>
              <td>{(res.baseline.oee * 100).toFixed(1)}%</td>
              <td>{res.baseline.units_per_kwh}</td></tr>
            <tr><td>{T("en.rowPolicy")}</td><td>{res.policy.energy_kwh} kWh</td>
              <td>{res.policy.peak_kw} kW</td><td>{res.policy.good_units}</td>
              <td>{(res.policy.oee * 100).toFixed(1)}%</td>
              <td>{res.policy.units_per_kwh}</td></tr>
            <tr><td>Δ</td>
              <td style={{ color: res.deltas.energy_kwh < 0 ? "var(--good)" : undefined }}>
                {res.deltas.energy_kwh} kWh ({res.deltas.energy_pct}%)</td>
              <td>{res.deltas.peak_kw} kW</td>
              <td style={{ color: res.deltas.good_units < 0 ? "var(--critical)" : "var(--good)" }}>
                {res.deltas.good_units}</td>
              <td>{(res.deltas.oee * 100).toFixed(2)}pp</td><td>—</td></tr>
          </tbody>
        </table>)}
      {res && res.note && <div className="sub" style={{ marginTop: 4 }}>{res.note}{T("en.noteSuffix")}</div>}
    </div>
  );
}

/* ---------------- 主視圖 ---------------- */
export function EnergyView() {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const snap = useTwin((s) => s.snap);
  const bd = usePoll<any>("/api/energy/breakdown", 5000);
  const [drill, setDrill] = useState(false);
  const st = snap?.state;
  const groups = useMemo(() => bd ? Object.entries(bd.by_group)
    .map(([g, d]: [string, any]) => ({
      label: GROUPS.includes(g) ? T(`en.g.${g}` as TKey) : g, kwh: d.kwh, color: GROUP_COLOR[g] ?? "#777" }))
    .sort((a, b) => b.kwh - a.kwh) : [], [bd, T]);
  const cellsB = useMemo(() => bd ? Object.entries(bd.by_cell)
    .map(([c, d]: [string, any]) => ({
      label: cellName(lang, c, c.replace("CELL-", "")), kwh: d.kwh, color: CELL_COLOR[c] ?? "#777" }))
    .sort((a, b) => b.kwh - a.kwh) : [], [bd, lang]);
  if (!st) return null;
  const k = st.kpis;
  return (
    <div className="viewpad">
      <div className="qstats">
        <span>{T("en.s.shift")} <b>{k.energy_kwh_total} kWh</b></span>
        <span>{T("en.s.now")} <b>{k.energy_kw_current} kW</b></span>
        <span>{T("en.s.peak")} <b style={{ color: k.peak_demand_kw > k.demand_limit_kw
          ? "var(--critical)" : undefined }}>{k.peak_demand_kw} kW</b>
          <i className="sub">/{k.demand_limit_kw}</i></span>
        <span>{T("en.s.perUnit")} <b>{k.energy_kwh_per_unit} kWh</b></span>
        <span>{T("en.s.upk")} <b>{k.units_per_kwh}</b></span>
        <span>{T("en.s.idle")} <b style={{ color: "var(--serious)" }}>{k.idle_waste_kwh} kWh</b></span>
        <span>{T("en.s.baseline")} <b style={{ color: k.baseline_delta_pct > 5 ? "var(--serious)"
          : "var(--good)" }}>{k.baseline_delta_pct > 0 ? "+" : ""}{k.baseline_delta_pct}%</b>
          <i className="sub">({k.baseline_kw} kW)</i></span>
        <span className="sub">{T("en.costNote")}</span>
      </div>
      <div className="egrid">
        <div>
          <PowerChart hist={st.history_minutes} baseline={k.baseline_kw}
            limit={k.demand_limit_kw} alerts={st.alerts} />
          <StackBar title={T("en.byType")} items={groups} />
          <StackBar title={T("en.byCell")} items={cellsB} />
          {bd && <div className="sub" style={{ fontSize: 10 }}>
            {T("en.conservation", { t: bd.total_kwh, s: bd.sum_assets_kwh })}
          </div>}
        </div>
        <div>
          {bd && (
            <div>
              <div className="sect">{T("en.top5")}</div>
              {bd.top_consumers.map((r: any) => (
                <div className="jl" key={r.asset}>
                  <div className="lab"><span>{r.asset} <span className="sub">{GROUPS.includes(r.group) ? T(`en.g.${r.group}` as TKey) : r.group}</span></span>
                    <span>{r.kwh} kWh · {T("en.now")} {r.kw} kW</span></div>
                  <div className="bar"><i style={{
                    width: `${r.kwh / bd.top_consumers[0].kwh * 100}%`,
                    background: GROUP_COLOR[r.group] ?? "#777" }} /></div>
                </div>))}
              <div className="sect">{T("en.topIdle")}</div>
              {bd.top_idle_waste.filter((r: any) => r.idle_kwh > 0).map((r: any) => (
                <div className="jl" key={r.asset}>
                  <div className="lab"><span>{r.asset} <span className="sub">{GROUPS.includes(r.group) ? T(`en.g.${r.group}` as TKey) : r.group}</span></span>
                    <span>{T("en.wasted", { n: r.idle_kwh })}</span></div>
                  <div className="bar"><i style={{
                    width: `${r.idle_kwh / (bd.top_idle_waste[0].idle_kwh || 1) * 100}%`,
                    background: "var(--serious)" }} /></div>
                </div>))}
              <button className="kpiex" style={{ marginTop: 6 }}
                onClick={() => setDrill(!drill)}>
                {drill ? T("en.hide") : T("en.drill")}{T("en.allAssets", { n: bd.assets.length })}</button>
            </div>)}
          <Opportunities />
          <EnergyWhatIf />
        </div>
      </div>
      {drill && bd && (
        <table className="vtable" style={{ marginTop: 8 }}>
          <thead><tr><th>{T("en.t.asset")}</th><th>{T("en.t.group")}</th><th>{T("en.t.cell")}</th><th>{T("en.t.kw")}</th>
            <th>{T("en.t.kwh")}</th><th>{T("en.t.cycle")}</th><th>{T("en.t.idle")}</th></tr></thead>
          <tbody>
            {bd.assets.map((r: any) => (
              <tr key={r.asset}>
                <td>{r.asset}</td><td>{GROUPS.includes(r.group) ? T(`en.g.${r.group}` as TKey) : r.group}</td>
                <td className="sub">{r.cell ? cellName(lang, r.cell, r.cell.replace("CELL-", "")) : "—"}</td>
                <td>{r.kw}</td><td>{r.kwh}</td>
                <td>{r.kwh_per_cycle ?? "—"}</td>
                <td style={{ color: r.idle_kwh > 1 ? "var(--serious)" : undefined }}>
                  {r.idle_kwh}</td>
              </tr>))}
          </tbody>
        </table>)}
      <div className="sub" style={{ marginTop: 8 }}>
        {T("en.footer")}
      </div>
    </div>
  );
}
