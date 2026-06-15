"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Film } from "lucide-react";
import type { UIStoryboard } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";

/* Horizontal scene-frame strip for one item. Frames have a fixed 9:16 aspect;
   thumbs come from the block payload or fall back to the existing
   /api/scenethumb/<itemId>/<index> route. Each frame links to /post/<itemId>. */

export function StoryboardView({ b }: { b: UIStoryboard }) {
  const href = b.href ?? `/post/${encodeURIComponent(b.itemId)}`;
  return (
    <BlockFrame eyebrow="storyboard" href={href} meta={`${b.scenes.length} scenes`}>
      <div className="blk-sb">
        {b.scenes.map((sc, i) => {
          const thumb = sc.thumb ?? `/api/scenethumb/${encodeURIComponent(b.itemId)}/${i}`;
          return (
            <Link
              className="blk-sb-scene blk-in"
              key={i}
              href={href}
              title={sc.caption ?? sc.id}
              style={{ "--i": i } as CSSProperties}
            >
              <span className="blk-sb-frame">
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb} alt="" loading="lazy" />
                ) : (
                  <Film size={14} />
                )}
                <span className="blk-sb-n">{i + 1}</span>
                {typeof sc.durationSec === "number" ? (
                  <span className="blk-sb-dur">{sc.durationSec}s</span>
                ) : null}
              </span>
              {sc.caption ? <span className="blk-sb-cap">{sc.caption}</span> : null}
            </Link>
          );
        })}
      </div>
    </BlockFrame>
  );
}
