/* hybrid-run.ts — detached CLI runner for the N6.2 hybrid render (render.ts).
 *
 * The tool registry spawns this file via `node --import tsx` and follows the
 * detached-spawn contract: render_hybrid returns {status:"started", pid, logPath}
 * immediately, then the parent walks away. This process owns the actual work —
 * spine → HybridPost render → footage audio mix → mux — and writes its progress to
 * the log file the spawner redirected stdout/stderr to.
 *
 * WHY no shebang + static imports only: per CLAUDE.md, tsx 4.19 cannot parse a file
 * that has BOTH a shebang and a dynamic import(). The spawner invokes us through
 * `node --import tsx` (not the shebang), so we drop the shebang and use static
 * imports (mirrors spine-run.ts / creative-run.ts).
 */
import "./env.ts";
import { renderHybrid, type Reframe } from "./render.ts";

/** parse `--aspect 9:16 --fill crop` (or `--aspect=9:16`) into a Reframe, or undefined. */
function parseReframe(argv: string[]): Reframe | undefined {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${k}=`));
    return eq ? eq.slice(k.length + 3) : undefined;
  };
  const aspect = get("aspect") as Reframe["aspect"] | undefined;
  const fill = get("fill") as Reframe["fill"] | undefined;
  if (!aspect && !fill) return undefined;
  return { aspect: aspect ?? "9:16", fill: fill ?? "crop" };
}

async function main() {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("✗ hybrid-run: missing run id (usage: hybrid-run <id> [--aspect 9:16] [--fill crop|blur|fit])");
    process.exit(1);
  }
  const reframe = parseReframe(argv);
  try {
    const out = await renderHybrid(id, { reframe, log: (m) => console.log(m) });
    console.log(`✓ hybrid render ready: ${out}`);
  } catch (e) {
    console.error(`✗ hybrid-run failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

main();
