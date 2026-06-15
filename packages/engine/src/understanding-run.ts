/* understanding-run.ts — detached worker for the long-running deep-understanding
 * pipeline (Pillar 5 / Ingest §7.1.5 N2f). The tool registry spawns this via
 * `node --import tsx` and follows the detached-spawn contract: editor_understand
 * returns {status:"started", pid, logPath} immediately, then this process owns the
 * work and writes progress to the redirected log.
 *
 * WHY no shebang + static imports only: per CLAUDE.md, tsx 4.19 cannot parse a
 * file with BOTH a shebang and a dynamic import(). The spawner invokes us through
 * `node --import tsx` (not the shebang), so we drop it and use static imports —
 * mirrors creative-run.ts exactly.
 */
import "./env.ts";
import { buildUnderstanding, understandingSummary } from "./understanding.ts";

async function main() {
  const id = process.argv.slice(2).find((t) => !t.startsWith("--"));
  if (!id) {
    console.error("✗ understanding-run: missing run id (usage: understanding-run <id>)");
    process.exit(1);
  }
  const deep = process.argv.includes("--deep");
  // --vocab "Ada Lovelace, CognitiveX, Laravel"  → biases Whisper toward these names.
  // --glossary "Ada Lovejoy=Ada Lovelace;Cognitive Acts=CognitiveX" → exact fixes.
  const argOf = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
  };
  const vocabulary = (argOf("--vocab") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const glossary = (argOf("--glossary") ?? "")
    .split(";")
    .map((p) => p.split("=").map((s) => s.trim()))
    .filter(([from, to]) => from && to)
    .map(([from, to]) => ({ from, to }));
  console.log(`understanding: building for ${id}${deep ? " (DEEP: vision + music)" : ""}${vocabulary.length ? ` [vocab: ${vocabulary.join(", ")}]` : ""}${glossary.length ? ` [glossary: ${glossary.length}]` : ""} …`);
  try {
    const u = await buildUnderstanding(id, { deep, vocabulary: vocabulary.length ? vocabulary : undefined, glossary: glossary.length ? glossary : undefined });
    console.log(understandingSummary(u));
    console.log(`✓ understanding built for ${id}`);
  } catch (e) {
    // buildUnderstanding is fail-open internally, but guard the entrypoint so a
    // catastrophic failure still exits cleanly with a logged reason.
    console.error(`✗ understanding failed for ${id}: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
  }
}

main();
