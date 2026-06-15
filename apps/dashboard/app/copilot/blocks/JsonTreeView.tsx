"use client";
import type { UIJsonTree } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { JsonTree } from "../JsonTree";

/* The `json_tree` UI block: an explorable collapsible tree for structured data
   when no specific widget fits. Wraps the shared JsonTree in the house
   BlockFrame so it carries the same ink chrome + eyebrow as every other block.
   The frame already renders its own header label, so JsonTree's internal header
   stays compact (count + copy + expand/collapse); we pass the block label (or a
   default) as the tree's rootLabel for the in-tree label slot. */
export function JsonTreeView({ b }: { b: UIJsonTree }) {
  return (
    <BlockFrame eyebrow={b.label || "data"}>
      <JsonTree data={b.data} rootLabel={b.label || "data"} defaultExpandDepth={2} />
    </BlockFrame>
  );
}

export default JsonTreeView;
