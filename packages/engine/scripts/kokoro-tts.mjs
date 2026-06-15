/* Local natural TTS via Kokoro (onnx-community/Kokoro-82M-v1.0-ONNX).
   No API key. Runs on the M4 via onnxruntime-node.
   Usage: node kokoro-tts.mjs <outDir> <id> <voice> <linesJsonFile> [speed]
   Prints JSON: { lines: [{ file, text }] }  (durations measured by caller via ffprobe) */
import { KokoroTTS } from "kokoro-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , outDir, id, voice, linesFile, speedArg] = process.argv;
const lines = JSON.parse(readFileSync(linesFile, "utf8"));
const speed = speedArg ? parseFloat(speedArg) : 1.0;

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
  dtype: "q8",
  device: "cpu",
});

const out = [];
for (let i = 0; i < lines.length; i++) {
  const audio = await tts.generate(lines[i], { voice: voice || "af_heart", speed });
  const file = join(outDir, `${id}_k${i}.wav`);
  await audio.save(file);
  out.push({ file, text: lines[i] });
}
writeFileSync(join(outDir, `${id}_kokoro.json`), JSON.stringify({ lines: out }));
console.log("KOKORO_OK");
