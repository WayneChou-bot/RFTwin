/** §51 感知層視覺化（WareTwin 借鏡）：把引擎 §47 讓行判斷的**輸入**畫出來。
 *  資料全部來自 wire 的 amr.perception（snapshot／10 Hz amr_patch）——前端不重算距離。
 *  - 選取的 AMR：前方 ±45° 扇形（safe 2.0 m 實心／clear 2.6 m 遲滯外緣）＋ 感測圈
 *    （sense_m）＋ 到每個感測物體的射線（顏色依距離：< hard_stop 紅／< safe 橙／其餘灰）。
 *    distance_m 依 wire 的 ref：他車＝中心距（射線到車心）、障礙物＝到邊緣（射線到邊緣）——
 *    兩者都是引擎交通邏輯實際比較的量（§52）。
 *  - 未選取但 STOPPED（讓行中）的 AMR：只畫前方紅弧，讓「誰在等誰」一眼可見。
 *  位置＝畫面上的 AMR 位置（__amrRender，與車體同步平滑）；朝向＝perception.heading。 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { useTwin } from "../state/store";
import type { AmrPerceptionWire as Perception } from "../state/store";

const FAN = Math.PI / 2;                     // ±45°
const FAN_START = -Math.PI / 2 - FAN / 2;    // ring 的 XY 面經 rotation-x=-90° 後，-y → +z（前方）
const STATE_COLOR: Record<Perception["state"], string> = {
  CLEAR: "#5fd2e5", CAUTION: "#ffb74d", STOPPED: "#ff5a4a",
};

/** 方位（0 = 前方，正 = 左）＋距離 → 車體局部座標（前方 = +z，左 = −x）。 */
function localPoint(distance: number, bearingDeg: number, y: number): THREE.Vector3 {
  const b = (bearingDeg * Math.PI) / 180;
  return new THREE.Vector3(-distance * Math.sin(b), y, distance * Math.cos(b));
}

function PerceptionOne({ amrId, selected }: { amrId: string; selected: boolean }) {
  const grp = useRef<THREE.Group>(null);
  const per = useTwin((s) => s.amrLive[amrId]?.perception ?? undefined) as Perception | undefined;
  useFrame(() => {
    if (!grp.current) return;
    const r = (window as unknown as { __amrRender?: Record<string, [number, number]> }).__amrRender?.[amrId];
    const p = useTwin.getState().amrLive[amrId]?.position;
    const x = r?.[0] ?? p?.[0], z = r?.[1] ?? p?.[1];
    if (x === undefined || z === undefined) return;
    grp.current.position.set(x, 0, z);
    const h = useTwin.getState().amrLive[amrId]?.perception?.heading;
    if (h && (h[0] !== 0 || h[1] !== 0)) grp.current.rotation.y = Math.atan2(h[0], h[1]);
  });
  const rays = useMemo(() => {
    if (!per || !selected) return [];
    return per.obstacles.map((o) => ({
      id: o.id,
      pts: [new THREE.Vector3(0, 0.12, 0), localPoint(o.distance_m, o.bearing_deg, 0.12)],
      color: o.distance_m < per.hard_stop_m ? "#ff5a4a"
        : o.distance_m < per.safe_m ? "#ffb74d" : "#9aa5ad",
      label: `${o.id} ${o.distance_m.toFixed(1)} m`,
    }));
  }, [per, selected]);
  if (!per) return null;
  const color = STATE_COLOR[per.state];
  if (!selected) {
    if (per.state !== "STOPPED") return null;
    return (
      <group ref={grp}>
        <mesh position={[0, 0.1, 0]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[1.25, 1.55, 24, 1, FAN_START, FAN]} />
          <meshBasicMaterial color="#ff5a4a" transparent opacity={0.85} depthWrite={false} /></mesh>
      </group>);
  }
  return (
    <group ref={grp}>
      {/* safe 扇形（實心）：前方 < safe_m 有車即讓行 */}
      <mesh position={[0, 0.09, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.9, per.safe_m, 32, 1, FAN_START, FAN]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} depthWrite={false} /></mesh>
      {/* clear 遲滯外緣（讓行解除門檻） */}
      <mesh position={[0, 0.1, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[per.clear_m - 0.07, per.clear_m, 32, 1, FAN_START, FAN]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} depthWrite={false} /></mesh>
      {/* hard_stop 圈（移動鉗制下限，全向） */}
      <mesh position={[0, 0.085, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[per.hard_stop_m - 0.05, per.hard_stop_m, 32]} />
        <meshBasicMaterial color="#ff5a4a" transparent opacity={0.5} depthWrite={false} /></mesh>
      {/* 感測範圍（全向、淡） */}
      <mesh position={[0, 0.08, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[per.sense_m - 0.04, per.sense_m, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.28} depthWrite={false} /></mesh>
      {rays.map((r) => (
        <group key={r.id}>
          <Line points={r.pts} color={r.color} lineWidth={2} transparent opacity={0.9} />
          <mesh position={r.pts[1]}>
            <sphereGeometry args={[0.14, 8, 8]} />
            <meshBasicMaterial color={r.color} /></mesh>
        </group>))}
    </group>
  );
}

export function AmrPerceptionLayer({ amrIds, selected }: { amrIds: string[]; selected: string | null }) {
  return (
    <group>
      {amrIds.map((id) => <PerceptionOne key={id} amrId={id} selected={id === selected} />)}
    </group>
  );
}
