/* dense-vision-run.ts — detached worker for the long-running DENSE per-frame VISION
 * pass (Editor Frame-Control B1). The tool registry spawns this via
 * `node --import tsx` and follows the detached-spawn contract:
 * editor_understand_dense_vision returns {status:"started", pid, logPath}
 * immediately, then this process owns the work and writes progress to the log.
 *
 * WHY no shebang + static imports only: per CLAUDE.md, tsx 4.19 cannot parse a file
 * with BOTH a shebang and a dynamic import(). The spawner invokes us through
 * `node --import tsx` (not the shebang), so we drop it and use static imports —
 * mirrors understanding-run.ts exactly.
 *
 * Usage: dense-vision-run <id> --sample-fps 1
 */
import "./env.ts";
import { buildDenseVision } from "./dense-vision.ts";

async function main() {
  const id = process.argv.slice(2).find((t) => !t.startsWith("--"));
  if (!id) {
    console.error("✗ dense-vision-run: missing run id (usage: dense-vision-run <id> --sample-fps N)");
    process.exit(1);
  }
  const argOf = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
  };
  const sampleFpsRaw = Number(argOf("--sample-fps"));
  const sampleFps = Number.isFinite(sampleFpsRaw) && sampleFpsRaw > 0 ? sampleFpsRaw : 1;
  console.log(`dense-vision: building grid for ${id} @ ${sampleFps}fps …`);
  try {
    const dense = await buildDenseVision(id, { sampleFps });
    console.log(`✓ dense vision built for ${id}: ${dense.frameCount} frame(s) @ ${dense.sampleFps}fps over ${dense.startSec}-${dense.endSec}s`);
  } catch (e) {
    // buildDenseVision is fail-open internally, but guard the entrypoint so a
    // catastrophic failure still exits cleanly with a logged reason.
    console.error(`✗ dense vision failed for ${id}: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
  }
}

main();
