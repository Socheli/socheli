#!/usr/bin/env node
// DOC SOC-001 deploy stamp — colophon KB/request numbers + commit hash.
// Never hand-write these; run before every deploy: node stamp.mjs
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

const html = readFileSync("index.html", "utf8");

// page weight: HTML + JS, before fonts (the claim says so via "loads no trackers")
const kb = Math.round(
  (statSync("index.html").size + statSync("assets/js/manual.js").size) / 1024,
);

// requests at first load: html, manual.js, inter-var, jbmono, caveat, favicon.svg
const req = 6;

let commit = "—";
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {}

const out = html
  .replace(/(<span data-stamp="kb">)[^<]*(<\/span>)/, `$1${kb}$2`)
  .replace(/(<span data-stamp="req">)[^<]*(<\/span>)/, `$1${req}$2`)
  .replace(/(<span data-stamp="commit">)[^<]*(<\/span>)/, `$1${commit}$2`);
writeFileSync("index.html", out);
console.log(`stamped: ${kb}KB · ${req} requests · commit ${commit}`);
