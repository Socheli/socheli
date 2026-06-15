import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* Minimal .env loader (no dep). Reads repo-root .env and fills process.env for
   any key not already set. Import this first in CLI entry points. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const file = join(ROOT, ".env");
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
  }
}
