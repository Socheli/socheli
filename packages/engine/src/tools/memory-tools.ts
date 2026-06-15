/**
 * memory-tools.ts — registry tools for the pluggable long-term memory layer.
 *
 * Exposes one provider-agnostic memory surface to every consumer via the unified
 * registry (CLI/API/MCP/SDK/copilot):
 *
 *   memory_recall    (read)    semantic/lexical search of long-term memory
 *   memory_remember  (mutate)  persist a durable fact across sessions
 *   memory_update    (mutate)  correct a stored memory by id
 *   memory_forget    (mutate)  delete a stored memory by id
 *   memory_learn     (mutate)  record an outcome signal (cognitive backends only)
 *   memory_reflect   (read)    backend self-state + which provider is active
 *
 * The backend (local-json default · cogx · mem0 · obsidian) is chosen by
 * MEMORY_PROVIDER; these tools never name it. learn/reflect are capability-gated:
 * on a backend that doesn't implement them they return a clear, actionable error
 * rather than throwing. The integrator spreads `memoryTools` into `pipelineTools`.
 *
 * Imports come from the LEAF ./helpers.ts (asyncResult/tool/ok/fail) — NOT
 * registry.ts — so there is no import cycle (see helpers.ts header).
 */

import { z } from "zod";

import { MemoryKind } from "@os/schemas";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import { getMemoryProvider, memoryStatus } from "../memory/index.ts";

/* channel → scope. A single optional `channel` keeps the tool surface simple
   while partitioning memory per brand under the hood. */
const channelArg = z.string().optional().describe("channel/brand id to scope this memory to (omit for the global store)");
const scopeFor = (channel?: string) => (channel ? { channelId: channel } : undefined);

export const memoryTools: PipelineTool[] = [
  tool({
    name: "memory_recall",
    description:
      "Search long-term memory for relevant past context — prior decisions, brand notes, user preferences, what was done in earlier sessions. Use BEFORE asking something the user may have already told you, or when a request references past work. Provider-agnostic (local store by default; semantic when a memory backend is configured).",
    kind: "read",
    schema: z
      .object({
        query: z.string().min(1).describe("what to look for, in natural language"),
        limit: z.number().int().positive().optional().describe("max memories to return (default 6)"),
        kind: MemoryKind.optional().describe("optional filter: fact | event | howto | identity | trait"),
        channel: channelArg,
      })
      .strict(),
    run: ({ query, limit, kind, channel }) =>
      asyncResult(
        getMemoryProvider()
          .recall(query, { limit, kind, scope: scopeFor(channel) })
          .then((memories) => ok({ provider: getMemoryProvider().name, count: memories.length, memories })),
      ),
  }),

  tool({
    name: "memory_remember",
    description:
      "Persist a durable fact to long-term memory so it survives across sessions — a user preference, a decision, an outcome, a reusable how-to. Store only things worth recalling later; never transient chatter. Write it self-contained so it makes sense when recalled out of context.",
    kind: "mutate",
    schema: z
      .object({
        content: z.string().min(1).describe("the single fact to remember, self-contained"),
        kind: MemoryKind.optional().describe("fact (default) | event | howto | identity | trait"),
        channel: channelArg,
      })
      .strict(),
    run: ({ content, kind, channel }) =>
      asyncResult(
        getMemoryProvider()
          .remember({ content, kind, scope: scopeFor(channel) })
          .then((rec) => ok({ provider: getMemoryProvider().name, memory: rec }, "remembered")),
      ),
  }),

  tool({
    name: "memory_update",
    description: "Correct a stored memory by id (from a memory_recall result). Replaces its content.",
    kind: "mutate",
    schema: z
      .object({ id: z.string().min(1).describe("the memory id from a recall result"), content: z.string().min(1).describe("the corrected content") })
      .strict(),
    run: ({ id, content }) =>
      asyncResult(getMemoryProvider().update(id, content).then((rec) => ok({ provider: getMemoryProvider().name, memory: rec }, "updated"))),
  }),

  tool({
    name: "memory_forget",
    description: "Delete a stored memory by id (from a memory_recall result). Idempotent.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1).describe("the memory id to delete") }).strict(),
    run: ({ id }) =>
      asyncResult(getMemoryProvider().forget(id).then(() => ok({ provider: getMemoryProvider().name, id }, "forgotten"))),
  }),

  tool({
    name: "memory_learn",
    description:
      "Record an outcome/learning signal (e.g. 'hook style X outperformed Y on TikTok') for the memory backend to fold into its confidence/consolidation. Only meaningful on a cognitive backend (cogx/iCog); on simpler backends it returns a clear note that the verb is unsupported.",
    kind: "mutate",
    schema: z.object({ outcome: z.string().min(1).describe("the outcome/signal to learn from"), channel: channelArg }).strict(),
    run: ({ outcome, channel }) => {
      const p = getMemoryProvider();
      if (!p.learn) return fail(`memory provider "${p.name}" does not support learn(); set MEMORY_PROVIDER=cogx for outcome-driven learning.`);
      return asyncResult(p.learn({ outcome, scope: scopeFor(channel) }).then(() => ok({ provider: p.name }, "learned")));
    },
  }),

  tool({
    name: "memory_reflect",
    description:
      "Report the active memory provider + whether the cognitive verbs are available, and (on backends that support it) the backend's self-state — memory count, narrative. Use when asked about the agent's memory/state.",
    kind: "read",
    schema: z.object({}).strict(),
    run: () => {
      const p = getMemoryProvider();
      const status = memoryStatus();
      if (!p.reflect) return ok({ ...status, narrative: null }, `provider: ${p.name}`);
      return asyncResult(p.reflect().then((r) => ok({ ...status, ...r })));
    },
  }),
];
