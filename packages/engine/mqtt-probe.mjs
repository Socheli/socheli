import fs from "node:fs";
import mqtt from "mqtt";

const env = {};
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = env.SOCHELI_BROKER_URL;
console.log("connecting:", url, "user:", env.SOCHELI_MQTT_USER);
const c = mqtt.connect(url, {
  username: env.SOCHELI_MQTT_USER, password: env.SOCHELI_MQTT_PASS,
  connectTimeout: 15000, reconnectPeriod: 0,
});
const t = setTimeout(() => {
  console.log("TIMEOUT — resolved opts:", JSON.stringify({ path: c.options.path, port: c.options.port, protocol: c.options.protocol, hostname: c.options.hostname }));
  process.exit(1);
}, 16000);
c.on("connect", () => {
  clearTimeout(t);
  console.log("CONNECTED ✓  path=", c.options.path, "port=", c.options.port, "protocol=", c.options.protocol, "host=", c.options.hostname);
  const seen = [];
  c.on("message", (tp, pl) => seen.push(tp + "  " + pl.toString().slice(0, 90)));
  c.subscribe("socheli/workers/+/presence", { qos: 1 }, (e) => console.log("subscribe presence:", e ? e.message : "ok"));
  setTimeout(() => {
    console.log("existing presence retained (" + seen.length + "):");
    seen.slice(0, 8).forEach((s) => console.log("  " + s));
    c.end(true);
    process.exit(0);
  }, 3000);
});
c.on("error", (e) => { clearTimeout(t); console.log("ERROR:", e.message); process.exit(1); });
