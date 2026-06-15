#!/usr/bin/env -S node --import tsx
import { callEditorTool, editorTools, formatCliResult, latestItemId, repoRoot, toolManifest } from "./editor-tools.ts";

const args = process.argv.slice(2);
const cmd = args.shift();

function take(name: string, def?: string) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? def;
}

function flag(name: string) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function numberOpt(name: string, def?: number) {
  const v = take(name);
  return v == null ? def : Number(v);
}

function parseJsonish(raw: string | undefined) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function idArg(required = true) {
  const id = take("id") ?? args.shift() ?? latestItemId();
  if (required && !id) throw new Error("id required");
  return id;
}

function printTool(name: string, input: any) {
  console.log(formatCliResult(callEditorTool(name, input)));
}

function help() {
  console.log(`Agent video editor tools

Usage:
  pnpm editor list
  pnpm editor state [id]
  pnpm editor clone <id> [--new-id id]
  pnpm editor scene <id> <index>
  pnpm editor set <id> <path> <json-or-string>
  pnpm editor unset <id> <path>
  pnpm editor patch-scene <id> <index> '<json>'
  pnpm editor add-scene <id> '<json>' [--index n]
  pnpm editor delete-scene <id> <index>
  pnpm editor duplicate-scene <id> <index>
  pnpm editor move-scene <id> <from> <to>
  pnpm editor split-scene <id> <index> <atSec>
  pnpm editor terminal-line <id> <sceneIndex> <add|update|delete|move> [--line-index n] [--to n] [--line json]
  pnpm editor style <id> <sceneIndex> '<json>'
  pnpm editor effect <id> <sceneIndex> <effect> <true|false>
  pnpm editor watch [id] [--scene n] [--frames n]
  pnpm editor scan-video [id] [--sample-fps n] [--width px] [--frames-per-sheet n]
  pnpm editor analyze-av [id]
  pnpm editor video-evidence [id] [--sample-fps n] [--width px] [--frames-per-sheet n] [--max-ocr-frames n] [--no-transcribe]
  pnpm editor competitive-intel
  pnpm editor deep-review [id] [--no-scan] [--sample-fps n] [--width px]
  pnpm editor compare-renders <beforeId> <afterId> [--samples n] [--width px]
  pnpm editor readability [id] [--width px]
  pnpm editor visual-readability [id] [--width px]
  pnpm editor ocr-review [id] [--width px]
  pnpm editor competitive-suite [id] [--width px] [--sample-fps n]
  pnpm editor suite-autofix [id] [--new-id id] [--width px] [--sample-fps n]
  pnpm editor accept-autofix <sourceId> <draftId> [--width px] [--samples n] [--sample-fps n] [--min-score-gain n]
  pnpm editor recipe <id> <tighten_pacing|make_terminal_clearer|raise_retention|fix_audio_ducking> [--new-id id] [--intensity n]
  pnpm editor frame [id] --time seconds
  pnpm editor rerender [id] [--voice] [--broll] [--procedural]
  pnpm editor mcp-info

MCP:
  pnpm editor:mcp

Repo:
  ${repoRoot()}
`);
}

async function main() {
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        help();
        break;
      case "tools":
      case "mcp-info":
        console.log(JSON.stringify({ mcpCommand: "pnpm editor:mcp", tools: toolManifest() }, null, 2));
        break;
      case "list":
        printTool("editor_list_items", {});
        break;
      case "state":
      case "show":
        printTool("editor_get_state", { id: idArg() });
        break;
      case "clone":
        printTool("editor_clone_item", { id: idArg(), newId: take("new-id") });
        break;
      case "scene":
        printTool("editor_get_scene", { id: idArg(), index: Number(args.shift()) });
        break;
      case "set":
        printTool("editor_set_path", { id: idArg(), path: args.shift(), value: parseJsonish(args.join(" ")) });
        break;
      case "unset":
        printTool("editor_unset_path", { id: idArg(), path: args.shift() });
        break;
      case "patch-scene":
        printTool("editor_patch_scene", { id: idArg(), index: Number(args.shift()), patch: parseJsonish(args.join(" ")) });
        break;
      case "add-scene":
        printTool("editor_add_scene", { id: idArg(), scene: parseJsonish(args.shift()), index: numberOpt("index") });
        break;
      case "delete-scene":
        printTool("editor_delete_scene", { id: idArg(), index: Number(args.shift()) });
        break;
      case "duplicate-scene":
        printTool("editor_duplicate_scene", { id: idArg(), index: Number(args.shift()) });
        break;
      case "move-scene":
        printTool("editor_move_scene", { id: idArg(), from: Number(args.shift()), to: Number(args.shift()) });
        break;
      case "split-scene":
        printTool("editor_split_scene", { id: idArg(), index: Number(args.shift()), atSec: Number(args.shift()) });
        break;
      case "terminal-line":
        printTool("editor_terminal_line", {
          id: idArg(),
          index: Number(args.shift()),
          action: args.shift(),
          lineIndex: numberOpt("line-index"),
          to: numberOpt("to"),
          line: parseJsonish(take("line")),
        });
        break;
      case "style":
        printTool("editor_set_style", { id: idArg(), index: Number(args.shift()), style: parseJsonish(args.join(" ")) });
        break;
      case "effect":
        printTool("editor_set_effect", { id: idArg(), index: Number(args.shift()), effect: args.shift(), enabled: parseJsonish(args.shift()) });
        break;
      case "watch":
        printTool("editor_watch_video", { id: idArg(), scene: numberOpt("scene"), frames: numberOpt("frames", 6) });
        break;
      case "scan-video":
        printTool("editor_scan_entire_video", {
          id: idArg(),
          sampleFps: numberOpt("sample-fps", 2),
          width: numberOpt("width", 360),
          framesPerSheet: numberOpt("frames-per-sheet", 24),
        });
        break;
      case "analyze-av":
        printTool("editor_analyze_av", { id: idArg() });
        break;
      case "video-evidence":
        printTool("editor_video_evidence", {
          id: idArg(),
          sampleFps: numberOpt("sample-fps", 1),
          width: numberOpt("width", 320),
          framesPerSheet: numberOpt("frames-per-sheet", 24),
          maxOcrFrames: numberOpt("max-ocr-frames", 80),
          transcribe: !flag("no-transcribe"),
        });
        break;
      case "competitive-intel":
        printTool("editor_competitive_intel", {});
        break;
      case "deep-review":
        printTool("editor_competitive_deep_review", {
          id: idArg(),
          scan: !flag("no-scan"),
          sampleFps: numberOpt("sample-fps", 2),
          width: numberOpt("width", 360),
          framesPerSheet: numberOpt("frames-per-sheet", 24),
        });
        break;
      case "compare-renders":
        printTool("editor_compare_renders", {
          beforeId: args.shift(),
          afterId: args.shift(),
          samples: numberOpt("samples", 8),
          width: numberOpt("width", 360),
        });
        break;
      case "readability":
        printTool("editor_readability_review", { id: idArg(), width: numberOpt("width", 360) });
        break;
      case "visual-readability":
        printTool("editor_visual_readability_review", { id: idArg(), width: numberOpt("width", 240) });
        break;
      case "ocr-review":
        printTool("editor_ocr_review", { id: idArg(), width: numberOpt("width", 540) });
        break;
      case "competitive-suite":
        printTool("editor_competitive_suite", { id: idArg(), width: numberOpt("width", 360), sampleFps: numberOpt("sample-fps", 2) });
        break;
      case "suite-autofix":
        printTool("editor_suite_autofix", { id: idArg(), newId: take("new-id"), width: numberOpt("width", 360), sampleFps: numberOpt("sample-fps", 1) });
        break;
      case "accept-autofix":
        printTool("editor_accept_autofix", {
          sourceId: args.shift(),
          draftId: args.shift(),
          width: numberOpt("width", 360),
          samples: numberOpt("samples", 8),
          sampleFps: numberOpt("sample-fps", 1),
          minScoreGain: numberOpt("min-score-gain", 5),
        });
        break;
      case "recipe":
        printTool("editor_apply_recipe", {
          id: idArg(),
          recipe: args.shift(),
          newId: take("new-id"),
          intensity: numberOpt("intensity", 1),
        });
        break;
      case "frame":
        printTool("editor_extract_frame", { id: idArg(), atSec: Number(take("time", args.shift())) });
        break;
      case "validate":
        printTool("editor_validate", { id: idArg() });
        break;
      case "rerender":
        printTool("editor_start_rerender", { id: idArg(), voice: flag("voice"), broll: flag("broll"), procedural: flag("procedural") });
        break;
      default:
        if (cmd?.startsWith("editor_")) {
          printTool(cmd, parseJsonish(args.join(" ")) ?? {});
          break;
        }
        throw new Error(`unknown command: ${cmd}`);
    }
  } catch (e) {
    process.exitCode = 1;
    console.error(e instanceof Error ? e.message : String(e));
  }
}

void main();
