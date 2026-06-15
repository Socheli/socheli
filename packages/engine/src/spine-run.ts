/* spine-run.ts — detached CLI runner for the N6.0 footage spine (render.ts).
 *
 * The tool registry spawns this file via `node --import tsx` and follows the
 * detached-spawn contract: render_spine_preview returns {status:"started", pid,
 * logPath} immediately, then the parent walks away. This process owns the actual
 * work — cutting + concatenating the silent spine — and writes its progress to the
 * log file the spawner redirected stdout/stderr to.
 *
 * WHY no shebang + static imports only: per CLAUDE.md, tsx 4.19 cannot parse a file
 * that has BOTH a shebang and a dynamic import(). The spawner invokes us through
 * `node --import tsx` (not the shebang), so we drop the shebang and use static
 * imports — the combination tsx is happy with (mirrors creative-run.ts).
 */
import "./env.ts";
import { renderSpine } from "./render.ts";

async function main() {
  const id = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("✗ spine-run: missing run id (usage: spine-run <id>)");
    process.exit(1);
  }
  try {
    const out = renderSpine(id, (m) => console.log(m));
    console.log(`✓ spine ready: ${out}`);
  } catch (e) {
    console.error(`✗ spine-run failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

main();
