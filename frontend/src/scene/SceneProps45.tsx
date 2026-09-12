/** §45.2 Cell 專屬設備 + §45.3/45.4 收出貨區道具。
 *  原則同 §36：關掉文字也能辨認每個 Cell 的製程。共用 MAT、低多邊形。 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Label } from "./Label";
import { MAT, Tote } from "./SceneProps";

/* ---------------- Welding：焊絲桶（wire drum + 送絲管） ---------------- */
export function WireDrum({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.42, 0]}>
        <cylinderGeometry args={[0.34, 0.34, 0.84, 12]} />
        <meshStandardMaterial color="#c07830" roughness={0.6} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 0.88, 0]}>
        <cylinderGeometry args={[0.36, 0.36, 0.06, 12]} /></mesh>
      {/* 送絲導管（拱向治具方向） */}
      <mesh material={MAT.darkSteel} position={[0, 1.15, 0]} rotation-z={0.5}>
        <cylinderGeometry args={[0.035, 0.035, 0.9, 6]} /></mesh>
    </group>
  );
}

/* ---------------- Welding：焊接煙霧（只在 WELDING 相位、每 Cell 一組） -------- */
const SMOKE_N = 5;
export function Smoke({ position }: { position: [number, number, number] }) {
  const grp = useRef<THREE.Group>(null);
  const seeds = useMemo(() => [...Array(SMOKE_N)].map((_, i) => i / SMOKE_N), []);
  useFrame(({ clock }) => {
    if (!grp.current) return;
    grp.current.children.forEach((c, i) => {
      const t = (clock.elapsedTime * 0.25 + seeds[i]) % 1;
      c.position.y = t * 2.4;
      c.position.x = Math.sin((t + seeds[i]) * 5) * 0.18;
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
      m.opacity = 0.16 * (1 - t);
      c.scale.setScalar(0.5 + t * 1.3);
    });
  });
  return (
    <group ref={grp} position={position}>
      {seeds.map((_, i) => (
        <mesh key={i}>
          <sphereGeometry args={[0.22, 6, 6]} />
          <meshBasicMaterial color="#9a9a92" transparent opacity={0.15}
            depthWrite={false} /></mesh>))}
    </group>
  );
}

/* ---------------- Assembly：Torque Controller / Tool Change Rack ------------ */
export function TorqueController({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh material={MAT.fencePost} position={[0, 0.65, 0]}>
        <boxGeometry args={[0.09, 1.3, 0.09]} /></mesh>
      <mesh material={MAT.cabinet} position={[0, 1.35, 0]}>
        <boxGeometry args={[0.42, 0.55, 0.2]} /></mesh>
      <mesh material={MAT.screen} position={[0, 1.42, 0.11]}>
        <boxGeometry args={[0.3, 0.22, 0.02]} /></mesh>
      <mesh position={[0, 1.14, 0.11]}>
        <boxGeometry args={[0.08, 0.08, 0.02]} />
        <meshStandardMaterial color="#0ca30c" emissive="#0ca30c" emissiveIntensity={1.4} /></mesh>
    </group>
  );
}

export function ToolChangeRack({ x, z, ry = 0 }: { x: number; z: number; ry?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      <mesh material={MAT.frame} position={[0, 0.75, 0]}>
        <boxGeometry args={[1.5, 0.08, 0.4]} /></mesh>
      {[-0.5, 0, 0.5].map((dx, i) => (
        <group key={i} position={[dx, 0.75, 0]}>
          <mesh material={MAT.steel} position={[0, -0.14, 0]}>
            <cylinderGeometry args={[0.09, 0.07, 0.3, 8]} /></mesh>
          <mesh position={[0, -0.34, 0]}>
            <cylinderGeometry args={[0.05, 0.03, 0.16, 8]} />
            <meshStandardMaterial color={["#c9a339", "#3987e5", "#8a8a80"][i]} /></mesh>
        </group>))}
      {[-0.65, 0.65].map((dx, i) => (
        <mesh key={"l" + i} material={MAT.fencePost} position={[dx, 0.38, 0]}>
          <boxGeometry args={[0.07, 0.76, 0.07]} /></mesh>))}
    </group>
  );
}

/* ---------------- Machine Tending：Coolant Tank / Chip Bin ---------------- */
export function CoolantTank({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.45, 0]}>
        <boxGeometry args={[1.5, 0.9, 0.9]} />
        <meshStandardMaterial color="#4a6a7a" metalness={0.4} roughness={0.5} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 0.94, 0.2]}>
        <cylinderGeometry args={[0.09, 0.09, 0.1, 8]} /></mesh>
      {/* 冷卻管（往 CNC） */}
      <mesh material={MAT.darkSteel} position={[0.9, 0.7, 0]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.05, 0.05, 0.7, 6]} /></mesh>
      <mesh position={[-0.55, 0.72, 0.46]}>
        <boxGeometry args={[0.22, 0.26, 0.02]} />
        <meshStandardMaterial color="#7fd2ff" emissive="#4a8ab0" emissiveIntensity={0.5} /></mesh>
    </group>
  );
}

export function ChipBin({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      {/* 開口式屑桶（內裝金屬切屑） */}
      <mesh position={[0, 0.35, 0]}>
        <boxGeometry args={[0.9, 0.7, 0.7]} />
        <meshStandardMaterial color="#5a5a54" metalness={0.5} roughness={0.6} /></mesh>
      <mesh position={[0, 0.72, 0]}>
        <boxGeometry args={[0.78, 0.1, 0.58]} />
        <meshStandardMaterial color="#8f9498" metalness={0.85} roughness={0.3} /></mesh>
      {[-0.28, 0.05, 0.3].map((dx, i) => (
        <mesh key={i} position={[dx, 0.8, (i - 1) * 0.15]} rotation-z={0.4 * i}>
          <coneGeometry args={[0.08, 0.16, 5]} />
          <meshStandardMaterial color="#a8adb2" metalness={0.9} roughness={0.25} /></mesh>))}
    </group>
  );
}

/* ---------------- Inspection：Camera Gantry / 分流道 / Hold Rack ------------ */
export function CameraGantry({ cx }: { cx: number }) {
  return (
    <group position={[cx, 0, 0]}>
      {/* 兩座 booth 沿 z 排列（z=±1.9）→ 龍門沿 z 跨越 */}
      {[-4.4, 4.4].map((dz, i) => (
        <mesh key={i} material={MAT.frame} position={[0, 2.1, dz]}>
          <boxGeometry args={[0.14, 4.2, 0.14]} /></mesh>))}
      <mesh material={MAT.frame} position={[0, 4.2, 0]}>
        <boxGeometry args={[0.16, 0.16, 9.0]} /></mesh>
      {/* 軌道相機 pod ×2（懸吊、對準兩座 booth） */}
      {[-1.9, 1.9].map((dz, i) => (
        <group key={"p" + i} position={[0, 4.0, dz]}>
          <mesh material={MAT.darkSteel}>
            <boxGeometry args={[0.3, 0.34, 0.3]} /></mesh>
          <mesh position={[0, -0.24, 0]}>
            <cylinderGeometry args={[0.09, 0.12, 0.14, 8]} />
            <meshStandardMaterial color="#14181c" /></mesh>
        </group>))}
    </group>
  );
}

/** Pass / Reject 分流道（綠→下游、琥珀→Rework；§45.2）。 */
export function PassRejectLanes({ cx }: { cx: number }) {
  return (
    <group>
      {/* PASS：綠色地面箭頭 → +x（FG 方向） */}
      {[0, 1.4, 2.8].map((d, i) => (
        <mesh key={"g" + i} position={[cx + 5.6 + d, 0.02, 0]} rotation-x={-Math.PI / 2}
          rotation-z={-Math.PI / 2}>
          <coneGeometry args={[0.24, 0.55, 3]} />
          <meshBasicMaterial color="#2e7d4f" transparent opacity={0.85} /></mesh>))}
      {/* REJECT：琥珀箭頭 → +z（前側 Rework Rack） */}
      {[0, 1.4, 2.8].map((d, i) => (
        <mesh key={"a" + i} position={[cx + 1.5, 0.02, 5.8 + d]} rotation-x={-Math.PI / 2}
          rotation-z={Math.PI}>
          <coneGeometry args={[0.24, 0.55, 3]} />
          <meshBasicMaterial color="#c98500" transparent opacity={0.85} /></mesh>))}
    </group>
  );
}

export function HoldRack({ x, z, held }: { x: number; z: number; held: number }) {
  return (
    <group position={[x, 0, z]}>
      {[-0.8, 0.8].map((dx, i) => (
        <mesh key={i} material={MAT.frame} position={[dx, 0.7, 0]}>
          <boxGeometry args={[0.08, 1.4, 0.55]} /></mesh>))}
      {[0.28, 0.85, 1.38].map((py, i) => (
        <mesh key={"s" + i} material={MAT.steel} position={[0, py, 0]}>
          <boxGeometry args={[1.65, 0.05, 0.58]} /></mesh>))}
      {[...Array(Math.min(4, held))].map((_, i) => (
        <group key={"t" + i}
          position={[-0.45 + (i % 2) * 0.9, 0.32 + Math.floor(i / 2) * 0.57, 0]}>
          <Tote kind="hold" scale={0.8} /></group>))}
      <Label position={[0, 1.95, 0]} size={0.5} tier={2}
        color={held > 0 ? "#c98500" : "#8a5a52"} text={`QUALITY HOLD · ${held}`} />
    </group>
  );
}

/* ---------------- §45.6 AMR Payload（三種載荷外觀） ---------------- */
export function AmrPayload({ kind }: { kind: string }) {
  if (kind === "fg" || kind === "pallet") {
    const toteKind = kind === "fg" ? "fg" : "full";
    return (
      <group>
        <mesh material={MAT.hazard} position={[0, 0.05, 0]}>
          <boxGeometry args={[1.35, 0.1, 0.95]} /></mesh>
        {[...Array(4)].map((_, i) => (
          <group key={i} position={[-0.33 + (i % 2) * 0.66, 0.1,
            -0.24 + Math.floor(i / 2) * 0.48]}>
            <Tote kind={toteKind} scale={0.95} /></group>))}
      </group>
    );
  }
  return <Tote kind={kind} scale={1.35} />;      // full / empty 單箱
}

/* ---------------- §45.3 Receiving 區（黃待驗／綠已驗；狀態=snapshot） -------- */
export function ReceivingZone({ x, z, stage, sku, qty, truckId }: {
  x: number; z: number; stage: string; sku: string | null;
  qty: number; truckId: string | null;
}) {
  const pending = stage === "UNLOADING" || stage === "INSPECTING";
  const accepted = stage === "WAIT_PICKUP";
  return (
    <group position={[x, 0, z]}>
      {/* 黃色待驗區 */}
      <mesh position={[-1.6, 0.014, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[2.6, 3.2]} />
        <meshBasicMaterial color={pending ? "#5a4a10" : "#3a3524"}
          transparent opacity={0.8} /></mesh>
      <mesh position={[-1.6, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[1.55, 1.68, 4]} />
        <meshBasicMaterial color="#c98500" /></mesh>
      {/* 綠色已驗收區 */}
      <mesh position={[1.8, 0.014, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[2.6, 3.2]} />
        <meshBasicMaterial color={accepted ? "#1e3a24" : "#2a332a"}
          transparent opacity={0.8} /></mesh>
      <mesh position={[1.8, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[1.55, 1.68, 4]} />
        <meshBasicMaterial color="#2e7d4f" /></mesh>
      {/* 到貨棧板（待驗黃區或已驗綠區） */}
      {(pending || accepted) && (
        <group position={[accepted ? 1.8 : -1.6, 0, 0]}>
          <mesh material={MAT.hazard} position={[0, 0.11, 0]}>
            <boxGeometry args={[1.5, 0.2, 1.2]} /></mesh>
          {[...Array(4)].map((_, i) => (
            <group key={i} position={[-0.35 + (i % 2) * 0.7, 0.22 + Math.floor(i / 2) * 0.3,
              0]}>
              <Tote kind="full" /></group>))}
        </group>)}
      {/* Barcode 掃描站（驗收中閃紅線） */}
      <group position={[0.1, 0, -1.9]}>
        <mesh material={MAT.fencePost} position={[0, 0.8, 0]}>
          <boxGeometry args={[0.08, 1.6, 0.08]} /></mesh>
        <mesh material={MAT.darkSteel} position={[0, 1.55, 0.12]}>
          <boxGeometry args={[0.26, 0.2, 0.24]} /></mesh>
        {stage === "INSPECTING" && (
          <mesh position={[0, 1.0, 0.4]} rotation-x={0.5}>
            <planeGeometry args={[0.06, 1.4]} />
            <meshBasicMaterial color="#ff4040" transparent opacity={0.8}
              side={THREE.DoubleSide} /></mesh>)}
      </group>
      <Label position={[0, 2.6, 0]} size={0.6} tier={0} priority={4}
        color={stage === "IDLE" ? "#7d7d76" : "#e5a339"}
        text={stage === "IDLE" ? "RECEIVING" :
          `RECEIVING · ${stage}${truckId ? " · " + truckId : ""}${sku ? ` · ${qty} ${sku}` : ""}`} />
    </group>
  );
}

/* ---------------- §45.4 出貨月台加強（Shipping label 板 + Pallet Ready 燈） --- */
export function OutboundStatus({ x, z, stage, shipmentId, palletsReady, palletsPerTruck }: {
  x: number; z: number; stage: string; shipmentId: string | null;
  palletsReady: number; palletsPerTruck: number;
}) {
  const ready = palletsReady >= palletsPerTruck;
  return (
    <group position={[x, 0, z]}>
      <mesh material={MAT.fencePost} position={[0, 1.15, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 2.3, 6]} /></mesh>
      {/* Pallet Ready indicator */}
      <mesh position={[0, 2.4, 0]}>
        <sphereGeometry args={[0.12, 8, 8]} />
        <meshStandardMaterial color={ready ? "#199e70" : "#3a3a36"}
          emissive={ready ? "#199e70" : "#000"} emissiveIntensity={ready ? 2 : 0} /></mesh>
      <Label position={[0, 1.85, 0]} size={0.5} tier={1}
        color={stage !== "IDLE" ? "#4fc3f7" : "#7d7d76"}
        text={stage === "IDLE"
          ? `PALLETS ${palletsReady}/${palletsPerTruck}`
          : `${shipmentId ?? ""} · ${stage}`} />
    </group>
  );
}
