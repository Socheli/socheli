"use client";
import type { CSSProperties, ReactNode } from "react";
import type { UIBoard, UIBlock } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";

/* Composite layout: a 2/3-column grid of nested blocks so Soli can compose a
   small dashboard mid-chat (e.g. weekly review = calendar_week +
   insights_chart + inbox_summary). Children were validated recursively by
   ui-spec (depth 1, max 6, never a nested board) and are rendered through the
   SAME BlockView the top level uses — passed in as `renderBlock` so this file
   doesn't import UIBlock.tsx back (no cycle). Cells cascade in via .blk-in. */

export function BoardView({
  b,
  renderBlock,
}: {
  b: UIBoard;
  renderBlock: (block: UIBlock, key: number) => ReactNode;
}) {
  return (
    <BlockFrame eyebrow={b.title ?? "board"}>
      <div className={`blk-board cols-${b.columns}`}>
        {b.blocks.map((child, i) => (
          <div className="blk-board-cell blk-in" key={i} style={{ "--i": i } as CSSProperties}>
            {renderBlock(child, i)}
          </div>
        ))}
      </div>
    </BlockFrame>
  );
}
