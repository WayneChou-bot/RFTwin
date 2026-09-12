/** 3D 工廠場景（§36）— 所有狀態視覺都由 Twin snapshot 推導。
 *  P0：可辨識製程的設備與安全結構；P1：狀態驅動動態 + Camera Preset。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import type { CellSnapshot, ConveyorSnapshot, RobotState, SnapshotMessage } from "../types";
import { useTwin } from "../state/store";
import { getJson } from "../panels/api";
import { tOpt, useLang, useT, type TKey } from "../i18n";
import { getLabelsMode, Label, LabelManager, LabelsMode, setLabelsMode } from "./Label";
import { RobotArm } from "./RobotArm";
import { Booth, BufferSlots, Cabinet, Cnc, ConveyorStruct, Feeder, Fence,
         Fixture, Hmi, MAT, MaintCart, Operator, PartMesh, Rack, Sparks, StackLight,
         ToolRack, Tote }
  from "./SceneProps";
import { AirPipe, AndonBoard, CctvProp, ChargingPad, ControlSpine, DockBay, ExitSign,
         MaintenanceArea, PalletStaging, QuarantineCage, SideWallDoor, SupermarketSku }
  from "./SceneProps44";
import { AmrPayload, CameraGantry, ChipBin, CoolantTank, HoldRack, OutboundStatus,
         PassRejectLanes, ReceivingZone, Smoke, TorqueController, ToolChangeRack, WireDrum }
  from "./SceneProps45";
import { AmrRoutes, ZoneObstacle } from "./SceneProps48";
import { AmrPerceptionLayer } from "./SceneProps51";
import { CellSign, EnergyHeatmap, FlowOverlay, FumeStatus, LogisticsOverlay,
         MAINT_ENTRY, MAINT_EXIT, MaintenanceOperator, OverheadGroup, SafetyOverlay,
         TruckTail, UtilityZoneLive, ZoneSign }
  from "./SceneProps46";

/* ---------------- 佈局（§50：單一來源 config/factory_layout.json） ---------------- */
import { AMR_HOMES, CELL_X, CHARGING_PADS, DOCK_IDS, DOCKS } from "../layout";
const CONV_SPAN: Record<string, [number, number]> = {
  "C-01": [-25.5, -18.5], "C-02": [-3.5, 3.5], "C-03": [18.5, 25.5],
};
const CONV_STAGE: Record<string, string> = { "C-01": "welded", "C-02": "assembled", "C-03": "machined" };
/* §46.5 狀態顏色統一：RUNNING 綠／IDLE·WAITING 藍／STARVED 黃／BLOCKED 橙／
 * WARNING·MAINTENANCE 琥珀／ERROR·SAFETY 紅／OFFLINE 灰 */
export const STATUS_TINT: Record<string, string> = {
  RUNNING: "#0ca30c", IDLE: "#3987e5", WAITING: "#3987e5",
  STARVED: "#fab219", BLOCKED: "#e07030",
  DEGRADED: "#c98500", MAINTENANCE: "#c98500", WARNING: "#c98500",
  FAULT: "#d03b3b", ERROR: "#d03b3b", EMERGENCY_STOP: "#d03b3b",
  OFFLINE: "#898781",
};
const STAGE_OF_CELL: Record<string, string> = {
  "CELL-WELDING": "raw", "CELL-ASSEMBLY": "welded",
  "CELL-MACHINE_TENDING": "assembled", "CELL-VISION_INSPECTION": "machined",
};

function stationPositions(cell: CellSnapshot): [number, number][] {
  const cx = CELL_X[cell.cell_id];
  if (cell.stations.length === 4) return [[cx - 4, -4.6], [cx + 4, -4.6], [cx - 4, 4.6], [cx + 4, 4.6]];
  return [[cx, -4.6], [cx, 4.6]];
}

/* ---------------- Camera Presets（§36.12） ---------------- */
export const PRESETS: Record<string, { pos: [number, number, number]; tgt: [number, number, number] }> = {
  Overview: { pos: [0, 33, 44], tgt: [0, 0, -3] },        // §45.11 降俯角；y>26 屋頂結構自動隱藏
  Flow: { pos: [0, 12, 26], tgt: [0, 1, -2] },
  Welding: { pos: [-33, 9, 17], tgt: [-33, 1, 2] },
  Assembly: { pos: [-11, 9, 17], tgt: [-11, 1, 2] },
  "Machine Tending": { pos: [11, 9, 17], tgt: [11, 1, 2] },
  Inspection: { pos: [33, 9, 17], tgt: [33, 1, 2] },
  AMR: { pos: [-24, 18, 36], tgt: [-38, 0, 18] },
  Outbound: { pos: [40, 10, 26], tgt: [56, 0, 20] },        // §44.8 staging / 出貨門
  Receiving: { pos: [-38, 11, 14], tgt: [-53, 0, 5] },      // §45.3 收貨閉環
  "Back Zone": { pos: [-7, 30, 3], tgt: [-7, 0, -20] },      // §44.3–44.5 後區（越過 Andon 俯瞰，R2 減遮擋）
};

/* §45.11 Cinematic Tour：收貨 → Supermarket/AMR → 四 Cell → Inspection(Rework/FG) → 出貨 → 後區 */
export const TOUR = ["Receiving", "AMR", "Welding", "Assembly", "Machine Tending",
  "Inspection", "Outbound", "Back Zone"];
export const TOUR_DWELL_MS = 7000;
const ZONE_LETTER: Record<string, string> = {
  "CELL-WELDING": "A", "CELL-ASSEMBLY": "B", "CELL-MACHINE_TENDING": "C",
  "CELL-VISION_INSPECTION": "D",
};

/* 選取設備位置表（Follow 用），由佈局推導 */
export function robotWorldPos(cellId: string, stationIndex: number, nStations: number):
  [number, number] {
  const cx = CELL_X[cellId];
  if (nStations === 4) {
    const p: [number, number][] = [[cx - 4, -4.6], [cx + 4, -4.6], [cx - 4, 4.6], [cx + 4, 4.6]];
    return p[stationIndex];
  }
  return stationIndex === 0 ? [cx, -4.6] : [cx, 4.6];
}

/* §42-14 驗證用 FPS 表：每 0.5 s 更新，直接寫 DOM（不觸發 React re-render）。 */
function FpsMeter({ el }: { el: React.RefObject<HTMLDivElement | null> }) {
  const acc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => {
    acc.current.t += dt; acc.current.n++;
    if (acc.current.t >= 0.5) {
      const fps = Math.round(acc.current.n / acc.current.t);
      if (el.current) {
        el.current.textContent = `${fps} FPS`;
        el.current.className = "fpsbadge" + (fps < 30 ? " low" : "");
      }
      acc.current.t = 0; acc.current.n = 0;
    }
  });
  return null;
}

function CameraRig({ preset, onArrive, followPos }:
  { preset: string | null; onArrive: () => void; followPos: [number, number] | null }) {
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  useFrame((_, dt) => {
    if (!preset || !controls) return;
    const k = Math.min(1, dt * 3.2);
    if ((preset === "Follow" || preset === "FlyTo") && followPos) {
      const [fx, fz] = followPos;
      const goal = new THREE.Vector3(fx + 5.5, 6.5, fz + (fz < 0 ? 8.5 : -8.5));
      camera.position.lerp(goal, k);
      controls.target.lerp(new THREE.Vector3(fx, 1.4, fz), k);
      controls.update();
      if (preset === "FlyTo" && camera.position.distanceTo(goal) < 0.3) onArrive();
      return;
    }
    const p = PRESETS[preset];
    if (!p) { onArrive(); return; }
    camera.position.lerp(new THREE.Vector3(...p.pos), k);
    controls.target.lerp(new THREE.Vector3(...p.tgt), k);
    controls.update();
    if (camera.position.distanceTo(new THREE.Vector3(...p.pos)) < 0.15) onArrive();
  });
  return null;
}

/* ---------------- Cell ---------------- */
function Cell({ cell, onCellClick, onPartClick }: { cell: CellSnapshot;
  onCellClick?: (name: string) => void; onPartClick?: (id: string) => void }) {
  const cx = CELL_X[cell.cell_id];
  const snapAll = useTwin((s) => s.snap)!;
  const firstWelder = cell.cell_id === "CELL-WELDING"
    ? cell.stations.find((st) => {
        const r = snapAll.state.robots.find((rb) => rb.robot_id === st.robot_id);
        return r?.cycle_state === "WELDING" && r.status === "RUNNING";
      })?.station_id ?? null
    : null;
  const tint = STATUS_TINT[cell.state] ?? "#898781";
  const pos = stationPositions(cell);
  const snap = useTwin((s) => s.snap)!;
  // §36.9 SAFETY_GATE_OPEN → 全 Cell FAULT；§45.12 維修人員進出窗口也開門
  const maintGate = cell.stations.some((st) => {
    const p = st.fault_progress ?? 0;
    return st.fault_kind === "tool_failure" &&
      ((p > MAINT_ENTRY - 0.04 && p < MAINT_ENTRY + 0.05) ||
       (p > MAINT_EXIT - 0.02 && p < MAINT_EXIT + 0.07));
  });
  const gateOpen = cell.state === "FAULT" || maintGate;
  const stage = STAGE_OF_CELL[cell.cell_id];
  return (
    <group>
      {/* Cell 地面 + 瓶頸框 */}
      <mesh position={[cx, 0.012, 0]} rotation-x={-Math.PI / 2}
        onClick={(e) => { e.stopPropagation(); onCellClick?.(cell.name); }}>
        <planeGeometry args={[15, 17]} />
        <meshStandardMaterial color="#3e3e3a" roughness={0.9} />
      </mesh>
      {/* §46.1/46.3 Cell Sign 2.0：CELL A–D · 名稱＋狀態圓點＋獨立 Badge */}
      <CellSign x={cx} z={-9.4} letter={ZONE_LETTER[cell.cell_id]}
        name={cell.name.toUpperCase()} state={cell.state} tint={tint}
        bottleneck={cell.is_bottleneck} awaitingReset={!!cell.safety_awaiting_reset} />
      {cell.is_bottleneck && (
        <mesh position={[cx, 0.02, 0]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[8.4, 8.75, 4, 1]} />
          <meshBasicMaterial color="#c98500" transparent opacity={0.65} />
        </mesh>)}
      <Fence cx={cx} w={15} d={17} gateOpen={gateOpen}
        gateId={`GATE-${CELL_SHORT[cell.cell_id]}`} />
      <StackLight x={cx + 7.1} z={8.1} state={cell.state} />
      <Hmi x={cx - 2.6} z={8.9} ry={0} />
      <Cabinet x={cx - 6.2} z={-7.6} />
      <Cabinet x={cx - 4.7} z={-7.6} w={0.9} h={1.6} />
      <ToolRack x={cx + 5.4} z={-7.7} />
      {/* 前側只留輕量狀態字（Cell Sign 在背側；§46.2 避免資訊重複） */}
      <Label position={[cx, 5.6, 8.6]} size={0.8} color={tint} tier={1} priority={4}
        text={`${cell.name.toUpperCase()} · ${cell.state}`} />

      {cell.stations.map((st, i) => {
        const [x, z] = pos[i];
        const robot = snap.state.robots.find((r) => r.robot_id === st.robot_id)!;
        const facing = z < 0 ? -Math.PI / 2 : Math.PI / 2;   // local +x 對準治具
        const workZ = z < 0 ? z + 2.7 : z - 2.7;   // 面向 conveyor 側的工作位
        const welding = robot.cycle_state === "WELDING" && robot.status === "RUNNING";
        const capturing = ["CAPTURE_IMAGE", "INSPECTING"].includes(robot.cycle_state);
        const doorOpen = ["OPEN_MACHINE", "LOAD_MACHINE", "REMOVE_PART"].includes(robot.cycle_state);
        const fault = ["ERROR", "EMERGENCY_STOP"].includes(robot.status);
        return (
          <group key={st.station_id}>
            <RobotArm robot={robot} position={[x, 0, z]} rotationY={facing} />
            {/* 地板磨損（robot 基座周圍） */}
            <mesh position={[x, 0.014, z]} rotation-x={-Math.PI / 2}>
              <circleGeometry args={[1.15, 20]} />
              <meshBasicMaterial color="#1d1d1c" transparent opacity={0.4} />
            </mesh>
            {/* §45.12 維修情境：tool_failure → 人員由維修區走到站位（LOTO）→ 離開 */}
            {st.fault_kind === "tool_failure" &&
              <MaintenanceOperator cx={cx} station={[x, z]} progress={st.fault_progress ?? 0} />}
            {robot.status === "ERROR" && st.fault_kind !== "tool_failure" &&
              <Operator x={x + 1.6} z={z + (z < 0 ? -1.4 : 1.4)} />}
            {/* 工作範圍地面標示（§36.9；§45.7 降透明度減少雜訊） */}
            <mesh position={[x, 0.016, z]} rotation-x={-Math.PI / 2}>
              <ringGeometry args={[2.9, 3.05, 24]} />
              <meshBasicMaterial color="#6a5a10" transparent opacity={0.32} />
            </mesh>
            {cell.cell_id === "CELL-WELDING" && (
              <>
                <Fixture x={x} z={workZ} kind="weld" hasPart={!!st.current_part_id} stage="raw"
                  onSelect={st.current_part_id
                    ? () => onPartClick?.(st.current_part_id!) : undefined} />
                {/* 焊接控制器 + 焊絲桶（§45.2）+ 排煙罩 */}
                <Cabinet x={x + (z < 0 ? 2.3 : -2.3)} z={z} w={0.8} h={1.2} d={0.6} />
                <WireDrum x={x + (z < 0 ? 3.3 : -3.3)} z={z + (z < 0 ? -0.7 : 0.7)} />
                <mesh material={MAT.darkSteel} position={[x, 3.6, workZ]}>
                  <coneGeometry args={[0.9, 1.0, 4]} /></mesh>
                <mesh material={MAT.darkSteel} position={[x, 5.2, workZ]}>
                  <cylinderGeometry args={[0.18, 0.18, 2.4, 8]} /></mesh>
                {welding && <Sparks position={[x, 1.25, workZ]} withLight={firstWelder === st.station_id} />}
                {welding && firstWelder === st.station_id &&
                  <Smoke position={[x, 1.7, workZ]} />}
              </>)}
            {cell.cell_id === "CELL-ASSEMBLY" && (
              <>
                <Fixture x={x} z={workZ} kind="assembly"
                  hasPart={!!st.current_part_id} stage="welded"
                  onSelect={st.current_part_id
                    ? () => onPartClick?.(st.current_part_id!) : undefined} />
                <Feeder x={x + (x < cx ? -2.6 : 2.6)} z={z} />
                {/* Fastener bin + Torque Controller（§45.2） */}
                <mesh material={MAT.darkSteel} position={[x + (x < cx ? -2.6 : 2.6), 0.35, workZ]}>
                  <boxGeometry args={[0.7, 0.7, 0.5]} /></mesh>
                <TorqueController x={x + (x < cx ? 1.6 : -1.6)} z={workZ} />
              </>)}
            {cell.cell_id === "CELL-MACHINE_TENDING" && (
              <>
                <Cnc x={x + 4.2} z={z} ry={-Math.PI / 2}
                  doorOpen={doorOpen} machining={robot.cycle_state === "WAITING_MACHINE"}
                  fault={fault} />
                {/* Infeed/Outfeed tray + Coolant/Chip（§45.2）；點托盤=選取工件（§46） */}
                <mesh material={MAT.darkSteel} position={[x - 2.2, 0.4, z + (z < 0 ? 1.6 : -1.6)]}
                  onClick={st.current_part_id
                    ? (e) => { e.stopPropagation(); onPartClick?.(st.current_part_id!); }
                    : undefined}>
                  <boxGeometry args={[1.0, 0.8, 0.8]} /></mesh>
                <CoolantTank x={x + 4.2} z={z + (z < 0 ? -2.6 : 2.6)} />
                <ChipBin x={x + 2.3} z={z + (z < 0 ? -2.2 : 2.2)} />
              </>)}
            {cell.cell_id === "CELL-VISION_INSPECTION" && (
              <Booth x={x} z={workZ} capturing={capturing}
                onSelect={st.current_part_id
                  ? () => onPartClick?.(st.current_part_id!) : undefined} />)}
            {/* §46.4 Equipment Tag：優先序依狀態（ERROR 10 > WARN/BLOCKED 8 > 一般 2） */}
            <Label position={[x, 3.8, z]} size={0.62}
              color={fault ? "#ff8a8a" : "#a8a69e"} tier={1}
              priority={fault ? 10 : ["BLOCKED", "STARVED"].includes(robot.status) ? 8 : 2}
              text={`${st.station_id} · ${st.robot_id}`} />
          </group>
        );
      })}
      {/* §45.2 Cell 級專屬設備（每 Cell 一組） */}
      {cell.cell_id === "CELL-ASSEMBLY" && <ToolChangeRack x={cx - 6.0} z={7.2} />}
      {cell.cell_id === "CELL-VISION_INSPECTION" && (
        <>
          <CameraGantry cx={cx} />
          <PassRejectLanes cx={cx} />
          <HoldRack x={cx + 6.4} z={6.9} held={snapAll.state.parts.held} />
        </>)}
    </group>
  );
}

/* ---------------- Conveyor（在途件用分段零件模型） ---------------- */
function Conveyor({ conv }: { conv: ConveyorSnapshot }) {
  const [x1, x2] = CONV_SPAN[conv.conveyor_id];
  const len = x2 - x1;
  const off = useRef(0);
  const grp = useRef<THREE.Group>(null);
  const paused = useTwin((s) => s.paused);
  const speed = useTwin((s) => s.speed);
  useFrame((_, dt) => {
    if (!paused && conv.status === "RUNNING") off.current += dt * speed * 0.35;
    if (!grp.current) return;
    grp.current.children.forEach((c, i) => {
      const f = ((i / Math.max(1, conv.in_transit_max)) + off.current) % 1;
      c.position.x = x1 + 0.5 + f * (len - 1);
      c.visible = i < conv.item_count;
    });
  });
  const jam = conv.status === "JAMMED";
  return (
    <group>
      <ConveyorStruct x1={x1} x2={x2} status={conv.status} />
      <group ref={grp}>
        {Array.from({ length: 4 }).map((_, i) => (
          <group key={i} position={[x1, 1.15, 0]}>
            <PartMesh stage={CONV_STAGE[conv.conveyor_id]} scale={0.95} />
          </group>))}
      </group>
      <Label position={[(x1 + x2) / 2, 2.4, 0]} size={0.85} tier={1}
        color={jam ? "#d03b3b" : "#898781"}
        text={`${conv.conveyor_id} · ${conv.item_count}/${conv.in_transit_max}`} />
    </group>
  );
}

/* ---------------- AMR（§47：權威空間模型） ----------------
 * 位置與路線皆由引擎決定（snapshot.position / route / route_progress）；
 * 前端只沿權威 polyline 外插與限速平滑——不再自行推算路徑。
 * DOCKS 座標保留給 dock 佔用標記與 §46 Logistics overlay 使用。 */
/* DOCKS／DOCK_IDS 自 §50 起由 ../layout 提供（re-export 供既有 import 使用） */
export { DOCKS };
function occupiedDocks(amrs: SnapshotMessage["state"]["amrs"]): Set<string> {
  const out = new Set<string>();
  for (const a of amrs) {
    const t = a.task_type;
    const pickup = t === "FG_COLLECT" ? "finished_goods"
      : t === "INBOUND_RESTOCK" ? "receiving" : "supermarket";
    const dropoff = t === "FG_COLLECT" ? "staging"
      : t === "RAW_REPLENISH" ? "raw_material"
      : (a.task_target ?? "welding");
    if (["DOCKING_PICKUP", "LOADING", "WAITING_FOR_DOCK"].includes(a.task_state)) out.add(pickup);
    if (["DOCKING_DROPOFF", "UNLOADING"].includes(a.task_state)) out.add(dropoff);
  }
  return out;
}
/** §46.3：各 dock 的等待佇列（WAITING 中且處於 DOCKING 相位的 AMR 數）。 */
function dockQueues(amrs: SnapshotMessage["state"]["amrs"]): Map<string, number> {
  const q = new Map<string, number>();
  for (const a of amrs) {
    if (a.status !== "WAITING") continue;
    const t = a.task_type;
    let dock: string | null = null;
    if (a.task_state === "DOCKING_PICKUP")
      dock = t === "FG_COLLECT" ? "finished_goods"
        : t === "INBOUND_RESTOCK" ? "receiving" : "supermarket";
    else if (a.task_state === "DOCKING_DROPOFF")
      dock = t === "FG_COLLECT" ? "staging"
        : t === "RAW_REPLENISH" ? "raw_material" : (a.task_target ?? null);
    if (dock) q.set(dock, (q.get(dock) ?? 0) + 1);
  }
  return q;
}

/* §44.3：Control Spine 命名縮寫 */
const CELL_SHORT: Record<string, string> = {
  "CELL-WELDING": "WELD", "CELL-ASSEMBLY": "ASSY",
  "CELL-MACHINE_TENDING": "CNC", "CELL-VISION_INSPECTION": "QA",
};
/* §44.9：CCTV 實體機位（與 Cctv.tsx CAMERAS 同步；§38.2 的空間對應物） */
const CAM_POSITIONS: { pos: [number, number, number]; look: [number, number, number] }[] = [
  { pos: [-26, 7.5, 12], look: [-33, 1, 0] }, { pos: [-4, 7.5, 12], look: [-11, 1, 0] },
  { pos: [18, 7.5, 12], look: [11, 1, 0] }, { pos: [40, 7.5, 12], look: [33, 1, 0] },
  { pos: [-28, 9, 26], look: [-42, 0, 14] }, { pos: [40, 8, 14], look: [47.5, 0.5, 0] },
];

type AmrSnap = SnapshotMessage["state"]["amrs"][number];
function Amr({ amr, home, selected, onSelect }: { amr: AmrSnap; home: [number, number];
  selected?: boolean; onSelect?: (id: string) => void }) {
  const grp = useRef<THREE.Group>(null);
  const transfer = useRef<THREE.Group>(null);    // §45.6 裝卸中的 tote
  const deck = useRef<THREE.Group>(null);        // 甲板 payload
  /* §50（WareTwin 借鏡）：位置權威以 10 Hz amr_patch 串流（store.amrLive）；
   * 前端只做指數平滑追上目標，**不外插**——舊的 fMono／fRender／折線追趕全部移除。
   * 不連續（run 變更／時間回捲）→ 直接定位。 */
  const runRef = useRef<string | null | undefined>(undefined);
  const tickRef = useRef(0);
  const snapUntil = useRef(0);
  useFrame((_, dt) => {
    if (!grp.current) return;
    const s = useTwin.getState();
    const now = performance.now();
    const tick = s.amrLiveTick || (s.snap?.sim_tick ?? 0);
    if ((runRef.current !== undefined && runRef.current !== s.runId)
        || (tick > 0 && tick < tickRef.current)) snapUntil.current = now + 1500;
    runRef.current = s.runId;
    if (tick > 0) tickRef.current = tick;
    const discontinuity = now < snapUntil.current;
    const live = s.amrLive[amr.amr_id];
    const tx = live?.position?.[0] ?? amr.position?.[0] ?? home[0];
    const tz = live?.position?.[1] ?? amr.position?.[1] ?? home[1];
    const prev = grp.current.position;
    const dxT = tx - prev.x, dzT = tz - prev.z, d = Math.hypot(dxT, dzT);
    // 指數平滑（每 100 ms 收斂 ~46%）；不連續或距離 > 6 m（不可能的正常位移）→ 直接定位
    const k = discontinuity || d > 6 ? 1 : 1 - Math.pow(0.002, dt);
    const nx = prev.x + dxT * k, nz = prev.z + dzT * k;
    const dx = nx - prev.x, dz = nz - prev.z;
    if (!discontinuity && dx * dx + dz * dz > 4e-7) grp.current.rotation.y = Math.atan2(dx, dz);
    grp.current.position.set(nx, 0, nz);
    // §48 e2e 掛勾：畫面位置（驗證 Reset 不倒車＝畫面位置與權威位置一致）
    ((window as unknown as { __amrRender?: Record<string, [number, number]> }).__amrRender ??= {})[amr.amr_id] = [nx, nz];
    /* §45.6 裝卸動畫：LOADING/UNLOADING 期間 tote 沿弧線在「架邊 ↔ 甲板」移動（進度來自 10 Hz） */
    const fp = live?.phase_progress ?? amr.phase_progress ?? 0;
    const ts = live?.task_state ?? amr.task_state;
    const loading = ts === "LOADING";
    const unloading = ts === "UNLOADING";
    if (transfer.current) {
      transfer.current.visible = loading || unloading;
      if (loading || unloading) {
        const k2 = loading ? fp : 1 - fp;        // 0 = 架邊 → 1 = 甲板
        transfer.current.position.set(
          1.7 * (1 - k2), 0.18 + 0.5 * k2 + Math.sin(k2 * Math.PI) * 0.35, 0);
      }
    }
    if (deck.current) deck.current.visible = !unloading;   // 卸貨中甲板改由 transfer 表現
  });

  const glow = amr.task_state === "ERROR" || amr.traffic_state === "BLOCKED" ? "#d03b3b"
    : amr.status === "DELIVERING" || amr.status === "RETURNING" ? "#3987e5"
    : amr.status === "CHARGING" ? "#c98500"
    : amr.status === "WAITING" ? "#ec835a" : "#898781";
  const traffic = amr.traffic_state === "YIELDING" ? " · YIELD"
    : amr.traffic_state === "REROUTED" ? " · REROUTE"
    : amr.traffic_state === "BLOCKED" ? " · NO SAFE PATH" : "";
  const stateTxt = (amr.task_state === "IDLE" || amr.task_state === "CHARGING"
    ? amr.task_state
    : `${amr.task_state}${amr.task_type ? " · " + amr.task_type : ""}`) + traffic;
  return (
    <group ref={grp} position={[home[0], 0, home[1]]}
      onClick={(e) => { e.stopPropagation(); onSelect?.(amr.amr_id); }}>
      <mesh material={MAT.darkSteel} position={[0, 0.3, 0]}><boxGeometry args={[1.7, 0.42, 1.15]} /></mesh>
      <mesh material={MAT.steel} position={[0, 0.6, 0]}><boxGeometry args={[1.4, 0.18, 1.0]} /></mesh>
      {selected && <mesh position={[0, 0.08, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[1.25, 1.42, 32]} />
        <meshBasicMaterial color="#5fd2e5" transparent opacity={0.9} /></mesh>}
      {amr.carrying && <group ref={deck} position={[0, 0.7, 0]}>
        <AmrPayload kind={amr.carrying} /></group>}
      {/* §45.6 裝卸中的 tote（LOADING/UNLOADING 才可見；useFrame 定位） */}
      <group ref={transfer} visible={false}>
        <Tote kind={amr.task_type === "FG_COLLECT"
          ? (amr.task_state === "LOADING" || amr.carrying === "fg" ? "fg" : "full")
          : amr.carrying === "empty" ? "empty" : "full"} scale={1.1} />
      </group>
      <mesh position={[0, 0.07, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.95, 1.1, 24]} />
        <meshBasicMaterial color={glow} transparent opacity={0.55} /></mesh>
      <mesh position={[0.7, 0.62, 0.45]}>
        <sphereGeometry args={[0.07, 8, 8]} />
        <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={1.6} /></mesh>
      <Label position={[0, 1.7, 0]} size={0.75} color={selected ? "#5fd2e5" : "#898781"} tier={0}
        priority={selected ? 9 : amr.traffic_state && amr.traffic_state !== "CLEAR" ? 7 : 4}
        text={`${amr.amr_id} · ${stateTxt} · ${amr.battery_percent}%`} />
    </group>
  );
}

/* ---------------- 廠房環境（§36.2 / P2 部分） ---------------- */
function Building() {
  const cols: [number, number][] = [];
  for (const x of [-52, -26, 0, 26, 52]) for (const z of [-24, 24]) cols.push([x, z]);
  return (
    <group>
      {/* 結構柱 */}
      {/* (0,24) 讓位大門走道；(52,24) 讓位 §44.8 Outbound Staging */}
      {cols.filter(([x, z]) => !(z > 0 && (x === 0 || x === 52))).map(([x, z], i) => (
        <mesh key={i} material={MAT.frame} position={[x, 5.5, z]}>
          <boxGeometry args={[0.6, 11, 0.6]} /></mesh>))}
      {/* 天花板桁架 + 線型燈 + 電纜橋架（§45.11：相機高於 26 m 自動隱藏，減少總覽遮擋） */}
      <OverheadGroup>
        {[-8, 8].map((z, i) => (
          <group key={i}>
            <mesh material={MAT.frame} position={[0, 10.6, z]}>
              <boxGeometry args={[110, 0.5, 0.5]} /></mesh>
            {[-40, -20, 0, 20, 40].map((x, j) => (
              <mesh key={j} position={[x, 10.3, z]}>
                <boxGeometry args={[6, 0.08, 0.3]} />
                <meshStandardMaterial color="#eeeee6" emissive="#e4ece8"
                  emissiveIntensity={1.5} /></mesh>))}
          </group>))}
        <mesh material={MAT.darkSteel} position={[0, 9.6, -12]}>
          <boxGeometry args={[110, 0.18, 0.8]} /></mesh>
      </OverheadGroup>
      {/* 焊接排氣幹管（連四支排煙管 → 屋頂立管） */}
      <mesh material={MAT.darkSteel} position={[-33, 6.55, -4.6]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.22, 0.22, 10, 10]} /></mesh>
      <mesh material={MAT.darkSteel} position={[-33, 6.55, 4.6]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.22, 0.22, 10, 10]} /></mesh>
      <mesh material={MAT.darkSteel} position={[-38.2, 8.3, 0]} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.26, 0.26, 9.4, 10]} /></mesh>
      <mesh material={MAT.darkSteel} position={[-38.2, 9.4, 0]}>
        <cylinderGeometry args={[0.28, 0.28, 2.6, 10]} /></mesh>
      {/* 後牆（局部） */}
      <mesh position={[0, 5.5, -30]} material={MAT.frame}>
        <boxGeometry args={[116, 11, 0.4]} /></mesh>
    </group>
  );
}

function FloorMarkings() {
  return (
    <group>
      {/* AMR 輪胎痕（雙向主車道正中） */}
      {[13.4, 15.2].map((z, i) => (
        <mesh key={"t" + i} rotation-x={-Math.PI / 2} position={[-2, 0.005, z]}>
          <planeGeometry args={[100, 0.18]} />
          <meshBasicMaterial color="#1c1c1b" transparent opacity={0.55} /></mesh>))}
      {/* 人員走道（綠，dock 排與車道之間） */}
      {[12.2, 12.9].map((z, i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[0, 0.006, z]}>
          <planeGeometry args={[100, 0.28]} />
          <meshBasicMaterial color="#2e7d4f" /></mesh>))}
      {/* §47 AMR 主車道（藍，z=13.4 西行／15.2 東行；與引擎車道模型同座標） */}
      {[13.4, 15.2].map((z, i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[-2, 0.006, z]}>
          <planeGeometry args={[104, 0.24]} />
          <meshBasicMaterial color="#2a5d9f" /></mesh>))}
      {/* §47 備援走廊（改道 bypass；淡藍虛線感） */}
      {[17.0, 18.8].map((z, i) => (
        <mesh key={"b" + i} rotation-x={-Math.PI / 2} position={[-2, 0.006, z]}>
          <planeGeometry args={[104, 0.18]} />
          <meshBasicMaterial color="#2a5d9f" transparent opacity={0.38} /></mesh>))}
      {/* Restricted（黃黑斜紋，MT 後方） */}
      {Array.from({ length: 10 }).map((_, i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} rotation-z={Math.PI / 4}
          position={[7 + i * 0.9, 0.007, 9.8]}>
          <planeGeometry args={[1.6, 0.22]} />
          <meshBasicMaterial color={i % 2 ? "#b98a10" : "#1a1a18"} /></mesh>))}
      {/* Fire zone（紅框，前側走道外） */}
      <lineSegments position={[47, 0.02, -13.5]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(4, 3).rotateX(-Math.PI / 2)]} />
        <lineBasicMaterial color="#d03b3b" />
      </lineSegments>
      {/* 疏散方向（綠色箭頭） */}
      {[-40, 0, 40].map((x, i) => (
        <mesh key={i} position={[x, 0.01, 12.4]} rotation-x={-Math.PI / 2}
          rotation-z={Math.PI / 2}>
          <coneGeometry args={[0.35, 0.8, 3]} />
          <meshBasicMaterial color="#2e7d4f" /></mesh>))}
    </group>
  );
}

/* ---------------- 場景組裝 ---------------- */
export function SceneContents({ snap, onCellClick, onPartClick, overlay = "none",
  energyByCell, demandPct = 0, selectedAmr = null, onAmrSelect }:
  { snap: SnapshotMessage; onCellClick?: (name: string) => void;
    onPartClick?: (id: string) => void; overlay?: string;
    energyByCell?: Record<string, { kw: number }> | null; demandPct?: number;
    selectedAmr?: string | null; onAmrSelect?: (id: string) => void }) {
  const st = snap.state;
  const reworkOcc = st.rework_buffer.occupancy;
  return (
    <group>
      {/* §45.1：低強度環境光＋主方向光＋局部補光；地面深灰不用純黑 */}
      <ambientLight intensity={1.25} />
      <hemisphereLight args={["#96a0ac", "#3a3a34", 0.85]} />
      <directionalLight position={[30, 40, 20]} intensity={2.1} />
      <directionalLight position={[-30, 25, -20]} intensity={0.95} />
      <pointLight position={[-46, 7, 25]} intensity={55} distance={26} decay={2}
        color="#dfe8f0" />                                   {/* Supermarket 局部照明 */}
      <pointLight position={[0, 6, -19]} intensity={40} distance={22} decay={2}
        color="#f0e8d8" />                                   {/* Maintenance 工作燈 */}
      <pointLight position={[38, 6.5, -18]} intensity={30} distance={20} decay={2}
        color="#f0e0e0" />                                   {/* Quarantine（R2 後區補光） */}
      <pointLight position={[-24, 6.5, -24]} intensity={30} distance={20} decay={2}
        color="#dfe8f0" />                                   {/* Utilities（R2 後區補光） */}
      <pointLight position={[-55, 7, 4]} intensity={35} distance={20} decay={2}
        color="#dfe8f0" />                                   {/* Receiving 門口 */}
      <pointLight position={[55, 7, 20]} intensity={35} distance={20} decay={2}
        color="#dfe8f0" />                                   {/* Shipping 門口 */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]}>
        <planeGeometry args={[120, 64]} />
        <meshStandardMaterial color="#373733" roughness={0.95} />
      </mesh>
      {/* AMR Lane 低亮度帶狀照明（emissive 條，貼近車道） */}
      <mesh rotation-x={-Math.PI / 2} position={[-2, 0.004, 16.4]}>
        <planeGeometry args={[104, 3.0]} />
        <meshStandardMaterial color="#2e3a44" emissive="#243642"
          emissiveIntensity={0.55} /></mesh>
      <Building />
      <FloorMarkings />
      <LabelManager />
      {st.cells.map((c) => <Cell key={c.cell_id} cell={c} onCellClick={onCellClick}
        onPartClick={onPartClick} />)}
      {st.conveyors.map((c) => <Conveyor key={c.conveyor_id} conv={c} />)}

      {/* Raw / Finished / Rework Buffer Slot（§36.7 水位 = Twin State） */}
      <BufferSlots x={-47.5} z={0} cols={6} cap={60} occ={st.raw_buffer.occupancy}
        stage="raw" label={`RAW ${st.raw_buffer.occupancy}/60 · reorder ${st.raw_buffer.reorder_point}`} />
      <BufferSlots x={47.5} z={0} cols={4} cap={12}
        occ={Math.min(12, st.finished_buffer.occupancy)} stage="good"
        label={`FINISHED ${st.finished_buffer.occupancy}`} />
      <BufferSlots x={33} z={11.5} cols={5} cap={10} occ={reworkOcc}
        stage="reject" label={`REWORK ${reworkOcc}/10`} />
      {/* Cell 間 Buffer Slot */}
      <BufferSlots x={-16.2} z={2.9} cols={4}
        cap={8} occ={st.cells[1].input_buffer.occupancy} stage="welded" label="BUF W→A" />
      <BufferSlots x={5.8} z={2.9} cols={4}
        cap={8} occ={st.cells[2].input_buffer.occupancy} stage="assembled" label="BUF A→M" />
      <BufferSlots x={27.8} z={2.9} cols={3}
        cap={6} occ={st.cells[3].input_buffer.occupancy} stage="machined" label="BUF M→I" />

      {/* §39/§44.2 Intralogistics：Per-SKU Supermarket / Cell Rack / Staging / Dock */}
      <SupermarketSku x={-46} z={25.5} perSku={st.supermarket.per_sku}
        empties={st.supermarket.empties} />
      {st.racks.map((r) => (
        <Rack key={r.rack_id} x={CELL_X[r.cell_id] - 8} z={8.8} qty={r.qty}
          capacity={r.capacity} low={r.material_low} sku={r.sku}
          label={`${r.qty}/${r.capacity}${r.qty <= 0 ? " · STOCKOUT"
            : r.material_low ? " · LOW" : r.reserved ? " · en route" : ""}`} />))}
      <PalletStaging x={52} z={21} units={st.staging.units}
        stage={st.staging.outbound_stage} progress={st.staging.outbound_progress}
        palletSize={st.staging.pallet_size} palletsPerTruck={st.staging.pallets_per_truck}
        outboundTotal={st.staging.outbound_total} />
      {(() => {
        const occ2 = occupiedDocks(st.amrs);
        const queue = dockQueues(st.amrs);          // §46.3 站點 Queue（WAITING_FOR_DOCK）
        return (Object.keys(DOCKS) as (keyof typeof DOCKS)[]).map((k) => {
          const [dx, dz] = DOCKS[k];
          return <DockBay key={k} x={dx} z={dz} id={DOCK_IDS[k]}
            occupied={occ2.has(k)} queue={queue.get(k) ?? 0}
            arrowRy={dz > 12 ? 0 : Math.PI} />;
        });
      })()}

      {/* AMR + 充電站（§44.7 接觸板 + 禁停面） */}
      {st.amrs.map((a) => (
        <Amr key={a.amr_id} amr={a} home={AMR_HOMES[a.amr_id] ?? [-40, 20.8]}
          selected={selectedAmr === a.amr_id} onSelect={onAmrSelect} />))}
      {/* §48：權威路線視覺化（Logistics overlay 全部；否則只畫選取的 AMR） */}
      <AmrRoutes amrs={st.amrs} showAll={overlay === "logistics"} selected={selectedAmr} />
      {/* §51：感知層（選取 → 扇形＋射線；未選取但讓行中 → 前方紅弧） */}
      <AmrPerceptionLayer amrIds={st.amrs.map((a) => a.amr_id)} selected={selectedAmr} />
      {/* §48：空間障礙物（有座標／半徑／剩餘時間；AMR 規劃繞開） */}
      {(st.obstacles ?? []).map((ob) => (
        <ZoneObstacle key={ob.obstacle_id} ob={ob} />))}
      {CHARGING_PADS.map(([x, z], i) => <ChargingPad key={i} x={x} z={z}
        active={st.facility.charger.state === "CHARGING"} />)}
      <Label position={[CHARGING_PADS[0][0] + 2, 2.6, CHARGING_PADS[0][1]]} size={0.8} color="#898781" text="CHARGING" tier={1} />

      {/* §44.3–44.5 後區：Control Spine / Maintenance / Quarantine / Utilities */}
      {st.cells.map((c) => (
        <ControlSpine key={c.cell_id} cx={CELL_X[c.cell_id]}
          short={CELL_SHORT[c.cell_id]} state={c.state} />))}
      <MaintenanceArea x={0} z={-19} />
      <QuarantineCage x={40} z={-18} held={st.rework_buffer.occupancy}
        scrap={st.parts.scrap} />
      {/* §45.8 廠務設備：狀態燈／壓力表／風扇／負載條＋hover tooltip（全由 facility 推導） */}
      <UtilityZoneLive x={-24} z={-26.5} f={st.facility as never} />
      <FumeStatus x={-38.2} z={1.4} unit={st.facility.fume_extraction as never} />
      <AirPipe fromX={-27.2} toX={-33} z={-28.5} />

      {/* §44.9 Overhead：CCTV 機位 / Andon / EXIT；§44.8 收出貨門 */}
      {CAM_POSITIONS.map((c, i) => <CctvProp key={i} pos={c.pos} look={c.look} />)}
      <AndonBoard x={0} z={-10.2}
        line1={`GOOD ${st.kpis.good_units}/${st.kpis.target_good_units} · ${st.kpis.throughput_uph} UPH · OEE ${(st.kpis.oee.oee * 100).toFixed(1)}%`}
        line2={(st.cells.find((c) => c.is_bottleneck)
          ? `BOTTLENECK ${st.cells.find((c) => c.is_bottleneck)!.name.toUpperCase()}` : "NO BOTTLENECK")
          + ` · ALERTS ${st.alerts.length}`}
        line3={`AMR PENDING ${st.amr_kpis.pending_tasks} · SAFETY ${
          st.cells.some((c) => c.stations.some((x) => x.fault_kind === "safety_gate")) ? "GATE OPEN — STOP"
          : st.facility.compressor.state === "FAULT" ? "UTILITY FAULT" : "NORMAL"}`}
        alert={st.alerts.length > 0} />
      {/* §45.9 側區大標牌 */}
      <ZoneSign x={0} z={-10.2} y={9.9} text="PRODUCTION LINE 01" tint="#e8e8e0" w={12} />
      <ZoneSign x={-46} z={22.4} y={6.6} text="MATERIAL SUPERMARKET" tint="#9fc4ff" w={11} />
      <ZoneSign x={-57.3} z={4} y={8.6} ry={Math.PI / 2} text="RECEIVING" tint="#9fc4ff" w={7} />
      <ZoneSign x={57.3} z={21} y={8.6} ry={-Math.PI / 2} text="SHIPPING" tint="#7fd2a8" w={7} />
      <ZoneSign x={33} z={14.2} y={6.2} text="REWORK / QUALITY HOLD" tint="#e0b070" w={9} />
      {/* §45.3/45.4 簡化車尾（只在有車時） */}
      <TruckTail x={58.6} z={21} ry={-Math.PI / 2} visible={st.staging.outbound_stage !== "IDLE"}
        label={st.staging.shipment_id ?? "TRUCK"} />
      <TruckTail x={-58.6} z={4} ry={Math.PI / 2}
        visible={["ARRIVED", "DOOR_OPENING", "UNLOADING"].includes(st.receiving.stage)}
        label={st.receiving.truck_id ?? "INBOUND"} />
      <SideWallDoor x={58} z={21} label="OUTBOUND" tint="#199e70"
        open={st.staging.door_open} />
      <SideWallDoor x={-58} z={4} label="RECEIVING" tint="#3987e5"
        open={st.receiving.door_open} />
      <ExitSign x={-56.5} z={12} />
      <ExitSign x={56.5} z={10.5} />

      {/* §45.3/45.4 收出貨閉環（狀態=snapshot） */}
      <ReceivingZone x={-53} z={5} stage={st.receiving.stage}
        sku={st.receiving.sku ?? null}
        qty={st.receiving.qty} truckId={st.receiving.truck_id ?? null} />
      {/* §46.6 Overlays（一次一種；資料=權威 snapshot / energy breakdown） */}
      {overlay === "energy" && energyByCell && (
        <EnergyHeatmap byCell={energyByCell} demandPct={demandPct} />)}
      {overlay === "logistics" && (
        <LogisticsOverlay docks={Object.values(DOCKS) as [number, number][]} />)}
      {overlay === "safety" && (
        <SafetyOverlay
          cells={st.cells.map((c) => ({ cx: CELL_X[c.cell_id],
            awaiting: !!c.safety_awaiting_reset }))}
          estops={st.cells.map((c) => [CELL_X[c.cell_id] + 1.7, 8.65] as [number, number])} />)}
      {overlay === "flow" && <FlowOverlay />}
      <OutboundStatus x={46.8} z={19.5} stage={st.staging.outbound_stage}
        shipmentId={st.staging.shipment_id ?? null}
        palletsReady={Math.floor(st.staging.units / st.staging.pallet_size)}
        palletsPerTruck={st.staging.pallets_per_truck} />

      {/* 周邊道具（§36.10：集中、不擋走道） */}
      <Cabinet x={-52} z={-8} w={2.2} h={2.2} />
      <Cabinet x={-52} z={-5} w={2.2} h={2.2} />
      <mesh material={MAT.hazard} position={[52, 0.5, -8]}><boxGeometry args={[1.1, 1.0, 1.1]} /></mesh>
      <mesh position={[52, 0.4, -5.5]}>
        <cylinderGeometry args={[0.16, 0.16, 0.8, 8]} />
        <meshStandardMaterial color="#a03030" /></mesh>
      <MaintCart x={-46} z={9.5} ry={0.4} />
      {/* （§45.3：原裝飾用 pallets 移除 — 收貨區棧板改由 receiving 狀態驅動） */}
    </group>
  );
}

/* §51：AMR 卡片的感知列（10 Hz amrLive）與最近一筆派工紀錄（snapshot） */
function AmrPerceptionRows({ amrId }: { amrId: string }) {
  const T = useT();
  const per = useTwin((s) => s.amrLive[amrId]?.perception);
  if (!per) return null;
  return (
    <>
      <div className="pkv">{T("sc.perception")} <b className={"pc-" + per.state.toLowerCase()}>
        {per.state} · {T("sc.ahead")} {per.ahead_m == null ? T("sc.clear") : `${per.ahead_m.toFixed(1)} m`}
        {` · safe/clear/stop ${per.safe_m}/${per.clear_m}/${per.hard_stop_m} m`}</b></div>
      {per.obstacles.length > 0 && (
        <div className="pkv">{T("sc.sensed")} <b>{per.obstacles.map((o) =>
          `${o.id} ${o.distance_m.toFixed(1)} m${o.ref === "edge" ? T("sc.edge") : ""} @ ${o.bearing_deg > 0 ? "L" : o.bearing_deg < 0 ? "R" : ""}${Math.abs(o.bearing_deg).toFixed(0)}°`).join(" · ")}</b></div>)}
    </>);
}
type Decision = NonNullable<SnapshotMessage["state"]["dispatch_decisions"]>[number];
function AmrDecisionRow({ amrId, decisions }: { amrId: string; decisions: Decision[] }) {
  const T = useT();
  const d = [...decisions].reverse().find((x) => x.chosen === amrId
    || x.candidates.some((c) => c.amr_id === amrId));
  if (!d) return null;
  const me = d.candidates.find((c) => c.amr_id === amrId);
  return (
    <>
      <div className="pkv">{T("sc.dispatch")} <b>{d.decision_id} · {d.task_id} · {d.task_type}</b></div>
      <div className="dnote">{d.chosen === amrId ? d.reason
        : T("sc.notChosen", { id: amrId, r: me?.rejected_reason ?? "—" })}</div>
    </>);
}

export function FactoryScene() {
  const T = useT();
  const lang = useLang((s) => s.lang);
  const snap = useTwin((s) => s.snap);
  const mode = useTwin((s) => s.renderMode);
  const sel = useTwin((s) => s.selectedRobot);
  const [preset, setPreset] = useState<string | null>("Overview");
  const fpsEl = useRef<HTMLDivElement>(null);
  const [labelsMode, setLabelsModeState] = useState<LabelsMode>(getLabelsMode());
  const [overlay, setOverlay] = useState("none");             // §46.6 Overlay
  const [selPart, setSelPart] = useState<string | null>(null);
  const [selAmr, setSelAmr] = useState<string | null>(null);      // §48 點選 AMR → 路線與狀態
  useEffect(() => {                                                // e2e 掛勾（§51：無頭環境點選 3D 物件不可靠）
    (window as unknown as { __selectAmr?: (id: string | null) => void }).__selectAmr = setSelAmr;
  }, []);
  const resetting = useTwin((s) => s.resetting);                    // §49 重建期間畫面凍結覆蓋
  const [partData, setPartData] = useState<Record<string, unknown> | null>(null);
  const [energyBd, setEnergyBd] = useState<Record<string, unknown> | null>(null);
  const [tour, setTour] = useState<number | null>(null);      // §45.11 Cinematic Tour index
  const cycleLabels = () => {
    const order: LabelsMode[] = ["auto", "all", "alerts", "off"];
    const next = order[(order.indexOf(getLabelsMode()) + 1) % order.length];
    setLabelsMode(next); setLabelsModeState(next);
  };
  useEffect(() => {                                             // L 鍵循環標籤模式；T 鍵 Tour
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "l" || e.key === "L") cycleLabels();
      if (e.key === "t" || e.key === "T") setTour((t) => (t === null ? 0 : null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {                                             // §46 Part Trace 輪詢（1 Hz）
    if (!selPart) { setPartData(null); return; }
    let dead = false;
    const load = async () => {
      const d = await getJson(`/api/parts/${selPart}`);
      if (!dead) setPartData(d);
    };
    load();
    const id = setInterval(load, 1000);
    return () => { dead = true; clearInterval(id); };
  }, [selPart]);
  useEffect(() => {                                             // §46 Energy overlay 資料（5 s）
    if (overlay !== "energy") return;
    let dead = false;
    const load = async () => {
      const d = await getJson("/api/energy/breakdown");
      if (!dead) setEnergyBd(d);
    };
    load();
    const id = setInterval(load, 5000);
    return () => { dead = true; clearInterval(id); };
  }, [overlay]);
  useEffect(() => {                                             // Tour：依序飛、定時前進
    if (tour === null) return;
    setPreset(TOUR[tour % TOUR.length]);
    const id = setTimeout(() => setTour((t) => (t === null ? null : t + 1)), TOUR_DWELL_MS);
    return () => clearTimeout(id);
  }, [tour]);
  const flyRequest = useTwin((s) => s.flyRequest);
  const firstFly = useRef(true);
  useEffect(() => {
    if (firstFly.current) { firstFly.current = false; return; }   // 初始載入不飛
    if (flyRequest) setPreset("FlyTo");
  }, [flyRequest]);
  const flyTarget = useTwin((s) => s.flyTarget);
  const followPos = useMemo<[number, number] | null>(() => {
    if (flyTarget) return flyTarget;                 // §46 CCTV 反向定位
    if (!snap) return null;
    for (const c of snap.state.cells) {
      const i = c.stations.findIndex((st) => st.robot_id === sel);
      if (i >= 0) return robotWorldPos(c.cell_id, i, c.stations.length);
    }
    return null;
  }, [snap, sel, flyTarget]);
  const dpr: [number, number] = mode === "high" ? [1, 2] : mode === "balanced" ? [1, 1.25] : [0.7, 0.8];
  if (!snap) return <div className="scene-loading">{T("sc.connecting")}</div>;
  const bottleneckCell = snap.state.cells.find((c) => c.is_bottleneck);
  const presetNames = [...Object.keys(PRESETS), "Bottleneck", "Follow"];
  return (
    <div className="c3dwrap">
      <Canvas dpr={dpr} camera={{ position: [0, 46, 33], fov: 48 }}
        gl={{ antialias: mode !== "performance", powerPreference: "high-performance" }}>
        <color attach="background" args={["#1a1a19"]} />
        <fog attach="fog" args={["#1a1a19", 130, 240]} />
        <SceneContents snap={snap}
          onCellClick={(name) => { setTour(null); setPreset(PRESETS[name] ? name : "Overview"); }}
          onPartClick={(id) => setSelPart(id)}
          selectedAmr={selAmr}
          onAmrSelect={(id) => setSelAmr((cur) => (cur === id ? null : id))}
          overlay={overlay}
          energyByCell={(energyBd as { by_cell?: Record<string, { kw: number }> } | null)?.by_cell ?? null}
          demandPct={snap ? 100 * snap.state.kpis.energy_kw_current / Math.max(1, snap.state.kpis.demand_limit_kw) : 0} />
        <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.12} minDistance={6}
          maxDistance={130} target={[0, 0, 0]} onStart={() => setTour(null)} />
        <CameraRig preset={preset} onArrive={() => setPreset(null)} followPos={followPos} />
        <FpsMeter el={fpsEl} />
      </Canvas>
      <div className="fpsbadge" ref={fpsEl}>— FPS</div>
      {resetting && (
        <div className="resetveil">
          <div className="rv"><span className="spin">⟲</span> {T("sc.rebuilding")}
            <small>{T("sc.rebuildingSub")}</small></div>
        </div>)}
      {selAmr && snap && (() => {
        const a = snap.state.amrs.find((x) => x.amr_id === selAmr);
        if (!a) return null;
        const route = a.route ?? [];
        const end = route.length ? route[route.length - 1] : a.position;
        return (
          <div className="partcard amrcard">
            <div className="ph"><b>{a.amr_id}</b>
              <button onClick={() => setSelAmr(null)}>✕</button></div>
            <div className="pkv">{T("sc.state")} <b>{a.task_state}{a.task_type ? " · " + a.task_type : ""}</b></div>
            <div className="pkv">{T("sc.traffic")} <b className={"tr-" + (a.traffic_state ?? "CLEAR").toLowerCase()}>
              {a.traffic_state === "BLOCKED" ? T("sc.blocked") : a.traffic_state ?? "CLEAR"}</b></div>
            <div className="pkv">{T("sc.position")} <b>({a.position[0].toFixed(1)}, {a.position[1].toFixed(1)})</b></div>
            <div className="pkv">{T("sc.route")} <b>{route.length
              ? T("sc.routeVal", { n: route.length, x: end[0].toFixed(1), z: end[1].toFixed(1), p: Math.round((a.route_progress ?? 0) * 100) })
              : T("sc.docked")}</b></div>
            <div className="pkv">{T("sc.battery")} <b>{a.battery_percent}%</b>
              {a.carrying && <>{T("sc.carrying")}<b>{a.carrying}</b></>}</div>
            <AmrPerceptionRows amrId={a.amr_id} />
            <AmrDecisionRow amrId={a.amr_id} decisions={snap.state.dispatch_decisions ?? []} />
            <div className="pkv muted">{T("sc.amrNote")}</div>
          </div>);
      })()}
      {selPart && (
        <div className="partcard">
          <div className="ph"><b>{selPart}</b>
            <button onClick={() => setSelPart(null)}>✕</button></div>
          {partData ? (
            <>
              <div className="proute">
                {(partData.route as { operation: string; status: string }[]).map((r) => (
                  <span key={r.operation} className={"pstep " + r.status.toLowerCase()}>
                    {r.operation.slice(0, 4)}</span>))}
              </div>
              <div className="pkv">{T("sc.lifecycle")} <b>{String(partData.lifecycle_state)}</b></div>
              <div className="pkv">{T("sc.quality")} <b>{String(partData.quality_state)}</b></div>
              <div className="pkv">{T("sc.location")} <b>{(partData.location as { type: string; id: string }).type}
                · {(partData.location as { type: string; id: string }).id}</b></div>
              <div className="pkv">{T("sc.age")} <b>{String(partData.age_sec)} s</b></div>
              <div className="pkv">{T("sc.carrier")} <b>{partData.carrier ? String(partData.carrier) : T("sc.batch")}</b></div>
            </>
          ) : (
            <div className="pkv">{useTwin.getState().mode === "LOCAL_DEMO"
              ? T("live.required") : T("sc.loading")}</div>)}
        </div>)}
      <div className="campresets">
        <button className={tour !== null ? "on" : ""} title={T("sc.tourTitle")}
          onClick={() => setTour((t) => (t === null ? 0 : null))}>
          {tour !== null ? T("sc.tourStop") : T("sc.tourStart")}</button>
        <button className={labelsMode === "off" ? "off" : labelsMode !== "auto" ? "on" : ""}
          title={T("sc.labelsTitle")} onClick={cycleLabels}>
          {T("sc.labels", { m: T(`sc.l.${labelsMode}` as TKey) })}</button>
        {(["none", "energy", "logistics", "safety", "flow"] as const).map((k) => (
          <button key={k} className={overlay === k ? "on" : ""} title={T("sc.overlay", { t: T(`sc.o.${k}` as TKey) })}
            onClick={() => setOverlay(k)}>{k === "none" ? "◻" : T(`sc.o.${k}` as TKey)}</button>))}
        {presetNames.map((n) => (
          <button key={n} onClick={() => {
            setTour(null);
            if (n === "Bottleneck" && bottleneckCell) {
              const nm = bottleneckCell.name === "Machine Tending" ? "Machine Tending"
                : bottleneckCell.name;
              setPreset(PRESETS[nm] ? nm : "Overview");
            } else setPreset(n);
          }}>{tOpt(lang, `sc.p.${n}`, n)}</button>))}
      </div>
    </div>
  );
}
