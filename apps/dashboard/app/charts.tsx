/* Socheli chart toolkit — pure SVG, zero deps, tuned to the premium monochrome
   dark design (one accent #f5f5f5, subtle fills). Server-renderable. */
import type { ReactNode } from "react";

const ACCENT = "var(--accent)";
const MUTED = "var(--text-muted)";
const GRID = "rgba(255,255,255,0.06)";

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / p) * p;
};

/* ── Sparkline — tiny inline trend (line + soft area) ───────────────────────── */
export function Sparkline({ data, w = 120, h = 34, color = ACCENT, fill = true }: { data: number[]; w?: number; h?: number; color?: string; fill?: boolean }) {
  if (!data.length) return <svg height={h} style={{ width: "100%", maxWidth: w, minWidth: 0 }} />;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const rng = max - min || 1;
  const pts = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * w, h - 3 - ((v - min) / rng) * (h - 6)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const id = `sp${Math.round(pts[0][1])}${data.length}${Math.round(max)}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} height={h} preserveAspectRatio="none" style={{ display: "block", width: "100%", maxWidth: w, minWidth: 0, overflow: "visible" }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.20" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.4" fill={color} />
    </svg>
  );
}

/* ── AreaChart — labelled trend with baseline + last value marker ───────────── */
export function AreaChart({ data, labels, h = 150, color = ACCENT, unit = "" }: { data: number[]; labels?: string[]; h?: number; color?: string; unit?: string }) {
  const w = 720, pad = 6;
  if (!data.length) return <div className="sub">no data</div>;
  const max = niceMax(Math.max(...data, 1));
  const x = (i: number) => pad + (i / Math.max(1, data.length - 1)) * (w - pad * 2);
  const y = (v: number) => pad + (1 - v / max) * (h - pad * 2 - 16);
  const line = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1)},${h - 16} L${x(0)},${h - 16} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="none" style={{ display: "block" }}>
      <defs><linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.18" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={pad} x2={w - pad} y1={pad + g * (h - pad * 2 - 16)} y2={pad + g * (h - pad * 2 - 16)} stroke={GRID} strokeWidth="1" />)}
      <path d={area} fill="url(#area-fill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r="3" fill={color} />
      {labels && labels.map((l, i) => (i % Math.ceil(labels.length / 7) === 0 || i === labels.length - 1) && (
        <text key={i} x={x(i)} y={h - 3} fontSize="9" fill={MUTED} textAnchor="middle" fontFamily="var(--font-mono)">{l}</text>
      ))}
      <text x={pad} y={pad + 8} fontSize="9" fill={MUTED} fontFamily="var(--font-mono)">{max}{unit}</text>
    </svg>
  );
}

/* ── BarChart — vertical bars with labels ───────────────────────────────────── */
export function BarChart({ data, labels, h = 150, color = ACCENT, unit = "" }: { data: number[]; labels?: string[]; h?: number; color?: string; unit?: string }) {
  const w = 720, pad = 6, n = data.length || 1;
  const max = niceMax(Math.max(...data, 1));
  const bw = ((w - pad * 2) / n) * 0.62;
  const gap = ((w - pad * 2) / n);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="none" style={{ display: "block" }}>
      {[0.5, 1].map((g) => <line key={g} x1={pad} x2={w - pad} y1={pad + g * (h - pad * 2 - 16)} y2={pad + g * (h - pad * 2 - 16)} stroke={GRID} strokeWidth="1" />)}
      {data.map((v, i) => {
        const bh = (v / max) * (h - pad * 2 - 16);
        const xx = pad + i * gap + (gap - bw) / 2;
        return <rect key={i} x={xx} y={h - 16 - bh} width={bw} height={Math.max(0, bh)} rx="2" fill={color} opacity={0.85} />;
      })}
      {labels && labels.map((l, i) => (i % Math.ceil(n / 7) === 0 || i === n - 1) && (
        <text key={i} x={pad + i * gap + gap / 2} y={h - 3} fontSize="9" fill={MUTED} textAnchor="middle" fontFamily="var(--font-mono)">{l}</text>
      ))}
      <text x={pad} y={pad + 8} fontSize="9" fill={MUTED} fontFamily="var(--font-mono)">{max}{unit}</text>
    </svg>
  );
}

/* ── Donut — proportions with center label ──────────────────────────────────── */
export function Donut({ segments, size = 132, label, sub }: { segments: { value: number; color: string; label?: string }[]; size?: number; label?: string; sub?: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = size / 2 - 11, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={GRID} strokeWidth="11" />
        {segments.map((s, i) => {
          const frac = s.value / total, dash = frac * C;
          const el = <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth="11" strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-acc * C} strokeLinecap="butt" />;
          acc += frac;
          return el;
        })}
      </svg>
      <div>
        {label !== undefined && <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}>{label}</div>}
        {sub && <div className="stat-label" style={{ marginTop: 4 }}>{sub}</div>}
        <div style={{ marginTop: 10, display: "grid", gap: 5 }}>
          {segments.map((s, i) => s.label && (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-secondary)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />{s.label}<span style={{ marginLeft: "auto", color: "var(--text-light)", fontFamily: "var(--font-mono)" }}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── ProgressRing — single % ring ───────────────────────────────────────────── */
export function ProgressRing({ value, size = 76, color = ACCENT, label }: { value: number; size?: number; color?: string; label?: ReactNode }) {
  const r = size / 2 - 6, C = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value));
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={GRID} strokeWidth="6" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="6" strokeDasharray={`${v * C} ${C}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 650 }}>{label ?? `${Math.round(v * 100)}%`}</div>
    </div>
  );
}

/* ── BarRow — horizontal labelled distribution bar ──────────────────────────── */
export function BarRow({ label, value, max, suffix = "", color = ACCENT }: { label: string; value: number; max: number; suffix?: string; color?: string }) {
  return (
    <div className="qa-row">
      <div className="qa-name" style={{ textTransform: "none" }}>{label}</div>
      <div className="qa-track"><div className="qa-fill" style={{ width: `${Math.min(100, (value / (max || 1)) * 100)}%`, background: color }} /></div>
      <div className="qa-num">{value}{suffix}</div>
    </div>
  );
}

/* ── Heatmap — day×hour grid (e.g. schedule / activity) ──────────────────────── */
export function Heatmap({ rows, cols, values, color = ACCENT }: { rows: string[]; cols: string[]; values: number[][]; color?: string }) {
  const max = Math.max(1, ...values.flat());
  return (
    <div style={{ display: "grid", gridTemplateColumns: `auto repeat(${cols.length}, 1fr)`, gap: 3, alignItems: "center" }}>
      <div />
      {cols.map((c) => <div key={c} style={{ fontSize: 8.5, color: MUTED, textAlign: "center", fontFamily: "var(--font-mono)" }}>{c}</div>)}
      {rows.map((r, ri) => (
        <>
          <div key={r} style={{ fontSize: 9.5, color: MUTED, paddingRight: 6, fontFamily: "var(--font-mono)" }}>{r}</div>
          {cols.map((_, ci) => {
            const v = values[ri]?.[ci] ?? 0;
            return <div key={ci} title={`${r} ${cols[ci]}: ${v}`} style={{ height: 16, borderRadius: 3, background: v ? color : "rgba(255,255,255,0.04)", opacity: v ? 0.25 + 0.75 * (v / max) : 1 }} />;
          })}
        </>
      ))}
    </div>
  );
}

/* ── TrendStat — headline number + delta + sparkline ────────────────────────── */
export function TrendStat({ label, value, unit, series, deltaPct, foot }: { label: string; value: string | number; unit?: string; series?: number[]; deltaPct?: number; foot?: string }) {
  const up = (deltaPct ?? 0) >= 0;
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 8, gap: 12 }}>
        <div className="stat-value" style={{ marginTop: 0 }}>{value}{unit && <span className="stat-unit">{unit}</span>}</div>
        {series && series.length > 1 && <Sparkline data={series} />}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        {deltaPct !== undefined && (
          <span style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: up ? "var(--success)" : "var(--error)" }}>{up ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(0)}%</span>
        )}
        {foot && <span className="stat-foot" style={{ marginTop: 0 }}>{foot}</span>}
      </div>
    </div>
  );
}
