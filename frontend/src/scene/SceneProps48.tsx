/** §48 AMR 交通可觀測性：權威路線視覺化＋空間障礙物。
 *  資料全部來自 snapshot（amr.route / state.obstacles）——前端不推算任何路線。 */
import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { SnapshotMessage } from "../types";
import { Label } from "./Label";

type AmrSnap = SnapshotMessage["state"]["amrs"][number];
type ObstacleSnap = NonNullable<SnapshotMessage["state"]["obstacles"]>[number];

const ROUTE_COLOR: Record<string, string> = { "AMR-01": "#5fd2e5", "AMR-02": "#d8a6ff" };

function RouteLine({ amr, emphasized }: { amr: AmrSnap; emphasized: boolean }) {
  const route = amr.route ?? [];
  if (route.length < 2) return null;
  const rerouted = amr.traffic_state === "REROUTED";
  const blocked = amr.traffic_state === "BLOCKED";     // §53：無安全路徑——路線畫成紅色虛線，不當作「改道成功」
  const color = blocked ? "#ff5a4a" : rerouted ? "#ffb74d" : ROUTE_COLOR[amr.amr_id] ?? "#5fd2e5";
  const y = 0.06 + (amr.amr_id === "AMR-02" ? 0.015 : 0);
  const pts = route.map(([x, z]) => new THREE.Vector3(x, y, z));
  const end = route[route.length - 1];
  return (
    <group>
      <Line points={pts} color={color} lineWidth={emphasized ? 3 : 1.6}
        dashed={rerouted || blocked} dashSize={blocked ? 0.4 : 0.8} gapSize={0.4}
        transparent opacity={blocked ? 0.5 : emphasized ? 0.95 : 0.6} />
      {/* 目標點標記 */}
      <mesh position={[end[0], 0.05, end[1]]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.55, 0.75, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} /></mesh>
      {emphasized && (
        <Label position={[end[0], 1.2, end[1]]} size={0.6} color={color} tier={1} priority={8}
          text={`${amr.amr_id} → ${amr.task_state.replace("TRAVEL_TO_", "")}`
            + (blocked ? " · NO SAFE PATH" : rerouted ? " · BYPASS" : "")} />)}
    </group>
  );
}

/** 路線層：Logistics overlay 畫全部；否則只畫選取中的 AMR。 */
export function AmrRoutes({ amrs, showAll, selected }: {
  amrs: AmrSnap[]; showAll: boolean; selected: string | null;
}) {
  return (
    <group>
      {amrs.filter((a) => showAll || a.amr_id === selected).map((a) => (
        <RouteLine key={a.amr_id} amr={a} emphasized={a.amr_id === selected || showAll} />))}
    </group>
  );
}

/** 空間障礙物：條紋護欄＋三角錐＋淨空圈＋剩餘秒數。 */
export function ZoneObstacle({ ob }: { ob: ObstacleSnap }) {
  const [x, z] = ob.position;
  return (
    <group position={[x, 0, z]}>
      {/* 實體半徑圈（radius_m）＋規劃淨空圈（clearance_m = 半徑 + hard_stop；§49
          畫面範圍與真正避障範圍一致） */}
      <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[ob.radius_m - 0.12, ob.radius_m, 40]} />
        <meshBasicMaterial color="#d03b3b" transparent opacity={0.75} /></mesh>
      {(ob.clearance_m ?? 0) > ob.radius_m && (
        <mesh position={[0, 0.025, 0]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[ob.clearance_m! - 0.06, ob.clearance_m!, 48]} />
          <meshBasicMaterial color="#ff8a2a" transparent opacity={0.45} depthWrite={false} /></mesh>)}
      <mesh position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[ob.radius_m, 40]} />
        <meshBasicMaterial color="#d03b3b" transparent opacity={0.12} depthWrite={false} /></mesh>
      {/* 條紋護欄 */}
      {[-0.55, 0, 0.55].map((dx, i) => (
        <mesh key={i} position={[dx, 0.5, 0]}>
          <boxGeometry args={[0.5, 1.0, 0.35]} />
          <meshStandardMaterial color={i % 2 ? "#f2f2ee" : "#d03b3b"} /></mesh>))}
      <mesh position={[0, 1.05, 0]}>
        <boxGeometry args={[1.7, 0.1, 0.4]} />
        <meshStandardMaterial color="#d03b3b" /></mesh>
      {/* 三角錐 */}
      {[[-1.0, 0.9], [1.0, 0.9], [0, -0.95]].map(([cx, cz], i) => (
        <group key={i} position={[cx, 0, cz]}>
          <mesh position={[0, 0.35, 0]}>
            <coneGeometry args={[0.22, 0.7, 10]} />
            <meshStandardMaterial color="#ff8a2a" /></mesh>
          <mesh position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[0.5, 0.5]} />
            <meshBasicMaterial color="#1a1a18" /></mesh>
        </group>))}
      <Label position={[0, 2.1, 0]} size={0.7} color="#ff6b6b" tier={0} priority={9}
        text={`OBSTACLE ${ob.obstacle_id} · ${Math.round(ob.remaining_sec)}s · clr ${(ob.clearance_m ?? ob.radius_m).toFixed(1)}m`} />
    </group>
  );
}
