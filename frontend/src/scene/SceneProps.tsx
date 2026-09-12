/** 工業設備元件庫（§36 P0/P1）。
 *  原則：每個元件都解釋製程、傳達 Twin State 或支撐安全/物流（§36 開頭原則）。 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Label } from "./Label";

/* ---------------- 共用材質（shared，控制 draw call 與記憶體） ---------------- */
/* §45.1 材質明度分層：結構深灰（不用純黑）、機器灰白、櫃體淺灰。 */
export const MAT = {
  steel: new THREE.MeshStandardMaterial({ color: "#77797e", metalness: 0.45, roughness: 0.45 }),
  darkSteel: new THREE.MeshStandardMaterial({ color: "#4e4e4a", metalness: 0.4, roughness: 0.6 }),
  frame: new THREE.MeshStandardMaterial({ color: "#464641", metalness: 0.3, roughness: 0.8 }),
  cabinet: new THREE.MeshStandardMaterial({ color: "#a4a7a9", metalness: 0.2, roughness: 0.6 }),
  fencePost: new THREE.MeshStandardMaterial({ color: "#4a4a42", metalness: 0.4, roughness: 0.7 }),
  fenceMesh: new THREE.MeshStandardMaterial({ color: "#8a8a80", metalness: 0.55, roughness: 0.6,
    transparent: true, opacity: 0.34, side: THREE.DoubleSide }),
  hazard: new THREE.MeshStandardMaterial({ color: "#b98a10", roughness: 0.8 }),
  belt: new THREE.MeshStandardMaterial({ color: "#2c2c2a", roughness: 0.95 }),
  screen: new THREE.MeshStandardMaterial({ color: "#0a2a3a", emissive: "#1a6a8a",
    emissiveIntensity: 0.8 }),
  slot: new THREE.MeshBasicMaterial({ color: "#8a8a80", transparent: true, opacity: 0.5 }),
};

/* Part 分段材質（§36.7：階段以材質/幾何表現，狀態色只作 overlay） */
const PART_MAT: Record<string, THREE.MeshStandardMaterial> = {
  raw: new THREE.MeshStandardMaterial({ color: "#7a7f85", metalness: 0.3, roughness: 0.7 }),
  welded: new THREE.MeshStandardMaterial({ color: "#6a6058", metalness: 0.5, roughness: 0.55 }),
  assembled: new THREE.MeshStandardMaterial({ color: "#5a6e82", metalness: 0.4, roughness: 0.5 }),
  machined: new THREE.MeshStandardMaterial({ color: "#b8bcc0", metalness: 0.8, roughness: 0.25 }),
  good: new THREE.MeshStandardMaterial({ color: "#b8bcc0", metalness: 0.8, roughness: 0.25 }),
  reject: new THREE.MeshStandardMaterial({ color: "#8a5a52", metalness: 0.4, roughness: 0.6 }),
};

export function PartMesh({ stage = "raw", y = 0, scale = 1 }:
  { stage?: string; y?: number; scale?: number }) {
  const m = PART_MAT[stage] ?? PART_MAT.raw;
  return (
    <group position-y={y} scale={scale}>
      <mesh material={m}><boxGeometry args={[0.62, 0.26, 0.46]} /></mesh>
      {stage !== "raw" && (            /* 焊接後：框架緣條 */
        <mesh material={MAT.darkSteel} position={[0, 0.16, 0]}>
          <boxGeometry args={[0.64, 0.06, 0.48]} /></mesh>)}
      {(stage === "assembled" || stage === "machined" || stage === "good") && (
        <mesh material={PART_MAT.assembled} position={[0.12, 0.24, 0]}>
          <boxGeometry args={[0.22, 0.14, 0.22]} /></mesh>)}
      {stage === "reject" && (
        <mesh position={[0, 0.3, 0]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.3, 0.38, 16]} />
          <meshBasicMaterial color="#d03b3b" transparent opacity={0.9} /></mesh>)}
    </group>
  );
}

/* ---------------- Stack Light（§36.9） ---------------- */
export function StackLight({ x, z, state }: { x: number; z: number; state: string }) {
  const on = state === "RUNNING" ? 0 : ["BLOCKED", "STARVED", "DEGRADED"].includes(state) ? 1 : 2;
  const cols = ["#0ca30c", "#fab219", "#d03b3b"];
  return (
    <group position={[x, 0, z]}>
      <mesh material={MAT.fencePost} position={[0, 1.4, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 2.8, 6]} /></mesh>
      {cols.map((c, i) => (
        <mesh key={i} position={[0, 3.0 - i * 0.34, 0]}>
          <cylinderGeometry args={[0.14, 0.14, 0.3, 10]} />
          <meshStandardMaterial color={c}
            emissive={on === (2 - i) ? c : "#000"}
            emissiveIntensity={on === (2 - i) ? 3.2 : 0}   /* §45.7 提高亮度 */
            transparent opacity={on === (2 - i) ? 1 : 0.4} />
        </mesh>))}
    </group>
  );
}

/* ---------------- 圍籬 + 聯鎖門（§36.9） ---------------- */
export function Fence({ cx, w, d, gateOpen, gateId }:
  { cx: number; w: number; d: number; gateOpen: boolean; gateId?: string }) {
  const hw = w / 2, hd = d / 2, H = 2.0;
  const gate = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!gate.current) return;
    const target = gateOpen ? -Math.PI / 2.2 : 0;
    gate.current.rotation.y += (target - gate.current.rotation.y) * Math.min(1, dt * 3);
  });
  const posts: [number, number][] = [];
  for (let x = -hw; x <= hw + 0.01; x += 3.75) { posts.push([cx + x, -hd]); posts.push([cx + x, hd]); }
  for (let z = -hd + 3; z < hd; z += 4) { posts.push([cx - hw, z]); posts.push([cx + hw, z]); }
  const gateW = 2.4;
  return (
    <group>
      {posts.map(([px, pz], i) => (
        <mesh key={i} material={MAT.fencePost} position={[px, H / 2, pz]}>
          <boxGeometry args={[0.09, H, 0.09]} /></mesh>))}
      {/* 網面：後(-z)、左、右、前(+z 留門口) */}
      <mesh material={MAT.fenceMesh} position={[cx, H / 2 + 0.15, -hd]}>
        <planeGeometry args={[w, H - 0.3]} /></mesh>
      {/* 側面板留 conveyor 穿越開口（z ∈ [-1.2, 1.2]） */}
      {[-hw, hw].map((sx, i) => (
        <group key={i}>
          <mesh material={MAT.fenceMesh} rotation-y={Math.PI / 2}
            position={[cx + sx, H / 2 + 0.15, -(hd + 1.2) / 2]}>
            <planeGeometry args={[hd - 1.2, H - 0.3]} /></mesh>
          <mesh material={MAT.fenceMesh} rotation-y={Math.PI / 2}
            position={[cx + sx, H / 2 + 0.15, (hd + 1.2) / 2]}>
            <planeGeometry args={[hd - 1.2, H - 0.3]} /></mesh>
        </group>))}
      <mesh material={MAT.fenceMesh} position={[cx - (gateW / 2 + (w - gateW) / 4), H / 2 + 0.15, hd]}>
        <planeGeometry args={[(w - gateW) / 2, H - 0.3]} /></mesh>
      <mesh material={MAT.fenceMesh} position={[cx + (gateW / 2 + (w - gateW) / 4), H / 2 + 0.15, hd]}>
        <planeGeometry args={[(w - gateW) / 2, H - 0.3]} /></mesh>
      {/* 聯鎖門（鉸鏈在左，開向 +z 走道；§45.7 黃框＋亮色把手＋狀態燈） */}
      <group ref={gate} position={[cx - gateW / 2, 0, hd]}>
        <mesh material={MAT.hazard} position={[gateW / 2, H / 2 + 0.15, 0]}>
          <boxGeometry args={[gateW, H - 0.3, 0.05]} /></mesh>
        {/* 黃色門框緣條（上下） */}
        {[0.34, H - 0.04].map((py, i) => (
          <mesh key={i} position={[gateW / 2, py, 0.04]}>
            <boxGeometry args={[gateW, 0.1, 0.04]} />
            <meshStandardMaterial color="#e8c832" emissive="#4a3c08"
              emissiveIntensity={0.6} /></mesh>))}
        <mesh position={[gateW - 0.15, H / 2, 0.1]}>
          <boxGeometry args={[0.12, 0.44, 0.14]} />
          <meshStandardMaterial color="#e8d84a" emissive="#5a5010"
            emissiveIntensity={0.7} /></mesh>
      </group>
      {/* 門狀態燈＋Gate ID（入口上方；OPEN 紅／CLOSED 綠） */}
      <group position={[cx, 0, hd + 0.1]}>
        <mesh position={[0, H + 0.35, 0]}>
          <sphereGeometry args={[0.09, 8, 8]} />
          <meshStandardMaterial color={gateOpen ? "#d03b3b" : "#0ca30c"}
            emissive={gateOpen ? "#d03b3b" : "#0ca30c"} emissiveIntensity={2} /></mesh>
        {gateId && (
          <Label position={[0, H + 0.85, 0]} size={0.52} tier={2}
            color={gateOpen ? "#ec835a" : "#8a9a8a"}
            text={`${gateId} · ${gateOpen ? "OPEN" : "CLOSED"}`} />)}
      </group>
      {/* E-Stop（門旁立柱；§45.7 紅鈕＋黃底座） */}
      <group position={[cx + gateW / 2 + 0.5, 0, hd + 0.15]}>
        <mesh material={MAT.fencePost} position={[0, 0.5, 0]}>
          <boxGeometry args={[0.1, 1.0, 0.1]} /></mesh>
        <mesh position={[0, 1.1, 0]}>
          <boxGeometry args={[0.3, 0.4, 0.14]} />
          <meshStandardMaterial color="#e8c832" /></mesh>
        <mesh position={[0, 1.1, 0.09]}>
          <cylinderGeometry args={[0.08, 0.08, 0.09, 10]} />
          <meshStandardMaterial color="#d03b3b" emissive="#d03b3b" emissiveIntensity={0.9} />
        </mesh>
      </group>
    </group>
  );
}

/* ---------------- 控制箱 / HMI ---------------- */
export function Cabinet({ x, z, w = 1.2, h = 1.9, d = 0.7, ry = 0 }:
  { x: number; z: number; w?: number; h?: number; d?: number; ry?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      <mesh material={MAT.cabinet} position={[0, h / 2, 0]}><boxGeometry args={[w, h, d]} /></mesh>
      <mesh position={[w * 0.25, h * 0.78, d / 2 + 0.01]}>
        <boxGeometry args={[0.08, 0.08, 0.02]} />
        <meshStandardMaterial color="#0ca30c" emissive="#0ca30c" emissiveIntensity={1.5} /></mesh>
      <mesh material={MAT.darkSteel} position={[-w * 0.25, h * 0.5, d / 2 + 0.01]}>
        <boxGeometry args={[0.3, 0.5, 0.02]} /></mesh>
    </group>
  );
}

export function Hmi({ x, z, ry = 0 }: { x: number; z: number; ry?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      <mesh material={MAT.fencePost} position={[0, 0.7, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 1.4, 6]} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 1.5, 0]} rotation-x={-0.25}>
        <boxGeometry args={[0.7, 0.5, 0.06]} /></mesh>
      <mesh material={MAT.screen} position={[0, 1.5, 0.035]} rotation-x={-0.25}>
        <boxGeometry args={[0.6, 0.4, 0.01]} /></mesh>
    </group>
  );
}

/* ---------------- Welding / Assembly Fixture ---------------- */
export function Fixture({ x, z, kind, hasPart, stage, onSelect }:
  { x: number; z: number; kind: "weld" | "assembly"; hasPart: boolean; stage: string;
    onSelect?: () => void }) {
  return (
    <group position={[x, 0, z]}
      onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(); } : undefined}>
      <mesh material={MAT.darkSteel} position={[0, 0.42, 0]}>
        <boxGeometry args={[1.7, 0.84, 1.15]} /></mesh>
      <mesh material={MAT.steel} position={[0, 0.87, 0]}>
        <boxGeometry args={[1.5, 0.06, 1.0]} /></mesh>
      {/* 治具夾爪四角 */}
      {[[-0.55, -0.32], [0.55, -0.32], [-0.55, 0.32], [0.55, 0.32]].map(([dx, dz], i) => (
        <mesh key={i} material={MAT.hazard} position={[dx, 0.99, dz]}>
          <boxGeometry args={[0.12, 0.18, 0.12]} /></mesh>))}
      {kind === "weld" && (      /* 防火花遮板 */
        <mesh position={[0, 1.35, 0.62]} rotation-x={0.15}>
          <planeGeometry args={[1.7, 0.8]} />
          <meshStandardMaterial color="#22261f" transparent opacity={0.5}
            side={THREE.DoubleSide} /></mesh>)}
      {hasPart && <group position={[0, 1.05, 0]}><PartMesh stage={stage} /></group>}
    </group>
  );
}

/* 供料盤（Assembly） */
export function Feeder({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh material={MAT.steel} position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.55, 0.4, 1.0, 14]} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 1.05, 0]}>
        <cylinderGeometry args={[0.62, 0.55, 0.16, 14]} /></mesh>
      <mesh material={MAT.steel} position={[0.75, 0.9, 0]} rotation-z={-0.18}>
        <boxGeometry args={[0.8, 0.05, 0.3]} /></mesh>
    </group>
  );
}

/* ---------------- CNC（§36.5：門與 Cycle State 一致） ---------------- */
export function Cnc({ x, z, ry = 0, doorOpen, machining, fault }:
  { x: number; z: number; ry?: number; doorOpen: boolean; machining: boolean; fault: boolean }) {
  const door = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (!door.current) return;
    const target = doorOpen ? 1.35 : 0;        // 滑門橫移
    door.current.position.x += (target - door.current.position.x) * Math.min(1, dt * 4);
  });
  const lamp = fault ? "#d03b3b" : machining ? "#0ca30c" : "#c98500";
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      <mesh material={MAT.steel} position={[0, 1.5, 0]}><boxGeometry args={[4.0, 3.0, 2.8]} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 3.05, 0]}><boxGeometry args={[4.1, 0.15, 2.9]} /></mesh>
      {/* 門框開口 + 滑動門 */}
      <mesh material={MAT.frame} position={[0, 1.35, 1.41]}>
        <boxGeometry args={[2.6, 2.2, 0.06]} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 1.35, 1.42]}>
        <boxGeometry args={[2.7, 2.3, 0.02]} /></mesh>
      {/* 內部工作區（門開時可見；加工時內光） */}
      <mesh position={[0, 1.3, 1.0]}>
        <boxGeometry args={[2.2, 1.8, 0.7]} />
        <meshStandardMaterial color="#14181c"
          emissive={machining ? "#2a4a1a" : "#000"} emissiveIntensity={machining ? 0.9 : 0} />
      </mesh>
      <mesh ref={door} material={MAT.cabinet} position={[0, 1.35, 1.46]}>
        <boxGeometry args={[1.5, 2.0, 0.06]} /></mesh>
      {/* 視窗 */}
      <mesh position={[0, 1.6, 1.5]}>
        <boxGeometry args={[0.8, 0.6, 0.01]} />
        <meshStandardMaterial color="#3a5262" transparent opacity={0.6} /></mesh>
      {/* 狀態燈 + 小 HMI */}
      <mesh position={[1.7, 3.25, 0.8]}>
        <cylinderGeometry args={[0.1, 0.1, 0.32, 8]} />
        <meshStandardMaterial color={lamp} emissive={lamp} emissiveIntensity={2} /></mesh>
      <mesh material={MAT.screen} position={[1.85, 1.6, 1.44]}>
        <boxGeometry args={[0.5, 0.7, 0.02]} /></mesh>
      {/* Infeed / Outfeed tray */}
      <mesh material={MAT.darkSteel} position={[-2.4, 0.45, 0.8]}>
        <boxGeometry args={[0.9, 0.9, 0.9]} /></mesh>
    </group>
  );
}

/* ---------------- Inspection Booth（§36.6） ---------------- */
export function Booth({ x, z, capturing, onSelect }:
  { x: number; z: number; capturing: boolean; onSelect?: () => void }) {
  return (
    <group position={[x, 0, z]}
      onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(); } : undefined}>
      {[[-1.1, -0.8], [1.1, -0.8], [-1.1, 0.8], [1.1, 0.8]].map(([dx, dz], i) => (
        <mesh key={i} material={MAT.frame} position={[dx, 1.6, dz]}>
          <boxGeometry args={[0.1, 3.2, 0.1]} /></mesh>))}
      <mesh material={MAT.frame} position={[0, 3.25, 0]}><boxGeometry args={[2.4, 0.12, 1.8]} /></mesh>
      {/* 側/後遮板 */}
      <mesh material={MAT.fenceMesh} position={[0, 1.9, 0.85]}>
        <planeGeometry args={[2.3, 2.6]} /></mesh>
      {/* 相機 + Ring Light */}
      <mesh material={MAT.darkSteel} position={[0, 2.9, 0]}>
        <boxGeometry args={[0.34, 0.5, 0.34]} /></mesh>
      <mesh position={[0, 2.6, 0]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.42, 0.06, 8, 24]} />
        <meshStandardMaterial color="#e8e8e0" emissive="#cfe8ff"
          emissiveIntensity={capturing ? 3 : 0.25} /></mesh>
      {/* 檢測台 */}
      <mesh material={MAT.darkSteel} position={[0, 0.45, 0]}>
        <boxGeometry args={[1.6, 0.9, 1.1]} /></mesh>
      {/* 掃描光柱（capturing 時） */}
      {capturing && (
        <mesh position={[0, 1.7, 0]}>
          <coneGeometry args={[0.55, 1.6, 16, 1, true]} />
          <meshBasicMaterial color="#3fd2ff" transparent opacity={0.14}
            side={THREE.DoubleSide} depthWrite={false} /></mesh>)}
    </group>
  );
}

/* ---------------- 實體 Conveyor（§36.7） ---------------- */
export function ConveyorStruct({ x1, x2, status }:
  { x1: number; x2: number; status: string }) {
  const len = x2 - x1, cx = (x1 + x2) / 2;
  const jam = status === "JAMMED";
  const legs: number[] = [];
  for (let x = x1 + 0.6; x < x2; x += 2.2) legs.push(x);
  return (
    <group>
      {/* 帶面 + 側護欄 + 腳架 + 馬達 */}
      <mesh position={[cx, 0.92, 0]}>
        <boxGeometry args={[len, 0.14, 1.15]} />
        <meshStandardMaterial color={jam ? "#4a2a26" : "#2c2c2a"} roughness={0.95} /></mesh>
      {[-0.66, 0.66].map((dz, i) => (
        <mesh key={i} material={MAT.frame} position={[cx, 1.02, dz]}>
          <boxGeometry args={[len, 0.22, 0.06]} /></mesh>))}
      {legs.map((lx, i) => (
        <group key={i}>
          <mesh material={MAT.frame} position={[lx, 0.45, -0.5]}>
            <boxGeometry args={[0.09, 0.9, 0.09]} /></mesh>
          <mesh material={MAT.frame} position={[lx, 0.45, 0.5]}>
            <boxGeometry args={[0.09, 0.9, 0.09]} /></mesh>
        </group>))}
      <mesh material={MAT.darkSteel} position={[x2 - 0.35, 0.62, -0.75]}>
        <boxGeometry args={[0.7, 0.5, 0.35]} /></mesh>
      {/* 光電感測器（入口/出口） */}
      {[x1 + 0.4, x2 - 0.4].map((sx, i) => (
        <group key={i}>
          <mesh material={MAT.fencePost} position={[sx, 1.25, -0.72]}>
            <boxGeometry args={[0.05, 0.5, 0.05]} /></mesh>
          <mesh position={[sx, 1.42, -0.68]}>
            <boxGeometry args={[0.08, 0.08, 0.08]} />
            <meshStandardMaterial color="#c98500" emissive="#c98500"
              emissiveIntensity={jam ? 0 : 1.2} /></mesh>
        </group>))}
      {/* 流向箭頭（belt 上的 chevron） */}
      {[0.25, 0.5, 0.75].map((f, i) => (
        <mesh key={i} position={[x1 + f * len, 1.0, 0]} rotation-x={-Math.PI / 2}
          rotation-z={-Math.PI / 2}>
          <coneGeometry args={[0.18, 0.36, 3]} />
          <meshBasicMaterial color={jam ? "#d03b3b" : "#5a8ab5"} transparent opacity={0.8} />
        </mesh>))}
    </group>
  );
}

/* ---------------- Buffer Slot 網格（§36.7；instanced，單位 draw call） ---------------- */
export function BufferSlots({ x, z, cols, cap, occ, stage, label, slotW = 0.85, slotD = 0.7 }:
  { x: number; z: number; cols: number; cap: number; occ: number; stage: string;
    label: string; slotW?: number; slotD?: number }) {
  const rows = Math.ceil(cap / cols);
  const centers = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < cap; i++) {
      out.push([
        (i % cols) * slotW - ((cols - 1) * slotW) / 2,
        Math.floor(i / cols) * slotD - ((rows - 1) * slotD) / 2,
      ]);
    }
    return out;
  }, [cap, cols, rows, slotW, slotD]);
  // 全部 slot 外框 → 一個 lineSegments
  const frameGeo = useMemo(() => {
    const pts: number[] = [];
    const hw = (slotW * 0.82) / 2, hd = (slotD * 0.82) / 2;
    for (const [cx, cz] of centers) {
      const c = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      for (let e = 0; e < 4; e++) {
        const a = c[e], b = c[(e + 1) % 4];
        pts.push(cx + a[0], 0, cz + a[1], cx + b[0], 0, cz + b[1]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [centers, slotW, slotD]);
  // 占用零件 → InstancedMesh（材質依 stage）
  const inst = useRef<THREE.InstancedMesh>(null);
  useFrame(() => {
    if (!inst.current) return;
    const m = new THREE.Matrix4();
    for (let i = 0; i < Math.min(occ, cap); i++) {
      m.setPosition(centers[i][0], 0.16, centers[i][1]);
      inst.current.setMatrixAt(i, m);
    }
    inst.current.count = Math.min(occ, cap);
    inst.current.instanceMatrix.needsUpdate = true;
  });
  const partMat = PART_MAT[stage] ?? PART_MAT.raw;
  return (
    <group position={[x, 0, z]}>
      <lineSegments geometry={frameGeo} position={[0, 0.03, 0]}>
        <lineBasicMaterial color="#7a7a72" />
      </lineSegments>
      <instancedMesh ref={inst} args={[undefined, undefined, cap]} material={partMat}>
        <boxGeometry args={[0.6, 0.26, 0.45]} />
      </instancedMesh>
      <Label position={[0, 1.7, -(rows * slotD) / 2 - 0.4]} size={0.8} color="#898781" tier={1}
        text={`${label} ${occ}/${cap}`} />
    </group>
  );
}

/* ---------------- Maintenance Operator（§36.10：僅維修時出現） ---------------- */
export function Operator({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
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
      <Label position={[0, 2.4, 0]} size={0.6} color="#e8d84a" text="MAINT" tier={0} priority={4} />
    </group>
  );
}

/* ---------------- 工具架 / 維修車（§36.10） ---------------- */
export function ToolRack({ x, z, ry = 0 }: { x: number; z: number; ry?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      <mesh material={MAT.frame} position={[0, 0.9, 0]}><boxGeometry args={[1.6, 1.8, 0.12]} /></mesh>
      {[[-0.5, 1.3], [0, 1.3], [0.5, 1.3], [-0.3, 0.75], [0.3, 0.75]].map(([dx, dy], i) => (
        <mesh key={i} material={MAT.steel} position={[dx, dy, 0.12]}>
          <boxGeometry args={[0.16, 0.34, 0.1]} /></mesh>))}
    </group>
  );
}

export function MaintCart({ x, z, ry = 0 }: { x: number; z: number; ry?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      <mesh material={MAT.hazard} position={[0, 0.55, 0]}><boxGeometry args={[1.1, 0.7, 0.6]} /></mesh>
      <mesh material={MAT.darkSteel} position={[0, 0.95, 0]}><boxGeometry args={[1.15, 0.08, 0.65]} /></mesh>
      {[[-0.4, -0.22], [0.4, -0.22], [-0.4, 0.22], [0.4, 0.22]].map(([dx, dz], i) => (
        <mesh key={i} material={MAT.frame} position={[dx, 0.12, dz]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.1, 0.1, 0.06, 8]} /></mesh>))}
    </group>
  );
}

/* ---------------- 焊接火花（§36.3：只在 WELDING 相位） ---------------- */
const SPARK_N = 46;
export function Sparks({ position, withLight = true }:
  { position: [number, number, number]; withLight?: boolean }) {
  const pts = useRef<THREE.Points>(null);
  const arr = useMemo(() => new Float32Array(SPARK_N * 3), []);
  useFrame(() => {
    for (let i = 0; i < SPARK_N; i++) {
      const r = Math.random() * 0.55, a = Math.random() * Math.PI * 2;
      arr[i * 3] = Math.cos(a) * r * Math.random();
      arr[i * 3 + 1] = Math.random() * 0.55;
      arr[i * 3 + 2] = Math.sin(a) * r * Math.random();
    }
    if (pts.current) {
      (pts.current.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  });
  return (
    <group position={position}>
      <points ref={pts}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[arr, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.09} color="#ffd27a" transparent opacity={0.95}
          depthWrite={false} />
      </points>
      {withLight &&
        <pointLight color="#ffb347" intensity={14} distance={7} decay={2} position={[0, 0.3, 0]} />}
      <mesh><sphereGeometry args={[0.12, 8, 8]} />
        <meshBasicMaterial color="#fff2c0" /></mesh>
    </group>
  );
}

/* ---------------- §39 Intralogistics props ---------------- */
/* §46.2 五色料箱：藍=原料、灰=空箱、綠=良品、紅=不良/Scrap、黃=Rework/Hold */
const TOTE_COLORS: Record<string, string> = {
  full: "#3987e5", empty: "#6b6b66", fg: "#199e70",
  reject: "#c0392b", hold: "#e8c832",
};

export function Tote({ kind = "full", scale = 1 }: { kind?: string; scale?: number }) {
  return (
    <group scale={scale}>
      <mesh position={[0, 0.12, 0]}>
        <boxGeometry args={[0.62, 0.26, 0.44]} />
        <meshStandardMaterial color={TOTE_COLORS[kind] ?? "#3987e5"} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.26, 0]}>
        <boxGeometry args={[0.64, 0.03, 0.46]} />
        <meshStandardMaterial color="#22221f" roughness={0.9} />
      </mesh>
    </group>
  );
}

/** Cell-side FIFO Rack（§39.1）：2 層 × 5 slot；1 tote ≈ capacity/10 單位。 */
export function Rack({ x, z, ry = 0, qty, capacity, low, sku, label }: {
  x: number; z: number; ry?: number; qty: number; capacity: number;
  low: boolean; sku: string; label: string;
}) {
  const slots = 10;
  const filled = Math.min(slots, Math.ceil((qty / Math.max(1, capacity)) * slots));
  const totes = [];
  for (let i = 0; i < filled; i++) {
    const row = Math.floor(i / 5), col = i % 5;
    totes.push(
      <group key={i} position={[-1.44 + col * 0.72, 0.32 + row * 0.62, 0]}>
        <Tote kind="full" scale={0.95} />
      </group>);
  }
  const tint = qty <= 0 ? "#d03b3b" : low ? "#c98500" : "#898781";
  return (
    <group position={[x, 0, z]} rotation-y={ry}>
      {[-1.75, 1.75].map((px) => (
        <mesh key={px} material={MAT.frame} position={[px, 0.72, 0]}>
          <boxGeometry args={[0.09, 1.44, 0.6]} /></mesh>))}
      {[0.28, 0.9, 1.46].map((py) => (
        <mesh key={py} material={MAT.steel} position={[0, py, 0]}>
          <boxGeometry args={[3.6, 0.05, 0.62]} /></mesh>))}
      {totes}
      {/* §44.6 FIFO 流向標示：AMR 於 +z 卸入 → Cell 於 −z 取用 */}
      {[-1.1, 0, 1.1].map((px, i) => (
        <mesh key={"c" + i} position={[px, 0.022, 0.85]} rotation-x={-Math.PI / 2}>
          <coneGeometry args={[0.15, 0.38, 3]} />
          <meshBasicMaterial color="#2a5d9f" transparent opacity={0.8} /></mesh>))}
      <mesh position={[0, 0.016, 1.15]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[3.7, 0.14]} />
        <meshBasicMaterial color="#2a5d9f" transparent opacity={0.5} /></mesh>
      <Label position={[0, 2.05, 0]} size={0.62} color={tint} tier={1}
        text={`${sku} ${label}`} />
    </group>
  );
}

/** Component Supermarket（§39.1）：3 bay × 3 層，庫存水位 = Twin State。 */
export function Supermarket({ x, z, qty, capacity }: {
  x: number; z: number; qty: number; capacity: number;
}) {
  const slots = 27;                     // 3 bay × 3 層 × 3 tote
  const filled = Math.min(slots, Math.round((qty / Math.max(1, capacity)) * slots));
  const totes = [];
  for (let i = 0; i < filled; i++) {
    const bay = Math.floor(i / 9), lvl = Math.floor((i % 9) / 3), col = i % 3;
    totes.push(
      <group key={i} position={[-4.1 + bay * 4.1 + (col - 1) * 1.05, 0.34 + lvl * 0.72, 0]}>
        <Tote kind="full" />
      </group>);
  }
  return (
    <group position={[x, 0, z]}>
      {[-6.2, -2.05, 2.05, 6.2].map((px) => (
        <mesh key={px} material={MAT.frame} position={[px, 1.15, 0]}>
          <boxGeometry args={[0.1, 2.3, 0.7]} /></mesh>))}
      {[0.3, 1.02, 1.74, 2.32].map((py) => (
        <mesh key={py} material={MAT.steel} position={[0, py, 0]}>
          <boxGeometry args={[12.5, 0.06, 0.72]} /></mesh>))}
      {totes}
      <Label position={[0, 2.95, 0]} size={0.85} color="#898781" tier={1}
        text={`SUPERMARKET ${qty}/${capacity}`} />
    </group>
  );
}

/** Finished Goods Staging（§39.1）：出貨暫存區；量 = shipped 的視覺提示。 */
export function Staging({ x, z, shipped }: { x: number; z: number; shipped: number }) {
  const stacks = Math.min(6, Math.floor((shipped % 120) / 20));
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.015, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[7, 5]} />
        <meshBasicMaterial color="#20301f" transparent opacity={0.55} /></mesh>
      {[...Array(stacks)].map((_, i) => (
        <group key={i} position={[-2.4 + (i % 3) * 2.4, 0, i < 3 ? -1.1 : 1.1]}>
          <mesh material={MAT.hazard} position={[0, 0.11, 0]}>
            <boxGeometry args={[1.5, 0.2, 1.15]} /></mesh>
          <group position={[0, 0.2, 0]}><Tote kind="fg" scale={1.4} /></group>
        </group>))}
      <Label position={[0, 1.9, 0]} size={0.75} color="#898781" tier={1}
        text={`OUTBOUND STAGING · shipped ${shipped}`} />
    </group>
  );
}

/** Docking Marker（§39.5）：AMR 停靠框線。 */
export function DockMarker({ x, z }: { x: number; z: number }) {
  return (
    <mesh position={[x, 0.02, z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.85, 1.0, 4]} />
      <meshBasicMaterial color="#2a5d9f" transparent opacity={0.8} />
    </mesh>
  );
}
