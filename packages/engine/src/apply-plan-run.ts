/* apply-plan-run.ts — detached CLI runner for an EditPlan apply WITH render (N5.1).
 *
 * creative_apply_plan / creative_edit are "long if rendering": when the caller
 * asks to render, the tool follows the detached-spawn contract (returns
 * {status:"started", pid, logPath} immediately) and hands the real work — apply
 * the plan's ops → compile → renderHybrid → optional review — to THIS process,
 * which writes progress to the redirected log file.
 *
 * Args (positional id, then flags the tool builds):
 *   <id> [--plan <planId>] [--request "<text>"] [--preview] [--review]
 * If --request is given we route it first (creative_edit one-shot); else we apply
 * the persisted plan (--plan, or the newest plan for the run).
 *
 * WHY no shebang + static imports only: per CLAUDE.md, tsx 4.19 can't parse a file
 * with BOTH a shebang and a dynamic import(); the spawner uses `node --import tsx`,
 * so we drop the shebang (mirrors hybrid-run.ts / spine-run.ts / creative-run.ts).
 */
import "./env.ts";
import { executeEditPlan, executeEditPlanById } from "./creative/apply-plan.ts";
import { routeEditRequest } from "./creative/edit-router.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const id = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("✗ apply-plan-run: missing run id");
    process.exit(1);
  }
  const opts = { render: true, preview: has("preview"), review: has("review") };
  try {
    const request = flag("request");
    const planId = flag("plan");
    const result = request
      ? await executeEditPlan(id, await routeEditRequest(id, request), opts)
      : await executeEditPlanById(id, planId, opts);
    for (const line of result.applied) console.log(`  ${line}`);
    console.log(`✓ apply-plan ready: ${result.render ?? "(no render)"}`);
  } catch (e) {
    console.error(`✗ apply-plan-run failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

main();
