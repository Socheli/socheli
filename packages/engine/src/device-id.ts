import os from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { think } from "./brain.ts";

/* Resolve this machine's fleet device id. The id is the device's identity on the
   control plane (MQTT presence + direct-dispatch topics), so it MUST be stable
   across reboots — we generate it once and persist it. It is also public (shows
   in the dashboard / API /v1/fleet), so it must NOT leak personal info: we seed
   the name from the hardware MODEL only and never from the hostname (which often
   carries the owner's name, e.g. "Janes-MacBook"). Resolution order:
     1. explicit SOCHELI_DEVICE_ID / --device  (handled by the caller)
     2. a previously persisted id              (~/.socheli/device-id)
     3. a memorable codename from a small/cheap model, seeded by the hardware
     4. a deterministic, non-personal fallback (offline / no brain) */

const HOME = os.homedir();
const ID_FILE = join(HOME, ".socheli", "device-id");

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

/* Best-effort hardware description — used only to seed a good codename. Never
   includes the hostname. */
function hardware(): { chip: string; model: string; desc: string } {
  const arch = process.arch;
  const cpus = os.cpus().length;
  const ramGb = Math.round(os.totalmem() / 1e9);
  let chip = "";
  let model = "";
  try {
    if (process.platform === "darwin") {
      chip = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim(); // e.g. "Apple M4"
      model = execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(); // e.g. "Mac15,12"
    } else if (process.platform === "linux") {
      chip = (os.cpus()[0]?.model || "").trim();
    }
  } catch {
    /* best effort — fall back to arch below */
  }
  const desc = [chip || `${arch} CPU`, `${cpus}-core`, `${ramGb}GB RAM`, `${process.platform}/${arch}`]
    .filter(Boolean)
    .join(", ");
  return { chip, model, desc };
}

const NameSchema = z.object({ name: z.string() });

export async function resolveDeviceId(): Promise<string> {
  // 2) persisted — stable across reboots
  try {
    if (existsSync(ID_FILE)) {
      const v = readFileSync(ID_FILE, "utf8").trim();
      if (v) return v;
    }
  } catch {
    /* ignore unreadable file */
  }

  const hw = hardware();
  const suffix = randomBytes(2).toString("hex"); // 4 hex — collision safety across identical machines
  let id = "";

  // 3) ask a small/cheap model for a memorable, non-personal codename
  try {
    const { data } = await think(
      NameSchema,
      `Invent a short, memorable codename for a video-render machine.\n` +
        `Hardware: ${hw.desc}.\n` +
        `Rules: one or two words; evocative (think "obsidian", "nova-forge", "render-falcon", "halcyon");\n` +
        `lowercase; letters, numbers and hyphens only; max 20 characters;\n` +
        `do NOT include any person's name, username, or hostname.\n` +
        `Return ONLY JSON: {"name":"<codename>"}.`,
      "cheap",
      1,
    );
    const s = slug(data.name);
    if (s.length >= 3) id = `${s}-${suffix}`;
  } catch {
    /* brain offline / no key — fall through to deterministic */
  }

  // 4) deterministic, non-personal fallback
  if (!id) id = `${slug(hw.chip) || "render-node"}-${suffix}`;

  // persist so it is stable from here on
  try {
    mkdirSync(join(HOME, ".socheli"), { recursive: true });
    writeFileSync(ID_FILE, id + "\n", "utf8");
  } catch {
    /* ephemeral if home isn't writable — still returns a usable id this run */
  }

  return id;
}
