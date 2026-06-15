import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { Job } from "./fleet.ts";

/* Fleet job verification — the zero-trust boundary on the cloud→device link
   (docs/HYBRID-ARCHITECTURE §4). The agent treats EVERY inbound MQTT message as
   hostile: strict Zod shape-bounding (no field the engine doesn't expect), then
   — when a job-signing public key is pinned — Ed25519 signature + target-binding
   + TTL + single-use nonce. A self-host instance with no pinned key (no cloud)
   degrades to shape validation only; it isn't under the cloud-RCE threat.

   Worst case of a fully-compromised cloud is bounded to "render a junk video":
   it can never inject an unexpected field, replay an old job, target another
   device, or — paired with the env allowlist + auto-post opt-in below — exfil a
   secret or post under the user's identity. */

const SOCHELI_DIR = join(homedir(), ".socheli");
const NONCE_FILE = join(SOCHELI_DIR, "consumed-nonces.json");
const AUDIT_FILE = join(SOCHELI_DIR, "job-audit.jsonl"); // device-local — NOT under data/ (never rsynced)
const TTL_MS = 5 * 60_000; // signed jobs older than 5 min are rejected (replay window)
const NONCE_CAP = 5000;

/* Strict, shape-bounded job envelope. `.strict()` rejects any field the engine
   doesn't model — a hard cap on what a message can even express. The security
   envelope (target/nonce/sig) is optional and enforced only when a key is pinned. */
export const JobSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["auto", "new", "ping", "render", "longform"]),
    channel: z.string().optional(),
    seed: z.string().optional(),
    mood: z.string().optional(),
    voice: z.boolean().optional(),
    research: z.enum(["quick", "standard", "deep"]).optional(),
    public: z.boolean().optional(),
    itemId: z.string().optional(),
    item: z.unknown().optional(),
    createdAt: z.string(),
    by: z.string().optional(),
    workspaceId: z.string().optional(),
    createdBy: z.string().optional(),
    // zero-trust envelope (set by the cloud signer; verified when a key is pinned)
    target: z.string().optional(),
    nonce: z.string().optional(),
    sig: z.string().optional(),
  })
  .strict();

function pinnedKey() {
  const raw = process.env.SOCHELI_JOB_SIGNING_PUBKEY;
  if (!raw) return null;
  try {
    // Accept a PEM (SPKI) directly, or a base64 blob we wrap as PEM.
    const pem = raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : `-----BEGIN PUBLIC KEY-----\n${raw}\n-----END PUBLIC KEY-----`;
    return createPublicKey(pem);
  } catch {
    return null;
  }
}

/* Deterministic canonical form so the device verifies exactly what the cloud
   signed: sorted keys, the `sig` field removed. */
function canonical(job: Record<string, unknown>): string {
  const { sig, ...rest } = job;
  void sig;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(rest).sort()) sorted[k] = (rest as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

function loadNonces(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(NONCE_FILE, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}
function consumeNonce(nonce: string): void {
  const set = loadNonces();
  set.add(nonce);
  const arr = [...set].slice(-NONCE_CAP); // bound the file; oldest fall off
  try {
    mkdirSync(SOCHELI_DIR, { recursive: true });
    const tmp = `${NONCE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(arr));
    renameSync(tmp, NONCE_FILE);
  } catch {
    /* best-effort */
  }
}

function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(SOCHELI_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* best-effort */
  }
}

export type VerifyResult = { ok: true; job: Job } | { ok: false; reason: string };

/* Validate + authenticate an inbound job for THIS device. Never throws. */
export function verifyInboundJob(raw: unknown, deviceId: string): VerifyResult {
  const parsed = JobSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = `schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`;
    audit({ decision: "reject", reason, deviceId });
    return { ok: false, reason };
  }
  const job = parsed.data;

  const key = pinnedKey();
  if (key) {
    // Cloud-paired zero-trust path: require signature + target + freshness + nonce.
    if (!job.sig) return reject(job, deviceId, "missing signature (key is pinned)");
    let valid = false;
    try {
      valid = cryptoVerify(null, Buffer.from(canonical(job)), key, Buffer.from(job.sig, "base64"));
    } catch {
      valid = false;
    }
    if (!valid) return reject(job, deviceId, "bad signature");
    if (job.target && job.target !== deviceId) return reject(job, deviceId, `target ${job.target} != ${deviceId}`);
    const age = Date.now() - new Date(job.createdAt).getTime();
    if (!(age <= TTL_MS) || age < -60_000) return reject(job, deviceId, `stale/future job (age ${Math.round(age / 1000)}s)`);
    if (!job.nonce) return reject(job, deviceId, "missing nonce (key is pinned)");
    if (loadNonces().has(job.nonce)) return reject(job, deviceId, "replayed nonce");
    consumeNonce(job.nonce);
  } else if (job.target && job.target !== deviceId) {
    // Even unsigned, honour an explicit target so a misrouted shared-queue job is dropped.
    return reject(job, deviceId, `target ${job.target} != ${deviceId}`);
  }

  audit({ decision: "accept", jobId: job.id, type: job.type, signed: !!key, deviceId });
  return { ok: true, job: job as Job };
}

function reject(job: { id: string; type: string }, deviceId: string, reason: string): VerifyResult {
  audit({ decision: "reject", jobId: job.id, type: job.type, reason, deviceId });
  return { ok: false, reason };
}

/* Least-privilege env for the render child: PATH/HOME + only the media/render
   keys. Deliberately EXCLUDES every publish token (IG/YouTube/TikTok/Meta), the
   broker creds, memory keys, and any SSH/deploy path — a render job has no need
   for them, so a compromised render pipeline can't exfiltrate them. */
const RENDER_ENV_ALLOW = new Set([
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "TERM", "SHELL", "NODE_OPTIONS",
  "PEXELS_API_KEY", "ELEVENLABS_API_KEY", "ELEVEN_PROXY", "HF_TOKEN", "HUGGINGFACE_TOKEN", "HF_HOME", "HF_HUB_CACHE",
  "MUSIC_PROVIDER", "MUSIC_API_KEY", "MUSIC_API_MODEL", "MUSICGEN_MODEL", "MUSICGEN_PYTHON", "SOCHELI_EXT_VOLUME",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_MODEL_BEST", "OPENROUTER_MODEL_SMART", "OPENROUTER_MODEL_CHEAP",
  "BRAIN_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_BIN",
  "SOCHELI_IN_AGENT", "SOCHELI_PLAN", "IG_USE_PROXY",
]);
export function minimalRenderEnv(): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const k of RENDER_ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out as NodeJS.ProcessEnv;
}

/* Public auto-post is a LOCAL device decision the cloud can REQUEST but never SET.
   A job's public:true is honoured only when the operator opted in on the device. */
export function localPublicOptIn(): boolean {
  return process.env.SOCHELI_ALLOW_AUTO_PUBLIC === "1" || existsSync(join(SOCHELI_DIR, "auto-public"));
}
