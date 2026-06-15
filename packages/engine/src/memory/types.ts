/**
 * types.ts — the pluggable memory provider contract.
 *
 * Socheli's long-term memory is provider-agnostic: CognitiveX (iCog), mem0, an
 * Obsidian vault, or a zero-dependency local JSON store all implement the SAME
 * tiny interface and are selected by MEMORY_PROVIDER (see ./index.ts). This is
 * the seam that both leading OSS agent harnesses converged on — Hermes' Python
 * `MemoryProvider` ABC and OpenClaw's `MemoryBackend` slot — generalised here
 * to TypeScript.
 *
 * The contract is deliberately small. The four CORE verbs (remember / recall /
 * update / forget) every backend must implement. The two COGNITIVE verbs
 * (learn / reflect) are OPTIONAL — capability-detected at the call site
 * (`if (provider.learn)`) so a dumb store (local-json, a plain vector db) stays
 * valid while a cognitive backend (iCog, Letta) can light them up. The
 * transport shapes (MemoryRecord/MemoryScope/MemoryKind) live in @os/schemas.
 */

import type { MemoryKind, MemoryRecord, MemoryScope } from "@os/schemas";

export interface RememberInput {
  content: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface RecallOpts {
  limit?: number;
  kind?: MemoryKind;
  scope?: MemoryScope;
}

export interface ReflectResult {
  summary: string;
  [k: string]: unknown;
}

export interface MemoryProvider {
  /** Stable id, e.g. "local-json" | "cogx" | "mem0" | "obsidian". */
  readonly name: string;

  /**
   * Is this provider usable in the current environment? A CHEAP, NETWORK-FREE
   * check (env keys present, vault path set). The factory uses this to resolve
   * MEMORY_PROVIDER=auto and to fail fast with an actionable message. local-json
   * is always available.
   */
  available(): boolean;

  // ── core verbs (required) ────────────────────────────────────────────────
  remember(input: RememberInput): Promise<MemoryRecord>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryRecord[]>;
  update(id: string, content: string): Promise<MemoryRecord>;
  forget(id: string): Promise<void>;

  // ── cognitive verbs (optional — capability-detected) ─────────────────────
  /** Record an outcome/signal the backend can fold into confidence/consolidation. */
  learn?(signal: { outcome: string; scope?: MemoryScope }): Promise<void>;
  /** A consolidated self-view (memory count, narrative, health) where supported. */
  reflect?(): Promise<ReflectResult>;
}
