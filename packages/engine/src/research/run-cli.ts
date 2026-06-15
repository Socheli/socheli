#!/usr/bin/env -S node --import tsx
import "../env.ts";
import { runResearch, type ResearchSpec } from "./orchestrator.ts";

/* Detached research worker — the spawn target for the `research_run` registry
   tool (and reusable by `content research` in cli.ts). Mirrors cli.ts arg
   conventions: flags are spliced out, the remaining args join into the query.

     run-cli.ts "<query>" [--kind trend|algo|topic|competitor|deep]
                [--depth quick|standard|deep] [--channel <id>] [--id <runId>]
                [--ttl <hours>] [--workspace <wsId>] [--by <userId>]

   The tool layer pre-allocates --id so callers can poll research_get while
   this process is still working. */

const args = process.argv.slice(2);

function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  }
  return def;
}

const KINDS = ["trend", "algo", "topic", "competitor", "deep"] as const;
const DEPTHS = ["quick", "standard", "deep"] as const;

async function main() {
  const kind = opt("kind", "topic");
  const depth = opt("depth", "standard");
  const channel = opt("channel", "") || undefined;
  const id = opt("id", "") || undefined;
  const ttl = opt("ttl", "");
  const workspaceId = opt("workspace", "") || undefined;
  const createdBy = opt("by", "") || undefined;
  const query = args.join(" ").trim();

  if (!query) {
    console.error('usage: run-cli.ts "<query>" [--kind topic] [--depth standard] [--channel <id>] [--id <runId>] [--ttl <hours>]');
    process.exit(2);
  }
  if (!KINDS.includes(kind as (typeof KINDS)[number])) {
    console.error(`unknown --kind "${kind}" (expected ${KINDS.join("|")})`);
    process.exit(2);
  }
  if (!DEPTHS.includes(depth as (typeof DEPTHS)[number])) {
    console.error(`unknown --depth "${depth}" (expected ${DEPTHS.join("|")})`);
    process.exit(2);
  }

  const spec: ResearchSpec = {
    kind: kind as (typeof KINDS)[number],
    query,
    depth: depth as (typeof DEPTHS)[number],
    channel,
    id,
    ttlHours: ttl ? Number(ttl) : undefined,
    workspaceId,
    createdBy,
  };

  console.log(`▶ research [${spec.kind}/${spec.depth}] ${query}${channel ? ` (channel: ${channel})` : ""}`);
  const run = await runResearch(spec, (s) => {
    console.log(`  ${s.kind.padEnd(7)} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
  });
  console.log(`\n✓ ${run.id}: ${run.sources.length} sources · ${run.claims.length} claims · $${run.usd.toFixed(3)}`);
}

main().catch((e) => {
  console.error(`✗ research failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
