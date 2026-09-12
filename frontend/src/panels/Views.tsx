/** 中央區六個操作視角（§7）— 3D 之外的五個資料視圖，全部由權威資料推導。 */
import { useEffect, useState } from "react";
import { getJson } from "./api";
import { useTwin } from "../state/store";
import { Bar, pct } from "./widgets";
import { tOpt, useLang, useT } from "../i18n";


export { FlowView } from "./FlowView";

/* ---------------- Robot Health（§7.3） ---------------- */
export function HealthView() {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await getJson<any[]>("/api/maintenance");
      if (live && r) setRows(r);
    };
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const select = useTwin((s) => s.selectRobot);
  return (
    <div className="viewpad">
      <table className="vtable">
        <thead><tr><th>{T("hv.robot")}</th><th>{T("hv.health")}</th><th>{T("hv.completions")}</th><th>{T("hv.wear")}</th>
          <th>{T("hv.rul")}</th><th>{T("hv.risk")}</th><th>{T("hv.window")}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.robot_id} onClick={() => select(r.robot_id)} style={{ cursor: "pointer" }}>
              <td>{r.robot_id} <span className="sub">{r.station_id}</span></td>
              <td style={{ minWidth: 140 }}>
                <Bar name="" value={r.health_score / 100}
                  color={r.health_score > 80 ? "var(--aqua)" : r.health_score > 65
                    ? "var(--warning)" : "var(--critical)"} />
              </td>
              <td>{r.completions}</td>
              <td>{r.wear_per_shift}</td>
              <td>{r.rul_shifts != null ? T("det.shifts", { n: r.rul_shifts }) : "—"}</td>
              <td style={{ color: r.maintenance_risk > 0.5 ? "var(--serious)" : "var(--ink-2)" }}>
                {Math.round(r.maintenance_risk * 100)}%</td>
              <td className="sub">{tOpt(lang, `win.${r.recommended_window}`, r.recommended_window)}</td>
            </tr>))}
        </tbody>
      </table>
      <div className="sub" style={{ padding: "6px 2px" }}>
        {T("hv.note")}
      </div>
    </div>
  );
}

/* ---------------- Quality（§7.4） ---------------- */
export function QualityView() {
  const T = useT();
  const snap = useTwin((s) => s.snap);
  const [feed, setFeed] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const [f, m] = await Promise.all([
        getJson<any[]>("/api/inspection/recent?limit=12"),
        getJson("/api/vision/metrics")]);
      if (live && f) { setFeed(f); setMetrics(m); }
    };
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const k = snap?.state.kpis;
  return (
    <div className="viewpad">
      {k && (
        <div className="qstats">
          <span>{T("qv.fpy")} <b>{pct(k.first_pass_yield, 2)}</b></span>
          <span>{T("qv.defect")} <b>{pct(k.defect_rate, 2)}</b></span>
          <span>{T("qv.rework")} <b>{k.rework_units}</b></span>
          {metrics && <span>{T("qv.agreement")} <b>{metrics.online_agreement != null
            ? pct(metrics.online_agreement, 0) : "—"}</b>
            {T("qv.window", { n: metrics.window, fr: metrics.false_rejects, fa: metrics.false_accepts })}</span>}
          {metrics?.model_meta?.held_out_accuracy &&
            <span>{T("qv.heldOut")} <b>{pct(metrics.model_meta.held_out_accuracy, 1)}</b> ·
              {" "}{metrics.model_source}</span>}
        </div>)}
      <div className="qgrid">
        {feed.map((f) => (
          <div key={f.part_id} className="qcard"
            style={{ borderColor: f.verdict === "FAIL" ? "var(--critical)" : "var(--line)" }}>
            <div className="qimg">
              <img src={f.image_url ?? `/api/inspection/${f.part_id}/image.png`}
                alt={f.part_id} />
              {f.bbox && <div className="bbox" style={{
                left: `${f.bbox[0] * 100}%`, top: `${f.bbox[1] * 100}%`,
                width: `${f.bbox[2] * 100}%`, height: `${f.bbox[3] * 100}%` }} />}
            </div>
            <div className="sub">{f.part_id} · {f.predicted}
              {" "}{Math.round(f.confidence * 100)}%{f.agreement ? "" : T("qv.truth") + f.ground_truth}</div>
          </div>))}
      </div>
    </div>
  );
}

export { EnergyView } from "./EnergyView";

/* ---------------- Simulation（§7.6） ---------------- */
export function SimulationView() {
  const T = useT();
  const [scens, setScens] = useState<any[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await getJson<any[]>("/api/scenarios");
      if (live && r) setScens([...r].reverse());
    };
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return (
    <div className="viewpad">
      <div className="sub" style={{ marginBottom: 8 }}>
        {T("sv.note")}
      </div>
      {scens.length === 0 && <div className="placeholder" style={{ minHeight: 80 }}>
        {T("sv.none")}</div>}
      {scens.map((sc) => (
        <div key={sc.scenario_id} className="cell" style={{ margin: "0 0 8px" }}>
          <div className="row1"><span className="name">{sc.scenario_id} ·
            {" "}{sc.injection.failure_type} @ {sc.injection.target_id}</span>
            <span className="sub">{T("sv.branch", { h: sc.horizon_min, seq: sc.branch_from.seq })}</span></div>
          <div className="kv" style={{ flexWrap: "wrap" }}>
            <span>Δgood <b style={{ color: sc.deltas.good_units < 0 ? "var(--serious)" : "var(--good)" }}>
              {sc.deltas.good_units}</b></span>
            <span>ΔOEE <b>{(sc.deltas.oee * 100).toFixed(2)} pp</b></span>
            <span>Δdowntime <b>{sc.deltas.downtime_sec}s</b></span>
            <span>Δenergy <b>{sc.deltas.energy_kwh_total} kWh</b></span>
          </div>
        </div>))}
    </div>
  );
}
