/* creative-run.ts — detached CLI runner for the long-running creative edit loop.
 *
 * The tool registry spawns this file via `node --import tsx` and follows the
 * detached-spawn contract: the registry returns {status:"started", pid, logPath}
 * immediately, then the parent walks away. This process owns the actual work and
 * writes its progress to the log file the spawner redirected stdout/stderr to.
 *
 * WHY no shebang + static imports only: per CLAUDE.md, tsx 4.19 cannot parse a
 * file that has BOTH a shebang and a dynamic import(). Because the spawner invokes
 * us through `node --import tsx` (not via the shebang), we drop the shebang and use
 * plain static imports — the simplest combination tsx is happy with.
 */
import "./env.ts";
import { creativeEdit } from "./creative/loop.ts";
import type { TargetPlatform } from "@os/schemas";
import { TargetPlatform as TargetPlatformSchema } from "@os/schemas";
import type { PassName } from "./creative/passes.ts";

/* Read a `--flag <value>` pair out of argv; undefined when the flag is absent
   or has no following token. Kept tiny — this is a one-shot CLI, not a parser lib. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

async function main() {
  const argv = process.argv.slice(2);

  // The run id is the sole positional arg — the first token that isn't a flag and
  // isn't a flag's value. We scan rather than assume argv[0] so the order of
  // positional-vs-flags is forgiving for whatever the spawner assembles.
  const id = (() => {
    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i];
      if (tok.startsWith("--")) continue; // a flag
      const prev = argv[i - 1];
      // skip a token that is the value of a value-taking flag we know about
      if (prev === "--platform" || prev === "--max-iter" || prev === "--passes") continue;
      return tok;
    }
    return undefined;
  })();

  if (!id) {
    console.error("✗ creative-run: missing run id (usage: creative-run <id> [--platform <p>] [--max-iter <n>] [--no-render] [--passes a,b,c])");
    process.exit(1);
  }

  // --platform: validate against the schema enum, fail-open to undefined (loop infers).
  const platformRaw = flagValue(argv, "--platform");
  const platform: TargetPlatform | undefined = platformRaw
    ? (TargetPlatformSchema.safeParse(platformRaw).success ? (platformRaw as TargetPlatform) : undefined)
    : undefined;
  if (platformRaw && !platform) console.log(`note: ignoring unknown --platform "${platformRaw}"`);

  // --max-iter: positive integer cap on review/fix iterations; undefined → loop default.
  const maxIterRaw = flagValue(argv, "--max-iter");
  const maxIterations = maxIterRaw && Number.isFinite(Number(maxIterRaw)) && Number(maxIterRaw) > 0
    ? Math.floor(Number(maxIterRaw))
    : undefined;

  // --no-render: skip the (expensive) re-render between iterations.
  const render = !argv.includes("--no-render");

  // --passes: comma list restricting which editorial passes run; undefined → full order.
  const passesRaw = flagValue(argv, "--passes");
  const passes: PassName[] | undefined = passesRaw
    ? (passesRaw.split(",").map((p) => p.trim()).filter(Boolean) as PassName[])
    : undefined;

  console.log(`creative-run starting for ${id}`);
  console.log(`  platform=${platform ?? "(infer)"} maxIter=${maxIterations ?? "(default)"} render=${render} passes=${passes ? passes.join(",") : "(all)"}`);

  const result = await creativeEdit(id, { platform, maxIterations, render, passes });

  // The loop already appends each CreativeReview to the item; here we just surface a
  // human-scannable tail. The overall score comes from the final review when present.
  const finalReview = result.reviews[result.reviews.length - 1];
  const overall = finalReview ? finalReview.scores.overall : undefined;
  console.log(`  iterations=${result.iterations} reviews=${result.reviews.length}`);
  console.log(`DONE ${id} verdict=${result.finalVerdict} overall=${overall ?? "n/a"}`);
  process.exit(0);
}

// Invoke at module load (mirrors rerender.ts's CLI tail). Any throw — including a
// missing run or a perception/render hiccup the loop chose to bubble — is logged and
// becomes a non-zero exit so the spawner can mark the detached job as failed.
main().catch((e) => {
  console.error(`✗ creative-run failed: ${e?.message ?? e}`);
  process.exit(1);
});
