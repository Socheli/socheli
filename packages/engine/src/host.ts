import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { httpCurl } from "./http.ts";

/* Public-URL uploader. Both Instagram (Graph API `video_url`) and TikTok
   (Content Posting `PULL_FROM_URL`) ingest a publicly-reachable https video,
   never a local file — so a live IG/TikTok post REQUIRES a public host. Backends,
   picked by which env is configured (first match wins):

   0. Local public dir (our deploy) — when publishing runs ON the Socheli server,
      the rendered mp4 already lives in a directory Caddy serves publicly. Set
      HOST_LOCAL_DIR (the Caddy-served dir, e.g. /opt/socheli/data/renders) +
      HOST_PUBLIC_BASE (e.g. https://media.socheli.com). The file is copied into
      that dir if not already there, and its public URL is returned — no upload.
   1. S3-compatible (AWS S3 / Cloudflare R2 / Bunny / MinIO) via the `aws` CLI:
      HOST_S3_BUCKET, HOST_S3_PUBLIC_BASE, optional HOST_S3_ENDPOINT + AWS_*.
   2. Generic signed PUT — HOST_UPLOAD_URL + HOST_PUBLIC_BASE.

   Returns null when nothing is configured → callers degrade to needs-auth. */

export type HostUpload = { url: string };
export interface HostUploader {
  kind: "local" | "s3" | "put";
  uploadPublic(localPath: string, key: string): Promise<HostUpload>;
}

function localUploader(): HostUploader | null {
  const dir = process.env.HOST_LOCAL_DIR;
  const publicBase = process.env.HOST_PUBLIC_BASE;
  if (!dir || !publicBase) return null;
  return {
    kind: "local",
    async uploadPublic(localPath, key) {
      if (!existsSync(localPath)) throw new Error(`host: missing file ${localPath}`);
      mkdirSync(dir, { recursive: true });
      // public file name: the key's basename (e.g. "<id>_vertical.mp4"), sanitized
      const name = basename(key).replace(/[^A-Za-z0-9._-]/g, "_");
      const dest = join(dir, name);
      // copy in unless the render already lives in the served dir
      if (resolve(localPath) !== resolve(dest)) copyFileSync(localPath, dest);
      return { url: `${publicBase.replace(/\/$/, "")}/${name}` };
    },
  };
}

function s3Uploader(): HostUploader | null {
  const bucket = process.env.HOST_S3_BUCKET;
  const publicBase = process.env.HOST_S3_PUBLIC_BASE;
  if (!bucket || !publicBase) return null;
  const endpoint = process.env.HOST_S3_ENDPOINT; // R2/Bunny/MinIO; omit for AWS
  const region = process.env.HOST_S3_REGION || process.env.AWS_REGION;
  return {
    kind: "s3",
    async uploadPublic(localPath, key) {
      if (!existsSync(localPath)) throw new Error(`host: missing file ${localPath}`);
      const args = ["s3", "cp", localPath, `s3://${bucket}/${key}`, "--content-type", "video/mp4"];
      if (endpoint) args.push("--endpoint-url", endpoint);
      if (region) args.push("--region", region);
      const r = spawnSync("aws", args, { encoding: "utf8", timeout: 1000 * 60 * 10 });
      if (r.status !== 0) throw new Error(`host: aws s3 cp failed — ${(r.stderr || r.stdout || "").slice(0, 300)}`);
      return { url: `${publicBase.replace(/\/$/, "")}/${key}` };
    },
  };
}

function putUploader(): HostUploader | null {
  const uploadUrl = process.env.HOST_UPLOAD_URL;
  const publicBase = process.env.HOST_PUBLIC_BASE;
  if (!uploadUrl || !publicBase) return null;
  return {
    kind: "put",
    async uploadPublic(localPath, key) {
      if (!existsSync(localPath)) throw new Error(`host: missing file ${localPath}`);
      const dest = `${uploadUrl.replace(/\/$/, "")}/${key}`;
      const r = httpCurl(["-X", "PUT", dest, "-H", "Content-Type: video/mp4", "--data-binary", `@${localPath}`, "-o", "/dev/null", "-w", "%{http_code}"]);
      const code = Number((r.stdout || "").trim());
      if (!(code >= 200 && code < 300)) throw new Error(`host: PUT ${dest} → ${code}`);
      return { url: `${publicBase.replace(/\/$/, "")}/${key}` };
    },
  };
}

export function hostUploader(): HostUploader | null {
  return localUploader() ?? s3Uploader() ?? putUploader();
}

export const hostConfigured = (): boolean => hostUploader() !== null;
