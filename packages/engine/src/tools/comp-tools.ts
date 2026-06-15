import { z } from "zod";

import { type PipelineTool, ok, tool } from "./helpers.ts";
import { loadItem, saveItem, logLine } from "../store.ts";
import { EffectGraph, type EffectNode } from "@os/schemas";
import { compTrack, trackAttach } from "../creative/tracking.ts";

/**
 * comp-tools.ts — the Fusion-style COMPOSITING tool surface (DaVinci spine §4.4,
 * M14). Spread into the canonical registry (registry.ts pipelineTools) so MCP /
 * HTTP / CLI / SDK / the dashboard copilot (Soli) all get the node-graph authoring
 * surface for free.
 *
 * M13 shipped the renderer (CompositeGraph) + the post-scope graph; M14 brings the
 * graph DOWN to the scene level (scene.style.comp) and adds mask/key/transform/
 * displace nodes + this hand-authoring surface. A graph lives EITHER on a scene
 * (scope:"scene", scene.style.comp — the default) OR at the post level
 * (scope:"post"/"global", storyboard.comp). Tools:
 *   • comp_add_node    — add an EffectNode to a graph (creates the graph + a source
 *                        node if absent), wired from the current output by default.
 *   • comp_wire        — set a node's `inputs` (connect upstream nodes by id).
 *   • comp_set_params  — merge params onto an existing node.
 *   • comp_remove_node — delete a node (and drop dangling references to it).
 *   • comp_preset      — apply a named LOOK graph (dreamy_glow / vintage_film /
 *                        subject_isolate / glitch_vhs / spotlight / punchy).
 *
 * Shape note: ok/tool come from the leaf helpers module (NOT registry.ts) so there
 * is no import cycle — mirrors mix-tools.ts / timeline-tools.ts exactly. Every
 * write is SYNCHRONOUS (loadItem → mutate scene.style.comp / storyboard.comp →
 * saveItem), the graph is RE-PARSED through EffectGraph before persist (a malformed
 * graph never reaches the render), and a LOCKED scene is left untouched (returns
 * skipped). The renderer's identity guarantee holds: an empty/absent graph renders
 * the scene/post byte-identical to today.
 */

const idArg = z.string().min(1).describe("ContentItem/run id (e.g. concept_20260610034331)");

// The node-type vocabulary the renderer understands (mirrors @os/schemas EffectNode
// — kept here as the tool-facing enum so a bad type is rejected at the boundary).
const NODE_TYPES = [
  "grade", "glow", "bloom", "light_leak", "chroma_ab", "grain", "vignette",
  "blur", "sharpen", "mask_shape", "mask_luma", "mask_alpha", "key_luma",
  "key_chroma", "transform", "displace", "blend", "source", "track_attach",
] as const;

// Where the graph lives. "scene" → scene.style.comp (needs sceneId/sceneIndex);
// "post" → storyboard.comp (a project-wide graph over the whole composition).
const scopeArg = z.enum(["scene", "post"]).default("scene").describe("graph location: per-scene (scene.style.comp) or post-wide (storyboard.comp)");
const sceneRefArg = z.string().optional().describe("scene id (or numeric index) when scope=scene");

let SEQ = 0;
const nid = (kind: string) => `${kind}_${Date.now().toString(36)}${(++SEQ).toString(36)}`;

/* Locate the scene a graph belongs to (by id, else numeric index). Returns the
   scene object (a live reference into item.storyboard.scenes) or null. */
function findScene(item: any, ref?: string): any | null {
  const scenes: any[] = item.storyboard?.scenes ?? [];
  if (!scenes.length) return null;
  if (ref == null || ref === "") return scenes[0] ?? null;
  const byId = scenes.find((s) => s?.id === ref);
  if (byId) return byId;
  const idx = Number(ref);
  if (Number.isInteger(idx) && idx >= 0 && idx < scenes.length) return scenes[idx];
  return null;
}

/* Read the current graph from a scope (scene.style.comp / storyboard.comp), or a
   fresh empty graph. Always returns a plain object we can mutate then re-parse. */
function readGraph(item: any, scope: string, scene: any): { nodes: EffectNode[]; output?: string } {
  const raw = scope === "post" ? item.storyboard?.comp : scene?.style?.comp;
  const nodes: EffectNode[] = Array.isArray(raw?.nodes) ? raw.nodes.map((n: any) => ({ ...n })) : [];
  return { nodes, output: raw?.output };
}

/* Persist a graph back to its scope. Re-parses through EffectGraph so a malformed
   graph never reaches the render; an EMPTY graph is written as `undefined` (clears
   the comp → the scene/post renders through the legacy path, identity). */
function writeGraph(item: any, scope: string, scene: any, graph: { nodes: EffectNode[]; output?: string }): z.infer<typeof EffectGraph> | undefined {
  const parsed = graph.nodes.length ? EffectGraph.parse(graph) : undefined;
  if (scope === "post") {
    item.storyboard = { ...(item.storyboard ?? {}), comp: parsed };
  } else {
    scene.style = { ...(scene.style ?? {}), comp: parsed };
  }
  return parsed;
}

/* Ensure a graph has a `source` leaf (every look/mask/key node chains FROM it).
   Returns the source node id. */
function ensureSource(nodes: EffectNode[]): string {
  const existing = nodes.find((n) => n.type === "source");
  if (existing) return existing.id;
  const src: EffectNode = { id: "src", type: "source", inputs: [] };
  nodes.unshift(src);
  return src.id;
}

export const compTools: PipelineTool[] = [
  tool({
    name: "comp_add_node",
    description:
      "Add a compositing EffectNode to a scene's (scope=scene, scene.style.comp) or the post's (scope=post, storyboard.comp) effect graph. Creates the graph + a `source` leaf if absent and, by default, wires the new node FROM the current graph output (a linear look stack) — pass `inputs` to wire it explicitly. `type` is the effect primitive (grade/glow/bloom/light_leak/chroma_ab/grain/vignette/blur/sharpen/mask_shape/mask_luma/mask_alpha/key_luma/key_chroma/transform/displace/blend). `params` are node-type-specific (clamped at render). Re-parsed through the schema before persist; a LOCKED scene is left untouched. Returns the persisted graph.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        scope: scopeArg,
        scene: sceneRefArg,
        type: z.enum(NODE_TYPES),
        params: z.record(z.unknown()).optional(),
        inputs: z.array(z.string()).optional().describe("upstream node ids feeding this node (default: the current output)"),
        nodeId: z.string().optional().describe("explicit node id (default: auto-generated)"),
      })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const scene = a.scope === "scene" ? findScene(item, a.scene) : null;
      if (a.scope === "scene" && !scene) return ok({ id: a.id, error: "scene not found" }, "scene not found");
      if (scene?.locked) return ok({ id: a.id, skipped: true }, "scene is locked — skipped");
      const g = readGraph(item, a.scope, scene);
      const srcId = ensureSource(g.nodes);
      const inputs = a.inputs && a.inputs.length ? a.inputs : [g.output ?? srcId];
      const node: EffectNode = { id: a.nodeId || nid(a.type), type: a.type, params: a.params, inputs };
      g.nodes.push(node);
      g.output = node.id; // the new node becomes the graph output (linear stack)
      const parsed = writeGraph(item, a.scope, scene, g);
      logLine(item, `comp: +${a.type} on ${a.scope}${scene ? ` scene ${scene.id}` : ""}`);
      saveItem(item);
      return ok({ id: a.id, nodeId: node.id, graph: parsed }, `added ${a.type} node (${parsed?.nodes.length ?? 0} total)`);
    },
  }),
  tool({
    name: "comp_wire",
    description:
      "Set a node's `inputs` (connect upstream node ids) in a scene/post effect graph — the Fusion 'wire one node into another' op. Replaces the node's inputs with the given list (each must be an existing node id; unknown ids are dropped). Optionally set `output` to make a node the graph's final image. Re-parsed before persist; locked scene untouched. Returns the persisted graph.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        scope: scopeArg,
        scene: sceneRefArg,
        nodeId: z.string().min(1),
        inputs: z.array(z.string()).default([]),
        output: z.boolean().optional().describe("make this node the graph output"),
      })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const scene = a.scope === "scene" ? findScene(item, a.scene) : null;
      if (a.scope === "scene" && !scene) return ok({ id: a.id, error: "scene not found" }, "scene not found");
      if (scene?.locked) return ok({ id: a.id, skipped: true }, "scene is locked — skipped");
      const g = readGraph(item, a.scope, scene);
      const target = g.nodes.find((n) => n.id === a.nodeId);
      if (!target) return ok({ id: a.id, error: "node not found" }, `node ${a.nodeId} not found`);
      const known = new Set(g.nodes.map((n) => n.id));
      target.inputs = a.inputs.filter((i: string) => known.has(i) && i !== a.nodeId); // drop dangling + self
      if (a.output) g.output = a.nodeId;
      const parsed = writeGraph(item, a.scope, scene, g);
      logLine(item, `comp: wire ${a.nodeId} ← [${target.inputs.join(", ")}]`);
      saveItem(item);
      return ok({ id: a.id, graph: parsed }, `wired ${a.nodeId} (${target.inputs.length} input${target.inputs.length === 1 ? "" : "s"})`);
    },
  }),
  tool({
    name: "comp_set_params",
    description:
      "Merge params onto an existing compositing node (scene/post graph). The given `params` are shallow-merged over the node's current params (omitted keys preserved); pass null/undefined-valued keys to leave them. Use to tweak a glow's amount, a mask's radius, a key's threshold, a grade node's grade, etc. Re-parsed before persist; locked scene untouched. Returns the persisted graph.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        scope: scopeArg,
        scene: sceneRefArg,
        nodeId: z.string().min(1),
        params: z.record(z.unknown()),
      })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const scene = a.scope === "scene" ? findScene(item, a.scene) : null;
      if (a.scope === "scene" && !scene) return ok({ id: a.id, error: "scene not found" }, "scene not found");
      if (scene?.locked) return ok({ id: a.id, skipped: true }, "scene is locked — skipped");
      const g = readGraph(item, a.scope, scene);
      const target = g.nodes.find((n) => n.id === a.nodeId);
      if (!target) return ok({ id: a.id, error: "node not found" }, `node ${a.nodeId} not found`);
      target.params = { ...(target.params ?? {}), ...a.params };
      const parsed = writeGraph(item, a.scope, scene, g);
      logLine(item, `comp: params ${a.nodeId} ← ${Object.keys(a.params).join(", ")}`);
      saveItem(item);
      return ok({ id: a.id, graph: parsed }, `set params on ${a.nodeId}`);
    },
  }),
  tool({
    name: "comp_remove_node",
    description:
      "Remove a node from a scene/post effect graph and drop every dangling reference to it (other nodes' inputs are re-pointed past it; the graph output falls back to the new last node). Removing the last look node leaves just the source → the comp is cleared and the scene/post renders through the legacy path (identity). A `source` node can't be removed while other nodes depend on it. Re-parsed before persist; locked scene untouched. Returns the persisted graph.",
    kind: "mutate",
    schema: z
      .object({ id: idArg, scope: scopeArg, scene: sceneRefArg, nodeId: z.string().min(1) })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const scene = a.scope === "scene" ? findScene(item, a.scene) : null;
      if (a.scope === "scene" && !scene) return ok({ id: a.id, error: "scene not found" }, "scene not found");
      if (scene?.locked) return ok({ id: a.id, skipped: true }, "scene is locked — skipped");
      const g = readGraph(item, a.scope, scene);
      const target = g.nodes.find((n) => n.id === a.nodeId);
      if (!target) return ok({ id: a.id, error: "node not found" }, `node ${a.nodeId} not found`);
      // re-point dependents past the removed node (onto ITS inputs), then drop it.
      const survivorInputs = target.inputs ?? [];
      g.nodes = g.nodes.filter((n) => n.id !== a.nodeId);
      for (const n of g.nodes) {
        if ((n.inputs ?? []).includes(a.nodeId)) {
          n.inputs = [...new Set([...(n.inputs ?? []).filter((i) => i !== a.nodeId), ...survivorInputs])].filter((i) => i !== n.id);
        }
      }
      // if every look node is gone (only source left), clear the graph entirely.
      if (g.nodes.every((n) => n.type === "source")) g.nodes = [];
      if (g.output === a.nodeId) g.output = g.nodes.length ? g.nodes[g.nodes.length - 1].id : undefined;
      const parsed = writeGraph(item, a.scope, scene, g);
      logLine(item, `comp: -${a.nodeId} on ${a.scope}`);
      saveItem(item);
      return ok({ id: a.id, graph: parsed }, `removed ${a.nodeId} (${parsed?.nodes.length ?? 0} node${(parsed?.nodes.length ?? 0) === 1 ? "" : "s"} left)`);
    },
  }),
  tool({
    name: "comp_preset",
    description:
      "Apply a named LOOK graph to a scene (scope=scene) or the post (scope=post), REPLACING any existing comp on that scope. Presets: 'dreamy_glow' (glow+bloom), 'vintage_film' (grain+vignette+light_leak), 'subject_isolate' (luma key + glow), 'glitch_vhs' (chroma_ab+displace), 'spotlight' (circle mask + vignette), 'punchy' (bloom + contrast). Each is a small, schema-real, restrained graph (the same vocabulary the EDL bridge's buildCompFromIntents emits). Locked scene untouched. Returns the persisted graph.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        scope: scopeArg,
        scene: sceneRefArg,
        preset: z.enum(["dreamy_glow", "vintage_film", "subject_isolate", "glitch_vhs", "spotlight", "punchy"]),
      })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const scene = a.scope === "scene" ? findScene(item, a.scene) : null;
      if (a.scope === "scene" && !scene) return ok({ id: a.id, error: "scene not found" }, "scene not found");
      if (scene?.locked) return ok({ id: a.id, skipped: true }, "scene is locked — skipped");
      const nodes = presetGraph(a.preset);
      const g = { nodes, output: nodes[nodes.length - 1].id };
      const parsed = writeGraph(item, a.scope, scene, g);
      logLine(item, `comp: preset ${a.preset} on ${a.scope}`);
      saveItem(item);
      return ok({ id: a.id, preset: a.preset, graph: parsed }, `applied ${a.preset} (${parsed?.nodes.length ?? 0} nodes)`);
    },
  }),
  tool({
    name: "comp_track",
    description:
      "MOTION TRACK a point/region across the run's rendered frames → TrackData ({points:[{frame,x,y}]}). Best-effort + fail-open: tries ffmpeg vidstabdetect global motion, then a coarse luma block-match on raw frames (no extra dependency), then a SINGLE STATIC point ('static fallback (no tracker)') when neither runs (no render / old ffmpeg / a tiny clip). `region` is in NORMALIZED [0,1] coords (resolution-independent): x/y centre (default 0.5,0.5), w/h extent (default 0.2; w=h=0 → a point). Tracking runs OFFLINE (frames decoded once → a fixed TrackData) so the React render stays deterministic. Pair with comp_track_attach to pin a comp node's transform to the result. Returns { track, method, note, sampleFps, frameCount }.",
    kind: "read",
    schema: z
      .object({
        id: idArg,
        region: z
          .object({
            x: z.number().min(0).max(1).optional().describe("centre x (0..1, default 0.5)"),
            y: z.number().min(0).max(1).optional().describe("centre y (0..1, default 0.5)"),
            w: z.number().min(0).max(1).optional().describe("width (0..1, default 0.2; 0 → a point)"),
            h: z.number().min(0).max(1).optional().describe("height (0..1, default 0.2; 0 → a point)"),
          })
          .optional(),
        sampleFps: z.number().min(1).max(12).default(6).describe("frames/sec to sample the track at (coarse is fine)"),
        width: z.number().min(96).max(512).default(240).describe("decode width for the block-match path"),
        maxSamples: z.number().int().min(8).max(1200).default(240).describe("hard cap on emitted track samples"),
      })
      .strict(),
    run: (a) => {
      const r = compTrack(a.id, a.region, { sampleFps: a.sampleFps, width: a.width, maxSamples: a.maxSamples });
      return ok(
        { id: a.id, track: r.track, method: r.method, note: r.note, sampleFps: r.sampleFps, frameCount: r.frameCount },
        `tracked ${r.frameCount} sample(s) via ${r.method}`,
      );
    },
  }),
  tool({
    name: "comp_track_attach",
    description:
      "Attach a comp node's TRANSFORM to a TrackData so an element RIDES the tracked motion (e.g. a logo riding a moving phone). Converts the track's pixel positions into tx/ty KEYFRAMES on the target node, retyped to a `transform` node (the renderable form of track_attach, which is a renderer no-op without precomputed data). Pass the `track` from comp_track. `sceneIndex` < 0 targets the post-scope graph (storyboard.comp). tx/ty are pixel OFFSETS from the track's first point (the element starts where authored, then rides). Locked scene → skipped; re-parsed before persist; never throws. Returns { ok, changed }.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        sceneIndex: z.number().int().describe("scene index whose graph holds the node (negative → post-scope storyboard.comp)"),
        nodeId: z.string().min(1).describe("id of the comp node to pin to the motion"),
        track: z
          .object({
            points: z
              .array(z.object({ frame: z.number().int().min(0), x: z.number(), y: z.number() }))
              .default([]),
          })
          .describe("TrackData from comp_track ({points:[{frame,x,y}]})"),
      })
      .strict(),
    run: (a) => {
      const r = trackAttach(a.id, a.sceneIndex, a.nodeId, a.track as any);
      return ok({ id: a.id, ok: r.ok, changed: r.changed }, r.changed[0] ?? (r.ok ? "attached" : "not attached"));
    },
  }),
];

/* Named LOOK graphs — small linear stacks rooted at a `source`, mirroring the
   EDL bridge's buildCompFromIntents looks so a hand-applied preset matches what the
   agent would author from prose. Each chains FROM the previous node. */
function presetGraph(preset: string): EffectNode[] {
  const src: EffectNode = { id: "src", type: "source", inputs: [] };
  const nodes: EffectNode[] = [src];
  let last = src.id;
  const add = (type: EffectNode["type"], params: Record<string, unknown>) => {
    const node: EffectNode = { id: nid(type), type, params, inputs: [last] };
    nodes.push(node);
    last = node.id;
  };
  switch (preset) {
    case "dreamy_glow":
      add("glow", { amount: 0.4, radius: 20 });
      add("bloom", { amount: 0.3 });
      break;
    case "vintage_film":
      add("grain", { amount: 0.1, frequency: 0.85 });
      add("vignette", { amount: 0.34 });
      add("light_leak", { amount: 0.4 });
      break;
    case "subject_isolate":
      add("key_luma", { threshold: 0.82, tolerance: 0.1 });
      add("glow", { amount: 0.42, radius: 18 });
      break;
    case "glitch_vhs":
      add("chroma_ab", { amount: 3 });
      add("displace", { scale: 6, frequency: 0.012, animate: true });
      break;
    case "spotlight":
      add("mask_shape", { shape: "circle", r: 52, x: 50, y: 48, feather: 18 });
      add("vignette", { amount: 0.4 });
      break;
    case "punchy":
    default:
      add("bloom", { amount: 0.34 });
      add("grade", { grade: { contrast: 1.12, saturation: 1.08 } });
      break;
  }
  return nodes;
}
