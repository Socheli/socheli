import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { resolveChannel } from "./channels.ts";
import { proposeConcepts, scanTrends } from "./stages.ts";
import { getLearnings } from "./learnings.ts";
import { genomeContextSafe } from "./dna.ts";

/* The Concept Board: a persistent slate of scored content concepts you can review,
   comment on, approve/reject, then turn into a video. Upstream of generation. */
const FILE = join(DATA_DIR, "concepts.json");

export type ConceptComment = { at: string; text: string };
export type BoardConcept = {
  id: string;
  channel: string;
  topic: string;
  angle: string;
  format: string;
  rationale: string;
  scores: Record<string, number>;
  overall: number;
  pick: boolean; // the model's top pick of its batch
  mood?: string; // suggested mood preset
  status: "new" | "approved" | "rejected" | "generated";
  comments: ConceptComment[];
  createdAt: string;
};

function load(): BoardConcept[] {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as BoardConcept[];
  } catch {
    return [];
  }
}
function save(list: BoardConcept[]) {
  ensureDir(DATA_DIR);
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

export const listConcepts = (): BoardConcept[] => load().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const getConcept = (id: string) => load().find((c) => c.id === id);

export function addComment(id: string, text: string) {
  const list = load();
  const c = list.find((x) => x.id === id);
  if (c) {
    c.comments.push({ at: nowIso(), text });
    save(list);
  }
  return c;
}
export function setStatus(id: string, status: BoardConcept["status"]) {
  const list = load();
  const c = list.find((x) => x.id === id);
  if (c) {
    c.status = status;
    save(list);
  }
  return c;
}

/* Concepts this channel has already seen — REJECTED ones first (the ones the
   user explicitly dismissed, which must never reappear), then other existing
   concepts (to avoid soft repeats). Fed into ideation so a fresh board stops
   re-proposing things you've already turned down. Capped to bound the prompt;
   rejected concepts always make the cut because they lead the list. */
export function avoidListForChannel(channelId: string, max = 60): string[] {
  const mine = load().filter((c) => c.channel === channelId);
  const rejected = mine.filter((c) => c.status === "rejected");
  const others = mine.filter((c) => c.status !== "rejected");
  const fmt = (c: BoardConcept) => `${c.topic}${c.angle ? ` — ${c.angle}` : ""}`.replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...rejected, ...others]) {
    const s = fmt(c);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/* Generate a fresh scored board for a channel (trend + learning aware) and append it. */
export async function generateBoard(channelId: string, n = 5): Promise<{ concepts: BoardConcept[]; usd: number }> {
  const channel = resolveChannel(channelId);
  let context = [getLearnings(channel.id), genomeContextSafe(channel.id)].filter(Boolean).join("\n\n");
  let usd = 0;
  try {
    const tr = await scanTrends(channel);
    usd += tr.usd;
    if (tr.data.angles.length) context = [context, `Trending now: ${tr.data.angles.join("; ")}`].filter(Boolean).join("\n");
  } catch {
    /* trends optional */
  }
  // Exclude what the user already rejected / queued so it stops resurfacing.
  const avoid = avoidListForChannel(channel.id);
  const r = await proposeConcepts(channel, context, n, avoid);
  usd += r.usd;
  const stamp = nowIso().replace(/[-:TZ.]/g, "").slice(0, 14);
  const fresh: BoardConcept[] = r.data.concepts.map((c, i) => ({
    id: `cb_${stamp}_${i}`,
    channel: channel.id,
    topic: c.topic,
    angle: c.angle,
    format: c.format,
    rationale: c.rationale,
    scores: c.scores,
    overall: c.overall,
    pick: i === r.data.pick,
    mood: c.mood,
    status: "new",
    comments: [],
    createdAt: nowIso(),
  }));
  save([...fresh, ...load()]);
  return { concepts: fresh, usd };
}
