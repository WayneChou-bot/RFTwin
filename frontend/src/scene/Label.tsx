/** 離線文字標籤：CanvasTexture sprite（不依賴外部字型/CDN）。
 *
 *  §45.10＋§46 Label 2.0：
 *  - tier 0（Cell Sign／Zone Sign／Andon／AMR ID 等，永遠參與）、tier 1（Equipment
 *    Tag：Robot/Station ID、buffer、camera、設備狀態）、tier 2（近景細節）。
 *  - 模式 Auto / All / Alerts / Off（`setLabelsMode`；Auto 依距離分級）。
 *  - tier ≥1 為「固定螢幕像素」動態標籤：每回合依距離重算 scale（夾制上下限），
 *    透視下不會縮到不可讀；同時可見的動態標籤 ≤ 20（All 模式 ≤ 60）。
 *  - 優先序（呼叫端依狀態傳入）：ERROR/SAFETY 10 > Selected 9 > WARN/BLOCKED 8 >
 *    BOTTLENECK 7 > 一般 2 > 裝飾 1；螢幕空間 greedy 碰撞，高優先／較近者保留。
 *  - 避讓每 150 ms 計算一次（非每幀）；文字貼圖有快取，內容不變不重建。
 *  - 深度測試維持開啟：被牆/設備遮住時自然不顯示（不穿透模型）。 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const cache = new Map<string, THREE.CanvasTexture>();

function makeTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${color}|${text}`;
  let tex = cache.get(key);
  if (tex) return tex;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = "600 34px system-ui, 'Segoe UI', 'Microsoft JhengHei', sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w; c.height = 48;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, 8, 26);
  tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 2;
  cache.set(key, tex);
  if (cache.size > 300) cache.clear();          // 粗略防洩漏
  return tex;
}

/* ---------------- registry（每個 Canvas/scene 各自管理） ---------------- */
type Entry = { ref: React.RefObject<THREE.Sprite | null>; tier: number; priority: number;
  scene: THREE.Scene; aspect: number; baseSize: number };
const registry = new Set<Entry>();

export type LabelsMode = "auto" | "all" | "alerts" | "off";
let labelsMode: LabelsMode = "auto";
export function setLabelsMode(m: LabelsMode): void { labelsMode = m; }
export function getLabelsMode(): LabelsMode { return labelsMode; }
/* 舊 API 相容（on/off） */
export function setLabelsEnabled(v: boolean): void { labelsMode = v ? "auto" : "off"; }
export function getLabelsEnabled(): boolean { return labelsMode !== "off"; }

/** LOD 門檻與預算（§45.10/§46.7）。 */
export const LOD = {
  far: 45, mid: 22, minPx: 8,
  px: [0, 15, 12] as const,       // tier1/2 目標螢幕像素高
  maxDynamic: 20, maxDynamicAll: 60,
  intervalSec: 0.15,
};

export function Label({ text, position, color = "#c3c2b7", size = 1, tier = 1, priority }:
  { text: string; position: [number, number, number]; color?: string; size?: number;
    tier?: 0 | 1 | 2; priority?: number }) {
  const tex = useMemo(() => makeTexture(text, color), [text, color]);
  const aspect = tex.image.width / tex.image.height;
  const ref = useRef<THREE.Sprite>(null);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const e: Entry = { ref, tier, priority: priority ?? (3 - tier), scene, aspect,
      baseSize: size * 0.55 };
    registry.add(e);
    return () => { registry.delete(e); };
  }, [tier, priority, scene, aspect, size]);
  return (
    <sprite ref={ref} position={position} scale={[size * aspect * 0.55, size * 0.55, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} />
    </sprite>
  );
}

/** 掛在主 Canvas：每 150 ms 重算本 scene 內所有 Label 的尺寸與可見性。 */
export function LabelManager() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const acc = useRef(999);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < LOD.intervalSec) return;
    acc.current = 0;
    if (labelsMode === "off") {
      for (const e of registry) if (e.scene === scene && e.ref.current) e.ref.current.visible = false;
      return;
    }
    const tanH = Math.tan((camera.fov * Math.PI) / 360);
    const items: { e: Entry; s: THREE.Sprite; rect: [number, number, number, number];
      key: number }[] = [];
    for (const e of registry) {
      if (e.scene !== scene) continue;
      const s = e.ref.current;
      if (!s) continue;
      s.getWorldPosition(v);
      const dist = v.distanceTo(camera.position);
      if (labelsMode === "auto") {
        const maxTier = dist > LOD.far ? 0 : dist > LOD.mid ? 1 : 2;
        if (e.tier > maxTier) { s.visible = false; continue; }
      } else if (labelsMode === "alerts") {
        if (e.tier > 0 && e.priority < 8) { s.visible = false; continue; }
      }
      const p = v.clone().project(camera);
      if (p.z > 1 || Math.abs(p.x) > 1.15 || Math.abs(p.y) > 1.15) { s.visible = false; continue; }
      // §46：tier ≥1 固定螢幕像素（依距離重算世界尺寸，夾制避免貼臉過大）
      if (e.tier > 0) {
        const worldH = Math.min(2.4, Math.max(0.28,
          (LOD.px[e.tier] * 2 * dist * tanH) / size.height));
        s.scale.set(worldH * e.aspect, worldH, 1);
      }
      const pxH = (s.scale.y * size.height) / (2 * dist * tanH);
      if (pxH < LOD.minPx && e.tier > 0 && labelsMode !== "all") { s.visible = false; continue; }
      const pxW = pxH * (s.scale.x / s.scale.y);
      const cx = ((p.x + 1) / 2) * size.width, cy = ((1 - p.y) / 2) * size.height;
      items.push({ e, s, rect: [cx - pxW / 2, cy - pxH / 2, cx + pxW / 2, cy + pxH / 2],
        key: e.priority * 10000 - dist });
    }
    items.sort((a, b) => b.key - a.key);          // 高優先、較近者先佔位
    const kept: [number, number, number, number][] = [];
    const cap = labelsMode === "all" ? LOD.maxDynamicAll : LOD.maxDynamic;
    let dyn = 0;
    for (const it of items) {
      if (it.e.tier > 0 && dyn >= cap) { it.s.visible = false; continue; }
      const r = it.rect;
      const hit = kept.some((k) => !(r[2] < k[0] || r[0] > k[2] || r[3] < k[1] || r[1] > k[3]));
      it.s.visible = !hit;
      if (!hit) { kept.push(r); if (it.e.tier > 0) dyn++; }
    }
  });
  return null;
}
