import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ContentItem } from "@os/schemas";
import { type PublishResult, captionFor, videoPathFor, titleFor } from "./publish-types.ts";

/* ─── Phone publish backend ───────────────────────────────────────────────
   An alternative to the API publishers: instead of an approved app + a public
   host (which IG Reels and TikTok both gate behind App Review), drive the real
   social apps on a docked Android over ADB and POST the rendered video the way
   a human would. Lives in tools/phone-agent (zero-dep Node, runs on the same
   Mac that renders). publisher.ts routes IG/TikTok (and optionally YouTube)
   through here when PHONE_PUBLISH=1.

   We shell out to the agent's `post` command and parse its `PHONE_RESULT {json}`
   line, so the agent stays a standalone tool and this stays a thin adapter. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const AGENT = join(ROOT, "tools", "phone-agent", "src", "run.mjs");

/** Phone posting is opt-in (it physically drives a device). */
export function phonePublishEnabled(): boolean {
  return process.env.PHONE_PUBLISH === "1";
}

/** Which platforms the phone should handle (default IG + TikTok — the two the
    API path can't do without App Review + a public host). Override with
    PHONE_PLATFORMS=instagram,tiktok,youtube. */
export function phonePlatforms(): string[] {
  const raw = process.env.PHONE_PLATFORMS;
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : ["instagram", "tiktok"];
  return list.filter((p) => ["instagram", "tiktok", "youtube"].includes(p));
}

export function phoneHandles(platform: string): boolean {
  return phonePublishEnabled() && phonePlatforms().includes(platform);
}

/** Is there an authorized ADB device attached right now? Cheap, sync, tolerant. */
export function phoneDeviceReady(): boolean {
  if (!phonePublishEnabled() || !existsSync(AGENT)) return false;
  try {
    const adb = process.env.ADB_BIN || "adb";
    const r = spawnSync(adb, ["devices"], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return false;
    return r.stdout
      .split("\n")
      .slice(1)
      .some((l) => /\bdevice\s*$/.test(l.trim()));
  } catch {
    return false;
  }
}

/** Run the phone-agent for one (item, platform) and surface a PublishResult.
    The engine owns item.publish (publisher.ts records the entry), so we invoke
    the agent with --no-mark and pass the engine-resolved caption for parity. */
export async function publishViaPhone(item: ContentItem, platform: string): Promise<PublishResult> {
  if (!phonePublishEnabled()) return { status: "needs-auth", message: "phone publishing disabled (set PHONE_PUBLISH=1)" };
  if (!existsSync(AGENT)) return { status: "error", message: `phone-agent not found at ${AGENT}` };

  const videoPath = videoPathFor(item, platform);
  if (!videoPath || !existsSync(videoPath)) return { status: "error", message: "no rendered video" };
  if (!phoneDeviceReady()) return { status: "needs-auth", message: "no authorized ADB device attached (plug in the phone + accept USB debugging)" };

  // Hand the canonical caption (honors P3 overrides + G6 first-comment) to the
  // agent via a temp file, so the phone posts exactly what the API path would.
  const dir = mkdtempSync(join(tmpdir(), "socheli-phone-"));
  const capFile = join(dir, "caption.txt");
  writeFileSync(capFile, captionFor(item, platform));

  try {
    const res = await runAgent(["post", "--id", item.id, "--platform", platform, "--send", "--no-mark", "--caption-file", capFile]);
    if (res == null) return { status: "processing", message: "phone post timed out — check the device" };
    if (res.ok) return { status: "published", url: res.url, message: res.reason };
    return { status: "error", message: res.reason || "phone post failed" };
  } catch (e: any) {
    return { status: "error", message: `phone post error: ${e?.message ?? e}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type AgentResult = { ok: boolean; platform: string; reason?: string; url?: string };

/* Spawn the agent, stream its output to a log, and pull the PHONE_RESULT line.
   Resolves null on timeout. node is invoked from PATH (the engine already runs
   under tsx/node). The agent loads its own .env and honors ADB_BIN. */
function runAgent(args: string[]): Promise<AgentResult | null> {
  const timeoutMs = Number(process.env.PHONE_POST_TIMEOUT_MS || 300_000);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, ...args], {
      cwd: dirname(AGENT),
      env: process.env,
    });
    let out = "";
    const onData = (b: Buffer) => {
      const s = b.toString();
      out += s;
      process.stderr.write(s); // mirror agent progress into the publish log
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);

    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/PHONE_RESULT (\{.*\})/);
      if (m) {
        try {
          resolve(JSON.parse(m[1]) as AgentResult);
          return;
        } catch {
          /* fall through */
        }
      }
      resolve({ ok: false, platform: args[args.indexOf("--platform") + 1] ?? "", reason: "no parsable result from phone-agent" });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, platform: "", reason: `spawn failed: ${e.message}` });
    });
  });
}
