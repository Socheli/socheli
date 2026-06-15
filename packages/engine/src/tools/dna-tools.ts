import { z } from "zod";

import { type PipelineTool, ok, spawnCli, tool } from "./helpers.ts";
import {
  applyMutation,
  genomeContext,
  getGenome,
  lockTrait,
  rejectMutation,
  setTrait,
  TRAIT_BUCKETS,
} from "../dna.ts";

/**
 * dna-tools.ts — the Brand Genome tool surface (spec §1), spread into the
 * canonical registry (registry.ts pipelineTools) so MCP / HTTP / CLI / SDK /
 * the dashboard copilot all get it for free.
 *
 * Shape note: the ok/spawnCli/tool helpers come straight from registry.ts so
 * this surface stays byte-identical to every other registry tool. That import
 * is circular-import-safe: they (and zodToJsonSchema) are hoisted `function`
 * bindings, fully initialized before either module body runs.
 */

// ---------------------------------------------------------------------------
// Shared input fragments
// ---------------------------------------------------------------------------

const channelArg = z.string().min(1).describe("channel/brand id (e.g. labrinox)");
const traitPath = z
  .string()
  .min(1)
  .describe(`trait path, e.g. ${TRAIT_BUCKETS.map((b) => `traits.${b}`).join(" | ")} | audienceModel.summary | platformPlaybooks`);

// ---------------------------------------------------------------------------
// The 9 dna_* tools (spec §1)
// ---------------------------------------------------------------------------

export const dnaTools: PipelineTool[] = [
  tool({
    name: "dna_get",
    description:
      "Get the full Brand Genome for a channel: learned trait weights (hooks/topics/formats/visual/voice), audience model, platform playbooks, evolution history, pending mutations and locks. Seeds a default genome from the channel's ChannelDNA + learnings on first read.",
    kind: "read",
    schema: z.object({ channel: channelArg, workspaceId: z.string().optional() }).strict(),
    run: ({ channel, workspaceId }) => ok(getGenome(channel, workspaceId) as unknown as Record<string, unknown>),
  }),
  tool({
    name: "dna_context",
    description:
      "Get the compact markdown genome context block for a channel (top-weighted hooks/topics/formats, audience summary, platform levers, avoid-list; <= 60 lines) — the exact block the engine injects into ideation/script prompts. Use it to ground any creative work in the brand's learned DNA.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => ok({ channel, context: genomeContext(channel) }),
  }),
  tool({
    name: "dna_evolve",
    description:
      "Run the genome evolution engine for a channel: gathers learnings, analytics scorecards, fresh research and recent QA verdicts, then proposes evidence-backed mutations (smart brain). policy=auto applies mutations with confidence >= 0.8 on unlocked paths and queues the rest; policy=gate (default) queues everything for approval. Long-running: starts a background job and returns its pid + log path; inspect results with dna_pending_list / dna_history.",
    kind: "long",
    schema: z
      .object({
        channel: channelArg,
        policy: z.enum(["auto", "gate"]).default("gate").describe("auto-apply confident mutations, or gate everything"),
      })
      .strict(),
    run: ({ channel, policy }) => {
      // HARD server-side gate: an autonomous harness worker (claude-code/codex
      // child, which carries SOCHELI_AGENT=1) can NEVER auto-apply genome
      // mutations, even if it passes policy:'auto'. We clamp to 'gate' here —
      // the single authoritative chokepoint before the --auto arg is built —
      // so the approvalPolicy.dnaMutations='gate' pin on the missions side is
      // backed by an enforcement the agent cannot talk its way around.
      // evolveGenome already defaults to 'gate', so a forced clamp degrades safely.
      if (process.env.SOCHELI_AGENT === "1") policy = "gate";
      const args = ["dna", "evolve", channel];
      if (policy === "auto") args.push("--auto");
      const job = spawnCli(args, "tool-dna-evolve.log");
      return ok({ status: "started", ...job, channel, policy }, "genome evolution started");
    },
  }),
  tool({
    name: "dna_pending_list",
    description:
      "List the pending (approval-gated) genome mutations for a channel: id, path, proposed change, rationale and confidence. Approve with dna_mutation_approve or discard with dna_mutation_reject.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => {
      const g = getGenome(channel);
      return ok({ channel, pending: g.pending }, `${g.pending.length} pending mutation(s)`);
    },
  }),
  tool({
    name: "dna_mutation_approve",
    description:
      "Approve one pending genome mutation by id: applies its machine patch to the genome, moves it into the evolution history (kind 'approved') and bumps the genome version.",
    kind: "mutate",
    schema: z.object({ channel: channelArg, id: z.string().min(1).describe("pending mutation id") }).strict(),
    run: ({ channel, id }) => {
      const g = applyMutation(channel, id);
      return ok({ channel, id, version: g.version, pendingLeft: g.pending.length }, `mutation applied — genome v${g.version}`);
    },
  }),
  tool({
    name: "dna_mutation_reject",
    description: "Reject (discard) one pending genome mutation by id. The genome's traits are untouched.",
    kind: "mutate",
    schema: z.object({ channel: channelArg, id: z.string().min(1).describe("pending mutation id") }).strict(),
    run: ({ channel, id }) => {
      const g = rejectMutation(channel, id);
      return ok({ channel, id, pendingLeft: g.pending.length }, "mutation rejected");
    },
  }),
  tool({
    name: "dna_set_trait",
    description:
      "Manually upsert a trait on a channel's genome (e.g. add a hook pattern to traits.hooks at a chosen weight, or update an audienceModel.summary). Logged to the evolution history as a manual mutation.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        path: traitPath,
        value: z.string().min(1).describe("the trait text (or, for platformPlaybooks, a JSON playbook)"),
        weight: z.number().min(0).max(1).default(0.6).describe("0..1 affinity weight"),
      })
      .strict(),
    run: ({ channel, path, value, weight }) => {
      const g = setTrait(channel, path, value, weight);
      return ok({ channel, path, value, weight, version: g.version }, "trait set");
    },
  }),
  tool({
    name: "dna_lock_trait",
    description:
      "Lock a trait path so the autonomous evolution loop can never auto-mutate it (pinned by the operator); pass locked=false to unlock. Manual edits via dna_set_trait still work on locked paths.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        path: traitPath,
        locked: z.boolean().default(true).describe("true = lock, false = unlock"),
      })
      .strict(),
    run: ({ channel, path, locked }) => {
      const g = lockTrait(channel, path, locked);
      return ok({ channel, locks: g.locks }, locked ? `${path} locked` : `${path} unlocked`);
    },
  }),
  tool({
    name: "dna_history",
    description:
      "Get the genome evolution history for a channel (newest first, capped at 100): every applied mutation with its kind (auto/approved/manual), cause and evidence trail.",
    kind: "read",
    schema: z
      .object({
        channel: channelArg,
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
    run: ({ channel, limit }) => {
      const g = getGenome(channel);
      return ok(
        { channel, version: g.version, evolution: g.evolution.slice(0, limit) },
        `${Math.min(limit, g.evolution.length)} of ${g.evolution.length} mutation(s)`,
      );
    },
  }),
];
