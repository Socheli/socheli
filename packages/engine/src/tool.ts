#!/usr/bin/env -S node --import tsx
/**
 * Canonical tool runner — the process the dashboard API (and anything that
 * cannot import the node-only engine into its bundle) spawns to invoke any
 * capability in the single registry and read back JSON on stdout.
 *
 * Usage:
 *   node --import tsx src/tool.ts --manifest
 *       → prints toolsManifest() as JSON to stdout, exits 0.
 *
 *   node --import tsx src/tool.ts <toolName> [jsonInput]
 *       → calls callTool(name, JSON.parse(jsonInput ?? "{}")) and prints the
 *         ToolResult as JSON to stdout. Exits 0 when result.ok, nonzero
 *         otherwise (and on any thrown error / bad arguments).
 *
 * Contract: stdout carries ONLY the JSON payload (manifest array or
 * ToolResult). Diagnostics go to stderr so callers can JSON.parse stdout
 * verbatim.
 */
import "./env.ts";
import { callTool, toolsManifest } from "./tools/registry.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "--help" || first === "-h") {
    process.stderr.write(
      "usage:\n" +
        "  tool --manifest                 print every tool's name/description/kind/inputSchema as JSON\n" +
        "  tool <name> [jsonInput]         call a tool with a JSON input object; prints the ToolResult as JSON\n",
    );
    return first ? 0 : 1;
  }

  if (first === "--manifest" || first === "manifest") {
    process.stdout.write(JSON.stringify(toolsManifest()));
    return 0;
  }

  const name = first;
  const rawInput = argv[1];

  let input: unknown = {};
  if (rawInput !== undefined && rawInput !== "") {
    try {
      input = JSON.parse(rawInput);
    } catch (e: any) {
      process.stderr.write(`invalid JSON input for ${name}: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  // Public demo (AUTH_MODE=demo): the dashboard spawns this runner; allow ONLY
  // read-only tools so a no-login visitor can browse but never mutate, spend, or
  // publish. This is the security chokepoint for the /api/tools path (which isn't
  // role-gated itself).
  const demo = (process.env.AUTH_MODE ?? "").toLowerCase() === "demo" || process.env.SOCHELI_DEMO === "1";
  if (demo) {
    const meta = toolsManifest().find((t) => t.name === name);
    if (!meta || meta.kind !== "read") {
      process.stdout.write(JSON.stringify({ ok: false, message: "This is a read-only demo — sign up to run actions." }));
      return 1;
    }
  }

  const result = await callTool(name, input);
  process.stdout.write(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: any) => {
    process.stderr.write(`✗ ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
