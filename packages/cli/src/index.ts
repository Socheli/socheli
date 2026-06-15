#!/usr/bin/env -S node --import tsx
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createSocheli, SocheliError } from "@socheli/sdk";

/* `socheli` — the remote-control CLI. Talks to the Socheli API (api.socheli.com)
   via @socheli/sdk. Config: env SOCHELI_API_URL / SOCHELI_API_KEY, or `socheli login`
   which writes ~/.socheli/config.json. */

const CFG_DIR = join(homedir(), ".socheli");
const CFG = join(CFG_DIR, "config.json");
const loadCfg = (): { apiUrl?: string; apiKey?: string } => (existsSync(CFG) ? JSON.parse(readFileSync(CFG, "utf8")) : {});

function client() {
  const cfg = loadCfg();
  return createSocheli({
    baseUrl: process.env.SOCHELI_API_URL || cfg.apiUrl,
    apiKey: process.env.SOCHELI_API_KEY || cfg.apiKey,
  });
}

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); if (i >= 0) { rest.splice(i, 1); return true; } return false; };
const opt = (n: string, d = "") => { const i = rest.indexOf(`--${n}`); if (i >= 0) { const v = rest[i + 1]; rest.splice(i, 2); return v; } return d; };
const out = (o: unknown) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

function runLocalCli(label: string, entry: string, forwarded: string[]) {
  const full = join(ROOT, entry);
  if (!existsSync(full)) {
    fail(`${label} is not bundled in this install. Run it from the Socheli monorepo, or install a Socheli package that includes local engine tools.`);
    return;
  }
  const r = spawnSync(process.execPath, ["--import", "tsx", full, ...forwarded], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
}

async function main() {
  switch (cmd) {
    case "content":
    case "engine": {
      runLocalCli("Socheli content CLI", "packages/engine/src/cli.ts", rest);
      break;
    }
    case "demo": {
      // ZERO-AUTH one-liner — forward straight to the local engine's `demo`.
      // Renders a real 9:16 vertical with NO API keys (canned storyboard +
      // motion-graphics + synth music + subtitles). Requires the local engine
      // (monorepo / package that bundles engine tools).
      runLocalCli("Socheli content CLI", "packages/engine/src/cli.ts", ["demo", ...rest]);
      break;
    }
    case "editor": {
      runLocalCli("Socheli editor CLI", "packages/engine/src/editor-cli.ts", rest);
      break;
    }
    case "mcp": {
      const target = rest[0];
      if (target === "editor") runLocalCli("Socheli editor MCP", "packages/engine/src/editor-mcp.ts", rest.slice(1));
      else if (target === "content" || target === "engine" || target == null) runLocalCli("Socheli MCP", "packages/engine/src/socheli-mcp.ts", target == null ? rest : rest.slice(1));
      else return fail("usage: socheli mcp [content|editor]");
      break;
    }
    case "login": {
      const apiUrl = opt("url", "https://api.socheli.com");
      const apiKey = opt("key") || rest[0];
      if (!apiKey) return fail("usage: socheli login --key <API_KEY> [--url https://api.socheli.com]");
      mkdirSync(CFG_DIR, { recursive: true });
      writeFileSync(CFG, JSON.stringify({ apiUrl, apiKey }, null, 2));
      console.log(`✓ saved → ${CFG}`);
      break;
    }
    case "health":
      out(await client().health());
      break;
    case "me": {
      const me = await client().me();
      console.log(`workspace ${me.workspaceId}  ·  role ${me.role}  ·  via ${me.via}${me.userId ? `  ·  user ${me.userId}` : ""}`);
      break;
    }
    case "keys": {
      // API key management — `socheli keys <list|issue|revoke> …`
      const sub = rest.shift();
      const c = client();
      switch (sub) {
        case "list": {
          for (const k of await c.keys.list())
            console.log(`${k.id}  ${k.role.padEnd(7)} ${k.prefix}…  ${k.revokedAt ? "[revoked]" : "active "}  ${k.label}`);
          break;
        }
        case "issue": {
          const role = (opt("role") || undefined) as any;
          const label = rest.join(" ").trim() || opt("label") || "API key";
          const { key, record } = await c.keys.issue({ label, role });
          console.log(`✓ issued ${record.id} (${record.role})`);
          console.log(`\n  ${key}\n`);
          console.log("save this now — it is shown only once.");
          break;
        }
        case "revoke": {
          if (!rest[0]) return fail("usage: socheli keys revoke <id>");
          console.log((await c.keys.revoke(rest[0])) ? "✓ revoked" : "not found");
          break;
        }
        default:
          return fail("usage: socheli keys <list|issue|revoke> …");
      }
      break;
    }
    case "items": {
      const limit = Number(opt("limit", "20"));
      const channel = opt("channel") || undefined;
      const items = await client().items.list({ limit, channel });
      for (const it of items) console.log(`${it.id}  ${String(it.status).padEnd(14)} ${it.qa ? "QA" + it.qa.toFixed(1) : "    "}  ${it.title}`);
      break;
    }
    case "get":
      out(await client().items.get(rest[0]));
      break;
    case "generate": {
      const auto = flag("auto");
      const channel = opt("channel", "labrinox");
      const mood = opt("mood") || undefined;
      const voice = flag("voice");
      const seed = rest.join(" ").trim();
      if (!seed) return fail('usage: socheli generate "<idea>" [--channel x] [--auto] [--voice]');
      const r = await client().generate({ seed, channel, mood, voice, type: auto ? "auto" : "new" });
      console.log(`✓ dispatched ${r.job.id} (${r.job.type}) → ${r.job.channel}`);
      break;
    }
    case "jobs": {
      for (const j of await client().jobs()) console.log(`${j.id}  ${j.status.padEnd(11)} ${j.type.padEnd(5)} ${j.device ?? "-"}  ${j.itemId ?? ""}`);
      break;
    }
    case "fleet": {
      const f = await client().fleet();
      console.log(`${f.online} device(s) online`);
      for (const d of f.devices) console.log(`  ${d.device.padEnd(12)} ${d.status.padEnd(8)} ${d.host ?? ""}${d.currentJob ? `  job ${d.currentJob}` : ""}`);
      break;
    }
    case "publish": {
      const pub = flag("public");
      await client().items.publish(rest[0], { public: pub });
      console.log(`✓ publishing ${rest[0]}${pub ? " (public)" : ""}`);
      break;
    }
    case "tools": {
      const manifest = await client().tools();
      for (const t of manifest) console.log(`${t.kind.padEnd(6)} ${t.name}  —  ${t.description}`);
      console.log(`\n${manifest.length} tools`);
      break;
    }
    case "tool": {
      const name = rest[0];
      if (!name) return fail("usage: socheli tool <name> [jsonInput]   (see: socheli tools)");
      let input: Record<string, unknown> = {};
      const raw = rest.slice(1).join(" ").trim();
      if (raw) { try { input = JSON.parse(raw); } catch (e: any) { return fail(`invalid JSON: ${e?.message ?? e}`); } }
      const r = await client().tool(name, input);
      out(r);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "plan": {
      // Calendar plan CRUD — `socheli plan <list|day|get|move|archive|delete|run> …`
      const sub = rest.shift();
      const c = client();
      switch (sub) {
        case "list": { const ch = opt("channel") || undefined; out(await c.plan.list({ channel: ch, includeArchived: flag("archived") })); break; }
        case "day": { const date = rest[0]; if (!date) return fail("usage: socheli plan day <YYYY-MM-DD>"); out(await c.plan.day(date, flag("archived"))); break; }
        case "get": { if (!rest[0]) return fail("usage: socheli plan get <id>"); out(await c.plan.get(rest[0])); break; }
        case "move": { const id = rest[0]; const date = opt("date"); const time = opt("time") || undefined; if (!id || !date) return fail("usage: socheli plan move <id> --date <YYYY-MM-DD> [--time HH:MM]"); out(await c.plan.move(id, date, time)); break; }
        case "archive": { if (!rest[0]) return fail("usage: socheli plan archive <id>"); out(await c.plan.archive(rest[0])); break; }
        case "delete": { if (!rest[0]) return fail("usage: socheli plan delete <id>"); console.log((await c.plan.remove(rest[0])) ? "✓ deleted" : "not found"); break; }
        case "run": { const channel = opt("channel"); if (!channel) return fail("usage: socheli plan run --channel <id> [--days n]"); const days = opt("days") ? Number(opt("days")) : undefined; out(await c.plan.run({ channel, days })); break; }
        default: return fail("usage: socheli plan <list|day|get|move|archive|delete|run> …");
      }
      break;
    }
    default:
      console.log(`socheli — content engine CLI

Local workspace commands:
  demo "<idea>"                          ZERO-AUTH demo — render a real 9:16
                                          vertical with NO API keys
  content <cmd>                          run the full local engine CLI
  engine <cmd>                           alias for content
  editor <cmd>                           run local video editor/review tools
  mcp [content|editor]                   run the local MCP server

Remote/API commands:
  login --key <API_KEY> [--url <api>]   save credentials
  health                                API status
  me                                    show this key's workspace + role
  keys <list|issue|revoke> …            manage workspace API keys
                                          keys issue "<label>" [--role member]
                                          keys revoke <id>
  items [--limit n] [--channel id]      list content items
  get <id>                              full item JSON
  generate "<idea>" [--channel id] [--auto] [--voice] [--mood id]
                                        dispatch a render job to the fleet
  jobs                                  recent fleet jobs
  fleet                                 connected devices
  publish <id> [--public]               publish an item
  tools                                 list every registry tool (name/kind/desc)
  tool <name> [json]                    call any registry tool with a JSON input
  plan <list|day|get|move|archive|delete|run> …
                                        curate the content calendar/plan

config: SOCHELI_API_URL / SOCHELI_API_KEY env, or ~/.socheli/config.json`);
  }
}

function fail(m: string) {
  console.error(m);
  process.exitCode = 1;
}

main().catch((e) => {
  if (e instanceof SocheliError) console.error(`✗ ${e.status}: ${e.message}`);
  else console.error("✗", e?.message ?? e);
  process.exitCode = 1;
});
