/** 程式化六軸手臂（§6.5 開發初期資產）。Joint hierarchy：
 *  base(J1 yaw) → shoulder(J2) → upper arm → elbow(J3) → forearm(J4 roll)
 *  → wrist(J5) → tool(J6 roll)。目標姿態逼近有角速度上限（§9.5，不可瞬間跳動）。 */
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { RobotState } from "../types";
import { extrapolatedProgress, useTwin } from "../state/store";
import { HOME, poseAt, type Pose } from "./poses";

const MAX_RAD_PER_SEC = 1.6;

const STATUS_COLOR: Record<string, string> = {
  RUNNING: "#0ca30c", WARNING: "#fab219", ERROR: "#d03b3b", BLOCKED: "#d03b3b",
  STARVED: "#ec835a", WAITING_MACHINE: "#898781", IDLE: "#898781",
};

export function RobotArm({ robot, position, rotationY = 0 }:
  { robot: RobotState; position: [number, number, number]; rotationY?: number }) {
  const j = [useRef<THREE.Group>(null), useRef<THREE.Group>(null), useRef<THREE.Group>(null),
             useRef<THREE.Group>(null), useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const cur = useRef<Pose>([...HOME] as Pose);
  const selected = useTwin((s) => s.selectedRobot === robot.robot_id);
  const select = useTwin((s) => s.selectRobot);
  const snapAt = useTwin((s) => s.snapReceivedAt);
  const paused = useTwin((s) => s.paused);
  const speed = useTwin((s) => s.speed);

  useFrame((_, dt) => {
    const prog = extrapolatedProgress(robot.cycle_progress, robot.cycle_time_sec,
                                      robot.status, snapAt, paused, speed);
    const target = (robot.status === "ERROR" || robot.status === "EMERGENCY_STOP")
      ? cur.current                                  // 故障/安全停止：凍結在當下姿態
      : ["RUNNING", "WAITING_MACHINE", "BLOCKED"].includes(robot.status)
        ? poseAt(robot.process, robot.cycle_time_sec, prog) : HOME;
    const maxStep = MAX_RAD_PER_SEC * Math.min(dt, 0.1) * Math.max(1, speed * 0.6);
    for (let i = 0; i < 6; i++) {
      const diff = target[i] - cur.current[i];
      cur.current[i] += Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
    }
    const [a1, a2, a3, a4, a5, a6] = cur.current;
    if (j[0].current) j[0].current.rotation.y = a1;
    if (j[1].current) j[1].current.rotation.z = a2;
    if (j[2].current) j[2].current.rotation.z = a3;
    if (j[3].current) j[3].current.rotation.x = a4;
    if (j[4].current) j[4].current.rotation.z = a5;
    if (j[5].current) j[5].current.rotation.x = a6;
  });

  const body = "#e8a33d";                       // 工業橘黃
  const dark = "#4a4a48";
  const status = STATUS_COLOR[robot.status] ?? "#898781";

  return (
    <group position={position} rotation-y={rotationY}
           onClick={(e) => { e.stopPropagation(); select(robot.robot_id); }}>
      {/* 底座 + 狀態燈 + 選取環 */}
      <mesh position={[0, 0.25, 0]}><cylinderGeometry args={[0.55, 0.65, 0.5, 20]} />
        <meshStandardMaterial color={dark} metalness={0.4} roughness={0.6} /></mesh>
      <mesh position={[0, 0.62, 0]}><sphereGeometry args={[0.09, 10, 10]} />
        <meshStandardMaterial color={status} emissive={status} emissiveIntensity={1.4} /></mesh>
      {selected && (
        <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.9, 1.15, 40]} />
          <meshBasicMaterial color="#3fd2ff" transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* J1 yaw */}
      <group ref={j[0]} position={[0, 0.5, 0]}>
        <mesh position={[0, 0.25, 0]}><cylinderGeometry args={[0.42, 0.5, 0.5, 16]} />
          <meshStandardMaterial color={body} metalness={0.3} roughness={0.5} /></mesh>
        {/* J2 shoulder */}
        <group ref={j[1]} position={[0, 0.55, 0]}>
          <mesh position={[0, 0.9, 0]}><boxGeometry args={[0.5, 1.9, 0.42]} />
            <meshStandardMaterial color={body} metalness={0.3} roughness={0.5} /></mesh>
          {/* J3 elbow */}
          <group ref={j[2]} position={[0, 1.85, 0]}>
            <mesh><sphereGeometry args={[0.3, 12, 12]} />
              <meshStandardMaterial color={dark} /></mesh>
            <mesh position={[0.75, 0, 0]} rotation-z={-Math.PI / 2}>
              <cylinderGeometry args={[0.2, 0.26, 1.5, 12]} />
              <meshStandardMaterial color={body} metalness={0.3} roughness={0.5} /></mesh>
            {/* J4 forearm roll */}
            <group ref={j[3]} position={[1.5, 0, 0]}>
              {/* J5 wrist pitch */}
              <group ref={j[4]}>
                <mesh position={[0.3, 0, 0]} rotation-z={-Math.PI / 2}>
                  <cylinderGeometry args={[0.14, 0.18, 0.6, 10]} />
                  <meshStandardMaterial color={dark} /></mesh>
                {/* J6 tool roll：焊槍或夾爪（§36.3/36.4 工具差異） */}
                <group ref={j[5]} position={[0.62, 0, 0]}>
                  {robot.process === "spot_welding" ? (
                    <group>
                      <mesh rotation-z={-Math.PI / 2} position={[0.1, 0, 0]}>
                        <cylinderGeometry args={[0.09, 0.09, 0.3, 8]} />
                        <meshStandardMaterial color="#3a3a38" metalness={0.6} roughness={0.4} /></mesh>
                      <mesh position={[0.3, -0.12, 0]} rotation-z={-Math.PI / 3}>
                        <cylinderGeometry args={[0.035, 0.05, 0.36, 8]} />
                        <meshStandardMaterial color="#b06a20" metalness={0.7} roughness={0.3} /></mesh>
                      <mesh position={[0.42, -0.24, 0]}>
                        <sphereGeometry args={[0.045, 8, 8]} />
                        <meshStandardMaterial color="#c3c2b7" metalness={0.8} roughness={0.2} /></mesh>
                    </group>
                  ) : (
                    <group>
                      <mesh rotation-z={-Math.PI / 2} position={[0.08, 0, 0]}>
                        <cylinderGeometry args={[0.08, 0.1, 0.22, 8]} />
                        <meshStandardMaterial color="#3a3a38" metalness={0.6} roughness={0.4} /></mesh>
                      {[-0.07, 0.07].map((dz, i) => (
                        <mesh key={i} position={[0.28, -0.05, dz]}>
                          <boxGeometry args={[0.22, 0.06, 0.05]} />
                          <meshStandardMaterial color="#c3c2b7" metalness={0.7} roughness={0.3} /></mesh>))}
                    </group>
                  )}
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}
