import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrandGenome, recordInWorkspace } from "@os/schemas";
import type { BrandGenome as Genome } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* Bridge to the engine's Brand Genome (packages/engine/src/dna.ts).

   The dashboard must NOT bundle the engine (node-only, tsx-run), so — same as
   /api/tools/[name] — we spawn the canonical tool runner and read the JSON
   ToolResult back from stdout:

     node --import tsx packages/engine/src/tool.ts dna_get '{"channel":"…"}'

   All genome MUTATION logic (patch application, lock checks, evolution) stays in
   the engine; the routes that use those helpers only add tenancy gating.

   Genome READS, however, do not need the engine graph: the genome is a plain
   data/dna/<channel>.json validated by the shared BrandGenome schema, so we read
   + safeParse it directly here (the lib/missions.ts pattern). The engine spawn is
   reserved for mutations and the cold-seed case (file absent → the engine's
   getGenome seeds a default from the brand's ChannelDNA on first touch). */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const DNA_TOOLS = new Set([
  "dna_get",
  "dna_context",
  "dna_evolve",
  "dna_pending_list",
  "dna_mutation_approve",
  "dna_mutation_reject",
  "dna_set_trait",
  "dna_lock_trait",
  "dna_history",
]);

const genomePath = (channel: string): string =>
  join(REPO_ROOT, "data", "dna", `${channel.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

/* Read one channel's genome DIRECTLY (no engine spawn) for the GET path. Scoped
   to the caller's workspace: a genome stamped to another workspace resolves to
   null (the route 404s) so genomes never leak across tenants. Returns null when
   the file is absent or malformed — the caller cold-seeds via runDnaTool. */
export function readGenomeFor(channel: string, workspaceId: string): Genome | null {
  const p = genomePath(channel);
  if (!existsSync(p)) return null;
  try {
    const parsed = BrandGenome.safeParse(JSON.parse(readFileSync(p, "utf8")));
    if (!parsed.success) return null;
    return recordInWorkspace(parsed.data, workspaceId) ? parsed.data : null;
  } catch {
    return null; // mid-write / corrupt file degrades to "missing", never throws
  }
}

/* Resolve a genome for a read route: direct file read first, and only on the
   cold-seed case (file absent) spawn the engine's dna_get once to seed the
   default genome from the brand's ChannelDNA, then return its data. Callers
   must have already confirmed `channel` is a brand in `workspaceId`. */
export async function getGenomeFor(
  channel: string,
  workspaceId: string,
): Promise<{ ok: true; genome: unknown } | { ok: false; message?: string }> {
  const direct = readGenomeFor(channel, workspaceId);
  if (direct) return { ok: true, genome: direct };
  // Cold seed: the file may simply not exist yet — let the engine create it.
  const res = await runDnaTool("dna_get", { channel, workspaceId });
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, genome: res.data };
}

export function runDnaTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!DNA_TOOLS.has(name)) {
    return Promise.resolve({ ok: false, message: `not a dna tool: ${name}` });
  }
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      // The runner prints a ToolResult on stdout even on failure (exit code
      // mirrors result.ok) — parse it regardless and only fall back to stderr
      // when stdout isn't valid JSON (e.g. tsx itself failed to boot).
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}
