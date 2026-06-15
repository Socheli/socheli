import { z } from "zod";

/* ════════════════════════════════════════════════════════════════════════
   MEMORY — the pluggable long-term memory layer's transport shapes.

   Socheli's memory is provider-agnostic: a channel/agent can be backed by
   CognitiveX (iCog), mem0, an Obsidian vault, or a zero-dependency local JSON
   store — selected by the MEMORY_PROVIDER env, one active at a time. Every
   provider speaks the SAME small vocabulary (remember / recall / update /
   forget, plus optional learn / reflect) over these shapes, so the engine,
   tools, harness roles and copilot never know which backend is underneath.

   This mirrors the pattern both leading OSS agent harnesses converged on
   (Hermes' `MemoryProvider` ABC, OpenClaw's `MemoryBackend` slot): keep the
   record shape tiny and let each adapter own everything behind it.

   The TypeScript MemoryProvider INTERFACE lives engine-side
   (packages/engine/src/memory/types.ts) — it's behaviour, not a persisted
   shape. These zod schemas are the data that crosses the wire.
   ════════════════════════════════════════════════════════════════════════ */

/* What a memory is, semantically. Deliberately small + backend-neutral; each
   adapter maps these onto its own taxonomy (e.g. iCog's semantic/episodic/
   procedural/foundational, mem0's metadata, an Obsidian tag). */
export const MemoryKind = z.enum(["fact", "event", "howto", "identity", "trait"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/* Tenant + brand scoping. Memories are partitioned by these so one workspace's
   recall never bleeds into another's (the local-json store keys files by scope;
   external backends map them onto user_id / agent_slug / vault path). */
export const MemoryScope = z
  .object({
    workspaceId: z.string().optional(),
    channelId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();
export type MemoryScope = z.infer<typeof MemoryScope>;

/* A single memory as returned by recall/remember. `score` is set by recall
   (relevance, 0..1 where the backend provides it); `id` is the backend's own
   handle, used by update/forget. */
export const MemoryRecord = z.object({
  id: z.string(),
  content: z.string(),
  kind: MemoryKind.optional(),
  scope: MemoryScope.optional(),
  metadata: z.record(z.unknown()).optional(),
  score: z.number().optional(),
  createdAt: z.string().optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

/* The known provider ids (free string in config so a new adapter is a one-file
   add, but this documents the built-ins). "auto" picks the first configured
   external backend, falling back to local-json. */
export const MemoryProviderId = z.enum(["auto", "local-json", "cogx", "mem0", "obsidian"]);
export type MemoryProviderId = z.infer<typeof MemoryProviderId>;
