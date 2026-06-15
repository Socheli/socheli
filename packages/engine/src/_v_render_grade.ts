import "./env.ts";
import { loadItem, saveItem } from "./store.ts";
import { rerender } from "./rerender.ts";
import { callEditorTool } from "./editor-tools.ts";
const id = "grade_render_test";
const src = loadItem("socheli_20260613182657");
const clone: any = JSON.parse(JSON.stringify(src)); clone.id = id; delete clone.videoPath;
delete clone.brief; delete clone.concepts; delete clone.chosenConcept; delete clone.edl; delete clone.reviews;
// strong, unmistakable global grade: warm orange push + lifted blacks + sat
clone.storyboard.grade = { temperature: 0.6, tint: 0.1, saturation: 1.35, contrast: 1.2, lift: { r: 0.15, g: 0.05, b: -0.05 }, gain: { r: 1.15, g: 1.0, b: 0.82 } };
saveItem(clone);
console.log("rendering with strong warm grade", new Date().toISOString());
await rerender(id, { preview: true });
const ex = await callEditorTool("editor_extract_frame", { id, atSec: 1.5 });
console.log("GRADED frame:", (ex.data as any)?.framePath);
