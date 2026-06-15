/**
 * index.ts — the memory provider factory.
 *
 * One active provider, selected by MEMORY_PROVIDER (mirrors how harness/router.ts
 * picks a runtime). This is the single seam that makes memory swappable: every
 * caller goes through getMemoryProvider(), so the engine/tools/harness/copilot
 * never name a backend.
 *
 *   MEMORY_PROVIDER = auto (default) | local-json | cogx | mem0 | obsidian
 *
 * "auto" prefers the first CONFIGURED external backend (cogx → mem0 → obsidian)
 * and falls back to local-json, so the repo works out-of-the-box with zero creds
 * but transparently upgrades the moment a key is present. An explicit value is
 * honoured even if its env is missing — the actionable error then surfaces on
 * first use rather than silently degrading.
 */

import type { MemoryProviderId } from "@os/schemas";

import { cogxProvider } from "./cogx.ts";
import { localJsonProvider } from "./local-json.ts";
import { mem0Provider } from "./mem0.ts";
import { obsidianProvider } from "./obsidian.ts";
import type { MemoryProvider } from "./types.ts";

export type { MemoryProvider, RecallOpts, RememberInput, ReflectResult } from "./types.ts";

const REGISTRY: Record<Exclude<MemoryProviderId, "auto">, MemoryProvider> = {
  "local-json": localJsonProvider,
  cogx: cogxProvider,
  mem0: mem0Provider,
  obsidian: obsidianProvider,
};

/* Auto-detection order: cognitive/semantic backends first, local-json last. */
const AUTO_ORDER: MemoryProvider[] = [cogxProvider, mem0Provider, obsidianProvider, localJsonProvider];

let cached: MemoryProvider | undefined;

function resolve(): MemoryProvider {
  const sel = (process.env.MEMORY_PROVIDER || "auto").toLowerCase();
  if (sel === "auto") return AUTO_ORDER.find((p) => p.available()) ?? localJsonProvider;
  const p = REGISTRY[sel as Exclude<MemoryProviderId, "auto">];
  if (!p) {
    throw new Error(
      `unknown MEMORY_PROVIDER="${sel}". Use one of: auto, ${Object.keys(REGISTRY).join(", ")}.`,
    );
  }
  return p;
}

/** The active memory provider (cached after first resolution). */
export function getMemoryProvider(): MemoryProvider {
  if (!cached) cached = resolve();
  return cached;
}

/** Reset the cached provider — for tests or after mutating MEMORY_PROVIDER. */
export function resetMemoryProvider(): void {
  cached = undefined;
}

/** Which provider is active + whether the cognitive verbs are available. */
export function memoryStatus(): { provider: string; configured: boolean; learn: boolean; reflect: boolean } {
  const p = getMemoryProvider();
  return { provider: p.name, configured: p.available(), learn: typeof p.learn === "function", reflect: typeof p.reflect === "function" };
}
