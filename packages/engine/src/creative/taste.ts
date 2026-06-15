import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { EditingTaste, type TasteRule } from "@os/schemas";
import { DATA_DIR, ensureDir, nowIso } from "../store.ts";

/* Per-channel EDITING taste memory — the editor's learned *craft* judgement,
   kept deliberately separate from the content Brand Genome (DNA in dna.ts).
   DNA answers "what should this brand SAY"; taste answers "how should a cut
   FEEL" (pacing, palette, typography, transitions, sound) and what we never do.

   Persisted one file per channel at data/editing-taste/<channel>.json so an
   autonomous review loop and a human edit can never tear each other's writes
   (atomic tmp+rename, mirroring dna.ts). Other creative modules inject
   tasteContext() into their think() prompts to ground the editor in this
   brand's house style; learnTaste() grows it from self-reviews + performance. */

const TASTE_DIR = join(DATA_DIR, "editing-taste");

/* Channel ids arrive from tool input at the boundary — sanitize so a hostile
   "../../x" can never escape data/editing-taste/ (same guard as dna.ts). */
const safeName = (channel: string) => channel.replace(/[^a-zA-Z0-9._-]/g, "_");

function tastePath(channel: string): string {
  return join(TASTE_DIR, `${safeName(channel)}.json`);
}

/* The starter taste for a never-seen channel: a premium-minimal editor's
   defaults. These are SEED-sourced (lowest authority) so the first real
   feedback/review signal outranks and reshapes them rather than fighting them. */
function seedTaste(channel: string): EditingTaste {
  const seedRule = (rule: string, weight: number): TasteRule => ({
    rule,
    weight,
    source: "seed",
    at: nowIso(),
  });
  return EditingTaste.parse({
    channel,
    prefs: {
      pacing: "brisk but breathing",
      palette: "restrained, one accent, deep neutrals",
      typography: "clean grotesk, generous tracking, high contrast",
      transitions: "hard cuts; motion only with intent",
      sound: "music ducks under voice; let silence land",
    },
    rules: [
      seedRule("hook lands in the first 3s", 0.9),
      seedRule("let silence breathe on emotional beats", 0.7),
      seedRule("cut on motion / on the beat", 0.7),
      seedRule("one idea per shot — keep it legible", 0.65),
    ],
    doNots: [
      seedRule("no cheesy transitions (spin/glitch as decoration)", 0.9),
      seedRule("no unreadable subtitles (too small / poor contrast)", 0.9),
      seedRule("no wall-to-wall music drowning the voice", 0.7),
      seedRule("no aimless slow zooms with nothing to say", 0.6),
    ],
  });
}

/* Read the channel's taste if it exists; otherwise return a fresh seed. We
   parse with zod at the boundary so a hand-edited / older file is coerced to
   the current shape (defaults fill gaps); an unreadable file falls back to the
   seed rather than throwing, since taste is advisory context, not a gate. */
export function loadTaste(channel: string): EditingTaste {
  const p = tastePath(channel);
  if (existsSync(p)) {
    try {
      return EditingTaste.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      /* corrupt/legacy file — fall through to seed so prompts still get context */
    }
  }
  return seedTaste(channel);
}

/* Atomic write (tmp + rename — a reader never sees a torn JSON file), stamping
   updatedAt so freshness is always visible. */
export function saveTaste(taste: EditingTaste): void {
  ensureDir(TASTE_DIR);
  taste.updatedAt = nowIso();
  const valid = EditingTaste.parse(taste);
  const p = tastePath(valid.channel);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2));
  renameSync(tmp, p);
}

/* A compact, prompt-ready block other creative modules inject into think()
   prompts (briefs, concepts, passes, review). Kept under ~600 chars: only the
   set prefs and the top-weighted rules/doNots make the cut, so this never
   bloats a downstream prompt as taste accumulates. */
export function tasteContext(channel: string): string {
  const t = loadTaste(channel);
  const top = (rules: TasteRule[], n: number) =>
    [...rules].sort((a, b) => b.weight - a.weight).slice(0, n).map((r) => r.rule);

  const prefBits = Object.entries(t.prefs)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}: ${v}`);

  const lines: string[] = [`## Editing taste — ${channel}`];
  if (prefBits.length) lines.push(`Prefs: ${prefBits.join(" · ")}`);
  const dos = top(t.rules, 4);
  if (dos.length) lines.push(`Do: ${dos.join("; ")}`);
  const donts = top(t.doNots, 4);
  if (donts.length) lines.push(`Never: ${donts.join("; ")}`);

  // Hard cap so a runaway taste file can't blow the prompt budget; trimming the
  // tail is safe because rules/doNots were sorted strongest-first above.
  const block = lines.join("\n");
  return block.length > 600 ? `${block.slice(0, 597)}...` : block;
}

/* Case-insensitive upsert into a rule list: if the rule text already exists,
   nudge its weight toward 1 (repeated signal = stronger conviction) and adopt
   the newer source/timestamp; otherwise append a fresh rule. Returns the list
   in place (mutated) — dedupe is by normalized rule text so the same lesson
   learned twice strengthens rather than duplicates. */
function upsertRule(list: TasteRule[], rule: string, source: TasteRule["source"]): void {
  const key = rule.trim().toLowerCase();
  const existing = list.find((r) => r.rule.trim().toLowerCase() === key);
  if (existing) {
    // Bump halfway toward 1 — converges on conviction without ever locking at 1.
    existing.weight = Math.min(1, Number(((existing.weight + 1) / 2).toFixed(3)));
    existing.source = source;
    existing.at = nowIso();
    return;
  }
  list.push({ rule: rule.trim(), weight: 0.6, source, at: nowIso() });
}

/* Grow the channel's taste from a signal: a learned "do" rule, a guardrail
   ("doNot"), and/or a prefs nudge. Source defaults to "feedback" (human/loop
   correction); reviews pass "review" and performance analysis passes
   "performance". De-dupes by rule text and bumps weight on repeats, so the
   memory sharpens with evidence instead of bloating. */
export async function learnTaste(
  channel: string,
  signal: {
    rule?: string;
    doNot?: string;
    pref?: Partial<EditingTaste["prefs"]>;
    source?: TasteRule["source"];
  },
): Promise<EditingTaste> {
  const taste = loadTaste(channel);
  const source = signal.source ?? "feedback";

  if (signal.rule?.trim()) upsertRule(taste.rules, signal.rule, source);
  if (signal.doNot?.trim()) upsertRule(taste.doNots, signal.doNot, source);
  if (signal.pref) {
    // Only overwrite prefs the caller actually set (skip undefined/empty), so a
    // partial nudge never wipes an existing dimension.
    for (const [k, v] of Object.entries(signal.pref)) {
      if (v && v.trim()) (taste.prefs as Record<string, string>)[k] = v.trim();
    }
  }

  saveTaste(taste);
  return taste;
}
