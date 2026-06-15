"use client";
import type { CSSProperties } from "react";
import type { UIGenome, GenomeTrait } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";

/* Brand Genome traits as tag rows grouped by kind (hook/topic/format/voice…),
   weights mono. Deep-links to /channels for the full genome view.
   Sketch-deep: trait groups cascade in (.blk-in). */

export function GenomeView({ b }: { b: UIGenome }) {
  const groups = new Map<string, GenomeTrait[]>();
  for (const t of b.traits) {
    const list = groups.get(t.kind) ?? [];
    list.push(t);
    groups.set(t.kind, list);
  }
  return (
    <BlockFrame eyebrow={`genome · ${b.channel}`} href={b.href}>
      <div className="blk-gn">
        {Array.from(groups.entries()).map(([kind, traits], gi) => (
          <div className="blk-gn-group blk-in" key={kind} style={{ "--i": gi } as CSSProperties}>
            <span className="blk-gn-kind">{kind}</span>
            <span className="blk-gn-tags">
              {traits.map((t, i) => (
                <span className="blk-gn-tag" key={i}>
                  {t.text}
                  {typeof t.weight === "number" ? <span className="blk-gn-w">{t.weight}</span> : null}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </BlockFrame>
  );
}
