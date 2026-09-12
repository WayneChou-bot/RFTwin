/** §45.8–45.12 元件：大型 Zone Sign、簡化車尾、廠務設備狀態（tooltip）、
 *  高空隱藏的屋頂結構、維修人員情境動畫。狀態全部由 snapshot 推導。 */
import { useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { Label } from "./Label";
import { MAT } from "./SceneProps";

/* ---------------- §45.9 大型實體 Zone Sign（吊掛板，遠景可讀） ---------------- */
export function ZoneSign({ x, z, y = 7.2, ry = 0, text, tint = "#e8e8e0", w = 9 }: {
  x: number; z: number; y?: number; ry?: number; text: string; tint?: string; w?: number;
}) {
  return (
    <group position={[x, y, z]} rotation-y={ry}>
      {[-w / 2 + 0.5, w / 2 - 0.5].map((dx, i) => (
        <mesh key={i} material={MAT.frame} position={[dx, 1.6, 0]}>
          <boxGeometry args={[0.1, 2.2, 0.1]} /></mesh>))}
      <mesh material={MAT.darkSteel}>
        <boxGeometry args={[w, 1.3, 0.16]} /></mesh>
      <mesh position={[0, 0, 0.09]}>
        <boxGeometry args={[w - 0.3, 1.0, 0.02]} />
        <meshStandardMaterial color="#1c1c1a" emissive={tint} emissiveIntensity={0.12} /></mesh>
      <Label position={[0, 0, 0.16]} size={1.35} color={tint} text={text} tier={0} priority={5} />
    </group>
  );
}

/* ---------------- §45.3/45.4 簡化車尾（門外；只在有車時出現） ---------------- */
export function TruckTail({ x, z, ry = 0, visible, label }: {
  x: number; z: number; ry?: number; visible: boolean; label: string;
}) {
  if (!visible) return null;
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      {/* 月台地面 + 車廂（只看到尾端）+ 輪 + 保險桿 + 尾燈 */}
      <mesh position={[0, 0.005, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[7, 9]} />
        <meshStandardMaterial color="#2c2c29" roughness={0.95} /></mesh>
      <mesh position={[0, 2.35, -3.2]}>
        <boxGeometry args={[4.4, 3.2, 6.4]} />
        <meshStandardMaterial color="#c9cbc8" metalness={0.2} roughness={0.6} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 0.72, -0.05]}>
        <boxGeometry args={[4.5, 0.25, 0.3]} /></mesh>
      {[-1.6, 1.6].map((dx, i) => (
        <mesh key={i} position={[dx, 0.55, -1.2]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.55, 0.55, 0.5, 14]} />
          <meshStandardMaterial color="#1e1e1c" roughness={0.9} /></mesh>))}
      {[-1.9, 1.9].map((dx, i) => (
        <mesh key={"t" + i} position={[dx, 1.05, 0.02]}>
          <boxGeometry args={[0.3, 0.18, 0.04]} />
          <meshStandardMaterial color="#d03b3b" emissive="#d03b3b" emissiveIntensity={1.5} /></mesh>))}
      <Label position={[0, 4.4, 0]} size={0.6} color="#c3c2b7" text={label} tier={1} />
    </group>
  );
}

/* ---------------- §45.8 廠務設備（狀態燈 + tooltip + 能耗） ---------------- */
type Unit = { asset_id: string; state: string; kw?: number; kwh?: number } & Record<string, unknown>;
export type Facility = {
  compressor: Unit; hvac: Unit; fume_extraction: Unit; mdp: Unit; charger: Unit;
};
const STATE_COLOR: Record<string, string> = {
  RUNNING: "#0ca30c", CHARGING: "#0ca30c", IDLE: "#c98500", STANDBY: "#c98500",
  FAULT: "#d03b3b",
};

function Tooltip({ unit, extra }: { unit: Unit; extra: string[] }) {
  return (
    <Html position={[0, 3.4, 0]} center distanceFactor={16} style={{ pointerEvents: "none" }}>
      <div className="tip3d">
        <b>{unit.asset_id}</b> <span style={{ color: STATE_COLOR[unit.state] ?? "#c3c2b7" }}>
          {unit.state}</span>
        {unit.kw !== undefined && <div>{unit.kw} kW now · {unit.kwh ?? 0} kWh shift</div>}
        {extra.map((e, i) => <div key={i}>{e}</div>)}
      </div>
    </Html>
  );
}

function HoverGroup({ unit, extra, children, position }: {
  unit: Unit; extra: string[]; children: React.ReactNode; position: [number, number, number];
}) {
  const [hover, setHover] = useState(false);
  return (
    <group position={position}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
      onPointerOut={() => setHover(false)}>
      {children}
      {hover && <Tooltip unit={unit} extra={extra} />}
    </group>
  );
}

function StatusLamp({ state, position }: { state: string; position: [number, number, number] }) {
  const c = STATE_COLOR[state] ?? "#5b5b56";
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.1, 8, 8]} />
      <meshStandardMaterial color={c} emissive={c} emissiveIntensity={2} /></mesh>
  );
}

export function UtilityZoneLive({ x, z, f }: { x: number; z: number; f: Facility }) {
  const comp = f.compressor, hv = f.hvac, mdp = f.mdp;
  const pressure = Number(comp.pressure_bar ?? 0);
  const needle = -1.9 + (pressure / 8) * 2.6;           // 0 → -110°、8 bar → +40°
  const fanRef = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {                                   // HVAC 風扇轉速 ∝ 負載
    if (fanRef.current) fanRef.current.rotation.z += dt * 2.5 * (Number(hv.cooling_load_pct ?? 0) / 100);
  });
  const compTint = comp.state === "FAULT" ? "#d03b3b" : "#5e9ea0";
  return (
    <group position={[x, 0, z]}>
      {/* Air compressor：臥式儲氣槽 + 馬達 + 壓力表（指針=權威壓力） */}
      <HoverGroup unit={comp} position={[-3.2, 0, 0]}
        extra={[`pressure ${pressure.toFixed(2)} bar · ${comp.active_welders} welder(s) drawing`,
          ...(comp.state === "FAULT" ? [`repair in ${comp.repair_remaining_sec}s — welding stopped`] : [])]}>
        <mesh material={MAT.steel} position={[0, 0.95, 0]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.75, 0.75, 3.2, 16]} /></mesh>
        {[-1.1, 1.1].map((dx, i) => (
          <mesh key={i} material={MAT.frame} position={[dx, 0.25, 0]}>
            <boxGeometry args={[0.25, 0.5, 1.2]} /></mesh>))}
        <mesh material={MAT.darkSteel} position={[0.6, 1.95, 0]}>
          <boxGeometry args={[1.1, 0.7, 0.8]} /></mesh>
        <group position={[-0.8, 1.95, 0]}>
          <mesh rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.2, 0.2, 0.08, 12]} />
            <meshStandardMaterial color="#e8e8e0" /></mesh>
          <mesh position={[0, 0, 0.05]} rotation-z={needle}>
            <boxGeometry args={[0.03, 0.17, 0.01]} />
            <meshBasicMaterial color="#d03b3b" /></mesh>
        </group>
        <StatusLamp state={comp.state} position={[1.15, 2.15, 0.3]} />
        <Label position={[0, 2.85, 0]} size={0.55} color={compTint} tier={1}
          text={`AIR COMPRESSOR · ${comp.state} · ${pressure.toFixed(1)} bar · ${comp.kw} kW`} />
      </HoverGroup>
      {/* HVAC / chiller：機箱 + 風扇（轉速=負載）+ 屋頂風管 */}
      <HoverGroup unit={hv} position={[3.6, 0, 0]}
        extra={[`cooling load ${hv.cooling_load_pct}% · supply ${hv.supply_temp_c} °C`]}>
        <mesh material={MAT.cabinet} position={[0, 1.25, 0]}>
          <boxGeometry args={[3.2, 2.5, 1.6]} /></mesh>
        {[-0.8, 0.8].map((dx, i) => (
          <mesh key={i} position={[dx, 1.55, 0.81]}>
            <torusGeometry args={[0.45, 0.06, 8, 18]} />
            <meshStandardMaterial color="#3a3a38" /></mesh>))}
        <mesh ref={fanRef} position={[-0.8, 1.55, 0.83]}>
          <boxGeometry args={[0.7, 0.08, 0.02]} />
          <meshStandardMaterial color="#8a8a80" /></mesh>
        <mesh material={MAT.darkSteel} position={[0.8, 1.55, 0.8]}>
          <cylinderGeometry args={[0.4, 0.4, 0.04, 12]} /></mesh>
        <mesh material={MAT.darkSteel} position={[0, 3.4, -0.3]}>
          <boxGeometry args={[0.8, 1.8, 0.8]} /></mesh>
        <StatusLamp state={hv.state} position={[1.4, 2.35, 0.82]} />
        <Label position={[0, 3.1, 0.6]} size={0.55} color="#7d8fc9" tier={1}
          text={`HVAC · ${hv.cooling_load_pct}% · ${hv.kw} kW`} />
      </HoverGroup>
      {/* 配電盤（MDP）：總負載 */}
      <HoverGroup unit={mdp} position={[8.2, 0, -0.3]}
        extra={[`plant load ${mdp.load_pct}% of demand limit · lighting ${mdp.lighting_kw} kW`]}>
        <mesh material={MAT.cabinet} position={[0, 1.05, 0]}>
          <boxGeometry args={[2.0, 2.1, 0.55]} /></mesh>
        <mesh position={[0, 1.7, 0.29]}>
          <boxGeometry args={[0.4, 0.4, 0.02]} />
          <meshStandardMaterial color="#b98a10" /></mesh>
        {/* 負載條 */}
        <mesh position={[0, 0.9, 0.29]}>
          <boxGeometry args={[1.4, 0.12, 0.02]} />
          <meshBasicMaterial color="#2a2a28" /></mesh>
        <mesh position={[-0.7 + (1.4 * Number(mdp.load_pct ?? 0)) / 200, 0.9, 0.3]}>
          <boxGeometry args={[(1.4 * Number(mdp.load_pct ?? 0)) / 100, 0.12, 0.02]} />
          <meshBasicMaterial color={Number(mdp.load_pct ?? 0) > 90 ? "#d03b3b" : "#0ca30c"} /></mesh>
        <StatusLamp state={mdp.state} position={[0.8, 1.95, 0.3]} />
        <Label position={[0, 2.6, 0]} size={0.5} color="#898781" tier={2}
          text={`MDP-01 · ${mdp.kw} kW · ${mdp.load_pct}%`} />
      </HoverGroup>
    </group>
  );
}

/** 排煙幹管狀態燈（焊接時運轉）——掛在原有排氣立管旁。 */
export function FumeStatus({ x, z, unit }: { x: number; z: number; unit: Unit }) {
  return (
    <HoverGroup unit={unit} position={[x, 0, z]}
      extra={[`${unit.active_hoods} hood(s) active`]}>
      <mesh material={MAT.darkSteel} position={[0, 7.6, 0]}>
        <boxGeometry args={[0.7, 0.5, 0.7]} /></mesh>
      <StatusLamp state={unit.state} position={[0.45, 7.95, 0]} />
      <Label position={[0, 8.5, 0]} size={0.5} color="#8a9a8a" tier={2}
        text={`FUME-01 · ${unit.state}`} />
    </HoverGroup>
  );
}

/* ---------------- §45.11 高空隱藏屋頂結構（Overview 減遮擋） ---------------- */
export function OverheadGroup({ children, hideAbove = 26 }:
  { children: React.ReactNode; hideAbove?: number }) {
  const ref = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    if (!ref.current) return;
    // 遲滯：高於 hideAbove 隱藏、低於 hideAbove-4 顯示
    const y = camera.position.y;
    if (ref.current.visible && y > hideAbove) ref.current.visible = false;
    else if (!ref.current.visible && y < hideAbove - 4) ref.current.visible = true;
  });
  return <group ref={ref}>{children}</group>;
}

/* ---------------- §45.12 維修人員情境動畫（由 fault_progress 驅動） ---------------- */
function pathPoint(pts: THREE.Vector3[], f: number): THREE.Vector3 {
  const lens = pts.slice(1).map((p, i) => p.distanceTo(pts[i]));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let d = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]) return pts[i].clone().lerp(pts[i + 1], lens[i] ? d / lens[i] : 1);
    d -= lens[i];
  }
  return pts[pts.length - 1].clone();
}
export const MAINT_ENTRY = 0.15, MAINT_EXIT = 0.85;   // 與引擎 MAINT_*_FRAC 相同

/** 從 Maintenance Area 走背側走廊 → 繞到 Cell 正面 Gate → 站位；85% 後原路返回。 */
export function MaintenanceOperator({ cx, station, progress }: {
  cx: number; station: [number, number]; progress: number;
}) {
  const grp = useRef<THREE.Group>(null);
  const path = useMemo(() => [
    new THREE.Vector3(0, 0, -16.5),                       // Maintenance Area
    new THREE.Vector3(cx + 8.9, 0, -12.5),                // 背側走廊
    new THREE.Vector3(cx + 8.9, 0, 10.2),                 // 繞到正面
    new THREE.Vector3(cx - 1.2, 0, 9.7),                  // Gate 外
    new THREE.Vector3(cx - 1.2, 0, 7.6),                  // 進 Gate
    new THREE.Vector3(station[0] + 1.6, 0, station[1] + (station[1] < 0 ? -1.4 : 1.4)),
  ], [cx, station[0], station[1]]);
  const walking = progress < MAINT_ENTRY || progress > MAINT_EXIT;
  const f = progress < MAINT_ENTRY ? progress / MAINT_ENTRY
    : progress > MAINT_EXIT ? 1 - (progress - MAINT_EXIT) / (1 - MAINT_EXIT) : 1;
  useFrame(({ clock }) => {
    if (!grp.current) return;
    const p = pathPoint(path, f);
    const prev = grp.current.position;
    const dx = p.x - prev.x, dz = p.z - prev.z;
    if (dx * dx + dz * dz > 1e-4) grp.current.rotation.y = Math.atan2(dx, dz);
    grp.current.position.set(p.x, walking ? Math.abs(Math.sin(clock.elapsedTime * 9)) * 0.06 : 0, p.z);
  });
  const atStation = !walking;
  return (
    <group ref={grp}>
      <mesh position={[0, 0.45, 0]} material={MAT.darkSteel}>
        <boxGeometry args={[0.34, 0.9, 0.22]} /></mesh>
      <mesh position={[0, 1.2, 0]}>
        <boxGeometry args={[0.42, 0.62, 0.26]} />
        <meshStandardMaterial color="#d8681e" /></mesh>
      <mesh position={[0, 1.28, 0.14]}>
        <boxGeometry args={[0.44, 0.1, 0.02]} />
        <meshStandardMaterial color="#e8d84a" emissive="#e8d84a" emissiveIntensity={0.5} /></mesh>
      <mesh position={[0, 1.72, 0]}>
        <sphereGeometry args={[0.16, 10, 10]} />
        <meshStandardMaterial color="#c9a385" /></mesh>
      <mesh position={[0, 1.84, 0]}>
        <sphereGeometry args={[0.18, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#e8d84a" /></mesh>
      {/* 工具箱（走路時提著） */}
      {walking && (
        <mesh material={MAT.hazard} position={[0.32, 0.55, 0]}>
          <boxGeometry args={[0.18, 0.28, 0.4]} /></mesh>)}
      {/* LOTO 掛牌（在站時掛在身旁立柱） */}
      {atStation && (
        <group position={[-0.5, 0, 0.3]}>
          <mesh material={MAT.fencePost} position={[0, 0.6, 0]}>
            <boxGeometry args={[0.05, 1.2, 0.05]} /></mesh>
          <mesh position={[0, 1.05, 0.03]}>
            <boxGeometry args={[0.2, 0.3, 0.02]} />
            <meshStandardMaterial color="#d03b3b" /></mesh>
          <mesh position={[0, 0.85, 0.03]}>
            <boxGeometry args={[0.2, 0.08, 0.02]} />
            <meshStandardMaterial color="#e8d84a" /></mesh>
        </group>)}
      <Label position={[0, 2.4, 0]} size={0.6} color="#e8d84a" tier={0} priority={4}
        text={walking ? (progress < MAINT_ENTRY ? "MAINT · en route" : "MAINT · leaving")
          : `MAINT · LOTO · ${Math.round(progress * 100)}%`} />
    </group>
  );
}

/* ================= §46 R3 新增 ================= */

/* ---------------- §46.1 Cell Sign 2.0（狀態圓點＋白字＋獨立 Badge） ---------------- */
export function CellSign({ x, z, letter, name, state, tint, bottleneck, awaitingReset }: {
  x: number; z: number; letter: string; name: string; state: string; tint: string;
  bottleneck: boolean; awaitingReset: boolean;
}) {
  return (
    <group position={[x, 7.2, z]}>
      {[-3.6, 3.6].map((dx, i) => (
        <mesh key={i} material={MAT.frame} position={[dx, 1.55, 0]}>
          <boxGeometry args={[0.1, 2.1, 0.1]} /></mesh>))}
      {/* 深灰藍底板（≈88% 不透明） */}
      <mesh>
        <boxGeometry args={[8.6, 1.75, 0.14]} />
        <meshStandardMaterial color="#232a34" transparent opacity={0.88} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 0, -0.02]}>
        <boxGeometry args={[8.8, 1.9, 0.06]} /></mesh>
      {/* 狀態圓點（左）＋細框 */}
      <mesh position={[-3.7, 0.32, 0.1]}>
        <sphereGeometry args={[0.16, 10, 10]} />
        <meshStandardMaterial color={tint} emissive={tint} emissiveIntensity={1.8} /></mesh>
      <lineSegments position={[0, 0, 0.08]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(8.5, 1.66)]} />
        <lineBasicMaterial color={tint} transparent opacity={0.5} />
      </lineSegments>
      {/* 名稱白字；狀態小字（顏色只在圓點/框/Badge） */}
      <Label position={[0.25, 0.32, 0.12]} size={1.0} color="#f2f2ec"
        text={`CELL ${letter} · ${name}`} tier={0} priority={5} />
      <Label position={[-2.4, -0.42, 0.12]} size={0.62} color={tint}
        text={state} tier={0} priority={4} />
      {/* BOTTLENECK 獨立琥珀 Badge；RESET REQUIRED 紅 Badge */}
      {bottleneck && (
        <group position={[2.6, -0.42, 0.1]}>
          <mesh><boxGeometry args={[2.6, 0.5, 0.03]} />
            <meshStandardMaterial color="#3a2c08" /></mesh>
          <lineSegments position={[0, 0, 0.02]}>
            <edgesGeometry args={[new THREE.PlaneGeometry(2.6, 0.5)]} />
            <lineBasicMaterial color="#c98500" /></lineSegments>
          <Label position={[0, 0, 0.05]} size={0.5} color="#f0b32a"
            text="BOTTLENECK" tier={0} priority={7} />
        </group>)}
      {awaitingReset && (
        <group position={[bottleneck ? 0.2 : 2.4, -0.42, 0.1]}>
          <mesh><boxGeometry args={[3.1, 0.5, 0.03]} />
            <meshStandardMaterial color="#3a0f0f" /></mesh>
          <Label position={[0, 0, 0.05]} size={0.5} color="#ff8a8a"
            text="RESET REQUIRED" tier={0} priority={9} />
        </group>)}
    </group>
  );
}

/* ---------------- §46 Overlay：Energy Heatmap ---------------- */
import { CELL_X as CELL_XS } from "../layout";   // §50 佈局單一來源
function heatColor(t: number): string {
  const a = new THREE.Color("#1f4fb0"), b = new THREE.Color("#d03b3b");
  return "#" + a.lerp(b, Math.max(0, Math.min(1, t))).getHexString();
}
export function EnergyHeatmap({ byCell, demandPct }: {
  byCell: Record<string, { kw: number }>; demandPct: number;
}) {
  const cellKw = Object.entries(byCell).filter(([k]) => k.startsWith("CELL-"));
  const maxKw = Math.max(1, ...cellKw.map(([, d]) => d.kw));
  return (
    <group>
      {cellKw.map(([cid, d]) => (
        <group key={cid}>
          <mesh position={[CELL_XS[cid] ?? 0, 0.03, 0]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[15, 17]} />
            <meshBasicMaterial color={heatColor(d.kw / maxKw)} transparent opacity={0.32}
              depthWrite={false} /></mesh>
          <Label position={[CELL_XS[cid] ?? 0, 2.2, -6.2]} size={1.0}
            color={heatColor(d.kw / maxKw)} text={`${d.kw.toFixed(1)} kW`}
            tier={0} priority={6} />
        </group>))}
      {/* Intralogistics（車道）與 Facility（後牆）區帶 */}
      {byCell.INTRALOGISTICS && (
        <mesh position={[-2, 0.03, 16.4]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[104, 4]} />
          <meshBasicMaterial color={heatColor(byCell.INTRALOGISTICS.kw / maxKw)}
            transparent opacity={0.3} depthWrite={false} /></mesh>)}
      {byCell.FACILITY && (
        <mesh position={[-19, 0.03, -26]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[26, 6]} />
          <meshBasicMaterial color={heatColor(byCell.FACILITY.kw / maxKw)}
            transparent opacity={0.3} depthWrite={false} /></mesh>)}
      <Label position={[0, 11.5, -9]} size={1.0}
        color={demandPct > 90 ? "#ff8a8a" : "#9fc4ff"}
        text={`ENERGY OVERLAY · plant load ${demandPct.toFixed(0)}% of demand limit`}
        tier={0} priority={8} />
    </group>
  );
}

/* ---------------- §46 Overlay：Logistics / Safety / Material Flow ---------------- */
export function LogisticsOverlay({ docks }: { docks: [number, number][] }) {
  return (
    <group>
      {/* §47：主走廊（13.4/15.2）＋備援走廊（17.0/18.8）帶狀高亮 */}
      <mesh position={[-2, 0.028, 14.3]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[104, 3.0]} />
        <meshBasicMaterial color="#1fb0c9" transparent opacity={0.22} depthWrite={false} /></mesh>
      <mesh position={[-2, 0.028, 17.9]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[104, 2.6]} />
        <meshBasicMaterial color="#1fb0c9" transparent opacity={0.12} depthWrite={false} /></mesh>
      {docks.map(([dx, dz], i) => (
        <mesh key={i} position={[dx, 0.03, dz]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[1.15, 1.45, 24]} />
          <meshBasicMaterial color="#1fb0c9" transparent opacity={0.8} depthWrite={false} /></mesh>))}
      {/* 連接線：dock → 車道 */}
      {docks.map(([dx, dz], i) => (
        <mesh key={"l" + i} position={[dx, 0.028, (dz + 14.3) / 2]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[0.16, Math.abs(14.3 - dz)]} />
          <meshBasicMaterial color="#1fb0c9" transparent opacity={0.4} depthWrite={false} /></mesh>))}
      <Label position={[0, 11.5, -9]} size={1.0} color="#5fd2e5"
        text="LOGISTICS OVERLAY · AMR lane / docking bays" tier={0} priority={8} />
    </group>
  );
}

export function SafetyOverlay({ cells, estops }: {
  cells: { cx: number; awaiting: boolean }[]; estops: [number, number][];
}) {
  return (
    <group>
      {cells.map((c, i) => (
        <lineSegments key={i} position={[c.cx, 0.06, 0]} rotation-x={-Math.PI / 2}>
          <edgesGeometry args={[new THREE.PlaneGeometry(15.4, 17.4)]} />
          <lineBasicMaterial color={c.awaiting ? "#ff5050" : "#d03b3b"} /></lineSegments>))}
      {/* 行人走道（綠）強調 */}
      <mesh position={[0, 0.028, 12.4]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[100, 2.2]} />
        <meshBasicMaterial color="#2e7d4f" transparent opacity={0.25} depthWrite={false} /></mesh>
      {estops.map(([x, z], i) => (
        <mesh key={"e" + i} position={[x, 0.04, z]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.5, 0.72, 20]} />
          <meshBasicMaterial color="#ffd23b" transparent opacity={0.9} depthWrite={false} /></mesh>))}
      <Label position={[0, 11.5, -9]} size={1.0} color="#ff9a9a"
        text="SAFETY OVERLAY · fences / E-stops / pedestrian lane" tier={0} priority={8} />
    </group>
  );
}

export function FlowOverlay() {
  const xs: number[] = [];
  for (let x = -44; x <= 44; x += 4) xs.push(x);
  return (
    <group>
      {xs.map((x, i) => (
        <mesh key={i} position={[x, 0.04, 0]} rotation-x={-Math.PI / 2}
          rotation-z={-Math.PI / 2}>
          <coneGeometry args={[0.45, 1.1, 3]} />
          <meshBasicMaterial color="#4a8f5f" transparent opacity={0.75} depthWrite={false} /></mesh>))}
      {/* FG → Staging（綠）；Supermarket → racks（藍） */}
      {[0, 1, 2].map((i) => (
        <mesh key={"fg" + i} position={[47 + i * 2.4, 0.04, 6 + i * 4]} rotation-x={-Math.PI / 2}
          rotation-z={Math.PI}>
          <coneGeometry args={[0.4, 1.0, 3]} />
          <meshBasicMaterial color="#199e70" transparent opacity={0.8} depthWrite={false} /></mesh>))}
      {[-33, -11, 11, 33].map((cx, i) => (
        <mesh key={"r" + i} position={[cx - 8, 0.04, 10.2]} rotation-x={-Math.PI / 2}>
          <coneGeometry args={[0.4, 1.0, 3]} />
          <meshBasicMaterial color="#3987e5" transparent opacity={0.8} depthWrite={false} /></mesh>))}
      <Label position={[0, 11.5, -9]} size={1.0} color="#7fd2a8"
        text="MATERIAL FLOW · RAW → W → A → M → I → FG → SHIPPING" tier={0} priority={8} />
    </group>
  );
}
