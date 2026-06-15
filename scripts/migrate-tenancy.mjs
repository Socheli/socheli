#!/usr/bin/env node
/* Tenancy migration — stamp every pre-tenancy record with a workspace.

   Socheli was single-tenant: all data in data/*.json was global. This makes the
   product multi-member by giving every existing record a `workspaceId` (+ a
   `createdBy` author). Reads treat an unstamped record as DEFAULT, so the app
   keeps working before this runs; running it makes ownership explicit and lets
   you point existing data at a real org.

   Usage:
     node scripts/migrate-tenancy.mjs                 # dry run (prints a plan)
     node scripts/migrate-tenancy.mjs --apply         # write changes
     SOCHELI_DEFAULT_WORKSPACE=org_123 \
       SOCHELI_OWNER_ID=user_abc node scripts/migrate-tenancy.mjs --apply

   Idempotent: a record that already has a workspaceId is left untouched, so it's
   safe to re-run. */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const APPLY = process.argv.includes("--apply");
const WS = process.env.SOCHELI_DEFAULT_WORKSPACE || "ws_default";
const OWNER = process.env.SOCHELI_OWNER_ID || "owner";

let totalStamped = 0;
const log = (...a) => console.log(...a);

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

/* Stamp one record in place; return 1 if it changed, 0 if already stamped. */
function stamp(rec) {
  if (!rec || typeof rec !== "object") return 0;
  let changed = 0;
  if (!rec.workspaceId) {
    rec.workspaceId = WS;
    changed = 1;
  }
  if (!rec.createdBy) {
    rec.createdBy = OWNER;
    changed = 1; // createdBy alone shouldn't force a rewrite, but pair it with ws
  }
  return changed;
}

/* A single JSON file holding an array of records (content-plan, concepts). */
function migrateArrayFile(name) {
  const p = join(DATA, name);
  if (!existsSync(p)) return;
  const arr = readJson(p);
  if (!Array.isArray(arr)) return;
  let n = 0;
  for (const rec of arr) n += stamp(rec);
  if (n && APPLY) writeJson(p, arr);
  totalStamped += n;
  log(`  ${name}: ${n} / ${arr.length} stamped`);
}

/* A JSON file whose records live under a top-level map (brands.json → {brands},
   strategy → {channel:…}, fleet.json → {devices}). `path` selects the map. */
function migrateMapFile(name, pathKey) {
  const p = join(DATA, name);
  if (!existsSync(p)) return;
  const doc = readJson(p);
  if (!doc) return;
  const map = pathKey ? doc[pathKey] : doc;
  if (!map || typeof map !== "object") return;
  let n = 0;
  for (const key of Object.keys(map)) n += stamp(map[key]);
  if (n && APPLY) writeJson(p, doc);
  totalStamped += n;
  log(`  ${name}${pathKey ? `.${pathKey}` : ""}: ${n} / ${Object.keys(map).length} stamped`);
}

/* The per-item run files (data/runs/*.json) — one ContentItem each. */
function migrateRuns() {
  const dir = join(DATA, "runs");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let n = 0;
  for (const f of files) {
    const p = join(dir, f);
    const item = readJson(p);
    if (!item) continue;
    if (stamp(item)) {
      n++;
      if (APPLY) writeJson(p, item);
    }
  }
  totalStamped += n;
  log(`  runs/: ${n} / ${files.length} stamped`);
}

/* schedule.json / jobs.json — array OR object depending on the build; handle both. */
function migrateFlexible(name) {
  const p = join(DATA, name);
  if (!existsSync(p)) return;
  const doc = readJson(p);
  if (!doc) return;
  let n = 0;
  if (Array.isArray(doc)) {
    for (const rec of doc) n += stamp(rec);
  } else if (Array.isArray(doc.jobs)) {
    for (const rec of doc.jobs) n += stamp(rec);
  } else {
    n += stamp(doc); // top-level (e.g. the global Schedule object)
  }
  if (n && APPLY) writeJson(p, doc);
  totalStamped += n;
  log(`  ${name}: ${n} stamped`);
}

log(`\nTenancy migration — workspace="${WS}", owner="${OWNER}" ${APPLY ? "(APPLY)" : "(dry run)"}\n`);
log("Stamping records:");
migrateMapFile("brands.json", "brands");
migrateRuns();
migrateArrayFile("content-plan.json");
migrateArrayFile("concepts.json");
migrateMapFile("content-strategy.json", null);
migrateMapFile("fleet.json", "devices");
migrateFlexible("jobs.json");
migrateFlexible("schedule.json");
migrateArrayFile("calendar-events.json");

log(`\nTotal records ${APPLY ? "stamped" : "to stamp"}: ${totalStamped}`);
if (!APPLY) log(`\nDry run only. Re-run with --apply to write changes.\n`);
else log(`\nDone. All records now belong to workspace "${WS}".\n`);
