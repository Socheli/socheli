import { z } from "zod";
import { think } from "./brain.ts";
import { effectiveChannels } from "./channels.ts";
import { searchContext } from "./websearch.ts";

/* Freeform "prompt on it" brainstorming for the calendar. Given an operator
   prompt (and optional brand + date), return a few concrete, on-brand content
   ideas. Used by the calendar day drawer's prompt box. Tolerant: falls back to
   a deterministic stub if the brain is unavailable. */

const Idea = z.object({
  title: z.string(),
  angle: z.string(),
  why: z.string(),
});
const Brainstorm = z.object({ ideas: z.array(Idea).min(1) });
export type BrainstormIdea = z.infer<typeof Idea>;

export async function brainstormIdeas(
  prompt: string,
  channelId?: string,
  n = 5,
  date?: string,
): Promise<{ ideas: BrainstormIdea[]; usd: number }> {
  const c = channelId ? effectiveChannels()[channelId] : undefined;
  const dna = c
    ? `BRAND: ${c.name}\naudience: ${c.audience}${c.domain ? `\nDOMAIN (stay strictly inside this): ${c.domain}` : ""}\ntone: ${c.tone}\nbanned: ${c.bannedPatterns.join(", ")}`
    : "No specific brand — keep ideas general but sharp.";
  const web = c ? searchContext(`${c.domain ?? c.audience} ${prompt} 2026`, 5) : searchContext(`${prompt} 2026`, 4);

  const full =
    `You are a content strategist brainstorming for a specific day on the content calendar.\n` +
    `${dna}\n${date ? `TARGET DATE: ${date}\n` : ""}` +
    `OPERATOR PROMPT: "${prompt}"\n` +
    `${web ? `\nLIVE WEB CONTEXT (ground ideas in these real, current results):\n${web}\n` : ""}` +
    `\nReturn ${n} concrete, specific, non-generic content ideas that answer the prompt and fit the brand.\n` +
    `Each: a scroll-stopping title, the angle (the specific take), and why it works now.\n` +
    `No hype, no em dashes. Return ONLY JSON: {"ideas":[{"title","angle","why"}]}.`;

  try {
    const r = await think(Brainstorm, full, "smart", 2, "brainstorm");
    return { ideas: r.data.ideas.slice(0, n), usd: r.usd };
  } catch {
    return {
      ideas: [
        { title: prompt.slice(0, 80) || "Idea for this day", angle: "A specific, concrete take on the prompt.", why: "Brain unavailable — placeholder idea." },
      ],
      usd: 0,
    };
  }
}
