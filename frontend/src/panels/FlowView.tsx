/** §40 Production Flow — 三層結構：
 *  上層 Flow KPI Strip（§40.1）／中層 Dynamic Flow Map（§40.2，含 Rework 與補料流、
 *  可見 Buffer Queue、量化瓶頸成因）／下層 時間與瓶頸分析（§40.3）＋ What-if 比較（§40.4）。
 *  全部數字來自權威 snapshot 與 /api/flow/*；前端不推導生產結果。 */
import { useEffect, useMemo, useState } from "react";
import { useTwin } from "../state/store";
import { pct } from "./widgets";
import { getJson } from "./api";
import { cellName, t, useLang, useT } from "../i18n";

const CELLS = ["CELL-WELDING", "CELL-ASSEMBLY", "CELL-MACHINE_TENDING",
  "CELL-VISION_INSPECTION"] as const;
const CELL_COLOR: Record<string, string> = {
  "CELL-WELDING": "#e5a339", "CELL-ASSEMBLY": "#3987e5",
  "CELL-MACHINE_TENDING": "#b06fd8", "CELL-VISION_INSPECTION": "#199e70",
};
const ST_COLOR: Record<string, string> = {
  RUNNING: "var(--good)", BLOCKED: "var(--critical)", STARVED: "var(--serious)",
  DEGRADED: "var(--serious)", FAULT: "var(--critical)",
};

/* ---------------- data hooks ---------------- */
export function usePoll<T>(url: string, ms: number, deps: unknown[] = []): T | null {
  const [d, setD] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => getJson<T>(url)
      .then((x) => { if (live && x !== null) setD(x); });
    load();
    const t = setInterval(load, ms);
    return () => { live = false; clearInterval(t); };
  }, deps);           // eslint-disable-line react-hooks/exhaustive-deps
  return d;
}

/* ---------------- 上層：KPI strip（§40.1） ---------------- */
function KpiStrip({ st, insight }: { st: any; insight: any }) {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const k = st.kpis;
  const blocked = st.cells.flatMap((c: any) => c.stations)
    .filter((s: any) => s.state === "BLOCKED").length;
  const starved = st.cells.flatMap((c: any) => c.stations)
    .filter((s: any) => s.state === "STARVED").length;
  const worst = [...st.racks].sort((a: any, b: any) =>
    a.qty / a.capacity - b.qty / b.capacity)[0];
  const matRisk = worst.qty <= 0 ? [T("fl.stockout"), "var(--critical)"]
    : worst.material_low ? [T("fl.low", { sku: worst.sku }), "var(--serious)"]
    : worst.reserved ? [T("fl.enRoute"), "var(--warning)"] : [T("fl.ok"), "var(--good)"];
  const takt = k.throughput_uph > 0 ? (3600 / k.throughput_uph).toFixed(1) : "—";
  const items: [string, string, string?][] = [
    [T("fl.goodRate"), `${k.throughput_uph} u/h`],
    [T("fl.takt"), `${takt}s / ${k.takt_time_sec}s`],
    [T("fl.wip"), `${k.wip}`],
    [T("fl.lead"), k.avg_lead_time_sec ? `${(k.avg_lead_time_sec / 60).toFixed(1)} ${T("wi.min")}` : "—"],
    [T("fl.bottleneck"), insight ? cellName(lang, insight.bottleneck, insight.bottleneck_name ?? "—") : "—", "var(--amber)"],
    [T("fl.blocked"), `${blocked}`, blocked ? "var(--critical)" : undefined],
    [T("fl.starved"), `${starved}`, starved ? "var(--serious)" : undefined],
    [T("fl.reworkWip"), `${k.rework_units}`],
    [T("fl.material"), matRisk[0], matRisk[1]],
    [T("fl.amrPending"), `${st.amr_kpis.pending_tasks}`],
  ];
  return (
    <div className="fkpis">
      {items.map(([l, v, c]) => (
        <div className="fk" key={l}>
          <span className="l">{l}</span>
          <span className="v" style={c ? { color: c } : undefined}>{v}</span>
        </div>))}
    </div>
  );
}

/* ---------------- 中層：Dynamic Flow Map（§40.2） ---------------- */
const NX: Record<string, number> = {   // 節點 x（w: cell 170 / 端點 86）
  raw: 8, "CELL-WELDING": 118, "CELL-ASSEMBLY": 330, "CELL-MACHINE_TENDING": 542,
  "CELL-VISION_INSPECTION": 754, fg: 966, staging: 1076,
};
const CY = 118;                        // 主流程節點 y
const NH = 108;

function fmtWait(c: any, rack: any): string {
  if (c.state === "BLOCKED") return t("fl.w.down");
  if (c.state === "STARVED") return rack && rack.qty <= 0 ? t("fl.w.mat") : t("fl.w.up");
  if (c.state === "FAULT" || c.state === "DEGRADED") return t("fl.w.fault");
  if (c.is_bottleneck) return t("fl.w.pacemaker");
  return t("fl.w.paced");
}

function BufQueue({ x, y, label, occ, cap, fullSec }: {
  x: number; y: number; label: string; occ: number; cap: number; fullSec?: number;
}) {
  const full = occ >= cap;
  return (
    <g>
      {[...Array(cap)].map((_, i) => (
        <rect key={i} x={x + i * 9} y={y} width={7} height={10} rx={1.5}
          fill={i < occ ? (full ? "var(--critical)" : "var(--blue)") : "var(--baseline)"} />))}
      <text x={x + cap * 9 + 6} y={y + 9} fontSize={10}
        fill={full ? "var(--critical)" : "var(--muted)"}>
        {label} {occ}/{cap}{full ? `${t("fl.full")}${fullSec ? ` ${fullSec}s` : ""}` : ""}</text>
    </g>
  );
}

function FlowLink({ x1, x2, y, uph, jammed, items }: {
  x1: number; x2: number; y: number; uph: number; jammed: boolean; items: number;
}) {
  const w = Math.max(2.5, Math.min(9, 2.5 + uph / 30));
  const color = jammed ? "var(--critical)" : uph <= 1 ? "#4a4a46"
    : uph < 110 ? "var(--amber)" : "#4a8f5f";
  const dur = uph > 1 ? Math.max(0.5, 40 / uph * 4) : 0;
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth={w}
        strokeDasharray={jammed ? "3 5" : "7 9"}
        className={dur && !jammed ? "fflow" : undefined}
        style={dur && !jammed ? { animationDuration: `${dur}s` } : undefined} />
      {jammed && <text x={(x1 + x2) / 2} y={y - 9} textAnchor="middle" fontSize={9}
        fill="var(--critical)" fontWeight={700}>{t("fl.jam", { n: items })}</text>}
    </g>
  );
}

/** 彎折輔助線（補料/回流/rework）。 */
function Elbow({ pts, color, dashed = true, active = false, label, lx, ly }: {
  pts: [number, number][]; color: string; dashed?: boolean; active?: boolean;
  label?: string; lx?: number; ly?: number;
}) {
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("");
  return (
    <g opacity={active ? 1 : 0.42}>
      <path d={d} fill="none" stroke={color} strokeWidth={active ? 2.4 : 1.4}
        strokeDasharray={dashed ? "5 6" : undefined}
        className={active ? "fflow" : undefined}
        style={active ? { animationDuration: "1.2s" } : undefined} />
      {label && <text x={lx} y={ly} fontSize={9.5} fill={color}>{label}</text>}
    </g>
  );
}

function FlowMap({ st, insight, scenario }: { st: any; insight: any; scenario: any }) {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const [showWhy, setShowWhy] = useState(false);
  const cellOf = (cid: string) => st.cells.find((c: any) => c.cell_id === cid);
  const rackOf = (cid: string) => st.racks.find((r: any) => r.cell_id === cid);
  const conv = (i: number) => st.conveyors[i];
  const bufFull = insight?.buffer_full_sec ?? {};
  const bufNames = ["welding_to_assembly", "assembly_to_machining", "machining_to_inspection"];
  // AMR 補料/收貨進行中 → 對應輔助線高亮
  const activeRepl = new Set(st.amrs.filter((a: any) => a.task_type === "CELL_REPLENISH")
    .map((a: any) => a.task_target));
  const fgActive = st.amrs.some((a: any) => a.task_type === "FG_COLLECT");
  const scenTarget = scenario?.injection?.target_id;
  return (
    <div className="fmapwrap">
    <svg viewBox="0 0 1170 300" style={{ width: "100%", height: "100%" }}>
      {/* 主流程連線（粗細=流量、顏色=狀態、行進虛線=流速） */}
      {CELLS.slice(0, 3).map((cid, i) => {
        const cv = conv(i);
        return <FlowLink key={cid} x1={NX[cid] + 170} x2={NX[CELLS[i + 1]]}
          y={CY + NH / 2} uph={cellOf(cid).throughput_uph} jammed={cv.status === "JAMMED"}
          items={cv.item_count} />;
      })}
      <FlowLink x1={NX.raw + 86} x2={NX["CELL-WELDING"]} y={CY + NH / 2}
        uph={cellOf("CELL-WELDING").throughput_uph} jammed={false} items={0} />
      <FlowLink x1={NX["CELL-VISION_INSPECTION"] + 170} x2={NX.fg} y={CY + NH / 2}
        uph={st.kpis.throughput_uph} jammed={false} items={0} />
      {/* FG → Outbound Staging（AMR 物流，藍） */}
      <Elbow pts={[[NX.fg + 86, CY + NH / 2], [NX.staging, CY + NH / 2]]}
        color="var(--blue)" active={fgActive}
        label={T("fl.toStaging", { n: st.parts.shipped })} lx={NX.fg + 80} ly={CY + NH / 2 - 10} />
      {/* Buffer Queue（可見佇列；§40.2） */}
      {CELLS.slice(1).map((cid, i) => (
        <BufQueue key={cid} x={NX[cid] - 96} y={CY + NH / 2 + 14}
          label={`B0${i + 1}`} occ={cellOf(cid).input_buffer.occupancy}
          cap={cellOf(cid).input_buffer.capacity}
          fullSec={Math.round(bufFull[bufNames[i]] ?? 0) || undefined} />))}
      {/* Rework 迴路（紫）：Inspection → Rework Rack → 回檢 */}
      <g>
        <rect x={754} y={10} width={170} height={44} rx={9} fill="var(--panel-2)"
          stroke={st.rework_buffer.occupancy >= 10 ? "var(--critical)" : "#8a5aa8"} />
        <text x={839} y={28} textAnchor="middle" fontSize={11} fill="#c9a3e0"
          fontWeight={650}>{T("fl.reworkRack")}</text>
        <text x={839} y={44} textAnchor="middle" fontSize={10} fill="var(--muted)">
          {T("fl.inLoop", { o: st.rework_buffer.occupancy, n: st.kpis.rework_units })}</text>
      </g>
      <Elbow pts={[[NX["CELL-VISION_INSPECTION"] + 150, CY], [904, 54]]}
        color="#b06fd8" active={st.rework_buffer.occupancy > 0}
        label={T("fl.failRework")} lx={906} ly={84} />
      <Elbow pts={[[774, 54], [NX["CELL-VISION_INSPECTION"] - 40, CY + NH / 2 + 4],
        [NX["CELL-VISION_INSPECTION"], CY + NH / 2 + 4]]}
        color="#b06fd8" active={st.rework_buffer.occupancy > 0}
        label={T("fl.reinspect")} lx={690} ly={96} />
      {/* Scrap（誠實顯示：目前流程 fail→rework，scrap 計數為權威值） */}
      <text x={NX["CELL-VISION_INSPECTION"] + 85} y={CY + NH + 30} textAnchor="middle"
        fontSize={9.5} fill="var(--muted)">{T("fl.scrap", { n: st.parts.scrap })}</text>
      {/* Supermarket → Cell racks（藍色補料流；§40.2 額外流向） */}
      <g>
        <rect x={118} y={252} width={190} height={40} rx={9} fill="var(--panel-2)"
          stroke="var(--blue)" opacity={0.9} />
        <text x={213} y={269} textAnchor="middle" fontSize={11} fill="var(--blue)"
          fontWeight={650}>{T("fl.supermarket")}</text>
        <text x={213} y={284} textAnchor="middle" fontSize={10} fill="var(--muted)">
          {st.supermarket.per_sku.reduce((a: number, s: any) => a + s.qty, 0)}
          /{st.supermarket.per_sku.reduce((a: number, s: any) => a + s.capacity, 0)}
          {" · "}{T("fl.empties", { n: st.supermarket.empties })}</text>
      </g>
      {CELLS.map((cid) => {
        const key = cid.replace("CELL-", "").toLowerCase();
        const r = rackOf(cid);
        return (
          <g key={cid}>
            <Elbow active={activeRepl.has(key)} color="var(--blue)"
              pts={[[308, 268], [NX[cid] + 46, 268], [NX[cid] + 46, CY + NH]]}
              label={`${r.sku} ${r.qty}`} lx={NX[cid] + 52}
              ly={CY + NH + 24} />
            {r.material_low && <text x={NX[cid] + 52} y={CY + NH + 36} fontSize={9.5}
              fill={r.qty <= 0 ? "var(--critical)" : "var(--serious)"} fontWeight={700}>
              {r.qty <= 0 ? T("fl.stockout") : T("fl.matLow")}</text>}
          </g>);
      })}
      {/* 端點節點 */}
      {[["raw", T("fl.raw"), `${st.raw_buffer.occupancy}/60`],
        ["fg", T("fl.fg"), T("fl.wait", { n: st.finished_buffer.occupancy })],
        ["staging", T("fl.outbound"), T("fl.staged", { s: st.staging.units, o: st.staging.outbound_total })]]
        .map(([k2, l, sub]) => (
        <g key={k2}>
          <rect x={NX[k2]} y={CY + 24} width={86} height={60} rx={9}
            fill="var(--panel-2)" stroke="var(--line)" />
          <text x={NX[k2] + 43} y={CY + 48} textAnchor="middle" fontSize={11.5}
            fill="var(--ink)" fontWeight={650}>{l}</text>
          <text x={NX[k2] + 43} y={CY + 66} textAnchor="middle" fontSize={10}
            fill="var(--muted)">{sub}</text>
        </g>))}
      {/* Cell 節點卡（§40.2 Cell Node 內容） */}
      {CELLS.map((cid) => {
        const c = cellOf(cid);
        const r = rackOf(cid);
        const bneck = insight?.bottleneck === cid;
        const scen = scenTarget === cid ||
          c.stations.some((s2: any) => s2.robot_id === scenTarget);
        return (
          <g key={cid} onClick={() => bneck && setShowWhy(!showWhy)}
            style={bneck ? { cursor: "pointer" } : undefined}>
            <rect x={NX[cid]} y={CY} width={170} height={NH} rx={10}
              fill="var(--panel-2)"
              stroke={bneck ? "var(--amber)" : ST_COLOR[c.state] ?? "var(--line)"}
              strokeWidth={bneck ? 2.2 : 1.2}
              strokeDasharray={scen ? "6 4" : undefined} />
            <rect x={NX[cid]} y={CY} width={4} height={NH} rx={2}
              fill={CELL_COLOR[cid]} />
            <text x={NX[cid] + 12} y={CY + 19} fontSize={11.5} fill="var(--ink)"
              fontWeight={650}>{cellName(lang, cid, c.name).toUpperCase()}</text>
            {bneck && <text x={NX[cid] + 158} y={CY + 19} textAnchor="end" fontSize={9.5}
              fill="var(--amber)" fontWeight={700}>{T("fl.bneckTag")}</text>}
            <text x={NX[cid] + 12} y={CY + 36} fontSize={10}
              fill={ST_COLOR[c.state] ?? "var(--muted)"} fontWeight={650}>{c.state}</text>
            <text x={NX[cid] + 158} y={CY + 36} textAnchor="end" fontSize={10}
              fill="var(--ink-2)">{c.throughput_uph} u/h</text>
            <text x={NX[cid] + 12} y={CY + 53} fontSize={9.5} fill="var(--muted)">
              {T("fl.cellLine1", { a: c.active_stations, n: c.stations.length, oee: pct(c.oee, 0), c: c.avg_station_cycle_sec })}</text>
            <text x={NX[cid] + 12} y={CY + 69} fontSize={9.5} fill="var(--muted)">
              {T("fl.cellLine2", { i: `${c.input_buffer.occupancy}${c.input_buffer.capacity ? `/${c.input_buffer.capacity}` : ""}`,
                o: `${c.output_buffer.occupancy}${c.output_buffer.capacity ? `/${c.output_buffer.capacity}` : ""}`,
                u: insight ? pct(insight.utilization[cid] ?? 0, 0) : "—" })}</text>
            <text x={NX[cid] + 12} y={CY + 87} fontSize={9.5} fontStyle="italic"
              fill={c.state === "RUNNING" && !c.is_bottleneck ? "var(--muted)" : "var(--ink-2)"}>
              {fmtWait(c, r)}</text>
            <text x={NX[cid] + 12} y={CY + 101} fontSize={9}
              fill={r.material_low ? "var(--serious)" : "var(--muted)"}>
              {T("fl.matLine", { q: r.qty, c: r.capacity })}{r.reserved ? T("fl.replEnRoute") : ""}</text>
          </g>);
      })}
    </svg>
    {showWhy && insight && (
      <div className="fwhy" onClick={() => setShowWhy(false)}>
        <b>{T("fl.why", { name: cellName(lang, insight.bottleneck, insight.bottleneck_name) })}</b>
        <p>{insight.reason}</p>
        <div className="sub">{T("fl.rates", { r: CELLS.map((c) =>
          `${c.replace("CELL-", "").slice(0, 4)} ${insight.rates_uph[c]}`).join(" · "), w: insight.window_min })}</div>
      </div>)}
    </div>
  );
}

/* ---------------- 下層：時間與瓶頸分析（§40.3） ---------------- */
function MultiLine({ series, h = 120, unit }: {
  series: { name: string; color: string; pts: number[] }[]; h?: number; unit: string;
}) {
  const W = 560;
  const all = series.flatMap((s) => s.pts);
  if (all.length === 0) return <div className="sub">{t("en.collecting")}</div>;
  const hi = Math.max(...all, 1), lo = Math.min(...all, 0);
  const n = Math.max(...series.map((s) => s.pts.length));
  const xs = (i: number) => 34 + (i * (W - 44)) / Math.max(1, n - 1);
  const ys = (v: number) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (h - 24);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} style={{ width: "100%" }}>
      {[lo, (lo + hi) / 2, hi].map((v, i) => (
        <g key={i}>
          <text x={30} y={ys(v) + 3} textAnchor="end" fontSize={8.5}
            fill="var(--muted)">{v.toFixed(0)}</text>
          <line x1={34} y1={ys(v)} x2={W - 8} y2={ys(v)} stroke="var(--line)"
            strokeWidth={0.5} />
        </g>))}
      {series.map((s) => (
        <polyline key={s.name} fill="none" stroke={s.color} strokeWidth={1.6}
          points={s.pts.map((v, i) => `${xs(i)},${ys(v)}`).join(" ")} />))}
      <text x={W - 8} y={h - 2} textAnchor="end" fontSize={8.5} fill="var(--muted)">
        {t("fl.lastMin", { unit, n })}</text>
      {series.map((s, i) => (
        <g key={s.name}>
          <rect x={40 + i * 92} y={h - 10} width={8} height={3} fill={s.color} />
          <text x={51 + i * 92} y={h - 4} fontSize={8.5} fill="var(--ink-2)">{s.name}</text>
        </g>))}
    </svg>
  );
}

function BneckStrip({ hist }: { hist: any[] }) {
  const lang = useLang((s) => s.lang);
  const W = 560;
  const n = hist.length || 1;
  return (
    <svg viewBox={`0 0 ${W} 70`} style={{ width: "100%" }}>
      {hist.map((h, i) => (
        <rect key={i} x={8 + (i * (W - 16)) / n} y={14} width={(W - 16) / n + 0.5}
          height={26} fill={CELL_COLOR[`CELL-${h.pacemaker.toUpperCase()}`] ?? "#666"} />))}
      <text x={8} y={10} fontSize={9} fill="var(--muted)">
        {t("fl.pacemaker")}</text>
      {CELLS.map((c, i) => (
        <g key={c}>
          <rect x={8 + i * 138} y={52} width={9} height={9} fill={CELL_COLOR[c]} />
          <text x={20 + i * 138} y={60} fontSize={9} fill="var(--ink-2)">
            {cellName(lang, c, c.replace("CELL-", "").replace("_", " "))}</text>
        </g>))}
    </svg>
  );
}

function Hist({ insight }: { insight: any }) {
  const lang = useLang((s) => s.lang);
  if (!insight?.cycle_samples) return <div className="sub">{t("fl.collecting")}</div>;
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {CELLS.map((cid) => {
        const raw: number[] = insight.cycle_samples[cid] ?? [];
        if (raw.length < 10) return <div key={cid} className="sub">{t("fl.nlt10", { id: cid })}</div>;
        const sorted = [...raw].sort((a, b) => a - b);
        const clip = sorted[Math.floor(sorted.length * 0.98)];   // 展示範圍剪除極端值
        const v = raw.map((x) => Math.min(x, clip));
        const outliers = raw.filter((x) => x > clip).length;
        const lo = Math.min(...v), hi = Math.max(...v);
        const bins = 14;
        const cnt = new Array(bins).fill(0);
        v.forEach((x) => cnt[Math.min(bins - 1,
          Math.floor(((x - lo) / (hi - lo || 1)) * bins))]++);
        const mx = Math.max(...cnt);
        return (
          <svg key={cid} viewBox="0 0 130 84" style={{ width: 130 }}>
            {cnt.map((c2, i) => (
              <rect key={i} x={4 + i * 9} y={58 - (c2 / mx) * 46} width={7}
                height={(c2 / mx) * 46} fill={CELL_COLOR[cid]} />))}
            <text x={65} y={70} textAnchor="middle" fontSize={8.5} fill="var(--ink-2)">
              {cellName(lang, cid, cid.replace("CELL-", "").replace("_", " "))}</text>
            <text x={65} y={80} textAnchor="middle" fontSize={8} fill="var(--muted)">
              {t("fl.hist", { lo: lo.toFixed(0), hi: hi.toFixed(0), p: insight.cycle_p95_sec[cid] ?? "—", n: v.length })}
              {outliers ? ` (+${outliers}>${clip.toFixed(0)}s)` : ""}</text>
          </svg>);
      })}
    </div>
  );
}

const ANA_TABS = [["Buffers", "fl.a.buffers"], ["Cell u/h", "fl.a.uph"], ["Bottleneck", "fl.a.bneck"],
  ["Blocked/Starved", "fl.a.bs"], ["Cycle dist", "fl.a.cycle"], ["Material", "fl.a.material"], ["AMR", "fl.a.amr"]] as const;

function Analysis({ hist, insight }: { hist: any[]; insight: any }) {
  const T = useT();
  const [tab, setTab] = useState<string>("Buffers");
  const H = hist.slice(-120);
  const body = useMemo(() => {
    switch (tab) {
      case "Buffers":
        return <MultiLine unit={T("fl.u.parts")} series={[
          { name: "B01", color: "#e5a339", pts: H.map((h) => h.buf.b1) },
          { name: "B02", color: "#3987e5", pts: H.map((h) => h.buf.b2) },
          { name: "B03", color: "#b06fd8", pts: H.map((h) => h.buf.b3) },
          { name: T("fl.s.rework"), color: "#d05a5a", pts: H.map((h) => h.buf.rework) },
          { name: T("fl.s.fgWait"), color: "#199e70", pts: H.map((h) => h.buf.fg) }]} />;
      case "Cell u/h":
        return <MultiLine unit="u/h" series={CELLS.map((c) => ({
          name: c.replace("CELL-", "").slice(0, 7), color: CELL_COLOR[c],
          pts: H.map((h) => h.cell_uph[c.replace("CELL-", "").toLowerCase()]) }))} />;
      case "Bottleneck": return <BneckStrip hist={H} />;
      case "Blocked/Starved":
        return <MultiLine unit={T("fl.u.stations")} series={[
          { name: T("fl.s.blocked"), color: "var(--critical)", pts: H.map((h) => h.blocked) },
          { name: T("fl.s.starved"), color: "var(--serious)", pts: H.map((h) => h.starved) }]} />;
      case "Cycle dist": return <Hist insight={insight} />;
      case "Material":
        return <MultiLine unit={T("fl.u.rack")} series={CELLS.map((c) => ({
          name: c.replace("CELL-", "").slice(0, 7), color: CELL_COLOR[c],
          pts: H.map((h) => h.rack[c.replace("CELL-", "").toLowerCase()]) }))} />;
      case "AMR":
        return <MultiLine unit={T("fl.u.tasks")} series={[
          { name: T("fl.s.pending"), color: "var(--serious)", pts: H.map((h) => h.amr_pending) },
          { name: T("fl.s.delivered"), color: "var(--blue)", pts: H.map((h) => h.amr_delivered) },
          { name: T("fl.s.raw"), color: "#e5a339", pts: H.map((h) => h.buf.raw) }]} />;
      default: return null;
    }
  }, [tab, hist, insight, T]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="fana">
      <div className="fsel">
        {ANA_TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""}
            onClick={() => setTab(k)}>{T(l)}</button>))}
      </div>
      {body}
    </div>
  );
}

/* ---------------- What-if 比較（§40.4） ---------------- */
function Compare({ onPick, scenario }: { onPick: (s: any) => void; scenario: any }) {
  const T = useT();
  const scens = usePoll<any[]>("/api/scenarios", 6000) ?? [];
  if (scens.length === 0) return null;
  return (
    <div className="fcomp">
      <span className="sub">{T("fl.compare")}</span>
      <select value={scenario?.scenario_id ?? ""} onChange={(e) => {
        onPick(scens.find((s) => s.scenario_id === e.target.value) ?? null);
      }}>
        <option value="">{T("fl.current")}</option>
        {scens.map((s) => (
          <option key={s.scenario_id} value={s.scenario_id}>
            {s.scenario_id} · {s.injection.failure_type}@{s.injection.target_id}</option>))}
      </select>
      {scenario && (
        <span className="fdelta">
          Δgood <b style={{ color: scenario.deltas.good_units < 0 ? "var(--serious)" : "var(--good)" }}>
            {scenario.deltas.good_units}</b>
          {" "}· ΔOEE <b>{(scenario.deltas.oee * 100).toFixed(2)}pp</b>
          {" "}· Δdowntime <b>{scenario.deltas.downtime_sec}s</b>
          {" "}· Δenergy <b>{scenario.deltas.energy_kwh_total}kWh</b>
          {T("fl.dashed")}</span>)}
    </div>
  );
}

export function FlowView() {
  const snap = useTwin((s) => s.snap);
  const insight = usePoll<any>("/api/flow/insight", 5000);
  const hist = usePoll<any[]>("/api/flow/history", 10000) ?? [];
  const [scenario, setScenario] = useState<any>(null);
  if (!snap) return null;
  const st = snap.state;
  return (
    <div className="flowwrap">
      <KpiStrip st={st} insight={insight} />
      <Compare onPick={setScenario} scenario={scenario} />
      <FlowMap st={st} insight={insight} scenario={scenario} />
      <Analysis hist={hist} insight={insight} />
    </div>
  );
}
