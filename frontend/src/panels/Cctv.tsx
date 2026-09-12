/** §38 Factory Camera／CCTV — Cell-level Station Camera（顯示層）。
 *  低成本 PIP：第二個 R3F Canvas 以 frameloop="demand" 重用 SceneContents，
 *  依 rendering mode 的 FPS 預算 invalidate（High 10 / Balanced 5 / Performance 1），
 *  只在面板掛載時存在（§38.4）。畫面標示 SIMULATED LIVE，非真實影像。 */
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { useTwin } from "../state/store";
import { SceneContents } from "../scene/FactoryScene";
import type { TwinEvent } from "../types";
import { t, tr, type Lang } from "../i18n";

export interface Cam {
  id: string; name: string; cell: string | null;
  pos: [number, number, number]; look: [number, number, number];
}

export const CAMERAS: Cam[] = [
  { id: "CAM-WELD-01", name: "Welding Cell", cell: "CELL-WELDING",
    pos: [-26, 7.5, 12], look: [-33, 1, 0] },
  { id: "CAM-ASSY-01", name: "Assembly Cell", cell: "CELL-ASSEMBLY",
    pos: [-4, 7.5, 12], look: [-11, 1, 0] },
  { id: "CAM-CNC-01", name: "Machine Tending Cell", cell: "CELL-MACHINE_TENDING",
    pos: [18, 7.5, 12], look: [11, 1, 0] },
  { id: "CAM-QA-01", name: "Vision Inspection", cell: "CELL-VISION_INSPECTION",
    pos: [40, 7.5, 12], look: [33, 1, 0] },
  { id: "CAM-AMR-01", name: "AMR Lane / Supermarket", cell: null,
    pos: [-28, 9, 26], look: [-42, 0, 14] },
  { id: "CAM-OUT-01", name: "Finished Goods / Outbound", cell: null,
    pos: [40, 8, 14], look: [47.5, 0.5, 0] },
];

export const CELL_TO_CAM: Record<string, string> = {
  "CELL-WELDING": "CAM-WELD-01", "CELL-ASSEMBLY": "CAM-ASSY-01",
  "CELL-MACHINE_TENDING": "CAM-CNC-01", "CELL-VISION_INSPECTION": "CAM-QA-01",
};

/** 異常事件 → 對應攝影機（§38.3）。只對「事故型」事件切換，不對穩態擁塞
 *  （OUTPUT_BUFFER_FULL / CELL BLOCKED 在飽和產線屬常態）反覆跳台。 */
const SWITCH_TYPES = new Set([
  "CONVEYOR_JAMMED", "SAFETY_GATE_OPEN", "SAFETY_STOP", "FAILURE_INJECTED",
  "BATTERY_LOW", "STATION_ERROR", "ROBOT_ERROR",
]);
export function cameraForEvent(ev: TwinEvent): string | null {
  const incident = SWITCH_TYPES.has(ev.event_type) ||
    (ev.severity === "CRITICAL") ||
    (ev.event_type === "STATION_STATE" && /ERROR|FAULT/.test(ev.message ?? ""));
  if (!incident) return null;
  if (ev.cell_id && CELL_TO_CAM[ev.cell_id]) return CELL_TO_CAM[ev.cell_id];
  const id = ev.source_id ?? "";
  if (/^W-|^R-0[1-4]$|^C-01$/.test(id)) return "CAM-WELD-01";
  if (/^A-|^R-0[5-8]$|^C-02$/.test(id)) return "CAM-ASSY-01";
  if (/^M-|^CNC|^R-09$|^R-10$|^C-03$/.test(id)) return "CAM-CNC-01";
  if (/^Q-|^CAM|^R-1[12]$/.test(id)) return "CAM-QA-01";
  if (/^AMR|raw_material/.test(id)) return "CAM-AMR-01";
  if (/finished/.test(id)) return "CAM-OUT-01";
  return null;
}

function Rig({ pos, look, fps }: {
  pos: [number, number, number]; look: [number, number, number]; fps: number }) {
  const { camera, invalidate } = useThree();
  useEffect(() => {                       // R3F 掛載後不再套用 camera prop → 手動移機位
    camera.position.set(...pos);
    camera.lookAt(...look);
    invalidate();
  }, [pos.join(), look.join()]);
  useEffect(() => {
    const t = setInterval(() => invalidate(), Math.round(1000 / fps));
    return () => clearInterval(t);
  }, [fps]);
  return null;
}

export function CctvView({ cam, big }: { cam: Cam; big?: boolean }) {
  const snap = useTwin((s) => s.snap);
  const mode = useTwin((s) => s.renderMode);
  const fps = mode === "high" ? 10 : mode === "balanced" ? 5 : 1;   // §38.4 預算
  const dpr = big ? 1 : mode === "performance" ? 0.5 : 0.75;
  if (!snap) return null;
  return (
    <Canvas frameloop="demand" dpr={dpr}
      gl={{ antialias: false, powerPreference: "low-power" }}
      camera={{ position: cam.pos, fov: 46 }}
      style={{ width: "100%", height: "100%", display: "block" }}>
      <color attach="background" args={["#0c0c0b"]} />
      <SceneContents snap={snap} />
      <Rig pos={cam.pos} look={cam.look} fps={fps} />
    </Canvas>
  );
}

/** Analyze（規則式）：以權威 snapshot 描述該攝影機視野內狀態；依介面語言（§56）。狀態代碼維持原文。
 *  呼叫端存「當時的 snapshot state」而不是字串，語言切換時用同一份 state 重算（Review：Analyze 結果需隨語言切換）。 */
export function analyzeCamera(cam: Cam, st: any, lang?: Lang): string {
  const T = (k: Parameters<typeof t>[0], v?: Parameters<typeof t>[1]) => lang ? tr(lang, k, v) : t(k, v);
  if (cam.cell) {
    const c = st.cells.find((x: any) => x.cell_id === cam.cell);
    if (!c) return T("cam.noData");
    const act = T("cam.stationsActive", { a: c.active_stations, n: c.stations.length });
    const buf = `${T("left.in")} ${c.input_buffer.occupancy}${c.input_buffer.capacity ? "/" + c.input_buffer.capacity : ""}, ${T("left.out")} ${c.output_buffer.occupancy}${c.output_buffer.capacity ? "/" + c.output_buffer.capacity : ""}`;
    // StationSnapshot 欄位是 state（FAULT / ERROR），不是 status
    const alarms = c.stations.filter((s: any) => s.state === "FAULT" || s.state === "MAINTENANCE").length;
    return `${c.name}: ${c.state} · ${act} · OEE ${(c.oee * 100).toFixed(1)}% · ${buf}` +
      (c.is_bottleneck ? T("cam.bottleneck") : "") +
      (alarms ? T("cam.faults", { n: alarms }) : T("cam.noFaults"));
  }
  if (cam.id === "CAM-AMR-01") {
    const parts = st.amrs.map((a: any) =>
      `${a.amr_id} ${a.status}${a.current_task ? " (" + a.current_task + ")" : ""} ${a.battery_percent}%`);
    return `${T("cam.rawBuffer", { o: st.raw_buffer.occupancy, c: st.raw_buffer.capacity, r: st.raw_buffer.reorder_point })} · ${parts.join(" · ")}`;
  }
  return T("cam.fg", { n: st.finished_buffer.occupancy, s: st.staging.units,
    cap: st.staging.pallet_size * st.staging.pallets_per_truck, out: st.staging.outbound_total });
}
