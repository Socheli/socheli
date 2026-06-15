import { loadItem, saveItem } from "./store.ts";
import { creativeEdit } from "./creative/loop.ts";
const cloneId = "real_loop_demo";
const src = loadItem("socheli_20260613182657");
const clone: any = JSON.parse(JSON.stringify(src)); clone.id = cloneId;
delete clone.brief; delete clone.concepts; delete clone.chosenConcept; delete clone.edl; delete clone.reviews;
saveItem(clone);
console.log("START real render loop on", cloneId, new Date().toISOString());
const out = await creativeEdit(cloneId, { render: true, maxIterations: 2 });
const after = loadItem(cloneId);
const rev = (after.reviews||[]).slice(-1)[0];
console.log("DONE verdict:", out.finalVerdict, "iterations:", out.iterations, "reviews:", out.reviews.length);
if (rev) {
  console.log("REAL-PIXEL REVIEW scores:", JSON.stringify(rev.scores));
  console.log("FIXES:", JSON.stringify((rev.fixes||[]).slice(0,5)));
  console.log("EVIDENCE:", JSON.stringify((rev.evidence||[]).slice(0,4)));
}
console.log("videoPath:", after.videoPath || "(none)");
