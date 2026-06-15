#!/usr/bin/env -S node --import tsx
import "./env.ts";
import { generate } from "./run.ts";
import { generateLongform } from "./longform-run.ts";
import { generateStatic } from "./generate-static.ts";
import { generateCarousel } from "./generate-carousel.ts";
import { scanContent, scanProfile } from "./scan.ts";
import { listObservations } from "./observation-store.ts";
import { importVideo } from "./ingest.ts";
import { listItems, loadItem, saveItem } from "./store.ts";
import { Storyboard } from "@os/schemas";
import { effectiveChannels } from "./channels.ts";
import { publishItem, pullStats } from "./publisher.ts";
import { renderCover } from "./render.ts";
import { aiKeyVisual, youtubeThumbnail, thumbnailConfigured, generateImagePublic, imageBackend } from "./thumbnail.ts";
import { selectConcept } from "./selection.ts";
import { autopilot } from "./autopilot.ts";
import { resolveChannel } from "./channels.ts";
import { packagePost } from "./stages.ts";
import { cleanPackage } from "./sanitize.ts";
import { generateBoard } from "./concept-board.ts";
import { runAlgoPlan, type PlatformKey } from "./algo-research.ts";
import { appendPlan, saveStrategy } from "./content-plan.ts";
import { brainstormIdeas } from "./brainstorm.ts";
import { tick, installAgent, uninstallAgent, agentStatus } from "./scheduler.ts";
import { describe as bestTimesReport, applyToSchedule, PLATFORMS, type Platform } from "./posting-times.ts";
import { runSync, installSync, uninstallSync, syncStatus } from "./sync.ts";
import { startAgent } from "./agent.ts";
import { resolveDeviceId } from "./device-id.ts";
import { startBridge } from "./bridge.ts";
import { jobsView } from "./jobs-view.ts";
import { callTool, toolsManifest } from "./tools/registry.ts";
import { runDmCommand } from "./cli-dm.ts";
import { runAdsCommand } from "./cli-ads.ts";
// Agent Harness v2 (docs/AGENT-HARNESS.md). Static imports — tsx 4.19's
// dynamic-import transformer cannot parse a file that has BOTH a shebang and
// an `import()` expression, and these modules are already loaded via the
// registry import above anyway.
import { getGenome, genomeContext, evolveGenome, applyMutation } from "./dna.ts";
import { runResearch } from "./research/orchestrator.ts";
import { createMission, listMissions, getMission, pauseMission, resumeMission, missionTick, MISSION_LOOPS, type MissionLoop } from "./missions.ts";
import { runAgentTask, newAgentTaskId, agentTaskLogPath } from "./harness/run.ts";
import type { AgentRole } from "./harness/types.ts";
import mqttLib from "mqtt";
import { newJobId, brokerConfig, TOPICS, type Job } from "./fleet.ts";
import { addAsset, searchInventory, loadInventory } from "./inventory.ts";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    args.splice(i, 1);
    return true;
  }
  return false;
}
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  }
  return def;
}

async function main() {
  switch (cmd) {
    case "new": {
      const voice = flag("voice"); // opt-in
      const noMusic = flag("no-music"); // opt-out
      flag("music"); // accepted no-op (on by default)
      const noBroll = flag("no-broll");
      const noAb = flag("no-ab");
      const preview = flag("preview");
      const channel = opt("channel", "labrinox");
      const mood = opt("mood", "") || undefined;
      const maxQaPasses = parseInt(opt("qa-passes", "3"), 10);
      const seed = args.slice(1).join(" ").trim();
      if (!seed) return fail('usage: content new "<idea>" [--channel <id>] [--mood <id>] [--voice] [--no-music] [--no-broll] [--no-ab] [--qa-passes <1-5>] [--preview]');
      console.log(`\n▶ generating for ${channel}\n  seed: ${seed}\n`);
      const item = await generate(seed, channel, { voice, music: !noMusic, broll: !noBroll, preview, mood, abStoryboard: !noAb, maxQaPasses });
      console.log(`\n${item.status === "packaged" ? "✓ done" : "■ stopped at " + item.status}: ${item.id}`);
      if (item.videoPath) console.log(`  video: ${item.videoPath}`);
      break;
    }
    case "longform": {
      const channel = opt("channel", "labrinox");
      const mood = opt("mood", "") || undefined;
      const topic = args.slice(1).join(" ").trim();
      if (!topic) return fail('usage: content longform "<topic>" [--channel <id>] [--mood <id>]  — produces a 16:9 multi-chapter YouTube video');
      console.log(`\n▶ LONG-FORM (16:9) for ${channel}\n  topic: ${topic}\n`);
      const item = await generateLongform(topic, channel, { mood });
      console.log(`\n${item.status === "packaged" ? "✓ done" : "■ stopped at " + item.status}: ${item.id}`);
      if (item.videoPath) console.log(`  video: ${item.videoPath}`);
      break;
    }
    case "ideas": {
      // Scored concept board for a channel — the "what should we make?" view. No render.
      const channel = opt("channel", args[1] && !args[1].startsWith("-") ? args[1] : "labrinox");
      const n = Number(opt("n", "5"));
      const sel = await selectConcept(resolveChannel(channel), n);
      console.log(`\n▶ concept board for ${channel}  (★ = winner, cost $${sel.usd.toFixed(3)})\n`);
      for (const c of sel.board) {
        const win = c.topic === sel.idea.topic ? "★" : " ";
        console.log(`${win} ${c.overall.toFixed(1).padStart(4)}  [${c.format}]  ${c.topic}`);
        console.log(`        ${c.angle}`);
      }
      console.log(`\n→ build the winner:  content auto --channel ${channel}`);
      break;
    }
    case "auto": {
      const voice = flag("voice");
      const noMusic = flag("no-music");
      const noBroll = flag("no-broll");
      const noPublish = flag("no-publish");
      const pub = flag("public");
      const preview = flag("preview");
      flag("music");
      const channel = opt("channel", "labrinox");
      const seed = args.slice(1).join(" ").trim(); // optional — empty = system selects
      console.log(`\n▶ autopilot for ${channel}${seed ? `\n  seed: ${seed}` : "  (auto-selecting concept)"}\n`);
      const { item, published, reason } = await autopilot(channel, {
        seed,
        voice,
        music: !noMusic,
        broll: !noBroll,
        publish: !noPublish && !preview,
        public: pub,
      });
      console.log(`\n${item.status === "packaged" ? "✓" : "■"} ${item.id} — ${item.status}`);
      if (item.videoPath) console.log(`  video: ${item.videoPath}`);
      if (published) for (const r of published) console.log(`  ${r.platform}: ${r.status}${r.url ? ` → ${r.url}` : ""}`);
      else if (reason) console.log(`  not published: ${reason}`);
      break;
    }
    case "import": {
      // Ingest an arbitrary user video → a ContentItem(kind:"ingested") the editor can understand/subtitle/edit.
      const channel = opt("channel", "labrinox");
      const path = args.slice(1).find((a) => !a.startsWith("-"));
      if (!path) return fail('usage: content import <video-path> [--channel <id>]  — ingest any video for understanding/editing');
      console.log(`\n▶ ingesting ${path}\n`);
      const item = await importVideo(path, { channel });
      const p = item.source?.probe;
      console.log(`✓ ingested: ${item.id}`);
      if (p) console.log(`  ${p.video?.width}×${p.video?.height} ${p.video?.codec} @ ${p.video?.fps?.toFixed?.(2) ?? p.video?.fps}fps · ${p.durationSec?.toFixed(1)}s · audio: ${p.hasAudio ? "yes" : "none"}${item.source?.normalized ? " · normalized" : ""}`);
      console.log(`\n→ understand it:  content tool editor_understand '{"id":"${item.id}"}'`);
      break;
    }
    case "list": {
      const items = listItems();
      if (!items.length) return console.log("no runs yet. try: content new \"...\"");
      for (const it of items)
        console.log(
          `${it.id}  ${it.status.padEnd(16)} $${it.ledger.totalUsd.toFixed(3).padStart(6)}  ${it.idea?.topic ?? it.seedIdea}`,
        );
      break;
    }
    case "show": {
      const it = loadItem(args[1]);
      console.log(JSON.stringify(it, null, 2));
      break;
    }
    case "validate": {
      const it = loadItem(args[1]);
      if (!it.storyboard) return fail("no storyboard on this item");
      Storyboard.parse(it.storyboard);
      console.log("✓ storyboard valid");
      break;
    }
    case "board": {
      const channel = opt("channel", args[1] && !args[1].startsWith("-") ? args[1] : "labrinox");
      const n = parseInt(opt("n", "5"), 10);
      const { concepts } = await generateBoard(channel, n);
      for (const c of concepts) console.log(`${c.overall.toFixed(1)}  ${c.pick ? "★" : " "} ${c.topic} [${c.format}]`);
      break;
    }
    case "package": {
      const it = loadItem(args[1]);
      const ch = resolveChannel(it.channel);
      // Long-form items (and any rendered post) don't carry the short-form
      // storyboard/script shape — they only have idea + a base pkg. Synthesize a
      // minimal storyboard/script from what's available so the packager can still
      // write per-platform captions. packagePost only stringifies these into the
      // prompt, so the stand-ins just need to convey the topic/angle/title.
      const sb =
        it.storyboard ??
        ({
          scenes: [],
          topic: it.idea?.topic ?? it.pkg?.title ?? it.seedIdea,
          format: it.idea?.format ?? it.kind ?? "longform",
        } as unknown as typeof it.storyboard);
      const script =
        it.script ??
        ({
          hook: it.idea?.angle ?? it.pkg?.title ?? it.seedIdea,
          beats: [it.idea?.rationale ?? it.pkg?.caption ?? ""].filter(Boolean),
          cta: "",
          narration: [it.pkg?.caption ?? it.idea?.rationale ?? it.idea?.angle ?? it.seedIdea].filter(Boolean),
        } as unknown as typeof it.script);
      if (!sb || !script) return fail("not enough content on this item to package (need at least an idea or base package)");
      const pkg = await packagePost(ch, sb, script);
      it.pkg = cleanPackage(pkg.data);
      saveItem(it);
      console.log(`✓ packaged: ${(it.pkg.platforms ?? []).length} platform variants`);
      break;
    }
    case "channels":
      for (const c of Object.values(effectiveChannels())) console.log(`${c.id}  — ${c.name} (${c.tone})`);
      break;
    case "dna": {
      // Brand Genome (docs/AGENT-HARNESS.md §1): inspect, evolve, approve.
      const sub = args[1];
      if (sub === "evolve") {
        const auto = flag("auto"); // call before positional reads — flag() splices args
        const channel = args[2];
        if (!channel) return fail("usage: content dna evolve <channel> [--auto]");
        const r = await evolveGenome(channel, { approvalPolicy: auto ? "auto" : "gate" });
        console.log(`genome v${r.genome.version} — applied ${r.applied.length}, queued ${r.queued.length} pending ($${r.usd.toFixed(4)})`);
        for (const m of r.applied) console.log(`  + ${m.path}: ${m.mutation}`);
        for (const q of r.queued) console.log(`  ? [${q.id}] ${q.path}: ${q.mutation} (conf ${q.confidence})`);
      } else if (sub === "pending") {
        console.log(JSON.stringify(getGenome(args[2]).pending, null, 2));
      } else if (sub === "approve") {
        const g = applyMutation(args[2], args[3]);
        console.log(`mutation applied — genome v${g.version}, ${g.pending.length} still pending`);
      } else if (sub) {
        const g = getGenome(sub);
        console.log(genomeContext(sub));
        console.log(`\nv${g.version} · ${g.evolution.length} mutation(s) · ${g.pending.length} pending · locks: ${g.locks.join(", ") || "none"}`);
      } else {
        console.log("usage: content dna <channel> | dna evolve <channel> [--auto] | dna pending <channel> | dna approve <channel> <id>");
      }
      break;
    }
    case "research": {
      // Verified deep-research run (docs/AGENT-HARNESS.md §2): plan → sweep →
      // fetch → extract → cross-verify → cited report, cached with a TTL.
      const kind = opt("kind", "topic");
      const depth = opt("depth", "standard");
      const channel = opt("channel", "") || undefined;
      const query = args.slice(1).join(" ").trim();
      if (!query) return fail('usage: content research "<query>" [--kind trend|algo|topic|competitor|deep] [--depth quick|standard|deep] [--channel <id>]');
      console.log(`\n▶ research [${kind}/${depth}] ${query}\n`);
      const run = await runResearch(
        { kind: kind as any, query, depth: depth as any, channel },
        (s) => console.log(`  ${s.kind.padEnd(7)} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`),
      );
      console.log(`\n✓ ${run.id}: ${run.sources.length} sources · ${run.claims.length} claims · $${run.usd.toFixed(3)}\n`);
      if (run.report) console.log(run.report);
      break;
    }
    case "mission": {
      // Missions orchestrator (docs/AGENT-HARNESS.md §4): standing channel
      // goals advanced on a cadence by harness agents. The scheduler's minute
      // tick drives them; `mission tick` runs one pass by hand (--dry = report
      // due work without enqueueing/executing — zero spend).
      const sub = args[1];
      if (sub === "create") {
        // flags first — flag()/opt() splice args, so read them before positionals
        const channel = opt("channel", "labrinox");
        const cadenceRaw = opt("cadence", ""); // "generate=daily,analyze=daily,evolve=weekly"
        const usdPerDay = opt("usd-per-day", "");
        const postsPerDay = opt("posts-per-day", "");
        const publish = opt("publish", "gate");
        const dna = opt("dna", "gate");
        const goal = opt("goal", "") || args.slice(2).filter((a) => !a.startsWith("-")).join(" ").trim();
        if (!goal)
          return fail('usage: content mission create --channel <id> --goal "<standing goal>" [--cadence "generate=daily,analyze=daily,…"] [--usd-per-day 5] [--posts-per-day 1] [--publish gate|auto] [--dna gate|auto]');
        let cadence: Partial<Record<MissionLoop, string>> | undefined;
        if (cadenceRaw) {
          cadence = {};
          for (const pair of cadenceRaw.split(",")) {
            const [k, v] = pair.split("=").map((x) => x.trim());
            if (!(MISSION_LOOPS as readonly string[]).includes(k) || !v)
              return fail(`bad --cadence entry "${pair}" (loops: ${MISSION_LOOPS.join(", ")}; e.g. generate=daily)`);
            cadence[k as MissionLoop] = v;
          }
        }
        const m = createMission({
          channel,
          goal,
          cadence,
          approvalPolicy: { publish: publish as "auto" | "gate", dnaMutations: dna as "auto" | "gate" },
          budget: {
            ...(usdPerDay ? { usdPerDay: Number(usdPerDay) } : {}),
            ...(postsPerDay ? { postsPerDay: Number(postsPerDay) } : {}),
          },
        });
        console.log(`✓ mission ${m.id} (${m.status}) — ${m.channel}: ${m.goal}`);
        console.log(`  cadence: ${Object.entries(m.cadence).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        console.log(`  policy: publish=${m.approvalPolicy.publish} dna=${m.approvalPolicy.dnaMutations} · budget: ${m.budget.usdPerDay != null ? `$${m.budget.usdPerDay}/day` : "∞"} / ${m.budget.postsPerDay != null ? `${m.budget.postsPerDay} post(s)/day` : "∞ posts"}`);
      } else if (sub === "list") {
        const missions = listMissions();
        if (!missions.length) return console.log('no missions yet. try: content mission create --channel labrinox --goal "…"');
        for (const m of missions) {
          const q = m.queue.filter((t) => t.status === "queued").length;
          const r = m.queue.filter((t) => t.status === "running").length;
          console.log(`${m.id}  ${m.status.padEnd(7)} ${m.channel.padEnd(14)} queued=${q} running=${r}  ${m.goal}`);
        }
      } else if (sub === "get") {
        if (!args[2]) return fail("usage: content mission get <id>");
        console.log(JSON.stringify(getMission(args[2]), null, 2));
      } else if (sub === "pause") {
        if (!args[2]) return fail("usage: content mission pause <id>");
        const m = pauseMission(args[2]);
        console.log(`mission ${m.id} → ${m.status}`);
      } else if (sub === "resume") {
        if (!args[2]) return fail("usage: content mission resume <id>");
        const m = resumeMission(args[2]);
        console.log(`mission ${m.id} → ${m.status}`);
      } else if (sub === "tick") {
        const dry = flag("dry");
        const r = await missionTick({ dry, onLog: (m) => console.log(`  ${m}`) });
        if (dry) {
          console.log(`\n— dry run: nothing enqueued/executed —`);
          if (!r.due.length) console.log("no loop tasks due");
          for (const d of r.due) console.log(`due  ${d.missionId} ${d.loop} (${d.role}) → ${d.goal.split("\n")[0]}`);
          for (const s of r.skipped) console.log(`skip ${s.missionId}${s.taskId ? ` ${s.taskId}` : ""}: ${s.reason}`);
          if (r.wouldExecute) console.log(`would execute: ${r.wouldExecute.missionId} ${r.wouldExecute.taskId} (${r.wouldExecute.role})`);
          else console.log("would execute: nothing");
        } else {
          for (const s of r.skipped) console.log(`skip ${s.missionId}${s.taskId ? ` ${s.taskId}` : ""}: ${s.reason}`);
          if (r.executed) console.log(`✓ ${r.executed.taskId} (${r.executed.loop}) — ${r.executed.status} ($${r.executed.usd.toFixed(4)})\n${r.executed.summary}`);
          else if (!r.due.length && !r.skipped.length) console.log("nothing due — no task executed");
          else if (!r.executed) console.log("no task executed");
        }
      } else {
        console.log('usage: content mission create --channel <id> --goal "<goal>" [--cadence "…"] [--usd-per-day n] [--posts-per-day n] [--publish gate|auto] [--dna gate|auto]\n       content mission list | get <id> | pause <id> | resume <id> | tick [--dry]');
      }
      break;
    }
    case "agent-task": {
      // Delegate a goal to a multi-turn harness agent (docs/AGENT-HARNESS.md §3).
      const role = opt("role", "");
      const tier = opt("tier", "");
      const runtime = opt("runtime", "");
      const context = opt("context", "");
      const maxSteps = opt("max-steps", "");
      const budget = opt("budget", "");
      const goal = args.slice(1).join(" ").trim();
      if (!role || !goal)
        return fail('usage: content agent-task --role <researcher|strategist|creative|editor|publisher|analyst|channel_manager|community_manager> [--tier cheap|smart|best] [--runtime claude-sdk|claude-code|codex|openrouter] [--max-steps n] [--budget usd] [--context "…"] "<goal>"');
      const id = newAgentTaskId();
      console.log(`▶ agent task ${id} (${role}) — events → ${agentTaskLogPath(id)}`);
      const { summary, usd } = await runAgentTask(
        {
          id,
          role: role as AgentRole,
          goal,
          context: context || undefined,
          tier: (tier || undefined) as "cheap" | "smart" | "best" | undefined,
          maxSteps: maxSteps ? Number(maxSteps) : undefined,
          budgetUsd: budget ? Number(budget) : undefined,
        },
        {
          runtime: runtime || undefined,
          onEvent: (e) => {
            if (e.type === "step") console.log(`· ${e.label}`);
            else if (e.type === "tool_call") console.log(`→ ${e.name}`);
            else if (e.type === "error") console.log(`✗ ${e.message}`);
          },
        },
      );
      console.log(`\n${summary}\n($${usd.toFixed(4)})`);
      break;
    }
    case "soli-turn": {
      // Run ONE Soli chat turn through the claude-code harness (the user's Claude
      // Code SUBSCRIPTION — no API key) and stream every harness event to stdout
      // as NDJSON, so the dashboard /api/agent route can bridge it straight to the
      // copilot's SSE chat events. Auth comes from the ambient claude login or
      // CLAUDE_CODE_OAUTH_TOKEN (set by the server's Claude Code connect flow).
      const role = (opt("role", "channel_manager") || "channel_manager") as AgentRole;
      const context = opt("context", "");
      const maxSteps = opt("max-steps", "");
      const budget = opt("budget", "");
      const goal = args.slice(1).join(" ").trim();
      if (!goal) return fail('usage: content soli-turn [--role <r>] [--context "…"] [--max-steps n] "<message>"');
      const id = newAgentTaskId();
      const emit = (e: unknown) => process.stdout.write(JSON.stringify(e) + "\n");
      emit({ type: "meta", id, role, runtime: "claude-code" });
      try {
        const { summary, usd } = await runAgentTask(
          {
            id,
            role,
            goal,
            context: context || undefined,
            maxSteps: maxSteps ? Number(maxSteps) : 12,
            budgetUsd: budget ? Number(budget) : undefined,
          },
          { runtime: "claude-code", onEvent: (e) => emit(e) },
        );
        // The harness already streams a `done`, but emit a final settled marker
        // carrying the full summary so the bridge always has the complete reply.
        emit({ type: "final", summary, usd });
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
        return fail("soli-turn failed");
      }
      break;
    }
    case "publish": {
      const pub = flag("public");
      const noAigc = flag("no-aigc");
      const it = loadItem(args[1]);
      const results = await publishItem(it, { public: pub, aigc: noAigc ? false : undefined });
      saveItem(it);
      for (const r of results)
        console.log(`  ${r.platform}: ${r.status}${r.url ? ` → ${r.url}` : ""}${r.message ? ` (${r.message})` : ""}`);
      break;
    }
    case "thumbnail": {
      // (re)generate a premium AI thumbnail. Long-form → a finished 16:9 YouTube
      // thumbnail (title baked in). Short-form → AI key visual + Remotion Cover.
      const it = loadItem(args[1]);
      if (!thumbnailConfigured()) return fail("no thumbnail backend — install Codex CLI (logged in) or set OPENAI_API_KEY");
      if (it.kind === "longform") {
        console.log("generating 16:9 YouTube thumbnail…");
        const yt = youtubeThumbnail(it, (m) => console.log("  " + m));
        if (!yt) return fail("thumbnail backend produced no image");
        it.thumbPath = yt;
        saveItem(it);
        console.log(`✓ thumbnail → ${yt}`);
        break;
      }
      const ch = resolveChannel(it.channel);
      const title = it.pkg?.title ?? it.idea?.topic ?? it.id;
      const words = title.split(/\s+/).filter(Boolean);
      console.log("generating AI key visual…");
      const bg = await aiKeyVisual(it, (m) => console.log("  " + m));
      if (!bg) return fail("thumbnail backend produced no image");
      const cover = await renderCover(it.id, {
        title,
        eyebrow: (it.idea?.topic ?? title).split(/\s+/).slice(0, 3).join(" "),
        highlight: (words[words.length - 1] || "").replace(/[^\w]/g, ""),
        themeName: ch.theme,
        mood: it.mood,
        bg,
        logo: ch.logo,
        handle: ch.handle,
      });
      if (!cover) return fail("cover render failed");
      it.thumbPath = cover;
      saveItem(it);
      console.log(`✓ thumbnail → ${cover}`);
      break;
    }
    case "genimage": {
      // generate a standalone AI image (Codex $imagegen / gpt-image-1) into the
      // render bundle's public/gen so it can be used as a scene/cover background.
      const prompt = args.slice(1).filter((a) => !a.startsWith("-")).join(" ") || opt("prompt", "");
      if (!prompt) return fail('usage: content genimage "<prompt>" [--aspect 16:9|9:16|1:1] [--name <stem>]');
      if (imageBackend() === "none") return fail("no image backend — install Codex CLI (logged in) or set OPENAI_API_KEY");
      const aspect = (opt("aspect", "16:9") as "16:9" | "9:16" | "1:1");
      const name = opt("name", "") || `gen_${Date.now()}`;
      console.log(`generating image (${imageBackend()}, ${aspect})…`);
      const src = generateImagePublic(prompt, name, { aspect, log: (m) => console.log("  " + m) });
      if (!src) return fail("image backend produced no file");
      console.log(`✓ image → packages/remotion/public/${src}`);
      break;
    }
    case "tick": {
      // one scheduler pass — what launchd invokes every minute
      await tick();
      break;
    }
    case "agent": {
      // run this device as a fleet render worker (Ctrl-C to stop). Device id:
      // --device flag → SOCHELI_DEVICE_ID → an auto-generated, persisted codename
      // derived from the hardware (see resolveDeviceId — never the hostname).
      const device = opt("device", "") || process.env.SOCHELI_DEVICE_ID || (await resolveDeviceId());
      console.log(`▶ fleet agent starting as device "${device}" → ${brokerConfig().url}`);
      startAgent(device);
      await new Promise(() => {}); // run forever
      break;
    }
    case "bridge": {
      // server-side: project the control plane into data/fleet.json + data/jobs.json
      console.log(`▶ fleet bridge starting → ${brokerConfig().url}`);
      startBridge();
      await new Promise(() => {});
      break;
    }
    case "jobs": {
      // consolidated live render progress across all fleet devices (MQTT control
      // plane). `content jobs` = one snapshot; `content jobs --watch` = live.
      await jobsView({ watch: flag("watch") });
      break;
    }
    case "dispatch": {
      // publish a job to the fleet from the CLI: content dispatch <ping|auto|new|longform> [--channel x] [--seed "..."] [--mood id] [--device id] [--public]
      // --device pins the job to ONE worker: it's published to that device's
      // direct topic AND stamped with `target`, so only that device runs it
      // (the shared queue would otherwise hand it to whichever worker is free).
      const type = (args[1] as Job["type"]) || "ping";
      const channel = opt("channel", "labrinox");
      const seed = opt("seed", "");
      const mood = opt("mood", "") || undefined;
      const device = opt("device", "") || undefined;
      const research = (opt("research", "") || undefined) as Job["research"];
      const pub = flag("public");
      // --voice carries word-level VO captions into the generate (needed for caption
      // choreography); without it a "new"/"auto" job renders silent + phrase subtitles.
      const voice = flag("voice");
      const { url, username, password } = brokerConfig();
      const job: Job = { id: newJobId(), type, channel, seed: seed || undefined, mood, voice, research, public: pub, target: device, createdAt: new Date().toISOString(), by: "cli" };
      const topic = device ? TOPICS.device(device) : TOPICS.jobs;
      const c = await mqttLib.connectAsync(url, { username, password });
      await c.publishAsync(topic, JSON.stringify(job), { qos: 1 });
      await c.endAsync();
      console.log(`dispatched ${job.id} (${type}) → ${channel}${device ? ` @ ${device}` : ""}`);
      break;
    }
    case "inventory": {
      // lexdrive: the user's own b-roll inventory the render pulls from first.
      //   content inventory add <path...> [--tags "a,b,c"] [--desc "..."]
      //   content inventory list
      //   content inventory search "<query>"
      const sub = args[1];
      if (sub === "add") {
        const tags = opt("tags", "").split(",").map((t) => t.trim()).filter(Boolean);
        const desc = opt("desc", "") || undefined;
        const paths = args.slice(2).filter((a) => !a.startsWith("--"));
        if (!paths.length) return fail('usage: content inventory add <path...> [--tags "a,b,c"] [--desc "..."]');
        for (const p of paths) {
          try {
            const a = addAsset(p, { tags: tags.length ? tags : undefined, description: desc });
            console.log(`✓ added ${a.id} (${a.type}${a.orientation ? ", " + a.orientation : ""}${a.durationSec ? ", " + a.durationSec.toFixed(1) + "s" : ""})  tags: ${a.tags.slice(0, 8).join(", ")}`);
          } catch (e: any) {
            console.log(`✗ ${p}: ${e?.message ?? e}`);
          }
        }
      } else if (sub === "list") {
        const inv = loadInventory();
        console.log(`lexdrive inventory — ${inv.assets.length} asset(s)\n`);
        for (const a of inv.assets) {
          console.log(`${a.id}  ${a.type.padEnd(5)} ${(a.orientation ?? "?").padEnd(9)} ${a.source ?? a.file}`);
          if (a.description) console.log(`   ${a.description}`);
          if (a.tags.length) console.log(`   #${a.tags.slice(0, 12).join(" #")}`);
        }
      } else if (sub === "search") {
        const q = args.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
        if (!q) return fail('usage: content inventory search "<query>"');
        const hits = searchInventory(q);
        if (!hits.length) console.log("no matches — render would fall back to stock b-roll.");
        for (const h of hits) console.log(`${(h.score).toFixed(2)}  ${h.id}  ${h.type}  ${h.source ?? h.file}  — ${h.description || h.tags.slice(0, 6).join(", ")}`);
      } else {
        console.log('usage: content inventory <add|list|search>');
      }
      break;
    }
    case "scheduler": {
      const sub = args[1];
      if (sub === "install") console.log(installAgent());
      else if (sub === "uninstall") console.log(uninstallAgent());
      else if (sub === "status") {
        const st = agentStatus();
        console.log(`launchd: ${st.installed ? "installed" : "not installed"}, ${st.loaded ? "loaded" : "not loaded"}`);
        console.log(`live posting: ${Object.entries(st.platforms).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        if (st.nextDue) console.log(`next slot: ${st.nextDue.slot.channel}@${st.nextDue.slot.time} → ${st.nextDue.at}`);
        if (st.logTail) console.log(`\n— scheduler.log (tail) —\n${st.logTail}`);
      } else console.log("usage: content scheduler <install|uninstall|status>");
      break;
    }
    case "sync": {
      // Data-plane sync: push freshly-rendered mp4s + run records → the server.
      //   content sync                 → run one pass now
      //   content sync install         → install the launchd timer (every 5 min)
      //   content sync uninstall|status
      const sub = args[1];
      if (sub === "install") console.log(installSync());
      else if (sub === "uninstall") console.log(uninstallSync());
      else if (sub === "status") {
        const st = syncStatus();
        console.log(`launchd: ${st.installed ? "installed" : "not installed"}, ${st.loaded ? "loaded" : "not loaded"}`);
        console.log(`target: ${st.host}`);
        if (st.logTail) console.log(`\n— sync.log (tail) —\n${st.logTail}`);
      } else {
        const code = await runSync();
        if (code !== 0) process.exitCode = code;
      }
      break;
    }
    case "stats": {
      for (const it of listItems().filter((i) => i.publish?.length)) {
        const s = pullStats(it);
        console.log(`${it.id}  ${s ? `${s.views ?? "?"} views, ${s.likes ?? "?"} likes` : "no stats"}  ${it.idea?.topic ?? ""}`);
      }
      console.log("learnings updated → data/learnings.json (feeds future ideation)");
      break;
    }
    case "besttimes": {
      // The posting-time strategy: default windows blended with learned feedback
      // (post time × measured engagement). Reporting only — no writes.
      const p = opt("platform", "") as Platform | "";
      console.log(bestTimesReport(p && PLATFORMS.includes(p as Platform) ? (p as Platform) : undefined));
      console.log("\nApply to the autopilot schedule:  content schedule:auto --channel <id> [--platform instagram] [--per-day 1]");
      break;
    }
    case "schedule:auto": {
      // Materialize the recommended week into data/schedule.json as weekday-aware
      // slots for a channel. Does not enable autopilot (that stays a manual opt-in).
      const channel = opt("channel", args[1] && !args[1].startsWith("-") ? args[1] : "labrinox");
      const pRaw = opt("platform", "instagram") as Platform;
      const platform = PLATFORMS.includes(pRaw) ? pRaw : "instagram";
      const perDay = Math.max(1, parseInt(opt("per-day", "1"), 10) || 1);
      const res = applyToSchedule({ channel, platform, perDay, public: flag("public"), mood: opt("mood", "") || undefined });
      console.log(`✓ wrote ${res.slots.length} weekday-aware slot(s) for "${channel}" → data/schedule.json (driven by ${platform} best times)`);
      for (const s of res.slots) console.log(`  ${s.time}  on ${s.days.map((d) => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join(",")}`);
      console.log("Autopilot stays OFF until you enable it (schedule.enabled / dashboard).");
      break;
    }
    case "algo-plan": {
      // Algorithm-hacking research → dated content plan. Streams each research
      // step as one NDJSON line to stdout (the dashboard pipes these to the UI as
      // a live timeline), then writes the planned posts to data/content-plan.json
      // unless --dry. `--json` alone (no streaming consumer) still works fine.
      const channel = opt("channel", args[1] && !args[1].startsWith("-") ? args[1] : "labrinox");
      const days = parseInt(opt("days", "14"), 10);
      const count = parseInt(opt("count", "0"), 10);
      const time = opt("time", "09:00");
      const dry = flag("dry");
      const only = opt("platforms", "").split(",").map((s) => s.trim()).filter(Boolean) as PlatformKey[];
      const emit = (o: unknown) => {
        process.stdout.write(JSON.stringify(o) + "\n");
      };
      const result = await runAlgoPlan(
        channel,
        { days, count: count || undefined, time, onlyPlatforms: only.length ? only : undefined },
        (s) => emit({ step: s }),
      );
      if (!dry) {
        appendPlan(result.posts);
        if (result.brief || result.subject || result.cadence) {
          saveStrategy({ channel: result.channel, channelName: result.channelName, planRunId: result.planRunId, at: new Date().toISOString(), brief: result.brief, subject: result.subject, cadence: result.cadence });
        }
      }
      emit({ result: { planRunId: result.planRunId, channel: result.channel, count: result.posts.length, usd: result.usd, committed: !dry } });
      break;
    }
    case "brainstorm": {
      // "Prompt on it": freeform idea generation for a calendar day. Prints JSON.
      const prompt = args[1] && !args[1].startsWith("-") ? args[1] : opt("prompt", "");
      const channel = opt("channel", "");
      const date = opt("date", "");
      const n = parseInt(opt("n", "5"), 10);
      if (!prompt) return fail('usage: content brainstorm "<prompt>" [--channel <id>] [--date YYYY-MM-DD] [--n 5]');
      const r = await brainstormIdeas(prompt, channel || undefined, n, date || undefined);
      console.log(JSON.stringify({ ideas: r.ideas, usd: r.usd }));
      break;
    }
    case "tools": {
      // List the single canonical tool manifest (name + kind + description).
      const json = flag("json");
      const manifest = toolsManifest();
      if (json) {
        console.log(JSON.stringify(manifest, null, 2));
      } else {
        for (const t of manifest) console.log(`${t.kind.padEnd(6)} ${t.name}  —  ${t.description}`);
        console.log(`\n${manifest.length} tools`);
      }
      break;
    }
    case "tool": {
      // Generic: call any tool in the registry by name with a JSON input object.
      const name = args[1];
      if (!name) return fail('usage: content tool <name> [jsonInput]   (see: content tools)');
      const rawInput = args.slice(2).join(" ").trim();
      let input: unknown = {};
      if (rawInput) {
        try {
          input = JSON.parse(rawInput);
        } catch (e: any) {
          return fail(`invalid JSON input for ${name}: ${e?.message ?? e}`);
        }
      }
      const result = await callTool(name, input);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case "dm": {
      // The friendly DM AI responder CLI (connect/setup/test/run/watch). See cli-dm.ts.
      process.exitCode = await runDmCommand(args.slice(1));
      break;
    }
    case "ads": {
      // Instagram boosts (paid amplification; gated, dry-run by default). See cli-ads.ts.
      process.exitCode = await runAdsCommand(args.slice(1));
      break;
    }
    case "inbox": {
      // Community inbox: comment + DM triage queues and pending (human-gated)
      // replies for a channel. `--pull` refreshes from Instagram first (needs a
      // token with instagram_manage_comments / instagram_manage_messages).
      //   content inbox <channel> [--pull] [--json]
      const channel = args[1] && !args[1].startsWith("-") ? args[1] : opt("channel", "labrinox");
      if (flag("pull")) {
        await callTool("comments_pull", { channel });
        await callTool("dm_pull", { channel });
      }
      const data = (r: any) => (r && r.ok ? r.data : undefined);
      const [cl, cp, dl, dp] = await Promise.all([
        callTool("comments_list", { channel, unansweredOnly: true }),
        callTool("comments_pending", { channel }),
        callTool("dm_list", { channel }),
        callTool("dm_pending", { channel }),
      ]);
      if (flag("json")) {
        console.log(JSON.stringify({ channel, comments: data(cl), commentDrafts: data(cp), dms: data(dl), dmDrafts: data(dp) }, null, 2));
        break;
      }
      const comments = (data(cl)?.comments ?? []) as any[];
      const cDrafts = (data(cp)?.drafts ?? []) as any[];
      const dms = (data(dl)?.threads ?? []) as any[];
      const dDrafts = (data(dp)?.drafts ?? []) as any[];
      console.log(`\n■ inbox — ${channel}`);
      console.log(`\nComments to triage (${comments.length}):`);
      for (const c of comments.slice(0, 10)) console.log(`  · @${c.username ?? "?"}: ${String(c.text).slice(0, 70)}   [${c.id}]`);
      console.log(`\nDMs to triage (${dms.length}):`);
      for (const t of dms.slice(0, 10)) console.log(`  · @${t.username ?? "?"}: ${String(t.lastMessage).slice(0, 70)}${t.windowOpen ? "" : "  (window closed)"}   [${t.conversationId}]`);
      console.log(`\nPending replies awaiting your approval — comments: ${cDrafts.length}, DMs: ${dDrafts.length}`);
      for (const d of cDrafts.slice(0, 10)) console.log(`  ✎ comment ${d.commentId}: ${String(d.reply).slice(0, 70)}`);
      for (const d of dDrafts.slice(0, 10)) console.log(`  ✎ dm ${d.conversationId}: ${String(d.reply).slice(0, 70)}`);
      console.log(`\nSend an approved reply:  content tool comment_send '{"channel":"${channel}","commentId":"…"}'`);
      console.log(`                         content tool dm_send '{"channel":"${channel}","conversationId":"…"}'`);
      break;
    }
    case "static": {
      const channel = opt("channel", opt("c", "labrinox"));
      const layout = opt("layout", "highlight_bar");
      const mood = opt("mood", "") || undefined;
      const preview = process.argv.includes("--preview");
      const seed = args.slice(1).join(" ").trim();
      if (!channel) { console.error("--channel required"); process.exit(1); }
      console.log(`\n▸ Generating static image post: "${seed}"\n`);
      const item = await generateStatic(seed, channel, { layout: layout as any, mood, preview });
      console.log(`\n✓ ${item.id}  status=${item.status}  image=${item.staticImagePath ?? "(none)"}\n`);
      break;
    }
    case "carousel": {
      const channel = opt("channel", opt("c", "labrinox"));
      const slides = parseInt(opt("slides", "6"), 10);
      const mood = opt("mood", "") || undefined;
      const aspect = (opt("aspect", "1:1")) as "1:1" | "4:5";
      const preview = process.argv.includes("--preview");
      const seed = args.slice(1).join(" ").trim();
      if (!channel) { console.error("--channel required"); process.exit(1); }
      console.log(`\n▸ Generating ${slides}-slide carousel: "${seed}"\n`);
      const item = await generateCarousel(seed, channel, { slides, mood, aspect, preview });
      console.log(`\n✓ ${item.id}  status=${item.status}  slides=${item.carouselSlides?.length ?? 0}\n`);
      break;
    }
    case "scan": {
      const url = args[1] ?? "";
      if (!url) { console.error("Usage: content scan <url> [--channel <id>] [--tags <a,b,c>] [--force]"); process.exit(1); }
      const channelId = opt("channel", opt("c", "")) || undefined;
      const tags = opt("tags", "").split(",").filter(Boolean);
      const force = process.argv.includes("--force");
      console.log(`\n▸ Scanning: ${url}\n`);
      const obs = await scanContent(url, { channelId, tags, forceRescan: force, log: console.log });
      console.log(`\n✓ obs id: ${obs.id}`);
      console.log(`  creator: ${obs.creator?.handle ?? "?"}`);
      console.log(`  likes: ${obs.metrics?.likes ?? "?"}, views: ${obs.metrics?.views ?? "?"}`);
      if (obs.analysis) {
        console.log(`  visual: ${obs.analysis.visualLanguage?.slice(0, 100)}`);
        console.log(`  score: ${obs.analysis.inspirationScore}/10`);
      }
      console.log();
      break;
    }
    case "scan-profile": {
      const profileUrl = args[1] ?? "";
      if (!profileUrl) { console.error("Usage: content scan-profile <url> [--limit 5] [--channel <id>]"); process.exit(1); }
      const channelId = opt("channel", opt("c", "")) || undefined;
      const limit = parseInt(opt("limit", "5"), 10);
      const tags = opt("tags", "").split(",").filter(Boolean);
      console.log(`\n▸ Deep scanning profile: ${profileUrl}\n`);
      const prof = await scanProfile(profileUrl, { limit, channelId, tags, log: console.log });
      console.log(`\n✓ profile id: ${prof.id}`);
      console.log(`  handle: ${prof.creator?.handle ?? "?"}`);
      console.log(`  top posts scanned: ${prof.topPosts?.length ?? 0}`);
      console.log();
      break;
    }
    case "observations": {
      const platform = opt("platform", "") || undefined;
      const channelId = opt("channel", "") || undefined;
      const limit = parseInt(opt("limit", "20"), 10);
      const items = listObservations({ platform, channelId, limit });
      if (!items.length) { console.log("No observations yet. Run: content scan <url>"); }
      for (const o of items) {
        const score = o.analysis?.inspirationScore;
        console.log(`[${o.id}] ${o.platform.padEnd(10)} ${(o.creator?.handle ?? "?").padEnd(20)} likes:${o.metrics?.likes ?? "?"} score:${score ?? "?"}  ${o.url.slice(0, 50)}`);
      }
      break;
    }
    case "moods": {
      const json = flag("json");
      const r = await callTool("tools_moods_list", { includeBlends: true });
      if (json) { console.log(JSON.stringify(r.data, null, 2)); break; }
      const { moods: mList = [], blends = [] } = (r.data ?? {}) as any;
      console.log("\n■ moods\n");
      for (const m of mList) {
        const tags = [m.bgVariant, m.noBroll ? "no-broll" : "b-roll", ...(m.transitions?.length ? [`transitions: ${m.transitions.join("→")}`] : [])].join("  ");
        console.log(`  ${m.id.padEnd(18)} ${m.accent}  ${m.name}`);
        console.log(`                     ${tags}`);
        console.log(`                     ${m.blurb}`);
      }
      if (blends.length) {
        console.log("\n■ named blends");
        for (const b of blends) console.log(`  ${b.id.padEnd(18)} ${b.blend}`);
      }
      console.log(`\nUsage: content new "<idea>" --mood <id>`);
      break;
    }
    case "broll-sources": {
      const json = flag("json");
      const r = await callTool("tools_broll_sources", {});
      if (json) { console.log(JSON.stringify(r.data, null, 2)); break; }
      const d = (r.data ?? {}) as any;
      console.log("\n■ b-roll / AI-video sources\n");
      console.log("  Active sources:  ", (d.sources ?? []).join(", ") || "(none)");
      console.log("  Gated (key req.): ", (d.gates ?? []).join(", ") || "(none)");
      console.log("  Fallbacks:        ", (d.fallbacks ?? []).join(", ") || "(none)");
      console.log("\nTo activate AI video, set: KLING_API_KEY, PIKA_API_KEY, MINIMAX_API_KEY, or LUMALABS_API_KEY");
      break;
    }
    default:
      console.log(`content — Agentic Content Team OS

  new "<idea>" [--channel <id>] [--voice] [--no-music] [--no-broll] [--no-ab] [--qa-passes <1-5>] [--preview]
                          generate a post end-to-end from one idea
  static "<idea>" [--channel <id>] [--layout <id>] [--mood <id>] [--preview]
                          generate a static image post (no video)
  carousel "<idea>" [--channel <id>] [--slides 6] [--aspect 1:1|4:5] [--mood <id>] [--preview]
                          generate a multi-slide carousel post
  scan <url> [--channel <id>] [--tags <a,b,c>] [--force]
                          scan any IG/YT/TikTok link — download, analyze frames with Claude vision, store observation
  scan-profile <url> [--limit 5] [--channel <id>]
                          deep scan a creator profile — bio, bio links, top posts ranked by engagement
  observations [--platform <ig|yt|tt>] [--channel <id>]
                          list saved observations
  ideas [--channel <id>] [--n 5]
                          show the scored concept board (what to make) — no render
  auto ["<seed>"] [--channel <id>] [--voice] [--public] [--no-publish]
                          autopilot: select concept → generate → publish
  list                    list all runs
  show <id>               print a run as JSON
  validate <id>           re-validate a run's storyboard
  channels                list channels
  publish <id> [--public] YouTube + IG Reels + TikTok live (when configured) + bundle
  tick                    run one scheduler pass (what launchd calls each minute)
  scheduler <install|uninstall|status>
                          manage the launchd autopilot agent
  sync [install|uninstall|status]
                          push renders + run records → server (data plane of the
                          fleet); bare = run once, install = launchd timer (5 min)
  stats                   pull analytics for published items → learnings
  besttimes [--platform]  posting-time strategy (best windows, learned from feedback)
  schedule:auto --channel <id> [--platform instagram] [--per-day 1]
                          write the recommended weekly post times into the schedule
  dna <channel>           print the channel's Brand Genome context + status
  dna evolve <channel> [--auto]
                          evolve the genome from learnings/analytics/research
  dna pending <channel>   list approval-gated genome mutations
  dna approve <channel> <id>
                          apply one pending genome mutation
  research "<query>" [--kind trend|algo|topic|competitor|deep] [--depth quick|standard|deep] [--channel <id>]
                          verified multi-source research run → cited report
  agent-task --role <r> ["<goal>"] [--tier cheap|smart|best] [--runtime <id>]
                          delegate a goal to a multi-turn harness agent
  mission create --channel <id> --goal "<goal>" [--cadence "generate=daily,…"]
                          create an autonomous standing mission for a channel
  mission list | get <id> | pause <id> | resume <id>
  mission tick [--dry]    run one orchestrator pass now (--dry = report only)
  dm <connect|setup|status|test|run|watch> <channel>
                          Instagram DM AI responder (24/7 with 'dm watch') — see 'content dm'
  inbox <channel> [--pull]  community inbox: comment + DM triage + pending replies
  moods [--json]          list all mood presets with bgVariant, transitions, accent, blurb
  broll-sources           show which b-roll + AI video providers are active (API keys present)
  tools [--json]          list every capability in the canonical tool registry
  tool <name> [jsonInput] call any tool by name with a JSON input object

channels: ${Object.keys(effectiveChannels()).join(", ")}`);
  }
}

function fail(msg: string) {
  console.error(msg);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("✗", e?.message ?? e);
  process.exitCode = 1;
});
