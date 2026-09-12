/** 小型圖表元件（dataviz 規則：單序列、hover tooltip、深色面板）。 */
import { useMemo, useRef, useState } from "react";
import type { MinutePoint } from "../types";

export const pct = (x: number, d = 1) => (x * 100).toFixed(d) + "%";
export const fmt = new Intl.NumberFormat("en-US");

export function Sparkline({ pts, color = "var(--blue)", fmtV, label = "" }:
  { pts: { t: string; v: number }[]; color?: string; fmtV: (v: number) => string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const w = 220, h = 46, pad = 3;
  const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  const xs = (i: number) => pad + (i * (w - 2 * pad)) / (pts.length - 1);
  const ys = (v: number) => h - pad - (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.v).toFixed(1)}`).join("");
  return (
    <div className="spark" ref={ref}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        setHover(Math.max(0, Math.min(pts.length - 1,
          Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)))));
      }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", overflow: "visible" }}>
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="var(--baseline)" strokeWidth={1} />
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {hover != null && (
          <circle cx={xs(hover)} cy={ys(pts[hover].v)} r={3.5} fill={color}
            stroke="var(--panel)" strokeWidth={2} />)}
      </svg>
      {hover != null && (
        <div className="tt" style={{ display: "block", left: `${(xs(hover) / w) * 100}%`, top: ys(pts[hover].v) }}>
          {pts[hover].t} {label}{fmtV(pts[hover].v)}
        </div>)}
    </div>
  );
}

export function bucket(hist: MinutePoint[], n: number,
  get: (sl: MinutePoint[]) => number): { t: string; v: number }[] {
  const out: { t: string; v: number }[] = [];
  for (let i = 0; i < hist.length; i += n) {
    const sl = hist.slice(i, i + n);
    out.push({ t: `${sl[0].sim_minute}–${sl[sl.length - 1].sim_minute}`, v: get(sl) });
  }
  return out;
}

export function OeeRing({ val, target }: { val: number; target: number }) {
  const r = 30, c = 2 * Math.PI * r, on = c * Math.min(1, val);
  return (
    <svg width={76} height={76} viewBox="0 0 76 76">
      <circle cx={38} cy={38} r={r} fill="none" stroke="var(--baseline)" strokeWidth={8} />
      <circle cx={38} cy={38} r={r} fill="none" stroke="var(--aqua)" strokeWidth={8}
        strokeDasharray={`${on} ${c - on}`} strokeLinecap="round" transform="rotate(-90 38 38)" />
      <text x={38} y={36} textAnchor="middle" fill="var(--ink)" fontSize={15} fontWeight={700}>{pct(val, 1)}</text>
      <text x={38} y={50} textAnchor="middle" fill="var(--muted)" fontSize={8.5}>TARGET {pct(target, 0)}</text>
    </svg>
  );
}

export function Bar({ name, value, color = "var(--aqua)" }:
  { name: string; value: number; color?: string }) {
  return (
    <div className="jl">
      <div className="lab"><span>{name}</span><span>{pct(value, 1)}</span></div>
      <div className="bar"><i style={{ width: `${Math.min(100, value * 100)}%`, background: color }} /></div>
    </div>
  );
}

export const sevIcon = (s: string) =>
  (({ CRITICAL: "⛔", HIGH: "▲", MEDIUM: "⚠", LOW: "ℹ", INFO: "ℹ" }) as Record<string, string>)[s] ?? "ℹ";
export const sevColor = (s: string) =>
  (({ CRITICAL: "var(--critical)", HIGH: "var(--critical)", MEDIUM: "var(--warning)",
      LOW: "var(--ink-2)", INFO: "var(--muted)" }) as Record<string, string>)[s] ?? "var(--muted)";
export const stDot = (s: string) =>
  (({ RUNNING: "var(--good)", WARNING: "var(--warning)", ERROR: "var(--critical)",
      BLOCKED: "var(--critical)", STARVED: "var(--serious)", WAITING_MACHINE: "var(--muted)",
      IDLE: "var(--muted)" }) as Record<string, string>)[s] ?? "var(--muted)";
