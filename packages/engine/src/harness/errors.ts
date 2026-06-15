/* Provider/runtime error classification (docs/AGENT-HARNESS.md §7).

   One small, dependency-free module shared by the one-shot brain (brain.ts)
   and the multi-turn harness (run.ts) so both layers make the SAME rotation
   decision when a provider dies mid-run. Classification is string-based on
   purpose: every backend surfaces failures as error MESSAGES ("claude exited
   1: …", "openrouter: 429 …", "spawn codex ENOENT"), not typed errors.

   Classes:
     unavailable — binary/endpoint missing: rotate immediately, retrying can't fix it
     auth        — bad/expired credentials: rotate immediately
     quota       — rate/usage/billing limit (the real-world killer: a Claude
                   subscription session limit surfaces as a bare "claude exited 1"
                   with "usage limit reached … resets 3am" on stderr): rotate
     transient   — network blip / 5xx / overload: retry the SAME provider once,
                   then rotate (callers own that retry; shouldRotate says false)
     model       — bad output (zod parse, malformed JSON, prompt issues): retry
                   the same provider — a different backend won't fix a prompt   */

export type ProviderErrorClass = "unavailable" | "auth" | "quota" | "transient" | "model";

const PATTERNS: ReadonlyArray<readonly [ProviderErrorClass, RegExp]> = [
  ["unavailable", /ENOENT|not found|no such file|command not found/i],
  ["auth", /\b40[13]\b|invalid.?api.?key|unauthorized|authentication|forbidden/i],
  ["quota", /\b429\b|quota|rate.?limit|limit reached|usage limit|resets \d|insufficient.{0,8}(credit|quota)|billing|exceeded.{0,12}limit/i],
  ["transient", /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket|fetch failed|network|\b5\d\d\b|overloaded|temporarily/i],
];

export function classifyProviderError(message: string): ProviderErrorClass {
  for (const [cls, re] of PATTERNS) if (re.test(message)) return cls;
  return "model";
}

/* Should the caller advance to the NEXT provider instead of retrying this one?
     unavailable/auth/quota → yes, immediately.
     model + a bare nonzero exit ("claude exited 1" with no recognizable detail)
       → yes: an opaque CLI death is a provider problem, not a prompt problem —
       this exact shape is what a quota-exhausted Claude subscription emits when
       stderr is empty, and retrying it 3× is how runs used to die.
     transient → no; the caller retries the same provider ONCE, then rotates.
     model (parse/zod) → no; retry the same provider with feedback.            */
export function shouldRotate(cls: ProviderErrorClass, message: string): boolean {
  if (cls === "unavailable" || cls === "auth" || cls === "quota") return true;
  if (cls === "model" && /exited \d+/i.test(message)) return true;
  return false;
}
