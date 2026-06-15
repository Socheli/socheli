import { renderPost } from "../src/render.ts";
import { demoProps } from "../../remotion/src/demo.ts";

const t0 = Date.now();
const out = await renderPost("demo", demoProps as any, {
  preview: true,
  log: (m) => console.log("  " + m),
});
console.log(`\n✓ rendered demo in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
