// Generic fleet job dispatcher (ops tool). Usage:
//   node --import tsx dispatch-job.mjs <type> "<seed/topic>" [channel] [mood]
import mqtt from "mqtt";
import { brokerConfig, TOPICS, newJobId } from "./src/fleet.ts";
const [,, type, seed, channel="labrinox", mood="explainer"] = process.argv;
const { url, username, password } = brokerConfig();
const c = mqtt.connect(url, { username, password });
c.on("connect", () => {
  const job = { id: newJobId(), type, channel, seed, mood, voice: true, createdAt: new Date().toISOString(), by: "cli-dispatch" };
  c.publish(TOPICS.jobs, JSON.stringify(job), { qos: 1 }, () => {
    console.log("dispatched", job.id, "type=", type, "seed=", JSON.stringify(seed));
    setTimeout(() => process.exit(0), 500);
  });
});
c.on("error", (e) => { console.error("mqtt err", e.message); process.exit(1); });
