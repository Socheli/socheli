import type { ChannelDNA, Idea } from "@os/schemas";
import { scanTrends, proposeConcepts, type Concept } from "./stages.ts";
import { getLearnings } from "./learnings.ts";
import { genomeContextSafe } from "./dna.ts";

export type Selection = { idea: Idea; board: Concept[]; usd: number };

/* Decide WHAT to make for a channel — no seed required.
   1. Pull what has worked/flopped (learning loop) + what is trending now.
   2. Propose a scored slate of concepts against that context.
   3. Return the winner (highest overall, ties → the model's own pick) as an Idea,
      plus the full ranked board so the operator can see the runners-up. */
export async function selectConcept(
  channel: ChannelDNA,
  count = 5,
  onLog?: (m: string) => void,
): Promise<Selection> {
  let usd = 0;
  let context = [getLearnings(channel.id), genomeContextSafe(channel.id)].filter(Boolean).join("\n\n");
  try {
    const tr = await scanTrends(channel);
    usd += tr.usd;
    if (tr.data.angles.length)
      context = [context, `Trending now: ${tr.data.angles.join("; ")}`].filter(Boolean).join("\n");
  } catch {
    /* trends optional — selection still works from learnings alone */
  }

  const res = await proposeConcepts(channel, context, count);
  usd += res.usd;
  const board = [...res.data.concepts].sort((a, b) => b.overall - a.overall);
  // Winner = highest overall; if the model's explicit pick scores within 0.3, honor it.
  const picked = res.data.concepts[res.data.pick];
  const best = picked && board[0].overall - picked.overall <= 0.3 ? picked : board[0];
  onLog?.(`concept board (${board.length}): ${board.map((c) => `${c.topic} ${c.overall.toFixed(1)}`).join(" · ")}`);

  const idea: Idea = { topic: best.topic, angle: best.angle, format: best.format, rationale: best.rationale };
  return { idea, board, usd };
}
