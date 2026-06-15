import React from "react";
import { AbsoluteFill } from "remotion";
import type { Theme } from "@os/tokens";
import { deterministicRandom } from "./motion.ts";
import { GradientMesh } from "./grade.tsx";

/* Cinematic background stack — grid + drifting particles + vignette + grain.
   Ported & generalised from the CognitiveX Remotion language. */

export const ParallaxGrid: React.FC<{
  w: number;
  h: number;
  color: string;
  frame: number;
  spacing?: number;
  opacity?: number;
}> = ({ w, h, color, frame, spacing = 96, opacity = 0.05 }) => {
  const drift = (frame * 0.15) % spacing;
  const lines: React.ReactNode[] = [];
  for (let x = -spacing + drift; x < w + spacing; x += spacing)
    lines.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={h} stroke={color} strokeWidth={1} opacity={opacity} />);
  for (let y = -spacing + drift; y < h + spacing; y += spacing)
    lines.push(<line key={`h${y}`} x1={0} y1={y} x2={w} y2={y} stroke={color} strokeWidth={1} opacity={opacity} />);
  return (
    <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
      {lines}
    </svg>
  );
};

export const Particles: React.FC<{
  w: number;
  h: number;
  color: string;
  frame: number;
  count?: number;
  seed?: number;
}> = ({ w, h, color, frame, count = 28, seed = 7 }) => {
  const dots: React.ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const r1 = deterministicRandom(seed + i * 3);
    const r2 = deterministicRandom(seed + i * 3 + 1);
    const r3 = deterministicRandom(seed + i * 3 + 2);
    const x = r1 * w;
    const speed = (0.25 + r3 * 0.7) * 0.6;
    const y = (((r2 * h - frame * speed) % h) + h) % h;
    const radius = 1 + r3 * 2.4;
    const op = 0.08 + Math.sin(frame * 0.05 + i * 1.3) * 0.05;
    dots.push(<circle key={i} cx={x} cy={y} r={radius} fill={color} opacity={Math.max(0.03, op)} />);
  }
  return (
    <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
      {dots}
    </svg>
  );
};

/* Network field — drifting nodes with single-pass neighbour links (connect each
   node to the NEXT if within threshold; capped). For builder/dev/on-chain DNAs. */
const NetworkField: React.FC<{ w: number; h: number; color: string; frame: number; seed?: number; count?: number }> = ({ w, h, color, frame, seed = 7, count = 18 }) => {
  const nodes: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const r1 = deterministicRandom(seed + i * 3);
    const r2 = deterministicRandom(seed + i * 3 + 1);
    const r3 = deterministicRandom(seed + i * 3 + 2);
    const speed = (0.25 + r3 * 0.7) * 0.5;
    nodes.push({ x: r1 * w, y: (((r2 * h - frame * speed) % h) + h) % h });
  }
  const thr = Math.min(w, h) * 0.3;
  const links: React.ReactNode[] = [];
  for (let i = 0; i < nodes.length - 1 && links.length < 16; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < thr) links.push(<line key={`nl${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1} opacity={0.12 * (1 - d / thr)} />);
  }
  return (
    <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
      {links}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={1.6} fill={color} opacity={0.2} />
      ))}
    </svg>
  );
};

/* ── TacticalBackground ──────────────────────────────────────────────────────
   Ops Room / intelligence-briefing backdrop: coordinate grid, radar sweep,
   continent silhouettes, animated hotspot pulses, satellite scan line,
   teletype data columns, corner brackets, and status HUD. Pure SVG + HTML, no footage. */
const COORD_LABELS = ["40°N", "20°N", "0°", "20°S", "60°E", "30°E", "0°", "30°W", "60°W"];

// Module-level static data — hoisted out of the component to avoid per-frame allocations.
const TACTICAL_INTEL_LEFT = [
  "GRID REF: 52N-014E .. CONFIRMED",
  "ASSET 07 ........... MOVING",
  "34.2°N 82.1°E ...... PRIORITY-1",
  "SIGNAL STR: 87% .... AUTH",
  "OPS TEMPEST ........ PHASE 2",
  "INTERCEPT DELTA .... 0412Z",
  "VECTOR: 270° ....... UPDATED",
  "SIGINT FEED ........ ACTIVE",
  "NODE 9 ............. STANDBY",
  "COORDINATES LOCKED . T+00:14",
  "CLEARANCE: UMBRA ... EYES ONLY",
  "RELAY UPLINK ....... NOMINAL",
  "BEARING: 043° ...... MOVING",
  "ASSET 12 ........... LOST",
  "GRID REF: 31N-035E . UNVERIFIED",
];
const TACTICAL_INTEL_RIGHT = [
  "FREQ: 143.625 MHz .. ACTIVE",
  "BURST: 0.4s ........ ENCRYPTED",
  "T+00:00:14 ......... LOGGED",
  "SNR: 24dB .......... NOMINAL",
  "HOP RATE: 100 ...... CONFIRMED",
  "SIGINT CH-7 ........ OPEN",
  "TX POWER: 12W ...... DETECTED",
  "BAND: UHF .......... MONITORED",
  "MODULATION: FSK .... DECODED",
  "CIPHER: AES-256 .... LOCKED",
  "RELAY NODE: B ...... STANDBY",
  "UPLINK 03 .......... NOMINAL",
  "DL BIT ERR: 0.02% .. OK",
  "SYNC PULSE ......... ACQUIRED",
  "LINK QUALITY: 97% .. STRONG",
];
const TACTICAL_HOTSPOTS = [
  { x: 560, y: 820 },
  { x: 700, y: 600 },
  { x: 300, y: 650 },
  { x: 820, y: 1100 },
] as const;
const RADAR_PIPS = [1.1, 2.4, 3.7, 4.9, 5.5] as const;
// Pre-built repeated strings — never reallocated per frame.
const SITREP_REPEATED = [...TACTICAL_INTEL_LEFT, ...TACTICAL_INTEL_LEFT, ...TACTICAL_INTEL_LEFT, ...TACTICAL_INTEL_LEFT].join("\n");
const SIGINT_REPEATED = [...TACTICAL_INTEL_RIGHT, ...TACTICAL_INTEL_RIGHT, ...TACTICAL_INTEL_RIGHT, ...TACTICAL_INTEL_RIGHT].join("\n");

const TacticalBackground: React.FC<{ w: number; h: number; frame: number; accent: string }> = ({ w, h, frame, accent }) => {
  // CoordinateGrid
  const hSpacing = 144;
  const vSpacing = 108;
  const hDrift = (frame * 0.06) % hSpacing;
  const vDrift = (frame * 0.06) % vSpacing;
  const gridLines: React.ReactNode[] = [];
  const hLines: number[] = [];
  const vLines: number[] = [];
  for (let y = -hSpacing + hDrift; y < h + hSpacing; y += hSpacing) hLines.push(y);
  for (let x = -vSpacing + vDrift; x < w + vSpacing; x += vSpacing) vLines.push(x);
  for (const y of hLines)
    gridLines.push(<line key={`gh${y}`} x1={0} y1={y} x2={w} y2={y} stroke={accent} strokeWidth={1} opacity={0.032} />);
  for (const x of vLines)
    gridLines.push(<line key={`gv${x}`} x1={x} y1={0} x2={x} y2={h} stroke={accent} strokeWidth={1} opacity={0.032} />);
  // Labels at every 4th intersection
  let li = 0;
  for (let hi = 0; hi < hLines.length; hi++) {
    for (let vi = 0; vi < vLines.length; vi++) {
      if ((hi + vi) % 4 === 0) {
        const label = COORD_LABELS[Math.floor(deterministicRandom(li * 7 + 3) * COORD_LABELS.length)];
        gridLines.push(
          <text key={`lbl${li}`} x={vLines[vi] + 3} y={hLines[hi] - 3} fontSize={9} fontFamily="monospace" fill={accent} opacity={0.10}>{label}</text>
        );
        li++;
      }
    }
  }

  // RadarSweep
  const cx = 540;
  const cy = 1050;
  const sweepAngle = (frame / 280) * Math.PI * 2;

  // Arc trail — single filled sector replacing 22 stacked spoke lines.
  const TRAIL_SPAN = Math.PI * 0.65;
  const trailStart = sweepAngle - TRAIL_SPAN;
  const R = 340;
  const tx1 = cx + Math.cos(trailStart) * R;
  const ty1 = cy + Math.sin(trailStart) * R;
  const tx2 = cx + Math.cos(sweepAngle) * R;
  const ty2 = cy + Math.sin(sweepAngle) * R;
  const trailLargeArc = TRAIL_SPAN > Math.PI ? 1 : 0;
  const sectorPath = `M ${cx} ${cy} L ${tx1.toFixed(1)} ${ty1.toFixed(1)} A ${R} ${R} 0 ${trailLargeArc} 1 ${tx2.toFixed(1)} ${ty2.toFixed(1)} Z`;
  const arcEdgePath = `M ${tx1.toFixed(1)} ${ty1.toFixed(1)} A ${R} ${R} 0 ${trailLargeArc} 1 ${tx2.toFixed(1)} ${ty2.toFixed(1)}`;

  // HotspotPulses
  const pulseElems: React.ReactNode[] = [];
  for (let i = 0; i < TACTICAL_HOTSPOTS.length; i++) {
    const { x: hx, y: hy } = TACTICAL_HOTSPOTS[i];
    const phase = (frame + i * 28) % 75;
    const phase2 = (frame + i * 28 + 38) % 75;
    const rp = 3.5 + (phase / 75) * 40;
    const op = (1 - phase / 75) * 0.38;
    const rp2 = 3.5 + (phase2 / 75) * 40;
    const op2 = (1 - phase2 / 75) * 0.38;
    pulseElems.push(
      <g key={`hp${i}`}>
        <circle cx={hx} cy={hy} r={rp} stroke={accent} strokeWidth={1} fill="none" opacity={op} />
        <circle cx={hx} cy={hy} r={rp2} stroke={accent} strokeWidth={1} fill="none" opacity={op2} />
        <circle cx={hx} cy={hy} r={3.5} fill={accent} opacity={0.82} />
      </g>
    );
  }

  // SatelliteScan
  const scanY = ((frame % 360) / 360) * h;
  const scanId = `scan-grad-${frame}`;

  // Teletype scroll — different speeds for left/right columns
  const scrollLeft = -(frame * 0.75 % 900);
  const scrollRight = -(frame * 0.55 % 900);

  // Stable episode number derived from dimensions (not frame-dependent)
  const epNum = Math.floor(deterministicRandom((w + h) % 997) * 200) + 100;
  const liveOn = Math.floor(frame / 20) % 2 === 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* CoordinateGrid */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {gridLines}
      </svg>

      {/* RadarSweep */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        <circle cx={cx} cy={cy} r={340} stroke={accent} strokeWidth={1} fill="none" opacity={0.11} />
        <circle cx={cx} cy={cy} r={170} stroke={accent} strokeWidth={1} fill="none" opacity={0.055} />
        <circle cx={cx} cy={cy} r={85} stroke={accent} strokeWidth={1} fill="none" opacity={0.055} />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
          const a = (i / 8) * Math.PI * 2;
          return <line key={`sp${i}`} x1={cx} y1={cy} x2={cx + Math.cos(a) * 340} y2={cy + Math.sin(a) * 340} stroke={accent} strokeWidth={1} opacity={0.04} />;
        })}
        {/* Filled sector trail — replaces 22 discrete spoke lines */}
        <path d={sectorPath} fill={accent} opacity={0.10} stroke="none" />
        {/* Bright arc edge along the swept boundary */}
        <path d={arcEdgePath} fill="none" stroke={accent} strokeWidth={1.2} opacity={0.28} />
        {/* Sweep arm */}
        <line x1={cx} y1={cy} x2={cx + Math.cos(sweepAngle) * 340} y2={cy + Math.sin(sweepAngle) * 340} stroke={accent} strokeWidth={1.5} opacity={0.75} />
        {/* Center crosshair */}
        <line x1={cx - 10} y1={cy} x2={cx + 10} y2={cy} stroke={accent} strokeWidth={1} opacity={0.6} />
        <line x1={cx} y1={cy - 10} x2={cx} y2={cy + 10} stroke={accent} strokeWidth={1} opacity={0.6} />
        <circle cx={cx} cy={cy} r={3} fill="none" stroke={accent} strokeWidth={1} opacity={0.5} />
        {RADAR_PIPS.map((a, i) => (
          <circle key={`pip${i}`} cx={cx + Math.cos(a) * 340} cy={cy + Math.sin(a) * 340} r={3} fill={accent} opacity={0.45 + Math.sin(frame * 0.11 + i) * 0.18} />
        ))}
      </svg>

      {/* ContinentSilhouettes */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        <g strokeWidth={1.2} stroke={accent} fill={accent} strokeOpacity={0.045} fillOpacity={0.008}>
          <path d="M 500 820 L 530 720 L 580 700 L 620 730 L 640 800 L 640 930 L 600 1050 L 560 1100 L 520 1000 L 490 920 Z" />
          <path d="M 100 600 L 200 550 L 350 520 L 500 530 L 650 500 L 800 520 L 900 560 L 950 580 L 980 620 L 900 680 L 750 700 L 600 710 L 450 720 L 300 730 L 150 720 L 80 680 Z" />
          <path d="M 80 550 L 200 480 L 360 450 L 450 500 L 420 620 L 340 720 L 250 780 L 160 760 L 80 700 L 40 640 Z" />
          <path d="M 280 820 L 350 780 L 420 800 L 440 900 L 420 1050 L 380 1150 L 320 1160 L 270 1080 L 250 960 L 260 860 Z" />
          <path d="M 760 1100 L 860 1060 L 950 1080 L 970 1150 L 920 1220 L 820 1240 L 740 1200 L 730 1140 Z" />
        </g>
      </svg>

      {/* HotspotPulses */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {pulseElems}
      </svg>

      {/* SatelliteScan */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <linearGradient id={scanId} x1="0" y1="0" x2="0" y2="1" gradientUnits="userSpaceOnUse"
            gradientTransform={`translate(0,${scanY - 55})`}>
            <stop offset="0%" stopColor={accent} stopOpacity={0} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.10} />
          </linearGradient>
        </defs>
        <rect x={0} y={Math.max(0, scanY - 55)} width={w} height={55} fill={`url(#${scanId})`} />
        <rect x={0} y={scanY - 1} width={w} height={2} fill={accent} opacity={0.42} />
        {Array.from({ length: 7 }, (_, k) => (
          <rect key={`sp${k}`} x={deterministicRandom(k * 11 + 1) * w} y={scanY + deterministicRandom(k * 11 + 2) * 8 - 4}
            width={2} height={2} fill={accent} opacity={0.55} />
        ))}
      </svg>

      {/* TeletypeColumns — left: SITREP, right: SIGINT, different scroll speeds */}
      <div style={{ position: "absolute", left: 0, top: 0, width: 70, height: h, background: "linear-gradient(90deg, rgba(0,0,0,0.62) 0%, transparent 100%)", overflow: "hidden" }}>
        <div style={{ transform: `translateY(${scrollLeft}px)`, fontSize: 9, fontFamily: "monospace", color: accent, opacity: 0.16, lineHeight: 1.65, whiteSpace: "nowrap", paddingLeft: 6 }}>
          {SITREP_REPEATED.split("\n").map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </div>
      <div style={{ position: "absolute", right: 0, top: 0, width: 70, height: h, background: "linear-gradient(270deg, rgba(0,0,0,0.62) 0%, transparent 100%)", overflow: "hidden" }}>
        <div style={{ transform: `translateY(${scrollRight}px)`, fontSize: 9, fontFamily: "monospace", color: accent, opacity: 0.16, lineHeight: 1.65, whiteSpace: "nowrap", paddingRight: 6, textAlign: "right" }}>
          {SIGINT_REPEATED.split("\n").map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </div>

      {/* CornerBrackets */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {/* TL */}
        <line x1={22} y1={22} x2={50} y2={22} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        <line x1={22} y1={22} x2={22} y2={50} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        {/* TR */}
        <line x1={w - 22} y1={22} x2={w - 50} y2={22} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        <line x1={w - 22} y1={22} x2={w - 22} y2={50} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        {/* BL */}
        <line x1={22} y1={h - 22} x2={50} y2={h - 22} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        <line x1={22} y1={h - 22} x2={22} y2={h - 50} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        {/* BR */}
        <line x1={w - 22} y1={h - 22} x2={w - 50} y2={h - 22} stroke={accent} strokeWidth={1.5} opacity={0.5} />
        <line x1={w - 22} y1={h - 22} x2={w - 22} y2={h - 50} stroke={accent} strokeWidth={1.5} opacity={0.5} />
      </svg>

      {/* Status HUD — LIVE indicator, OPS counter, classification footer */}
      <div style={{ position: "absolute", top: 52, left: 24, display: "flex", alignItems: "center", gap: 7, opacity: 0.82 }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%", background: accent,
          opacity: liveOn ? 1 : 0.15,
          boxShadow: liveOn ? `0 0 8px ${accent}` : "none",
        }} />
        <span style={{ fontFamily: "monospace", fontSize: 10, color: accent, letterSpacing: "0.12em", opacity: 0.9 }}>LIVE</span>
      </div>
      <div style={{ position: "absolute", top: 48, right: 24, fontFamily: "monospace", fontSize: 10, color: accent, opacity: 0.55, letterSpacing: "0.1em" }}>
        {`OPS ROOM // EP.${String(epNum).padStart(3, "0")}`}
      </div>
      <div style={{ position: "absolute", bottom: 52, left: 0, right: 0, textAlign: "center", fontFamily: "monospace", fontSize: 8, color: accent, opacity: 0.22, letterSpacing: "0.18em" }}>
        CLASSIFICATION: UNCLASSIFIED // FOR OFFICIAL USE ONLY
      </div>

      {/* Vignette — SVG radial gradient for reliable Remotion rendering */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <defs>
          <radialGradient id="tvignette" cx="50%" cy="50%" r="70%">
            <stop offset="40%" stopColor="transparent" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.88)" />
          </radialGradient>
        </defs>
        <rect width={w} height={h} fill="url(#tvignette)" />
      </svg>
    </AbsoluteFill>
  );
};

/* ── NewsroomBackground ───────────────────────────────────────────────────────
   War Economy / newsroom backdrop: economic grid, animated chart traces,
   CSS halftone dot overlay, blinking alert dots, scrolling ticker strip. Pure SVG + HTML, no footage. */
const TICKER_TEXT = "INTL AGENT IDX ▲ 2.4%  ●  BASE TVL ▼ 8.1%  ●  PROTOCOL REVENUE ▲ 31.2%  ●  AI WORKFORCE EST. 2.4M  ●  COMPUTE CAPEX ▲ 180%  ●  AUTOMATION RATE ▲ 11.3%  ●  LABOR DISP. INDEX ▼ 0.82  ●  OPERATOR FEE ▲ 0.05  ●  ";

const NewsroomBackground: React.FC<{ w: number; h: number; frame: number; accent: string }> = ({ w, h, frame, accent }) => {
  // EconomicGrid
  const hGridLines: React.ReactNode[] = [];
  for (let i = 1; i < 14; i++)
    hGridLines.push(<line key={`hg${i}`} x1={0} y1={(h / 14) * i} x2={w} y2={(h / 14) * i} stroke="white" strokeWidth={1} opacity={0.028} />);
  for (let i = 1; i < 5; i++)
    hGridLines.push(<line key={`vg${i}`} x1={(w / 5) * i} y1={0} x2={(w / 5) * i} y2={h} stroke="white" strokeWidth={0.8} opacity={0.022} />);

  // Animated economic chart traces
  const chartPoints: string[][] = [];
  for (let c = 0; c < 4; c++) {
    const pts: string[] = [];
    const yBase = (h / 5) * (c + 1);
    for (let xi = 0; xi <= 80; xi++) {
      const x = (xi / 80) * w;
      const t = (xi + frame * (0.4 + c * 0.15)) / 80;
      const y = yBase
        + Math.sin(t * 2.1 + c * 1.8) * 18
        + Math.sin(t * 5.3 + c * 0.7) * 8
        + (deterministicRandom(Math.floor(t) * 7 + c * 3) - 0.5) * 12;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    chartPoints.push(pts);
  }

  // BlinkingAlerts — positions computed at render time since they depend on w/h
  const alertPositions = [{ x: 38, y: 62 }, { x: w - 38, y: 62 }, { x: 38, y: h / 2 }];
  const blinkOn = Math.floor(frame / 22) % 2 === 0;
  const pulseProgress = (frame % 80) / 80;
  const rPulse = 4.5 + pulseProgress * 27;
  const opPulse = (1 - pulseProgress) * 0.32;

  // Ticker scroll
  const tickerX = -(frame * 1.35 % 2200);

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* EconomicGrid + animated chart lines — first layer, behind everything */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {hGridLines}
        {/* Fill under first (accent) chart trace */}
        <path
          d={`M ${chartPoints[0][0]} ${chartPoints[0].slice(1).map((p) => `L ${p}`).join(" ")} L ${w} ${h} L 0 ${h} Z`}
          fill={`${accent}08`}
          stroke="none"
        />
        {/* Chart lines — first uses accent, rest near-white at low opacity */}
        {chartPoints.map((pts, c) => (
          <polyline
            key={`cl${c}`}
            points={pts.join(" ")}
            stroke={c === 0 ? accent : "rgba(255,255,255,0.5)"}
            strokeWidth={c === 0 ? 1.2 : 0.7}
            fill="none"
            opacity={c === 0 ? 0.18 : 0.08}
          />
        ))}
      </svg>

      {/* Halftone dot screen — CSS repeating-radial-gradient replaces feTurbulence noise */}
      <AbsoluteFill style={{
        backgroundImage: `radial-gradient(circle, ${accent}29 1px, transparent 1px)`,
        backgroundSize: "12px 12px",
        opacity: 0.6,
        mixBlendMode: "overlay",
        pointerEvents: "none",
      }} />

      {/* BlinkingAlerts */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {alertPositions.map((pos, i) => (
          <g key={`alert${i}`}>
            <circle cx={pos.x} cy={pos.y} r={rPulse} stroke={accent} strokeWidth={1} fill="none" opacity={opPulse} />
            <circle cx={pos.x} cy={pos.y} r={4.5} fill={accent} opacity={blinkOn ? 0.82 : 0.10} />
          </g>
        ))}
      </svg>

      {/* TickerStrip — fixed MARKETS badge + scrolling content */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 34,
        background: "rgba(0,0,0,0.90)", overflow: "hidden",
      }}>
        {/* Fixed category badge */}
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          display: "flex", alignItems: "center", paddingLeft: 10, paddingRight: 10,
          background: accent, zIndex: 2,
        }}>
          <span style={{ fontFamily: "monospace", fontSize: 9, color: "#000", fontWeight: 700, letterSpacing: "0.1em" }}>MARKETS</span>
        </div>
        {/* Scrolling ticker content, offset right of the badge */}
        <div style={{ position: "absolute", left: 80, right: 0, top: 0, bottom: 0, overflow: "hidden" }}>
          <div style={{ transform: `translateX(${tickerX}px)`, display: "flex", alignItems: "center", height: "100%", paddingLeft: 8, whiteSpace: "nowrap" }}>
            <span style={{ color: accent, fontWeight: 700, marginRight: 16, letterSpacing: "0.06em", fontSize: 10, fontFamily: "monospace" }}>BREAKING</span>
            <span style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.90)" }}>{TICKER_TEXT}</span>
          </div>
        </div>
      </div>

      {/* Vignette */}
      <AbsoluteFill style={{ boxShadow: "inset 0 0 360px 100px rgba(0,0,0,0.78)", pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

/* ── TechBackground ──────────────────────────────────────────────────────────
   Tech/AI backdrop: dense network graph, faint matrix rain, terminal grid,
   and blinking cursor prompt. Pure SVG + HTML, no footage. */
const HEX_CHARS = "0123456789ABCDEF";
const TECH_NODE_COUNT = 32;

const TechBackground: React.FC<{ w: number; h: number; frame: number; accent: string }> = ({ w, h, frame, accent }) => {
  // Enhanced network graph — 32 nodes, hubs every 4th
  const nodes: { x: number; y: number; isHub: boolean }[] = [];
  for (let i = 0; i < TECH_NODE_COUNT; i++) {
    const r1 = deterministicRandom(42 + i * 3);
    const r2 = deterministicRandom(42 + i * 3 + 1);
    const r3 = deterministicRandom(42 + i * 3 + 2);
    const speed = (0.2 + r3 * 0.6) * 0.5;
    nodes.push({ x: r1 * w, y: (((r2 * h - frame * speed) % h) + h) % h, isHub: i % 4 === 0 });
  }
  const thr = Math.min(w, h) * 0.32;
  const netLinks: React.ReactNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    let connected = 0;
    for (let j = 0; j < nodes.length && connected < 3; j++) {
      if (i === j) continue;
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d < thr) {
        netLinks.push(<line key={`nl${i}-${j}`} x1={nodes[i].x} y1={nodes[i].y} x2={nodes[j].x} y2={nodes[j].y} stroke={accent} strokeWidth={0.8} opacity={(1 - d / thr) * 0.18} />);
        connected++;
      }
    }
  }

  // Matrix rain — 12 columns, 8 rows each, ultra-faint hex chars
  const rainElems: React.ReactNode[] = [];
  const COLS = 12;
  const ROWS_PER_COL = 8;
  for (let col = 0; col < COLS; col++) {
    const cx = (w / COLS) * col + w / COLS / 2;
    for (let row = 0; row < ROWS_PER_COL; row++) {
      const charIdx = Math.floor(deterministicRandom(col * 13 + row * 7 + Math.floor(frame / 18)) * HEX_CHARS.length);
      const char = HEX_CHARS[charIdx];
      const cy = ((frame * 1.8 + col * 97 + row * 28) % (h + 200)) - 100;
      const op = row === 0 ? 0.22 : 0.22 - (row / ROWS_PER_COL) * 0.17;
      rainElems.push(<text key={`rain${col}-${row}`} x={cx} y={cy} fontSize={11} fontFamily="monospace" fill={accent} opacity={Math.max(0, op)} textAnchor="middle">{char}</text>);
    }
  }

  // Terminal grid — fine lines at 96px H / 72px V with drifting coordinate labels
  const termGridSpacingH = 96;
  const termGridSpacingV = 72;
  const termDrift = (frame * 0.04) % termGridSpacingH;
  const termLines: React.ReactNode[] = [];
  const tgHLines: number[] = [];
  const tgVLines: number[] = [];
  for (let y = -termGridSpacingH + termDrift; y < h + termGridSpacingH; y += termGridSpacingH) tgHLines.push(y);
  for (let x = -termGridSpacingV + termDrift; x < w + termGridSpacingV; x += termGridSpacingV) tgVLines.push(x);
  for (const y of tgHLines) termLines.push(<line key={`tgh${y}`} x1={0} y1={y} x2={w} y2={y} stroke={accent} strokeWidth={0.7} opacity={0.03} />);
  for (const x of tgVLines) termLines.push(<line key={`tgv${x}`} x1={x} y1={0} x2={x} y2={h} stroke={accent} strokeWidth={0.7} opacity={0.03} />);
  let tgLi = 0;
  for (let hi = 0; hi < tgHLines.length; hi++) {
    for (let vi = 0; vi < tgVLines.length; vi++) {
      if ((hi + vi) % 4 === 0) {
        const r = deterministicRandom(tgLi * 11 + 5);
        const hexLabel = `0x${Math.floor(r * 255).toString(16).toUpperCase().padStart(2, "0")}:${Math.floor(deterministicRandom(tgLi * 7 + 3) * 255).toString(16).toUpperCase().padStart(2, "0")}`;
        termLines.push(<text key={`tglbl${tgLi}`} x={tgVLines[vi] + 3} y={tgHLines[hi] - 3} fontSize={8} fontFamily="monospace" fill={accent} opacity={0.09}>{hexLabel}</text>);
        tgLi++;
      }
    }
  }

  const cursorOn = Math.floor(frame / 15) % 2 === 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* Terminal grid */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {termLines}
      </svg>
      {/* Matrix rain */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {rainElems}
      </svg>
      {/* Network graph */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {netLinks}
        {nodes.map((n, i) => (
          <g key={`tn${i}`}>
            {n.isHub && <circle cx={n.x} cy={n.y} r={6} fill="none" stroke={accent} strokeWidth={0.8} opacity={0.12} />}
            <circle cx={n.x} cy={n.y} r={n.isHub ? 3.2 : 1.8} fill={accent} opacity={n.isHub ? 0.45 : 0.25} />
          </g>
        ))}
      </svg>
      {/* Terminal prompt — bottom-left */}
      <div style={{ position: "absolute", bottom: 48, left: 20, fontFamily: "monospace", fontSize: 10, color: accent, opacity: 0.35, display: "flex", alignItems: "center" }}>
        <span>root@node:~$ </span>
        <span style={{ opacity: cursorOn ? 0.9 : 0.1, background: accent, color: "#000", padding: "0 3px" }}>█</span>
      </div>
      {/* Vignette */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <defs>
          <radialGradient id="techvignette" cx="50%" cy="50%" r="70%">
            <stop offset="40%" stopColor="transparent" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.88)" />
          </radialGradient>
        </defs>
        <rect width={w} height={h} fill="url(#techvignette)" />
      </svg>
    </AbsoluteFill>
  );
};

/* ── FinancialBackground ─────────────────────────────────────────────────────
   Bloomberg terminal meets dark cinema — sparkline rows, price grid,
   scrolling data strip, and a bottom financial ticker. Pure SVG + HTML, no footage. */
const FIN_DATA_ROWS = [
  { label: "AAPL", val: "+2.4%", pos: true },
  { label: "MSFT", val: "-0.8%", pos: false },
  { label: "BTC", val: "+14.2%", pos: true },
  { label: "ETH", val: "-3.1%", pos: false },
  { label: "SPX", val: "+0.2%", pos: true },
  { label: "NVDA", val: "+5.6%", pos: true },
  { label: "AGT", val: "▲8.1%", pos: true },
  { label: "OP", val: "▼2.3%", pos: false },
  { label: "ARB", val: "+1.7%", pos: true },
  { label: "LINK", val: "+4.0%", pos: true },
  { label: "UNI", val: "-1.2%", pos: false },
  { label: "AAVE", val: "+6.3%", pos: true },
];
const FIN_PRICE_LABELS = ["124.50", "98.72", "143.00", "211.88", "76.34", "188.10", "55.92", "302.45", "64.17", "149.60", "93.25", "178.80", "112.30", "256.40", "87.61", "195.50"];
const FIN_BOTTOM_TEXT = "NET ASSET FLOW: +$2.4B  ●  PROTOCOL FEES: $18.2M/d  ●  TVL DELTA: -3.2%  ●  ACTIVE OPERATORS: 12,441  ●  ";

const FinancialBackground: React.FC<{ w: number; h: number; frame: number; accent: string }> = ({ w, h, frame, accent }) => {
  // Price grid
  const priceGridElems: React.ReactNode[] = [];
  for (let i = 1; i < 16; i++) {
    const y = (h / 16) * i;
    const isMajor = i % 4 === 0;
    priceGridElems.push(<line key={`pg${i}`} x1={0} y1={y} x2={w} y2={y} stroke="white" strokeWidth={1} opacity={isMajor ? 0.038 : 0.022} />);
    if (isMajor) {
      const priceVal = FIN_PRICE_LABELS[Math.floor(i / 4) % FIN_PRICE_LABELS.length];
      priceGridElems.push(<text key={`pglbl${i}`} x={w - 6} y={y - 3} fontSize={9} fontFamily="monospace" fill="white" opacity={0.14} textAnchor="end">{priceVal}</text>);
    }
  }
  for (let j = 1; j < 5; j++) {
    priceGridElems.push(<line key={`pgv${j}`} x1={(w / 5) * j} y1={0} x2={(w / 5) * j} y2={h} stroke="white" strokeWidth={0.8} opacity={0.018} />);
  }

  // Animated sparkline rows — 6 rows
  const sparklineElems: React.ReactNode[] = [];
  for (let row = 0; row < 6; row++) {
    const yBase = 200 + row * 280;
    const pts: string[] = [];
    for (let xi = 0; xi <= 120; xi++) {
      const x = (xi / 120) * w;
      const t = xi / 120;
      const y = yBase
        + Math.sin(t * Math.PI * 8 + (frame * 0.03) + row * 1.7) * 14
        + Math.sin(t * Math.PI * 3 + (frame * 0.018)) * 10;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const isAccent = row % 2 === 0;
    const fillPath = `M ${pts[0]} ${pts.slice(1).map((p) => `L ${p}`).join(" ")} L ${w} ${yBase} L 0 ${yBase} Z`;
    if (isAccent) {
      sparklineElems.push(<path key={`sf${row}`} d={fillPath} fill={`${accent}0a`} stroke="none" />);
    }
    sparklineElems.push(
      <polyline key={`sl${row}`} points={pts.join(" ")} stroke={isAccent ? accent : "white"} strokeWidth={isAccent ? 1.2 : 0.7} fill="none" opacity={isAccent ? 0.12 : 0.05} />
    );
  }

  // Scrolling data rows — right strip
  const scrollUp = -(frame * 0.6 % 600);

  // Bottom strip scroll
  const bottomScrollX = -(frame * 0.9 % 1800);

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* Price grid */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {priceGridElems}
        {sparklineElems}
      </svg>
      {/* Right scrolling data strip */}
      <div style={{ position: "absolute", right: 0, top: 0, width: 70, height: h, background: "linear-gradient(270deg, rgba(0,0,0,0.55) 0%, transparent 100%)", overflow: "hidden" }}>
        <div style={{ transform: `translateY(${scrollUp}px)`, fontFamily: "monospace", fontSize: 8, lineHeight: 1.7, paddingRight: 6, textAlign: "right", whiteSpace: "nowrap" }}>
          {[...FIN_DATA_ROWS, ...FIN_DATA_ROWS, ...FIN_DATA_ROWS].map((r, i) => (
            <div key={i} style={{ color: r.pos ? accent : "#ff4d5a", opacity: 0.18 }}>{r.label} {r.val}</div>
          ))}
        </div>
      </div>
      {/* Bottom data strip */}
      <div style={{ position: "absolute", bottom: 28, left: 0, right: 0, overflow: "hidden", height: 16 }}>
        <div style={{ transform: `translateX(${bottomScrollX}px)`, whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 9, color: accent, opacity: 0.35 }}>
          {FIN_BOTTOM_TEXT + FIN_BOTTOM_TEXT + FIN_BOTTOM_TEXT}
        </div>
      </div>
      {/* Vignette */}
      <svg width={w} height={h} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <defs>
          <radialGradient id="finvignette" cx="50%" cy="50%" r="70%">
            <stop offset="40%" stopColor="transparent" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.88)" />
          </radialGradient>
        </defs>
        <rect width={w} height={h} fill="url(#finvignette)" />
      </svg>
    </AbsoluteFill>
  );
};

export const CinematicBackground: React.FC<{
  theme: Theme;
  w: number;
  h: number;
  frame: number;
  energy?: string;
  variant?: "grid" | "mesh" | "soft" | "memory" | "network" | "tactical" | "newsroom" | "network_tech" | "financial"; // per-DNA background character
  seed?: number; // per-video so the particle field isn't identical everywhere
}> = ({ theme, w, h, frame, energy, variant = "mesh", seed = 7 }) => {
  const glow = energy ?? theme.accent.brand;
  // glow position drifts by seed so even similar moods don't frame identically
  const gx = 50 + ((seed % 7) - 3) * 5;
  const gy = 18 + ((seed % 5) - 2) * 6;
  // memory variant breathes: the central glow slowly swells/contracts.
  const breathe = 1 + Math.sin(frame * 0.028) * 0.12;
  if (variant === "tactical") return (
    <AbsoluteFill style={{ background: "linear-gradient(180deg, #030608 0%, #060c12 100%)" }}>
      <TacticalBackground w={w} h={h} frame={frame} accent={glow} />
    </AbsoluteFill>
  );
  if (variant === "newsroom") return (
    <AbsoluteFill style={{ background: "linear-gradient(180deg, #07080a 0%, #0c0d10 100%)" }}>
      <NewsroomBackground w={w} h={h} frame={frame} accent={glow} />
    </AbsoluteFill>
  );
  if (variant === "network_tech") return (
    <AbsoluteFill style={{ background: "linear-gradient(180deg, #030a0f 0%, #060d14 100%)" }}>
      <TechBackground w={w} h={h} frame={frame} accent={glow} />
    </AbsoluteFill>
  );
  if (variant === "financial") return (
    <AbsoluteFill style={{ background: "linear-gradient(180deg, #03040a 0%, #060812 100%)" }}>
      <FinancialBackground w={w} h={h} frame={frame} accent={glow} />
    </AbsoluteFill>
  );
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${theme.bgGradTop} 0%, ${theme.bgGradBottom} 100%)` }}>
      <GradientMesh theme={theme} frame={frame} />
      {variant === "grid" && <ParallaxGrid w={w} h={h} color={theme.grid} frame={frame} opacity={0.04} />}
      {variant === "network" && <NetworkField w={w} h={h} color={glow} frame={frame} seed={seed} />}
      {(variant === "grid" || variant === "mesh") && <Particles w={w} h={h} color={glow} frame={frame} seed={seed} count={variant === "grid" ? 28 : 18} />}
      {/* memory: a slow breathing radial at the centre, almost no particles */}
      {variant === "memory" && (
        <AbsoluteFill style={{ background: `radial-gradient(${Math.round(680 * breathe)}px ${Math.round(680 * breathe)}px at 50% 42%, ${glow}1f, transparent 66%)` }} />
      )}
      {/* ambient glow — position varies per video */}
      <AbsoluteFill style={{ background: `radial-gradient(900px 720px at ${gx}% ${gy}%, ${glow}16, transparent 70%)` }} />
      {/* a second low warm/cool glow for depth (soft moods lean on this) */}
      <AbsoluteFill style={{ background: `radial-gradient(780px 780px at ${100 - gx}% 86%, ${glow}0d, transparent 68%)` }} />
      <AbsoluteFill style={{ boxShadow: "inset 0 0 320px 80px rgba(0,0,0,0.65)", pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
