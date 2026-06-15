import mqtt from "mqtt";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { brokerConfig, TOPICS, newJobId } from "./src/fleet.ts";
// repo root = two levels up from packages/engine/dispatch-render.mjs (override with SOCHELI_ROOT)
const REPO = process.env.SOCHELI_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const id = process.argv[2];
const item = JSON.parse(readFileSync(`${REPO}/data/runs/${id}.json`, "utf8"));
const { url, username, password } = brokerConfig();
const c = mqtt.connect(url, { username, password });
c.on("connect", () => {
  const jobId = newJobId();
  const job = { id: jobId, type: "render", itemId: id, item, voice: "kokoro", createdAt: new Date().toISOString() };
  c.publish(TOPICS.jobs, JSON.stringify(job), { qos: 1 }, () => {
    console.log("dispatched", jobId, "for", id);
    setTimeout(() => process.exit(0), 500);
  });
});
c.on("error", (e) => { console.error("mqtt err", e.message); process.exit(1); });
