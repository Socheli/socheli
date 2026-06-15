import type { UIBlock } from "./ui-spec";
import { validateBlocks } from "./ui-spec";

/* ----------------------------------------------------------------------------
   Rich tool-result visualizer.

   Maps a registry tool's RESULT (the engine envelope {ok, data?, message?}) to
   one or more existing UIBlocks, so a settled tool step in the execution
   timeline (and the expandable ToolCallChip) can show its result as a REAL
   widget rather than raw pretty-JSON.

   This is a best-effort heuristic layer, NOT a schema: it recognizes the
   VERIFIED data shapes the registry's read tools return and shapes them into
   blocks the existing UIBlocks renderer already knows. It always runs its
   output back through validateBlocks (the canonical sanitizer/normalizer), so
   anything it produces is guaranteed to be a valid, safe block. When no
   confident DOMAIN mapping exists it no longer returns `null` (which used to
   drop the caller back to a raw pretty-JSON <pre>) — instead it emits a single
   `json_tree` block so the result still renders as the rich, collapsible tree
   explorer inline. It never throws.

   Block types are picked from KNOWN_TYPES (ui-spec) — read-only. We deliberately
   keep mappings conservative: only the shapes that read clearly as a widget. */

type Envelope = { ok?: boolean; data?: unknown; message?: string };
type Dict = Record<string, unknown>;

function isObj(v: unknown): v is Dict {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/* Unwrap the {ok,data,message} envelope to its payload. A non-envelope value is
   returned as-is (some tools may return the bare shape). */
function unwrap(result: unknown): unknown {
  if (isObj(result) && "ok" in result && ("data" in result || "message" in result)) {
    return (result as Envelope).data ?? null;
  }
  return result;
}

/* Pick the first present array field from a payload, trying common keys. The
   payload itself is used when it is already an array. */
function pickArray(payload: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isObj(payload)) return null;
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k] as unknown[];
  }
  return null;
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/* A name matches a family if any of the fragments appears in it (so both
   `runs_list` and `content_list` hit "list", `ads_status` hits "status"). */
function nameHas(name: string, ...frags: string[]): boolean {
  const n = name.toLowerCase();
  return frags.some((f) => n.includes(f));
}

/* ---- per-family builders (each returns raw blocks; validation happens once at
   the end of vizForToolResult). Builders return null to decline. ---- */

/* runs_list / content_list / library → a compact table of items, one row each.
   Items look like {id,title,status,pct?,updatedAt?}. */
function vizItemList(items: unknown[]): UIBlock[] | null {
  const rows = items
    .filter(isObj)
    .map((it) => {
      const title = str(it.title) || str(it.topic) || str(it.name) || str(it.id);
      const status = str(it.status);
      const pct = num(it.pct);
      const when = str(it.updatedAt) || str(it.createdAt);
      return [
        title,
        status,
        pct != null ? `${Math.round(pct)}%` : "",
        when ? when.replace("T", " ").slice(0, 16) : "",
      ];
    })
    .filter((r) => r[0]);
  if (!rows.length) return null;
  // Drop columns that are empty across every row so the table stays tight.
  const headers = ["item", "status", "progress", "updated"];
  const keep = headers.map((_, c) => rows.some((r) => r[c]));
  const columns = headers.filter((_, c) => keep[c]);
  const trimmed = rows.map((r) => r.filter((_, c) => keep[c]));
  return [{ type: "table", columns, rows: trimmed } as unknown as UIBlock];
}

/* channels_list → labelled chips ({id,name}). */
function vizChannels(items: unknown[]): UIBlock[] | null {
  const badges = items
    .filter(isObj)
    .map((c) => ({ label: str(c.name) || str(c.id) }))
    .filter((b) => b.label);
  if (!badges.length) return null;
  return [{ type: "badge_row", title: "channels", badges } as unknown as UIBlock];
}

/* missions list → one mission_card per mission (cap at the board limit), or a
   single card. {id,goal,status,cadence?,nextRun?}. */
function vizMissions(items: unknown[]): UIBlock[] | null {
  const cards = items
    .filter(isObj)
    .map((m) => {
      const missionId = str(m.id) || str(m.missionId);
      const goal = str(m.goal) || str(m.title);
      if (!missionId || !goal) return null;
      return {
        type: "mission_card",
        missionId,
        goal,
        status: str(m.status) || "active",
        cadence: str(m.cadence) || undefined,
        nextRun: str(m.nextRun) || undefined,
        href: "/missions",
      } as unknown as UIBlock;
    })
    .filter((b): b is UIBlock => b !== null);
  if (!cards.length) return null;
  return cards.slice(0, 6);
}

/* analytics_scorecard → scorecard. rows look like {label, verdict|score}. A
   numeric score is bucketed into the verdict scale. */
function vizScorecard(payload: unknown): UIBlock[] | null {
  const rows = pickArray(payload, ["rows", "items", "scores"]);
  if (!rows) return null;
  const out = rows
    .filter(isObj)
    .map((r) => {
      const label = str(r.label) || str(r.name);
      if (!label) return null;
      let verdict = str(r.verdict).toLowerCase();
      if (verdict !== "strong" && verdict !== "weak" && verdict !== "variable") {
        const score = num(r.score);
        verdict = score == null ? "variable" : score >= 70 ? "strong" : score >= 40 ? "variable" : "weak";
      }
      return { label, verdict, note: str(r.note) || undefined };
    })
    .filter((r): r is { label: string; verdict: string; note?: string } => r !== null);
  if (!out.length) return null;
  return [{ type: "scorecard", title: "scorecard", rows: out } as unknown as UIBlock];
}

/* analytics_get → insights_chart from a series, or a sparkline from a bare
   number series. Shapes: {series:[{label,value,delta?}]} or {points:[n,...]}. */
function vizAnalytics(payload: unknown): UIBlock[] | null {
  if (isObj(payload) && Array.isArray(payload.series)) {
    const series = (payload.series as unknown[])
      .filter(isObj)
      .map((s) => {
        const label = str(s.label) || str(s.name);
        const value = num(s.value);
        if (!label || value == null) return null;
        return { label, value, delta: num(s.delta) };
      })
      .filter((s): s is { label: string; value: number; delta?: number } => s !== null);
    if (series.length) {
      return [
        {
          type: "insights_chart",
          title: str((payload as Dict).title) || "analytics",
          series,
          unit: str((payload as Dict).unit) || undefined,
          href: "/analytics",
        } as unknown as UIBlock,
      ];
    }
  }
  const points = pickArray(payload, ["points", "values"]);
  if (points) {
    const nums = points.map(num).filter((n): n is number => n != null);
    if (nums.length >= 2) {
      return [{ type: "sparkline", title: "analytics", points: nums } as unknown as UIBlock];
    }
  }
  return null;
}

/* fleet_devices → a stat_grid roll-up by status + one device_card each.
   {devices:[{id|device,status,job?,hw?}]}. */
function vizDevices(items: unknown[]): UIBlock[] | null {
  const devs = items.filter(isObj);
  if (!devs.length) return null;
  const counts = { online: 0, busy: 0, offline: 0 } as Record<string, number>;
  for (const d of devs) {
    const s = str(d.status).toLowerCase();
    if (s === "busy") counts.busy++;
    else if (s === "offline") counts.offline++;
    else counts.online++;
  }
  const grid = {
    type: "stat_grid",
    stats: [
      { label: "online", value: String(counts.online) },
      { label: "busy", value: String(counts.busy) },
      { label: "offline", value: String(counts.offline) },
    ],
  } as unknown as UIBlock;
  const cards = devs.slice(0, 5).map(
    (d) =>
      ({
        type: "device_card",
        device: str(d.device) || str(d.id) || str(d.name),
        status: str(d.status) || "online",
        job: str(d.job) || str(d.currentJob) || undefined,
        hw: str(d.hw) || str(d.hardware) || undefined,
        href: "/devices",
      }) as unknown as UIBlock,
  );
  return [grid, ...cards.filter((c) => str((c as Dict).device))];
}

/* fleet_jobs → a progress bar per in-flight job (cap a few). {jobs:[{id,pct,
   phase?,status?,itemId?}]}. */
function vizJobs(items: unknown[]): UIBlock[] | null {
  const jobs = items.filter(isObj);
  const bars = jobs
    .map((j) => {
      const pct = num(j.pct) ?? num(j.progress);
      if (pct == null) return null;
      const phase = str(j.phase) || str(j.stage) || str(j.status);
      const label = str(j.id) || str(j.itemId) || "render";
      return {
        type: "progress",
        label: phase ? `${label} · ${phase}` : label,
        value: pct,
        itemId: str(j.itemId) || undefined,
        jobId: str(j.id) || undefined,
      } as unknown as UIBlock;
    })
    .filter((b): b is UIBlock => b !== null)
    .slice(0, 6);
  return bars.length ? bars : null;
}

/* A record carrying a pct/progress (e.g. *_status, render snapshot) → a single
   progress bar or a render_progress snapshot when it names an item. */
function vizProgressRecord(payload: unknown): UIBlock[] | null {
  if (!isObj(payload)) return null;
  const pct = num(payload.pct) ?? num(payload.progress) ?? num(payload.percent);
  if (pct == null) return null;
  const itemId = str(payload.itemId) || str(payload.id);
  const stage = str(payload.stage) || str(payload.phase) || str(payload.status);
  if (itemId) {
    const st = str(payload.status).toLowerCase();
    const status = st === "done" || st === "failed" ? st : "running";
    return [
      { type: "render_progress", itemId, stage: stage || status, pct, status, href: `/post/${itemId}` } as unknown as UIBlock,
    ];
  }
  return [{ type: "progress", label: stage || "progress", value: pct } as unknown as UIBlock];
}

/* ads_list → a table of ads; ads_status / one ad record → boost_preview. */
function vizAdsList(items: unknown[]): UIBlock[] | null {
  const rows = items
    .filter(isObj)
    .map((a) => [str(a.id) || str(a.adId), str(a.status), num(a.dailyBudgetUsd) != null ? `$${num(a.dailyBudgetUsd)}/day` : ""])
    .filter((r) => r[0]);
  if (!rows.length) return null;
  return [{ type: "table", columns: ["ad", "status", "budget"], rows } as unknown as UIBlock];
}

function vizAdRecord(payload: unknown): UIBlock[] | null {
  if (!isObj(payload)) return null;
  const adId = str(payload.adId) || str(payload.id);
  if (!adId) return null;
  const gateReasons = Array.isArray(payload.gateReasons)
    ? (payload.gateReasons as unknown[]).map(str).filter(Boolean)
    : [];
  return [
    {
      type: "boost_preview",
      adId,
      status: str(payload.status) || "draft",
      dailyBudgetUsd: num(payload.dailyBudgetUsd) ?? 0,
      durationDays: num(payload.durationDays) ?? 0,
      gateReasons,
      href: "/ads",
    } as unknown as UIBlock,
  ];
}

/* genome / dna_context → genome block. {channel, traits:[{kind,text,weight?}]}. */
function vizGenome(payload: unknown): UIBlock[] | null {
  if (!isObj(payload)) return null;
  const traits = pickArray(payload, ["traits", "genome"]);
  const channel = str(payload.channel) || str(payload.channelId);
  if (!traits || !channel) return null;
  const t = traits
    .filter(isObj)
    .map((x) => ({ kind: str(x.kind) || "trait", text: str(x.text) || str(x.value), weight: num(x.weight) }))
    .filter((x) => x.text);
  if (!t.length) return null;
  return [{ type: "genome", channel, traits: t, href: "/channels" } as unknown as UIBlock];
}

/* ---- Editor Studio: a routed EditPlan → readable APPROVAL cards -----------

   Pillar 5 N5.3. creative_edit_route returns a grounded EditPlan (analysis only,
   status "proposed"): a list of ops that each cite real evidence (dead-air spans,
   highlights, timeline clip ids) plus a rationale. We render it as an Odysser-style
   review the user can act on:
     - a callout carrying the plan's rationale ("here's what I'd do …"),
     - a scorecard of the ops (each row = one op + the evidence it cites),
     - a key_value of plan metadata (request, mode, est. length, evidence count),
     - and (ONLY for a still-PROPOSED, guided plan) an actions block with
       Approve / Run buttons whose `send` text re-enters the chat so Soli applies
       the plan — the gate stays in the conversation, never auto-fired here.

   The one-shot creative_edit (inline) and creative_apply_plan return an APPLIED
   shape ({plan?, applied:string[], render?, review?}); we render the same plan
   cards WITHOUT the approve buttons (it already ran) plus an "applied" summary.
   This is presentation only — it never applies or renders anything. */

/* A short, human label per EditOp.kind for the scorecard rows. */
const OP_LABELS: Record<string, string> = {
  ripple_trim: "Ripple trim",
  razor: "Razor cut",
  jl_cut: "J/L cut",
  slip: "Slip",
  slide: "Slide",
  insert_broll: "Insert b-roll",
  remove_clip: "Remove clip",
  reorder: "Reorder clips",
  subtitle: "Subtitle",
  grade: "Color grade",
  mix: "Audio mix",
  select_highlight: "Select highlights",
};

/* One scorecard note describing an op's parameters, kept compact. Evidence (when
   present) is the grounded "why" — a dead-air span, a filler hit, a shot id. */
function opNote(op: Dict): string {
  const kind = str(op.kind);
  const bits: string[] = [];
  switch (kind) {
    case "ripple_trim":
      bits.push(`${str(op.edge)} edge ${num(op.deltaSec) != null && num(op.deltaSec)! >= 0 ? "+" : ""}${num(op.deltaSec) ?? "?"}s`);
      break;
    case "razor":
      bits.push(`at ${num(op.atSec) ?? "?"}s`);
      break;
    case "jl_cut":
      bits.push(`lead ${num(op.leadSec) ?? "?"}s`);
      break;
    case "slip":
    case "slide":
      bits.push(`${num(op.deltaSec) != null && num(op.deltaSec)! >= 0 ? "+" : ""}${num(op.deltaSec) ?? "?"}s`);
      break;
    case "insert_broll":
      bits.push(`at ${num(op.atSec) ?? "?"}s${str(op.query) ? ` · "${str(op.query)}"` : ""}`);
      break;
    case "remove_clip":
      bits.push(str(op.clipId));
      break;
    case "reorder": {
      const order = Array.isArray(op.order) ? (op.order as unknown[]).length : 0;
      bits.push(`${order} clip(s)`);
      break;
    }
    case "subtitle":
      if (str(op.preset)) bits.push(`preset ${str(op.preset)}`);
      break;
    case "grade":
      bits.push(str(op.intent) || `${str(op.scope) || "global"} grade`);
      break;
    case "mix":
      bits.push(str(op.intent));
      break;
    case "select_highlight":
      bits.push(num(op.topN) != null ? `top ${num(op.topN)}` : num(op.maxSec) != null ? `${num(op.maxSec)}s` : "highlights");
      break;
  }
  const clip = str(op.clipId);
  if (clip && kind !== "remove_clip") bits.push(clip);
  const evidence = str(op.evidence);
  const head = bits.filter(Boolean).join(" · ");
  return evidence ? (head ? `${head} — ${evidence}` : evidence) : head;
}

/* The plan object lives either at the payload root (creative_edit_route) or
   under `.plan` (the one-shot creative_edit). */
function findPlan(payload: unknown): Dict | null {
  if (isObj(payload) && Array.isArray(payload.ops) && str(payload.id)) return payload;
  if (isObj(payload) && isObj(payload.plan) && Array.isArray((payload.plan as Dict).ops)) return payload.plan as Dict;
  return null;
}

function vizEditPlan(payload: unknown): UIBlock[] | null {
  const plan = findPlan(payload);
  if (!plan) return null;
  const planId = str(plan.id);
  const runId = str(plan.runId);
  const request = str(plan.request);
  const mode = str(plan.mode) || "guided";
  const status = str(plan.status) || "proposed";
  const ops = Array.isArray(plan.ops) ? (plan.ops as unknown[]).filter(isObj) : [];

  // Has this been applied already? creative_edit/apply_plan carry an `applied`
  // string[] alongside the plan; a bare routed plan does not. An applied plan
  // (or a non-guided / non-proposed one) gets NO approve buttons.
  const appliedLines = Array.isArray((payload as Dict)?.applied)
    ? ((payload as Dict).applied as unknown[]).map(str).filter(Boolean)
    : [];
  const wasApplied = appliedLines.length > 0 || status === "applied";
  const showApproval = !wasApplied && status === "proposed";

  const blocks: UIBlock[] = [];

  // 1) The rationale, framed as the "here's what I'd do" review header.
  const rationale = str(plan.rationale);
  if (rationale) {
    blocks.push({ type: "callout", tone: wasApplied ? "ok" : "info", text: rationale } as unknown as UIBlock);
  }

  // 2) The ops as a scorecard — one row per edit, the cited evidence as the note.
  //    verdict "strong" = grounded (cites evidence), "variable" = ungrounded, so
  //    a reader sees at a glance which edits are evidence-backed.
  const rows = ops.slice(0, 8).map((op) => {
    const kind = str(op.kind);
    return {
      label: OP_LABELS[kind] || kind || "edit",
      verdict: str(op.evidence) ? "strong" : "variable",
      note: opNote(op) || undefined,
    };
  });
  if (rows.length) {
    blocks.push({
      type: "scorecard",
      title: wasApplied ? `Applied — ${ops.length} edit${ops.length === 1 ? "" : "s"}` : `Proposed plan — ${ops.length} edit${ops.length === 1 ? "" : "s"}`,
      rows,
      href: runId ? `/post/${runId}` : undefined,
    } as unknown as UIBlock);
  }

  // 3) Plan metadata (compact).
  const kv: { key: string; value: string }[] = [];
  if (request) kv.push({ key: "request", value: request });
  kv.push({ key: "mode", value: mode });
  if (plan.montage) kv.push({ key: "montage", value: str((plan.montage as Dict).style) || "yes" });
  const est = num(plan.estDurationSec);
  if (est != null) kv.push({ key: "est. length", value: `${Math.round(est)}s` });
  const refs = Array.isArray(plan.evidenceRefs) ? (plan.evidenceRefs as unknown[]).length : 0;
  if (refs) kv.push({ key: "evidence cited", value: String(refs) });
  if (kv.length) blocks.push({ type: "key_value", title: "plan", items: kv } as unknown as UIBlock);

  // 4) Applied summary, OR the approval gate (guided plans only).
  if (wasApplied) {
    const render = str((payload as Dict)?.render);
    const review = isObj((payload as Dict)?.review) ? ((payload as Dict).review as Dict) : null;
    const steps = appliedLines.slice(0, 10).map((line) => ({
      label: line.replace(/^skip:\s*/i, ""),
      state: /^skip:/i.test(line) ? "pending" : "done",
    }));
    if (steps.length) blocks.push({ type: "steps", title: "what changed", items: steps } as unknown as UIBlock);
    if (review) {
      blocks.push({ type: "callout", tone: "info", text: `Self-review: ${str(review.verdict)}` } as unknown as UIBlock);
    }
    if (render) {
      blocks.push({ type: "callout", tone: "ok", text: "Final mp4 rendered." } as unknown as UIBlock);
    }
  } else if (showApproval) {
    // The gate stays in the conversation: each button sends text back as the
    // user's next message so Soli applies (or renders) the SHOWN plan. There is
    // deliberately no auto-apply here — this is presentation only.
    const planRef = planId ? ` (plan ${planId})` : "";
    blocks.push({
      type: "actions",
      buttons: [
        { label: "Approve & apply", send: `Approve and apply the edit plan you just showed${planRef}.` },
        { label: "Apply & render final", send: `Approve the plan${planRef}, apply it, and render the final video.` },
        { label: "Revise the plan", send: "Revise that edit plan — I want to change something before applying." },
      ],
    } as unknown as UIBlock);
  }

  return blocks.length ? blocks : null;
}

/* ---- Editor Frame-Control: at-a-frame + timeline views ---------------------

   The Phase-B frame tools return verified shapes the json_tree fallback CAN
   render, but a FrameInspector / Timeline block reads far better in Soli's
   answer. We compose them from EXISTING validated blocks (no new KNOWN_TYPES):

   - FrameInspector (timeline_seek_frame / timeline_query_frame) — "what's at
     frame N": a key_value of the frame anchor (frame, sec, clip, source window),
     a callout of the dense-vision read at that moment, a badge_row of the words
     on that frame, and a key_value of the music context (beats/drops/section).
   - Timeline (timeline_get / timeline_frame_range) — the cut: a stat_grid of
     fps/frames/length, a per-track table of clips (id · kind · in→out · window),
     and a callout marking the playhead frame when a range/position is present. */

function fmtSec(v: unknown): string {
  const n = num(v);
  if (n == null) return "";
  return `${n.toFixed(2)}s`;
}

/* timeline_seek_frame / timeline_query_frame → the at-a-frame inspector. seek
   carries the cross-modal context (vision/words/music); query is the lighter
   clip-only read — both render through here, the extra modalities simply absent
   on a query. */
function vizFrameInspector(payload: unknown): UIBlock[] | null {
  if (!isObj(payload)) return null;
  // Must look like a frame read: an atFrame anchor plus a clip slot (clip may be
  // null on a gap — still a valid inspector showing the gap).
  if (!("atFrame" in payload) || !("clip" in payload)) return null;
  const atFrame = num(payload.atFrame);
  if (atFrame == null) return null;

  const blocks: UIBlock[] = [];
  const clip = isObj(payload.clip) ? (payload.clip as Dict) : null;
  const fps = num(payload.fps);

  // 1) The frame anchor: where we are + which clip reads + its source window.
  const anchor: { key: string; value: string }[] = [
    { key: "frame", value: `${Math.round(atFrame)}${fps != null ? ` @ ${fps}fps` : ""}` },
    { key: "time", value: fmtSec(payload.atSec) || `${(atFrame / (fps ?? 30)).toFixed(2)}s` },
  ];
  if (clip) {
    anchor.push({ key: "clip", value: `${str(clip.id) || "?"}${str(clip.kind) ? ` · ${str(clip.kind)}` : ""}` });
    const inS = fmtSec(payload.sourceInSec);
    const outS = fmtSec(payload.sourceOutSec);
    const atS = fmtSec(payload.sourceAtSec);
    if (inS && outS) anchor.push({ key: "source window", value: `${inS} → ${outS}` });
    if (atS) anchor.push({ key: "source @", value: atS });
  } else {
    anchor.push({ key: "clip", value: "— gap (no clip here)" });
  }
  blocks.push({ type: "key_value", title: `frame ${Math.round(atFrame)}`, items: anchor } as unknown as UIBlock);

  // 2) Dense-vision read at this frame (nearest described frame).
  const vision = isObj(payload.vision) ? (payload.vision as Dict) : null;
  const frame = vision && isObj(vision.frame) ? (vision.frame as Dict) : null;
  if (frame) {
    const desc = str(frame.description);
    const ost = str(frame.onScreenText);
    const subs = Array.isArray(frame.subjects) ? (frame.subjects as unknown[]).map(str).filter(Boolean) : [];
    const delta = num(vision!.deltaSec);
    const lines: string[] = [];
    if (desc) lines.push(desc);
    if (ost) lines.push(`on-screen: “${ost}”`);
    if (subs.length) lines.push(`subjects: ${subs.slice(0, 6).join(", ")}`);
    if (lines.length) {
      const suffix = delta != null && Math.abs(delta) > 0.05 ? ` (nearest described frame, ${delta > 0 ? "+" : ""}${delta.toFixed(2)}s)` : "";
      blocks.push({ type: "callout", tone: "info", text: `${lines.join(" · ")}${suffix}` } as unknown as UIBlock);
    }
  }

  // 3) Transcript words on this frame → chips.
  const words = Array.isArray(payload.words) ? (payload.words as unknown[]).filter(isObj) : [];
  if (words.length) {
    const badges = words
      .slice(0, 10)
      .map((w) => ({ label: str(w.word) }))
      .filter((b) => b.label);
    if (badges.length) blocks.push({ type: "badge_row", title: "words on frame", badges } as unknown as UIBlock);
  }

  // 4) Music context at this frame (beats/drops/section/energy).
  const music = isObj(payload.music) ? (payload.music as Dict) : null;
  if (music) {
    const beats = Array.isArray(music.beats) ? (music.beats as unknown[]).length : 0;
    const drops = Array.isArray(music.drops) ? (music.drops as unknown[]).length : 0;
    const sections = Array.isArray(music.sections) ? (music.sections as Dict[]).filter(isObj) : [];
    const section = sections.length ? str(sections[0].kind) : "";
    const hasMusic = music.hasMusic === true || beats > 0;
    const mkv: { key: string; value: string }[] = [];
    if (section) mkv.push({ key: "section", value: section });
    mkv.push({ key: "on the beat", value: beats > 0 ? "yes" : "no" });
    if (drops > 0) mkv.push({ key: "drop here", value: "yes" });
    const bpm = num(music.tempoBpm);
    if (bpm != null) mkv.push({ key: "tempo", value: `${Math.round(bpm)} bpm` });
    if (hasMusic && mkv.length) blocks.push({ type: "key_value", title: "music", items: mkv } as unknown as UIBlock);
  }

  return blocks.length ? blocks : null;
}

/* timeline_get / timeline_frame_range → the timeline/range view: a stat_grid
   header (fps · frames · length), one table per track of its clips, and a
   playhead callout when the payload carries a position/range. */
function vizTimeline(payload: unknown): UIBlock[] | null {
  if (!isObj(payload)) return null;

  const fps = num(payload.fps);
  const blocks: UIBlock[] = [];

  // ── timeline_get: { fps, totalFrames, totalSec, derived, tracks:[{id,clips}] }
  const tracks = Array.isArray(payload.tracks) ? (payload.tracks as Dict[]).filter(isObj) : null;
  if (tracks && fps != null) {
    const totalFrames = num(payload.totalFrames);
    const totalSec = num(payload.totalSec);
    const clipCount = tracks.reduce((n, t) => n + (Array.isArray(t.clips) ? (t.clips as unknown[]).length : 0), 0);
    const stats = [
      { label: "fps", value: String(fps) },
      ...(totalFrames != null ? [{ label: "frames", value: String(Math.round(totalFrames)) }] : []),
      ...(totalSec != null ? [{ label: "length", value: `${totalSec.toFixed(1)}s` }] : []),
      { label: "clips", value: String(clipCount) },
    ];
    blocks.push({ type: "stat_grid", stats } as unknown as UIBlock);

    for (const track of tracks) {
      const clips = Array.isArray(track.clips) ? (track.clips as Dict[]).filter(isObj) : [];
      if (!clips.length) continue;
      const rows = clips.slice(0, 50).map((c) => {
        const sf = num(c.startFrame);
        const ef = num(c.endFrame);
        const span = sf != null && ef != null ? `${Math.round(sf)}→${Math.round(ef)}f` : `${fmtSec(c.startSec)}`;
        const inF = num(c.inFrame);
        const outF = num(c.outFrame);
        const win = inF != null && outF != null ? `${Math.round(inF)}→${Math.round(outF)}f` : `${fmtSec(c.inSec)}→${fmtSec(c.outSec)}`;
        return [str(c.id), str(c.kind), span, win];
      });
      blocks.push({
        type: "table",
        columns: [`${str(track.id) || "track"}`, "kind", "timeline", "source"],
        rows,
      } as unknown as UIBlock);
    }
    if (payload.derived === true) {
      blocks.push({ type: "callout", tone: "info", text: "Derived view (no built timeline yet) — run timeline_build to make frame edits stick." } as unknown as UIBlock);
    }
    return blocks.length ? blocks : null;
  }

  // ── timeline_frame_range: { fps, startFrame, endFrame, startSec, endSec, clips:[{clip,trackId,startFrame,endFrame,frames}] }
  const rangeClips = Array.isArray(payload.clips) ? (payload.clips as Dict[]).filter(isObj) : null;
  if (rangeClips && ("startFrame" in payload || "endFrame" in payload)) {
    const a = num(payload.startFrame);
    const b = num(payload.endFrame);
    blocks.push({
      type: "callout",
      tone: "info",
      text: `Window ${a != null ? Math.round(a) : "?"}→${b != null ? Math.round(b) : "?"}f${fps != null ? ` @ ${fps}fps` : ""} · ${rangeClips.length} clip(s)`,
    } as unknown as UIBlock);
    if (rangeClips.length) {
      const rows = rangeClips.slice(0, 50).map((rc) => {
        const clip = isObj(rc.clip) ? (rc.clip as Dict) : {};
        const sf = num(rc.startFrame);
        const ef = num(rc.endFrame);
        const span = sf != null && ef != null ? `${Math.round(sf)}→${Math.round(ef)}f` : "";
        const fcount = Array.isArray(rc.frames) ? (rc.frames as unknown[]).length : 0;
        return [str(clip.id), str(clip.kind), str(rc.trackId), span, fcount ? `${fcount}f indexed` : "—"];
      });
      blocks.push({ type: "table", columns: ["clip", "kind", "track", "window", "index"], rows } as unknown as UIBlock);
    }
    return blocks.length ? blocks : null;
  }

  return null;
}

/* Decide a viz from the tool NAME + its result data. Order matters: most
   specific name match first, then shape-based fallbacks. */
export function vizForToolResult(name: string, result: unknown): UIBlock[] | null {
  try {
    const payload = unwrap(result);
    if (payload == null) return null;

    let raw: UIBlock[] | null = null;

    // ----- name-driven mappings -----
    // Editor Studio: a routed/applied EditPlan → approval cards (most specific,
    // checked first so it wins over the generic shape fallbacks below).
    if (nameHas(name, "creative_edit_route", "creative_apply_plan") || name === "creative_edit") {
      raw = vizEditPlan(payload);
    } else if (nameHas(name, "seek_frame", "query_frame")) {
      // Editor Frame-Control: "what's at frame N" → the at-a-frame inspector.
      raw = vizFrameInspector(payload);
    } else if (nameHas(name, "timeline_get", "frame_range")) {
      // Editor Frame-Control: the whole timeline view OR a scrubber range window.
      raw = vizTimeline(payload);
    } else if (nameHas(name, "scorecard")) raw = vizScorecard(payload);
    else if (nameHas(name, "genome") || nameHas(name, "dna_context")) raw = vizGenome(payload);
    else if (nameHas(name, "channel") && nameHas(name, "list")) raw = vizChannels(pickArray(payload, ["items", "channels"]) ?? []);
    else if (nameHas(name, "mission")) raw = vizMissions(pickArray(payload, ["missions", "items"]) ?? (isObj(payload) ? [payload] : []));
    else if (nameHas(name, "device") || nameHas(name, "fleet")) {
      const devices = pickArray(payload, ["devices"]);
      const jobs = pickArray(payload, ["jobs"]);
      if (devices) raw = vizDevices(devices);
      else if (jobs) raw = vizJobs(jobs);
      // fleet_dispatch → a single LIVE progress bar keyed by the new jobId, so it
      // starts at 0% and animates as the worker streams research/render progress
      // (the ProgressView polls /api/jobs by jobId until the job is terminal).
      else if (isObj(payload) && str(payload.jobId)) {
        const target = str(payload.target);
        const label = [str(payload.type) || "render", str(payload.seed)].filter(Boolean).join(" · ");
        raw = [{ type: "progress", label: target && target !== "shared queue" ? `${label} → ${target}` : label, value: 0, jobId: str(payload.jobId) } as unknown as UIBlock];
      }
    } else if (nameHas(name, "ads")) {
      const ads = pickArray(payload, ["ads"]);
      if (ads) raw = vizAdsList(ads);
      else raw = vizAdRecord(payload);
    } else if (nameHas(name, "analytic", "insight", "scorecard_get")) raw = vizAnalytics(payload);
    else if (nameHas(name, "list") || nameHas(name, "runs")) {
      const items = pickArray(payload, ["items", "runs", "results"]);
      if (items) raw = vizItemList(items);
    }

    // ----- shape-based fallbacks (only when name didn't resolve) -----
    if (!raw) {
      const jobs = pickArray(payload, ["jobs"]);
      const devices = pickArray(payload, ["devices"]);
      if (jobs) raw = vizJobs(jobs);
      else if (devices) raw = vizDevices(devices);
      else if (isObj(payload) && Array.isArray(payload.series)) raw = vizAnalytics(payload);
      // Editor Frame-Control shapes (frame inspector / timeline) recognized by
      // their fields when the name didn't resolve (e.g. an intent tool that
      // forwards a raw seek/timeline result through).
      else if (isObj(payload) && "atFrame" in payload && "clip" in payload) raw = vizFrameInspector(payload);
      else if (isObj(payload) && (Array.isArray(payload.tracks) || (Array.isArray(payload.clips) && "startFrame" in payload))) raw = vizTimeline(payload);
      else raw = vizProgressRecord(payload);
    }

    if (raw && raw.length) {
      const validated = validateBlocks(raw);
      if (validated.length) return validated;
    }

    // No confident DOMAIN mapping (or the mapping validated to nothing): fall
    // back to a json_tree block so the result renders as the rich collapsible
    // explorer inline instead of a raw JSON dump. validateBlocks drops it if
    // the payload is empty or non-serializable, in which case we return null
    // and the caller shows nothing extra.
    const tree = validateBlocks([{ type: "json_tree", data: payload, label: "result" }]);
    return tree.length ? tree : null;
  } catch {
    return null;
  }
}
