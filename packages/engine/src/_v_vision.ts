import "./env.ts";
import { itemPath, loadItem } from "./store.ts";
import { importVideo } from "./ingest.ts";
import { buildUnderstanding } from "./understanding.ts";
import { describeShots } from "./understanding-vision.ts";
import { rmSync } from "node:fs";
const item = await importVideo("data/renders/socheli_20260613182657.mp4", { channel: "labrinox" });
const id = item.id;
await buildUnderstanding(id); // base (shots)
console.log("VISION pass (3 shots)...", new Date().toISOString());
await describeShots(id, { maxShots: 3 });
const u = loadItem(id).understanding!;
let n = 0;
for (const sh of u.shots.slice(0, 3)) {
  const a = u.perShot[sh.id];
  if (a?.description) { n++; console.log(`shot ${sh.index}: ${a.description}`); if (a.subjects?.length) console.log(`   subjects: ${a.subjects.join(", ")} | action: ${a.action||"-"} | emotion: ${a.emotion||"-"}`); }
}
console.log(`\nDESCRIBED: ${n}/3 ${n>0?"✓ VISION WORKS":"✗ still failing"}`);
rmSync(itemPath(id), { force: true });
