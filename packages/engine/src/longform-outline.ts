import { LongformOutline, type ChannelDNA } from "@os/schemas";
import { think, type BrainResult } from "./brain.ts";
import { searchContext } from "./websearch.ts";
import { findFresh } from "./research/store.ts";
import { runResearch } from "./research/orchestrator.ts";
import { subMoods, SUBMOOD_IDS } from "@os/tokens";

/* ─── Long-form (16:9) outline + shared research ───────────────────────────
   The Showrunner stage of the long-form pipeline: plan a premium ~7-9 minute
   YouTube video as an outline of chapters, then gather a single shared research
   cache that every chapter script reuses so facts stay consistent. */

const dna = (c: ChannelDNA) =>
  `CHANNEL: ${c.name}
audience: ${c.audience}${c.domain ? `\nDOMAIN (the whole video MUST stay in this subject area): ${c.domain}` : ""}
tone: ${c.tone}
visual style: ${c.visualStyle}${c.archetype ? `\nEDITORIAL ARCHETYPE (how this channel conceives a video — let it shape the outline's structure and the kinds of chapters you choose): ${c.archetype}` : ""}
banned (never produce): ${c.bannedPatterns.join(", ")}
preferred hook shapes: ${c.preferredHooks.join(" | ")}`;

// The sub-mood menu (id + purpose) the Showrunner picks from per chapter.
const subMoodMenu = () =>
  SUBMOOD_IDS.map((id) => `- ${id}: ${subMoods[id].purpose}`).join("\n");

export const outlineLongform = (
  c: ChannelDNA,
  topic: string,
  moodId: string,
  context = "",
): Promise<BrainResult<LongformOutline>> =>
  think<LongformOutline>(
    LongformOutline,
    `You are the Showrunner for ${c.name}, planning a PREMIUM ~7-9 minute YouTube long-form video on the topic: "${topic}".
${dna(c)}
Base mood for the whole video: ${moodId}.
${context ? `\nPERFORMANCE + TREND CONTEXT (weight your plan toward this):\n${context}\n` : ""}
Produce: a compelling TITLE, a clear THESIS (the through-line/central argument), and 4-7 CHAPTERS.
Each chapter:
- number (1..N, sequential)
- a short title
- a subMood id from this exact list: ${SUBMOOD_IDS.join(", ")} (with their purposes:
${subMoodMenu()})
- a one-line purpose
- 2-5 outline points it must cover

Chapter 1's subMood MUST be "hook"; the last chapter's subMood MUST be "payoff".
Vary the sub-moods across the middle chapters so the video isn't monotone.
Be specific, accurate, non-generic — no filler chapters.

Return ONLY JSON matching {title,thesis,chapters:[{id,number,title,subMood,purpose,points}]}.`,
    "best",
  ).then((r) => ({
    data: {
      ...r.data,
      chapters: r.data.chapters.map((ch) => ({ ...ch, id: ch.id || `ch${ch.number}` })),
    },
    usd: r.usd,
  }));

/* Gather one SHARED research cache for the WHOLE video. Fed to every chapter
   script so facts stay consistent. Robust + fail-open: any search may return
   "" and we simply skip it. */
export async function researchLongform(
  topic: string,
  outline: LongformOutline,
): Promise<{ research: string; sources: string[] }> {
  const CAP = 6000;
  // §2 research harness: one cached/verified topic run replaces the raw
  // per-chapter search loop; the loop below remains the fallback path.
  try {
    const run = findFresh("topic", topic, 48) ?? (await runResearch({ kind: "topic", query: topic, depth: "standard" }));
    if (run.report) return { research: run.report.slice(0, CAP), sources: run.sources.map((s) => s.url) };
  } catch {
    /* harness down → legacy searchContext loop below */
  }
  const blocks: string[] = [];
  const sources = new Set<string>();

  // Build a small set of focused queries: the topic itself, then each chapter.
  const queries: string[] = [topic];
  for (const ch of outline.chapters) {
    const pts = ch.points.slice(0, 2).join(", ");
    queries.push(`${topic} ${ch.title}${pts ? ` ${pts}` : ""}`.trim());
  }

  for (const q of queries) {
    if (blocks.join("\n\n").length >= CAP) break;
    try {
      const text = searchContext(q, 4);
      if (!text) continue;
      blocks.push(text);
      // Pull any URLs the context block surfaced.
      for (const m of text.matchAll(/\[(https?:\/\/[^\]\s]+)\]/g)) sources.add(m[1]);
    } catch {
      // fail open — skip this query
    }
  }

  const research = blocks.join("\n\n").slice(0, CAP);
  return { research, sources: [...sources] };
}
