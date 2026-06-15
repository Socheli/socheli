import type { Idea, Script, Storyboard, PostPackage } from "@os/schemas";

/* Strip AI-tell punctuation. The big one: em/en dashes dropped into the middle of
   a sentence. We replace them with natural commas/periods. ASCII hyphen "-" is left
   alone (so code like `a - b` and `src/auth` is untouched). */
export function deAi(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ") // em/en dash → comma
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ", ")
    .replace(/,\s*\./g, ".")
    .replace(/,\s*$/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* Deep-walk any value, applying deAi to every string. Safe across the whole
   storyboard since it only touches typographic dashes. */
function deepClean<T>(v: T): T {
  if (typeof v === "string") return deAi(v) as unknown as T;
  if (Array.isArray(v)) return v.map(deepClean) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = deepClean(val);
    return out as T;
  }
  return v;
}

export const cleanIdea = (i: Idea): Idea => deepClean(i);
export const cleanScript = (s: Script): Script => deepClean(s);
export const cleanStoryboard = (sb: Storyboard): Storyboard => deepClean(sb);
export const cleanPackage = (p: PostPackage): PostPackage => deepClean(p);
