"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type {
  UICountdown,
  UISlots,
  UIMissionCard,
  UIBudgetMeter,
  UIGateBlock,
  UIDeviceCard,
} from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { CountUp, InkStroke } from "./anim";

/* Ops widgets — the social-media-manager's control surfaces: a live ticking
   countdown to the next slot, best posting times, a mission's standing state,
   spend vs cap, a HUMAN approval gate (deep-link only — gates are sacred, the
   block never carries an approve button), and one fleet device. */

/* ---------- countdown ---------- */

/* hand-drawn clock: wobbled circle + two hands */
const INK_CLOCK =
  "M11 2.6 C 16.4 2.2, 20.6 6, 20.4 11.2 C 20.2 16.6, 16 20.4, 10.8 20.2 C 5.8 20, 2.2 16.2, 2.4 11 C 2.6 6.2, 6.2 2.9, 11.2 2.8";
const INK_HANDS = "M11.3 6.2 C 11.2 8.1, 11.4 9.8, 11.3 11.4 C 13 11.6, 14.6 12.4, 15.8 13.4";

function partsUntil(at: string): { label: string; past: boolean } {
  const ms = new Date(at).getTime() - Date.now();
  const past = ms <= 0;
  const a = Math.abs(ms);
  const d = Math.floor(a / 86400000);
  const h = Math.floor((a % 86400000) / 3600000);
  const m = Math.floor((a % 3600000) / 60000);
  const s = Math.floor((a % 60000) / 1000);
  const label =
    d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  return { label, past };
}

export function CountdownView({ b }: { b: UICountdown }) {
  // tick once a second; the interval dies with the block
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const { label, past } = partsUntil(b.at);
  return (
    <BlockFrame eyebrow={b.label} href={b.href} hug>
      <div className="blk-cd">
        <span className="blk-cd-clock">
          <InkStroke d={INK_CLOCK} viewBox="0 0 23 23" className="blk-cd-face" durMs={520} />
          <InkStroke d={INK_HANDS} viewBox="0 0 23 23" className="blk-cd-hands" delayMs={480} durMs={320} width={1.5} />
        </span>
        <span className={`blk-cd-time${past ? " past" : ""}`}>{past ? `${label} ago` : `in ${label}`}</span>
        <span className="blk-cd-at">{new Date(b.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </BlockFrame>
  );
}

/* ---------- slots (best posting times) ---------- */

const INK_RING_S =
  "M6 14.5 C 4.6 8.6, 10 3.4, 19 3.1 C 28.4 2.8, 35.4 7, 35 13 C 34.6 19, 27.6 23.2, 18.6 22.9 C 10.6 22.6, 5.6 19.4, 5.8 14.2";

export function SlotsView({ b }: { b: UISlots }) {
  const best = b.slots.reduce(
    (bi, s, i) => ((s.score ?? -1) > (b.slots[bi]?.score ?? -1) ? i : bi),
    0,
  );
  const hasScores = b.slots.some((s) => s.score != null);
  return (
    <BlockFrame eyebrow={b.title ?? "best times"} href={b.href}>
      <ul className="blk-st">
        {b.slots.map((s, i) => {
          const isBest = hasScores && i === best;
          return (
            <li className={`blk-st-row blk-in${isBest ? " best" : ""}`} key={i} style={{ "--i": i } as CSSProperties}>
              <span className="blk-st-day">{s.day}</span>
              <span className="blk-st-time">
                {s.time}
                {isBest ? <InkStroke d={INK_RING_S} viewBox="0 0 40 26" className="blk-st-ink" delayMs={420 + i * 60} durMs={520} width={1.4} /> : null}
              </span>
              <span className="blk-st-track">
                {s.score != null ? (
                  <span className="blk-st-bar" style={{ width: `${Math.max(3, s.score * 100)}%`, animationDelay: `${i * 55}ms` }} />
                ) : null}
              </span>
              <span className="blk-st-score">{s.score != null ? `${Math.round(s.score * 100)}` : ""}</span>
            </li>
          );
        })}
      </ul>
    </BlockFrame>
  );
}

/* ---------- mission_card ---------- */

export function MissionCardView({ b }: { b: UIMissionCard }) {
  return (
    <BlockFrame eyebrow="mission" meta={b.missionId} href={b.href}>
      <div className="blk-mn">
        <div className="blk-mn-head">
          <span className={`blk-mn-dot st-${b.status}`} />
          <span className={`blk-pill blk-mn-status st-${b.status}`}>{b.status}</span>
          {b.nextRun ? <span className="blk-mn-next">next {b.nextRun}</span> : null}
        </div>
        <p className="blk-mn-goal blk-in">{b.goal}</p>
        {b.cadence ? <div className="blk-mn-cadence blk-in" style={{ "--i": 2 } as CSSProperties}>{b.cadence}</div> : null}
      </div>
    </BlockFrame>
  );
}

/* ---------- budget_meter ---------- */

/* a hand-drawn cap bracket: small vertical wobble stroke */
const INK_CAP = "M3.4 1.6 C 2.8 5.4, 3.6 10.2, 3 14.4";

export function BudgetMeterView({ b }: { b: UIBudgetMeter }) {
  const ratio = b.spentUsd / b.capUsd;
  const pct = Math.min(1, ratio) * 100;
  const tone = ratio >= 1 ? "over" : ratio >= 0.85 ? "near" : "ok";
  return (
    <BlockFrame eyebrow={b.label ?? "budget"} href={b.href} hug>
      <div className={`blk-bm t-${tone}`}>
        <div className="blk-bm-nums">
          <span className="blk-bm-spent">
            $<CountUp value={b.spentUsd} delayMs={150} format={false} decimals={b.spentUsd % 1 ? 2 : 0} />
          </span>
          <span className="blk-bm-cap">of ${b.capUsd % 1 ? b.capUsd.toFixed(2) : b.capUsd} cap</span>
          <span className="blk-bm-pct">{Math.round(ratio * 100)}%</span>
        </div>
        <div className="blk-bm-track">
          <span className="blk-bm-bar" style={{ width: `${Math.max(1.5, pct)}%` }} />
          <span className="blk-bm-capmark">
            <InkStroke d={INK_CAP} viewBox="0 0 6 16" className="blk-bm-ink" delayMs={560} durMs={260} width={1.4} />
          </span>
        </div>
      </div>
    </BlockFrame>
  );
}

/* ---------- gate (human approval) ---------- */

/* four drawn corner brackets — the "stop here" frame */
const GATE_CORNERS: { cls: string; d: string }[] = [
  { cls: "g-tl", d: "M12 2.6 C 8.4 2.4, 5 2.8, 2.8 3.2 C 2.4 5.6, 2.5 9, 2.6 12" },
  { cls: "g-tr", d: "M2 2.6 C 5.6 2.4, 9 2.8, 11.2 3.2 C 11.6 5.6, 11.5 9, 11.4 12" },
  { cls: "g-br", d: "M11.4 2 C 11.5 5, 11.6 8.4, 11.2 10.8 C 9 11.2, 5.6 11.6, 2 11.4" },
  { cls: "g-bl", d: "M2.6 2 C 2.5 5, 2.4 8.4, 2.8 10.8 C 5 11.2, 8.4 11.6, 12 11.4" },
];

export function GateView({ b }: { b: UIGateBlock }) {
  return (
    <BlockFrame eyebrow="awaiting approval" meta={b.kind} href={b.href}>
      <div className="blk-gt">
        {GATE_CORNERS.map((c, i) => (
          <InkStroke key={c.cls} d={c.d} viewBox="0 0 14 14" className={`blk-gt-corner ${c.cls}`} delayMs={i * 110} durMs={300} width={1.4} />
        ))}
        <div className="blk-gt-title blk-in">{b.title}</div>
        {b.summary ? <p className="blk-gt-summary blk-in" style={{ "--i": 1 } as CSSProperties}>{b.summary}</p> : null}
        <div className="blk-gt-note blk-in" style={{ "--i": 2 } as CSSProperties}>
          held for your call — nothing moves until you approve
        </div>
      </div>
    </BlockFrame>
  );
}

/* ---------- device_card ---------- */

/* three drawn signal arcs over the device dot */
const SIGNAL_ARCS = [
  "M7.2 12.4 C 8.6 11, 10.6 11, 12 12.3",
  "M5 9.8 C 7.6 7.2, 11.6 7.2, 14.2 9.7",
  "M2.8 7.2 C 6.6 3.4, 12.6 3.4, 16.4 7.1",
];

export function DeviceCardView({ b }: { b: UIDeviceCard }) {
  return (
    <BlockFrame eyebrow="device" meta={b.hw} href={b.href} hug>
      <div className="blk-dv">
        <span className={`blk-dv-sig st-${b.status}`}>
          {SIGNAL_ARCS.map((d, i) => (
            <InkStroke key={i} d={d} viewBox="0 0 19 15" className="blk-dv-arc" delayMs={i * 160} durMs={300} width={1.4} />
          ))}
          <span className="blk-dv-dot" />
        </span>
        <div className="blk-dv-main">
          <div className="blk-dv-name">
            {b.device}
            <span className={`blk-pill blk-dv-status st-${b.status}`}>{b.status}</span>
          </div>
          {b.job ? <div className="blk-dv-job">{b.job}</div> : null}
        </div>
      </div>
    </BlockFrame>
  );
}
