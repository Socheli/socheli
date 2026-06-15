import type { ContentItem } from "@os/schemas";
import { generate } from "./run.ts";
import { publishItem, type PlatformResult } from "./publisher.ts";
import { saveItem } from "./store.ts";
import { isSendingHalted } from "./admin.ts";

export type AutopilotResult = { item: ContentItem; published: PlatformResult[] | null; reason?: string };

/* End-to-end autonomous lane: pick the concept, build the video, and publish it.
   - seed "" → the system selects what to make (concept board); a seed steers it.
   - publishing only runs if the item actually reached "packaged" (QA-gated upstream).
   - default privacy is private/ready: you review before anything goes public. */
export async function autopilot(
  channelId: string,
  opts: {
    seed?: string;
    voice?: boolean;
    music?: boolean;
    broll?: boolean;
    publish?: boolean; // default true
    public?: boolean; // default false (upload private / bundle ready)
    onLog?: (m: string) => void;
  } = {},
): Promise<AutopilotResult> {
  const log = opts.onLog ?? (() => {});
  const item = await generate(opts.seed ?? "", channelId, {
    voice: opts.voice,
    music: opts.music,
    broll: opts.broll,
    onLog: opts.onLog,
  });

  if (item.status !== "packaged") return { item, published: null, reason: `stopped at ${item.status}` };
  if (opts.publish === false) return { item, published: null, reason: "publish disabled" };

  // Defense-in-depth: publishItem already guards on the kill-switch, but stop
  // before the publish call so the autopilot result carries a clean reason and
  // we never even attempt the post when an admin has halted this brand.
  const halt = isSendingHalted(channelId);
  if (halt.halted) {
    saveItem(item);
    return { item, published: null, reason: halt.reason ?? "autopilot halted by admin" };
  }

  log(`publishing ${item.id}${opts.public ? " (public)" : " (private/ready)"}…`);
  const published = await publishItem(item, { public: opts.public });
  saveItem(item);
  for (const r of published) log(`  ${r.platform}: ${r.status}${r.url ? ` → ${r.url}` : ""}${r.message ? ` (${r.message})` : ""}`);
  return { item, published };
}
