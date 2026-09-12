/** §44 Side-Zone 元件庫：左右兩側「有功能的廠區」。
 *  原則同 §36：每個物件都解釋製程或傳達 Twin State；狀態一律由 snapshot 推導。
 *  材質共用 MAT（draw call 控制）；無新增動態光源、無 per-frame 更新。 */
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Label } from "./Label";
import { MAT, PartMesh, Tote } from "./SceneProps";

const SKU_TINT: Record<string, string> = {
  "WELD-WIRE": "#e5a339", "FASTENER-KIT": "#3987e5",
  "CNC-INSERT": "#b06fd8", "QA-TRAY": "#199e70",
};

/* ---------------- §44.2 Per-SKU Supermarket（4 bay + 空箱架） ---------------- */
export function SupermarketSku({ x, z, perSku, empties }: {
  x: number; z: number;
  perSku: { sku: string; qty: number; capacity: number }[]; empties: number;
}) {
  const BAY_W = 3.9;
  const x0 = -((perSku.length - 1) * BAY_W) / 2;
  return (
    <group position={[x, 0, z]}>
      {/* 骨架：立柱 + 三層橫樑（整排共用） */}
      {[...Array(perSku.length + 1)].map((_, i) => (
        <mesh key={i} material={MAT.frame} position={[x0 - BAY_W / 2 + i * BAY_W, 1.2, 0]}>
          <boxGeometry args={[0.1, 2.4, 0.72]} /></mesh>))}
      {[0.3, 1.02, 1.74, 2.42].map((py) => (
        <mesh key={py} material={MAT.steel} position={[0, py, 0]}>
          <boxGeometry args={[perSku.length * BAY_W + 0.3, 0.06, 0.74]} /></mesh>))}
      {perSku.map((s, bi) => {
        const bx = x0 + bi * BAY_W;
        const slots = 9;                        // 3 層 × 3 tote
        const filled = Math.min(slots, Math.ceil((s.qty / Math.max(1, s.capacity)) * slots));
        const lamp = s.qty <= 0 ? "#d03b3b" : s.qty < 40 ? "#c98500" : "#0ca30c";
        const totes = [];
        for (let i = 0; i < filled; i++) {
          const lvl = Math.floor(i / 3), col = i % 3;
          totes.push(
            <group key={i} position={[bx + (col - 1) * 1.15, 0.34 + lvl * 0.72, 0]}>
              <Tote kind="full" /></group>);
        }
        return (
          <group key={s.sku}>
            {totes}
            {/* Bay 狀態燈 + SKU 招牌 */}
            <mesh position={[bx, 2.62, 0.3]}>
              <boxGeometry args={[0.16, 0.16, 0.1]} />
              <meshStandardMaterial color={lamp} emissive={lamp} emissiveIntensity={1.8} /></mesh>
            <Label position={[bx, 3.0, 0]} size={0.6} color={SKU_TINT[s.sku] ?? "#898781"} tier={2}
              text={`${s.sku} ${s.qty}/${s.capacity}`} />
          </group>);
      })}
      <Label position={[0, 3.7, 0]} size={0.9} color="#dcdcd2" text="MATERIAL SUPERMARKET" tier={0} priority={4} />
      {/* R2：區域地面色差（藍灰）提高 side-zone 辨識度 */}
      <mesh position={[1.4, 0.011, 0.6]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[perSku.length * BAY_W + 7, 4.2]} />
        <meshBasicMaterial color="#2a3240" transparent opacity={0.7} /></mesh>
      {/* 空箱回收架（§44.2：empties = Twin State） */}
      <group position={[(perSku.length * BAY_W) / 2 + 2.6, 0, 0]}>
        {[-1.15, 1.15].map((px) => (
          <mesh key={px} material={MAT.frame} position={[px, 0.75, 0]}>
            <boxGeometry args={[0.08, 1.5, 0.62]} /></mesh>))}
        {[0.26, 0.86, 1.48].map((py) => (
          <mesh key={py} material={MAT.steel} position={[0, py, 0]}>
            <boxGeometry args={[2.35, 0.05, 0.64]} /></mesh>))}
        {[...Array(Math.min(6, empties))].map((_, i) => (
          <group key={i} position={[-0.72 + (i % 3) * 0.72, 0.3 + Math.floor(i / 3) * 0.6, 0]}>
            <Tote kind="empty" scale={0.9} /></group>))}
        <Label position={[0, 2.05, 0]} size={0.55} color="#6b6b66" tier={2}
          text={`EMPTY TOTES · ${empties}`} />
      </group>
    </group>
  );
}

/* ---------------- §44.6 Docking Bay（斜紋框 + ID + 方向 + 佔用燈） ---------------- */
export function DockBay({ x, z, id, occupied, queue = 0, arrowRy = 0 }: {
  x: number; z: number; id: string; occupied: boolean; queue?: number; arrowRy?: number;
}) {
  return (
    <group position={[x, 0, z]}>
      {/* 斜紋邊框（黃黑段交錯的四邊） */}
      {[[0, -1.05, 2.3, 0.16, 0], [0, 1.05, 2.3, 0.16, 0],
        [-1.15, 0, 0.16, 1.94, 0], [1.15, 0, 0.16, 1.94, 0]].map(([dx, dz, w, d], i) => (
        <mesh key={i} position={[dx as number, 0.018, dz as number]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[w as number, d as number]} />
          <meshBasicMaterial color={occupied ? "#b98a10" : "#6a5410"} /></mesh>))}
      <mesh position={[0, 0.014, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[2.1, 1.9]} />
        <meshBasicMaterial color="#22221f" transparent opacity={0.7} /></mesh>
      {/* 進入方向箭頭 */}
      <mesh position={[0, 0.022, 0]} rotation-x={-Math.PI / 2} rotation-z={arrowRy}>
        <coneGeometry args={[0.3, 0.7, 3]} />
        <meshBasicMaterial color={occupied ? "#4fc3f7" : "#2a5d9f"} /></mesh>
      {/* 佔用狀態燈（矮柱） */}
      <mesh material={MAT.fencePost} position={[1.35, 0.45, -0.9]}>
        <cylinderGeometry args={[0.04, 0.04, 0.9, 6]} /></mesh>
      <mesh position={[1.35, 0.95, -0.9]}>
        <sphereGeometry args={[0.08, 8, 8]} />
        <meshStandardMaterial color={occupied ? "#4fc3f7" : "#3a3a36"}
          emissive={occupied ? "#4fc3f7" : "#000"} emissiveIntensity={occupied ? 2 : 0} /></mesh>
      <Label position={[0, 1.5, 0]} size={0.5}
        color={queue > 0 ? "#fab219" : occupied ? "#4fc3f7" : "#6d6d66"}
        tier={queue > 0 ? 1 : 2} priority={queue > 0 ? 8 : 1}
        text={`${id}${occupied ? " · BUSY" : ""}${queue > 0 ? ` · Q${queue}` : ""}`} />
    </group>
  );
}

/* ---------------- §44.8 FG Staging（棧板 = staging state；出貨看板） ---------------- */
export function PalletStaging({ x, z, units, palletSize, palletsPerTruck, outboundTotal,
  stage = "IDLE", progress = 0 }: {
  x: number; z: number; units: number; palletSize: number;
  palletsPerTruck: number; outboundTotal: number; stage?: string; progress?: number;
}) {
  const fullPallets = Math.floor(units / palletSize);
  const partial = units % palletSize;
  const spots = [...Array(palletsPerTruck)].map((_, i) => i);
  // §45.4 裝車：DOCKED 期間滿板依權威進度滑向出貨門（+x）；SHIPPED 時引擎清空 staging
  const slide = stage === "DOCKED" ? progress * 6.2 : 0;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.012, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[9, 6.5]} />
        <meshBasicMaterial color="#27392a" transparent opacity={0.7} /></mesh>
      {/* empty-state 明確標示（不讓空棧板區像未使用場地） */}
      {units === 0 && (
        <Label position={[0, 0.9, -1.2]} size={0.55} color="#6f8a74" tier={1}
          text="EMPTY · awaiting finished-goods pallets" />)}
      {spots.map((i) => {
        const px = -2.9 + i * 2.9;
        const isFull = i < fullPallets;
        const isPartial = i === fullPallets && partial > 0;
        const nTotes = isFull ? 8 : isPartial ? Math.ceil((partial / palletSize) * 8) : 0;
        return (
          <group key={i} position={[px + (isFull ? slide : 0), 0, -1.2]}>
            {/* 棧板格位框線 */}
            <mesh position={[0, 0.016, 0]} rotation-x={-Math.PI / 2}>
              <ringGeometry args={[1.18, 1.28, 4]} />
              <meshBasicMaterial color={isFull ? "#199e70" : "#4a4a44"} /></mesh>
            {(isFull || isPartial) && (
              <mesh material={MAT.hazard} position={[0, 0.11, 0]}>
                <boxGeometry args={[1.6, 0.2, 1.25]} /></mesh>)}
            {[...Array(nTotes)].map((_, j) => (
              <group key={j}
                position={[-0.45 + (j % 2) * 0.9, 0.22 + Math.floor((j % 4) / 2) * 0.34,
                  -0.32 + Math.floor(j / 4) * 0.64]}>
                <Tote kind="fg" scale={1.05} /></group>))}
          </group>);
      })}
      {/* 出貨看板（shipping board；靠出貨門側、面向廠內） */}
      <group position={[3.9, 0, -0.6]} rotation-y={-Math.PI / 2}>
        {[-2.2, 2.2].map((px) => (
          <mesh key={px} material={MAT.fencePost} position={[px, 1.5, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 3.0, 6]} /></mesh>))}
        <mesh material={MAT.darkSteel} position={[0, 2.65, 0]}>
          <boxGeometry args={[5.2, 1.15, 0.1]} /></mesh>
        <Label position={[0, 2.95, 0.1]} size={0.6} color="#199e70" tier={1}
          text={`OUTBOUND STAGING · ${units}/${palletSize * palletsPerTruck} on pallets`} />
        <Label position={[0, 2.35, 0.1]} size={0.55} color="#898781" tier={2}
          text={`shipped total ${outboundTotal} · truck at ${palletsPerTruck} pallets`} />
      </group>
    </group>
  );
}

/* ---------------- §44.7 充電站升級（接觸板 + 禁停面） ---------------- */
export function ChargingPad({ x, z, active = false }: { x: number; z: number; active?: boolean }) {
  return (
    <group position={[x, 0, z]}>
      <mesh material={MAT.cabinet} position={[0, 0.55, 0]}>
        <boxGeometry args={[0.9, 1.1, 0.4]} /></mesh>
      <mesh position={[0, 0.9, 0.21]}>
        <boxGeometry args={[0.24, 0.14, 0.02]} />
        <meshStandardMaterial color={active ? "#0ca30c" : "#3a5a3a"}
          emissive={active ? "#0ca30c" : "#000"} emissiveIntensity={active ? 1.4 : 0} /></mesh>
      {/* 地面充電接觸板（銅色） */}
      <mesh position={[0, 0.02, -1.2]}>
        <boxGeometry args={[0.7, 0.03, 0.5]} />
        <meshStandardMaterial color="#a67434" metalness={0.8} roughness={0.35} /></mesh>
      <mesh position={[0, 0.024, -1.2]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.75, 0.85, 4]} />
        <meshBasicMaterial color="#c98500" transparent opacity={0.8} /></mesh>
    </group>
  );
}

/* ---------------- §44.3 Control & Utility Spine（每 Cell 後方） ---------------- */
const SPINE_TINT: Record<string, string> = {
  RUNNING: "#0ca30c", BLOCKED: "#c98500", STARVED: "#c98500",
  DEGRADED: "#c98500", FAULT: "#d03b3b",
};
export function ControlSpine({ cx, short, state }: {
  cx: number; short: string; state: string;
}) {
  const lamp = SPINE_TINT[state] ?? "#5b5b56";
  const boxes: [number, number, number][] = [[-2.4, 1.9, 0.9], [0, 1.6, 0.8], [2.3, 1.75, 1.1]];
  return (
    <group position={[cx, 0, -11.9]}>
      {boxes.map(([dx, h, w], i) => (
        <group key={i} position={[dx, 0, 0]}>
          <mesh material={MAT.cabinet} position={[0, h / 2, 0]}>
            <boxGeometry args={[w + 0.5, h, 0.66]} /></mesh>
          <mesh material={MAT.darkSteel} position={[0, h * 0.55, 0.34]}>
            <boxGeometry args={[w * 0.6, h * 0.5, 0.02]} /></mesh>
          <mesh position={[w * 0.3, h - 0.18, 0.34]}>
            <boxGeometry args={[0.1, 0.1, 0.02]} />
            <meshStandardMaterial color={lamp} emissive={lamp} emissiveIntensity={1.6} /></mesh>
        </group>))}
      {/* 纜線落管（spine → cell） */}
      <mesh material={MAT.darkSteel} position={[0, 2.6, 0]}>
        <boxGeometry args={[6.4, 0.14, 0.4]} /></mesh>
      <Label position={[0, 3.2, 0]} size={0.55} color="#7d8fc9" tier={2}
        text={`RC-${short}-01 · PLC-${short} · E-CAB-${short}`} />
    </group>
  );
}

/* ---------------- §44.4 Maintenance Area（後區中央） ---------------- */
export function MaintenanceArea({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.011, 0.4]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[11, 7]} />
        <meshStandardMaterial color="#30302c" roughness={0.95} /></mesh>
      {/* 工作桌 + 虎鉗 + 零件 */}
      <group position={[-3.4, 0, -1]}>
        <mesh material={MAT.darkSteel} position={[0, 0.85, 0]}>
          <boxGeometry args={[2.6, 0.1, 1.2]} /></mesh>
        {[[-1.15, -0.45], [1.15, -0.45], [-1.15, 0.45], [1.15, 0.45]].map(([dx, dz], i) => (
          <mesh key={i} material={MAT.frame} position={[dx, 0.42, dz]}>
            <boxGeometry args={[0.08, 0.84, 0.08]} /></mesh>))}
        <mesh material={MAT.steel} position={[-0.7, 1.0, 0]}>
          <boxGeometry args={[0.35, 0.22, 0.3]} /></mesh>
        <group position={[0.5, 0.9, 0]}><PartMesh stage="welded" scale={0.8} /></group>
      </group>
      {/* 工具櫃 + 備品架（灰 tote） */}
      <group position={[1.2, 0, -2.4]}>
        <mesh material={MAT.cabinet} position={[0, 0.9, 0]}>
          <boxGeometry args={[1.4, 1.8, 0.7]} /></mesh>
        {[0.35, 0.85, 1.35].map((py) => (
          <mesh key={py} material={MAT.frame} position={[0, py, 0.36]}>
            <boxGeometry args={[1.3, 0.04, 0.03]} /></mesh>))}
      </group>
      <group position={[3.8, 0, -2.3]}>
        {[-0.9, 0.9].map((px) => (
          <mesh key={px} material={MAT.frame} position={[px, 0.8, 0]}>
            <boxGeometry args={[0.08, 1.6, 0.6]} /></mesh>))}
        {[0.3, 0.95, 1.58].map((py) => (
          <mesh key={py} material={MAT.steel} position={[0, py, 0]}>
            <boxGeometry args={[1.85, 0.05, 0.62]} /></mesh>))}
        {[[-0.55, 0.34], [0.55, 0.34], [0, 0.99]].map(([px, py], i) => (
          <group key={i} position={[px, py, 0]}><Tote kind="empty" scale={0.85} /></group>))}
      </group>
      {/* LOTO 看板（紅底 + 黃色掛牌） */}
      <group position={[-0.6, 0, -3.1]}>
        <mesh material={MAT.fencePost} position={[0, 1.1, 0]}>
          <boxGeometry args={[0.08, 2.2, 0.08]} /></mesh>
        <mesh position={[0, 1.75, 0.06]}>
          <boxGeometry args={[1.5, 0.9, 0.05]} />
          <meshStandardMaterial color="#7a1f1f" /></mesh>
        {[-0.45, -0.15, 0.15, 0.45].map((dx, i) => (
          <mesh key={i} position={[dx, 1.6, 0.1]}>
            <boxGeometry args={[0.14, 0.24, 0.02]} />
            <meshStandardMaterial color="#e8d84a" /></mesh>))}
      </group>
      <Label position={[0, 3.0, -1]} size={0.75} color="#e8d84a" text="MAINTENANCE" tier={0} priority={3} />
    </group>
  );
}

/* ---------------- §44.5 Quarantine（HELD = rework 佔用；scrap = 權威計數） -------- */
export function QuarantineCage({ x, z, held, scrap }: {
  x: number; z: number; held: number; scrap: number;
}) {
  const W = 6.4, D = 4.6, H = 1.9;
  const redMesh = held > 0;
  return (
    <group position={[x, 0, z]}>
      {[[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2],
        [0, -D / 2], [0, D / 2]].map(([px, pz], i) => (
        <mesh key={i} material={MAT.fencePost} position={[px, H / 2, pz]}>
          <boxGeometry args={[0.08, H, 0.08]} /></mesh>))}
      {/* 圍網（紅調半透明；留 +z 開口當入口） */}
      <mesh position={[0, H / 2, -D / 2]}>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color="#6a2a26" transparent opacity={0.3}
          side={THREE.DoubleSide} /></mesh>
      {[-W / 2, W / 2].map((px, i) => (
        <mesh key={i} position={[px, H / 2, 0]} rotation-y={Math.PI / 2}>
          <planeGeometry args={[D, H]} />
          <meshStandardMaterial color="#6a2a26" transparent opacity={0.3}
            side={THREE.DoubleSide} /></mesh>))}
      <mesh position={[W / 4 + 0.4, H / 2, D / 2]}>
        <planeGeometry args={[W / 2 - 0.8, H]} />
        <meshStandardMaterial color="#6a2a26" transparent opacity={0.3}
          side={THREE.DoubleSide} /></mesh>
      {/* HELD 零件（reject 樣式） */}
      {[...Array(Math.min(6, held))].map((_, i) => (
        <group key={i} position={[-2.2 + (i % 3) * 1.1, 0.05, -1.2 + Math.floor(i / 3) * 1.1]}>
          <PartMesh stage="reject" scale={0.9} /></group>))}
      {/* Scrap bin */}
      <group position={[2.2, 0, -1.3]}>
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[1.3, 1.0, 1.0]} />
          <meshStandardMaterial color="#5a2320" roughness={0.8} /></mesh>
        <Label position={[0, 1.4, 0]} size={0.45} color="#d03b3b" text={`SCRAP ${scrap}`} tier={2} />
      </group>
      {/* Red-tag 站 + 人工複判桌 */}
      <group position={[2.2, 0, 1.2]}>
        <mesh material={MAT.fencePost} position={[0, 0.9, 0]}>
          <boxGeometry args={[0.07, 1.8, 0.07]} /></mesh>
        <mesh position={[0, 1.45, 0.05]}>
          <boxGeometry args={[0.55, 0.55, 0.04]} />
          <meshStandardMaterial color="#a02525" /></mesh>
      </group>
      <group position={[-1.6, 0, 1.35]}>
        <mesh material={MAT.darkSteel} position={[0, 0.8, 0]}>
          <boxGeometry args={[1.9, 0.09, 0.95]} /></mesh>
        {[[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]].map(([dx, dz], i) => (
          <mesh key={i} material={MAT.frame} position={[dx, 0.4, dz]}>
            <boxGeometry args={[0.07, 0.8, 0.07]} /></mesh>))}
        <mesh material={MAT.screen} position={[0.55, 1.15, -0.2]} rotation-x={-0.4}>
          <boxGeometry args={[0.5, 0.35, 0.03]} /></mesh>
      </group>
      <Label position={[0, 2.7, 0]} size={0.7} color={redMesh ? "#d03b3b" : "#8a5a52"} tier={0} priority={3}
        text={`QUARANTINE · HELD ${held}`} />
    </group>
  );
}

/* ---------------- §44.10 Utilities（壓縮機隨焊接活動；HVAC 常載） ---------------- */
export function UtilityZone({ x, z, compressorActive }: {
  x: number; z: number; compressorActive: boolean;
}) {
  const lamp = compressorActive ? "#0ca30c" : "#c98500";
  return (
    <group position={[x, 0, z]}>
      {/* Air compressor：臥式儲氣槽 + 馬達 + 壓力表 */}
      <group position={[-3.2, 0, 0]}>
        <mesh material={MAT.steel} position={[0, 0.95, 0]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.75, 0.75, 3.2, 16]} /></mesh>
        {[-1.1, 1.1].map((dx, i) => (
          <mesh key={i} material={MAT.frame} position={[dx, 0.25, 0]}>
            <boxGeometry args={[0.25, 0.5, 1.2]} /></mesh>))}
        <mesh material={MAT.darkSteel} position={[0.6, 1.95, 0]}>
          <boxGeometry args={[1.1, 0.7, 0.8]} /></mesh>
        <mesh position={[-0.8, 1.95, 0]}>
          <cylinderGeometry args={[0.16, 0.16, 0.1, 10]} />
          <meshStandardMaterial color="#e8e8e0" /></mesh>
        <mesh position={[1.15, 2.15, 0.3]}>
          <sphereGeometry args={[0.09, 8, 8]} />
          <meshStandardMaterial color={lamp} emissive={lamp} emissiveIntensity={2} /></mesh>
        <Label position={[0, 2.85, 0]} size={0.55} color="#5e9ea0" tier={1}
          text={`AIR COMPRESSOR${compressorActive ? " · WELD LOAD" : ""}`} />
      </group>
      {/* HVAC / chiller：機箱 + 風扇格柵 + 屋頂風管 */}
      <group position={[3.6, 0, 0]}>
        <mesh material={MAT.cabinet} position={[0, 1.25, 0]}>
          <boxGeometry args={[3.2, 2.5, 1.6]} /></mesh>
        {[-0.8, 0.8].map((dx, i) => (
          <mesh key={i} position={[dx, 1.55, 0.81]}>
            <torusGeometry args={[0.45, 0.06, 8, 18]} />
            <meshStandardMaterial color="#3a3a38" /></mesh>))}
        {[-0.8, 0.8].map((dx, i) => (
          <mesh key={"f" + i} material={MAT.darkSteel} position={[dx, 1.55, 0.8]}>
            <cylinderGeometry args={[0.4, 0.4, 0.04, 12]} /></mesh>))}
        <mesh material={MAT.darkSteel} position={[0, 3.4, -0.3]}>
          <boxGeometry args={[0.8, 1.8, 0.8]} /></mesh>
        <Label position={[0, 3.1, 0.6]} size={0.55} color="#7d8fc9" text="HVAC" tier={1} />
      </group>
      {/* 配電盤（MDP） */}
      <group position={[8.2, 0, -0.3]}>
        <mesh material={MAT.cabinet} position={[0, 1.05, 0]}>
          <boxGeometry args={[2.0, 2.1, 0.55]} /></mesh>
        <mesh position={[0, 1.7, 0.29]}>
          <boxGeometry args={[0.4, 0.4, 0.02]} />
          <meshStandardMaterial color="#b98a10" /></mesh>
        <Label position={[0, 2.6, 0]} size={0.5} color="#898781" text="MDP-01" tier={2} />
      </group>
    </group>
  );
}

/** 壓縮空氣幹管：utilities → 焊接 Cell（沿後牆，帶垂直落管）。 */
const pipeMat = new THREE.MeshStandardMaterial({
  color: "#5e9ea0", metalness: 0.5, roughness: 0.5 });
export function AirPipe({ fromX, toX, z }: { fromX: number; toX: number; z: number }) {
  const midX = (fromX + toX) / 2, len = Math.abs(fromX - toX);
  return (
    <group>
      <mesh material={pipeMat} position={[midX, 7.0, z]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.14, 0.14, len, 8]} /></mesh>
      {/* 落管：焊接端（下至 cell 後方）與 utilities 端 */}
      {[toX, fromX].map((px, i) => (
        <mesh key={i} material={pipeMat} position={[px, i === 0 ? 4.4 : 5.0, z]}>
          <cylinderGeometry args={[0.12, 0.12, i === 0 ? 5.2 : 4.0, 8]} /></mesh>))}
    </group>
  );
}

/* ---------------- §44.9 Overhead：CCTV 燈柱、Andon、EXIT ---------------- */
/** CCTV 實體攝影機（位置 = §38 CAMERAS；朝向由 look 推導）。 */
export function CctvProp({ pos, look }: {
  pos: [number, number, number]; look: [number, number, number];
}) {
  const yaw = Math.atan2(look[0] - pos[0], look[2] - pos[2]);
  const dxz = Math.hypot(look[0] - pos[0], look[2] - pos[2]);
  const pitch = Math.atan2(pos[1] - look[1], dxz);
  /* 機身沿視線後退 1.1（PIP 虛擬相機正好在 pos —— 不得被自己的機殼擋住） */
  const back: [number, number, number] = [
    pos[0] - ((look[0] - pos[0]) / dxz) * 1.1, pos[1] + 0.12,
    pos[2] - ((look[2] - pos[2]) / dxz) * 1.1];
  return (
    <group position={back}>
      <mesh material={MAT.fencePost} position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 1.1, 6]} /></mesh>
      <group rotation-y={yaw}>
        <group rotation-x={pitch}>
          <mesh material={MAT.darkSteel} position={[0, 0, 0.25]}>
            <boxGeometry args={[0.26, 0.26, 0.62]} /></mesh>
          <mesh position={[0, 0, 0.58]} rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.1, 0.13, 0.14, 10]} />
            <meshStandardMaterial color="#14181c" /></mesh>
          <mesh position={[0.1, 0.16, 0.05]}>
            <sphereGeometry args={[0.035, 6, 6]} />
            <meshStandardMaterial color="#d03b3b" emissive="#d03b3b" emissiveIntensity={2} /></mesh>
        </group>
      </group>
    </group>
  );
}

/** Andon Board（吊掛；即時 KPI = snapshot 推導）。 */
export function AndonBoard({ x, z, line1, line2, line3, alert }: {
  x: number; z: number; line1: string; line2: string; line3?: string; alert: boolean;
}) {
  return (
    <group position={[x, 0, z]}>
      {[-4.2, 4.2].map((dx, i) => (
        <mesh key={i} material={MAT.frame} position={[dx, 9.1, 0]}>
          <boxGeometry args={[0.12, 2.6, 0.12]} /></mesh>))}
      <mesh material={MAT.darkSteel} position={[0, 6.85, 0]}>
        <boxGeometry args={[9.6, 2.5, 0.25]} /></mesh>
      <mesh material={MAT.screen} position={[0, 6.85, 0.14]}>
        <boxGeometry args={[9.2, 2.1, 0.02]} /></mesh>
      <Label position={[0, 7.45, 0.3]} size={0.72} color="#e8e8e0" text={line1} tier={0} priority={6} />
      <Label position={[0, 6.8, 0.3]} size={0.62} tier={0} priority={6}
        color={alert ? "#ec835a" : "#7fd2a8"} text={line2} />
      {line3 && <Label position={[0, 6.2, 0.3]} size={0.55} tier={0} priority={6}
        color={line3.includes("NORMAL") ? "#9fc4ff" : "#ec835a"} text={line3} />}
    </group>
  );
}

export function ExitSign({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 4.6, 0]}>
        <boxGeometry args={[1.3, 0.5, 0.12]} />
        <meshStandardMaterial color="#123f26" emissive="#2e7d4f" emissiveIntensity={0.9} /></mesh>
      <Label position={[0, 4.6, 0.12]} size={0.4} color="#9fe8c0" text="EXIT" tier={2} />
    </group>
  );
}

/* ---------------- §44.8 側牆 + Roll-up Door（收貨 −x／出貨 +x） ---------------- */
export function SideWallDoor({ x, z, label, tint, open = false }: {
  x: number; z: number; label: string; tint: string; open?: boolean;
}) {
  const sign = x > 0 ? -1 : 1;                  // 面向廠內
  const slats = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!slats.current) return;
    const target = open ? 0.1 : 1;              // §45.3/45.4 捲門：板條向頂端捲收
    slats.current.scale.y += (target - slats.current.scale.y) * Math.min(1, dt * 2.2);
  });
  return (
    <group position={[x, 0, z]} rotation-y={sign * Math.PI / 2}>
      {/* 牆段（淺鋼板，避免像懸浮黑塊） */}
      {[-4.1, 4.1].map((dx, i) => (
        <mesh key={i} material={MAT.steel} position={[dx, 3.3, 0]}>
          <boxGeometry args={[2.4, 6.6, 0.3]} /></mesh>))}
      <mesh material={MAT.steel} position={[0, 6.0, 0]}>
        <boxGeometry args={[10.6, 1.3, 0.3]} /></mesh>
      {/* Roll-up door（橫向板條；open → 向上捲收） */}
      <group ref={slats} position={[0, 5.35, 0.05]}>
        {[...Array(7)].map((_, i) => (
          <mesh key={i} material={MAT.cabinet} position={[0, -4.9 + i * 0.74, 0]}>
            <boxGeometry args={[5.7, 0.66, 0.1]} /></mesh>))}
      </group>
      <mesh material={MAT.hazard} position={[0, 0.06, 0.4]}>
        <boxGeometry args={[6.2, 0.06, 0.5]} /></mesh>
      {/* 門狀態燈（open 綠） */}
      <mesh position={[3.2, 5.1, 0.25]}>
        <sphereGeometry args={[0.1, 8, 8]} />
        <meshStandardMaterial color={open ? "#0ca30c" : "#3a3a36"}
          emissive={open ? "#0ca30c" : "#000"} emissiveIntensity={open ? 2 : 0} /></mesh>
      <Label position={[0, 6.4, 0.4]} size={0.7} color={tint} text={label} tier={0} priority={4} />
    </group>
  );
}
