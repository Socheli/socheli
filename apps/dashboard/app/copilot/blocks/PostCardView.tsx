"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Film } from "lucide-react";
import type { UIPostCard } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { CountUp } from "./anim";

/* Rich preview of ONE content item: 9:16 poster (payload thumb or the
   /api/thumb/<itemId> fallback), title, status pill in the frame header, mono
   meta line (channel/mood/platforms) and a mono metrics row. The whole card
   links to /post/<itemId>.

   Entrance: the poster scales/fades in (blk-pc-poster), the meta + platform
   pills settle on the .blk-in cascade, and the metric numbers ROLL up via the
   shared CountUp — same grammar as the chart values. */

function fmtDur(s: number): string {
  const sec = Math.round(s);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function PostCardView({ b }: { b: UIPostCard }) {
  const href = b.href ?? `/post/${encodeURIComponent(b.itemId)}`;
  const thumb = b.thumb ?? `/api/thumb/${encodeURIComponent(b.itemId)}`;
  const meta = [b.channel, b.mood].filter(Boolean).join(" · ");
  const metrics: { label: string; value: number }[] = [];
  if (b.metrics?.views != null) metrics.push({ label: "views", value: b.metrics.views });
  if (b.metrics?.likes != null) metrics.push({ label: "likes", value: b.metrics.likes });
  if (b.metrics?.comments != null) metrics.push({ label: "comments", value: b.metrics.comments });

  return (
    <BlockFrame
      eyebrow="post"
      href={href}
      meta={<span className={`blk-pill pc-${b.status.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{b.status}</span>}
    >
      <Link className="blk-pc" href={href} title={b.title}>
        <span className="blk-pc-poster">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" loading="lazy" />
          ) : (
            <Film size={16} />
          )}
          {typeof b.durationSec === "number" ? (
            <span className="blk-pc-dur">{fmtDur(b.durationSec)}</span>
          ) : null}
        </span>
        <span className="blk-pc-main">
          <span className="blk-pc-title blk-in">{b.title}</span>
          {meta ? <span className="blk-pc-meta blk-in" style={{ "--i": 1 } as CSSProperties}>{meta}</span> : null}
          {b.publishedTo && b.publishedTo.length ? (
            <span className="blk-pc-platforms blk-in" style={{ "--i": 2 } as CSSProperties}>
              {b.publishedTo.map((p, i) => (
                <span className="blk-pc-platform" key={i}>
                  {p}
                </span>
              ))}
            </span>
          ) : null}
          {metrics.length ? (
            <span className="blk-pc-metrics blk-in" style={{ "--i": 3 } as CSSProperties}>
              {metrics.map((m, i) => (
                <span className="blk-pc-metric" key={i}>
                  <span className="blk-pc-n"><CountUp value={m.value} delayMs={200 + i * 90} /></span> {m.label}
                </span>
              ))}
            </span>
          ) : null}
          <span className="blk-pc-id blk-in" style={{ "--i": 4 } as CSSProperties}>{b.itemId}</span>
        </span>
      </Link>
    </BlockFrame>
  );
}
