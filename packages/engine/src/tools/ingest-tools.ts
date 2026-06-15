import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { type PipelineTool, asyncResult, fail, ok, spawnEngine, tool } from "./helpers.ts";
import { INGEST_DIR, importVideo, needsNormalize, probeVideo } from "../ingest.ts";
import { newId } from "../store.ts";

/**
 * ingest-tools.ts — Pillar 5 (Ingest & Understand) N1c tool surface.
 * Roadmap docs/DAVINCI-ROADMAP.md §7.1.5 N1c. Spread into the canonical registry
 * (registry.ts pipelineTools) so MCP / HTTP / CLI / SDK / the dashboard copilot
 * (Soli) all get import + probe for free.
 *
 * Three tools:
 *   - ingest_probe (read): ffprobe a path → SourceProbe summary, no side effects.
 *   - ingest_video (long): import a user video as a kind:"ingested" ContentItem.
 *       Passthrough (already render-friendly) runs INLINE and returns the item.
 *       A source that needs a transcode DETACHES a worker (detached-spawn
 *       contract: {status:"started", pid, logPath, id}) so the call returns fast.
 *   - ingest_status (read): report where an import got to (probe-decision + item).
 *
 * Shape note: ok/fail/asyncResult/spawnEngine/tool come from the leaf helpers
 * module (NOT registry.ts) so there is no import cycle — mirrors creative-tools.ts.
 * FAIL-OPEN throughout (real footage is messy): a bad path returns fail(), never
 * throws past the tool boundary.
 */

const pathArg = z.string().min(1).describe("Absolute path to the source video file to import/probe");
const channelArg = z.string().min(1).default("labrinox").describe("Channel id to register the ingested item under");

export const ingestTools: PipelineTool[] = [
  tool({
    name: "ingest_probe",
    description:
      "Probe a video file with ffprobe WITHOUT importing it: returns container, duration, video stream (codec, width, height, fps, rotation, pixel format, SAR, bitrate), audio streams (codec/channels/sampleRate/language), and whether a normalize transcode would be needed (render-friendly = h264 / mp4|mov / no baked rotation / yuv420p). Read-only, no side effects. Use to inspect an upload before committing to an import.",
    kind: "read",
    schema: z.object({ path: pathArg }).strict(),
    run: ({ path }) => {
      const abs = resolve(path);
      if (!existsSync(abs)) return fail(`source video not found: ${path}`);
      const probe = probeVideo(abs);
      const normalize = needsNormalize(probe);
      const v = probe.video;
      const summary = v
        ? `${v.width}×${v.height} ${v.codec} @ ${v.fps}fps${v.rotation ? ` (rotated ${v.rotation}°)` : ""}, ${probe.durationSec.toFixed(1)}s, audio ${probe.hasAudio ? "present" : "none"}`
        : `no video stream, ${probe.durationSec.toFixed(1)}s, audio ${probe.hasAudio ? "present" : "none"}`;
      return ok({ probe, needsNormalize: normalize, willTranscode: !!normalize }, summary);
    },
  }),
  tool({
    name: "ingest_video",
    description:
      "Import a user video as a normal ContentItem of kind:\"ingested\" (status \"ingested\", videoPath = the normalized source) so every existing evidence tool / craft pass / timeline / caption renderer operates on it unchanged. Probes the file, and if it is NOT render-friendly (non-h264, non-mp4/mov, rotated, or not yuv420p) transcodes it to a baked-rotation h264/yuv420p mp4. A passthrough import runs inline and returns the item; one that needs a transcode is long-running — it detaches a worker and returns {status:\"started\", pid, logPath, id} immediately (poll ingest_status with that id). Fails open on a messy file: warns + degrades, never throws.",
    kind: "long",
    schema: z.object({ path: pathArg, channel: channelArg }).strict(),
    run: ({ path, channel }) => {
      const abs = resolve(path);
      if (!existsSync(abs)) return fail(`source video not found: ${path}`);
      const probe = probeVideo(abs);
      const willTranscode = !!needsNormalize(probe);

      if (!willTranscode) {
        // Passthrough — cheap (probe + thumbnail only). Run inline and return the item.
        return asyncResult(
          importVideo(abs, { channel }).then((item) =>
            ok(
              { id: item.id, status: item.status, videoPath: item.videoPath, source: item.source },
              `imported ${item.id} (passthrough)`,
            ),
          ),
        );
      }

      // Transcode needed — DETACH (the re-encode can be minutes on long footage).
      // Pre-allocate the id so the worker writes the SAME run the caller can poll.
      const id = newId(channel);
      const job = spawnEngine("ingest-run.ts", [abs, "--channel", channel, "--id", id], "tool-ingest.log");
      return ok({ status: "started", ...job, id }, `import started (transcoding ${needsNormalize(probe)})`);
    },
  }),
  tool({
    name: "ingest_status",
    description:
      "Report the import progress for an ingested run id: whether the ContentItem exists yet, its status, whether the source has been normalized, the probe summary, and the latest log/warning lines. Read-only. Use to poll an ingest_video import that detached a transcode worker.",
    kind: "read",
    schema: z.object({ id: z.string().min(1).describe("ingested run id returned by ingest_video") }).strict(),
    run: ({ id }) => {
      // Lazy-load the store inside run() — keep helpers.ts the only static import
      // (avoids pulling store's deps into the manifest-load path unnecessarily).
      let item: any = null;
      try {
        item = require("../store.ts").loadItem(id);
      } catch {
        return ok({ id, exists: false, state: "pending" }, "no item yet — transcode still running or never started");
      }
      const src = item?.source;
      const recentLog = (item?.log ?? []).slice(-5).map((l: any) => l.msg);
      return ok(
        {
          id,
          exists: true,
          status: item?.status,
          normalized: !!src?.normalized,
          normalizeReason: src?.normalizeReason,
          videoPath: item?.videoPath,
          probe: src?.probe,
          warnings: item?.warnings ?? [],
          log: recentLog,
        },
        `${id} — ${item?.status}${src?.normalized ? " (normalized)" : ""}`,
      );
    },
  }),
];

// Re-exported so the registry barrel can keep the INGEST_DIR constant near its
// tools if it ever needs to advertise the path (none today; here for discoverability).
export { INGEST_DIR };
