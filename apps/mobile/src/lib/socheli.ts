/* Socheli SDK — vendored for the mobile app (React Native friendly: uses global
   fetch, builds query strings manually to avoid URLSearchParams polyfill issues).
   Mirrors @socheli/sdk. */

export type ItemStatus =
  | "idea_proposed" | "script_ready" | "storyboard_ready" | "qa_passed" | "qa_failed" | "rendered" | "packaged" | "failed";

export interface PublishEntry { platform: string; status: string; url?: string; id?: string; at: string }

export interface ItemSummary {
  id: string; channel: string; status: ItemStatus | string; title: string;
  createdAt: string; updatedAt: string; qa?: number; costUsd?: number; publish?: PublishEntry[];
}
export interface Item extends ItemSummary {
  idea?: { topic: string; angle: string; format: string };
  script?: { hook: string; narration: string[]; cta: string };
  storyboard?: { topic: string; format: string; scenes: { id: string; type: string; durationSec: number }[] };
  pkg?: { title: string; caption: string; hashtags: string[]; altText?: string };
  videoUrl?: string;
  warnings?: { at: string; stage: string; code: string; message: string; detail?: string }[];
}

export type JobType = "auto" | "new" | "ping";
export interface Job { id: string; type: JobType; channel?: string; seed?: string; by?: string; createdAt: string }
export interface JobRow extends Job {
  status: "dispatched" | "running" | "done" | "error";
  device?: string; itemId?: string; message?: string; progress: { at: string; line: string }[]; updatedAt: string;
}

export type DeviceStatus = "online" | "idle" | "busy" | "offline";
export interface DeviceProfile { arch: string; platform: string; cpus: number; ramGb: number; gpu: string }
export interface Device {
  device: string; status: DeviceStatus; host?: string; caps?: string[]; profile?: DeviceProfile;
  currentJob?: string | null; lastSeen: string;
}
export interface FleetState { devices: Device[]; jobs: JobRow[]; online: number }

export interface GenerateInput { seed: string; channel?: string; mood?: string; voice?: boolean; type?: "auto" | "new" }
export interface PublishInput { public?: boolean; aigc?: boolean }

export class SocheliError extends Error {
  status: number; body?: unknown;
  constructor(message: string, status: number, body?: unknown) { super(message); this.name = "SocheliError"; this.status = status; this.body = body; }
}

export interface SocheliClient {
  health(): Promise<{ ok: boolean; version: string; uptime: number }>;
  items: {
    list(params?: { limit?: number; channel?: string }): Promise<ItemSummary[]>;
    get(id: string): Promise<Item>;
    publish(id: string, input?: PublishInput): Promise<{ dispatched: boolean }>;
  };
  generate(input: GenerateInput): Promise<{ dispatched: boolean; job: Job; device?: string; routing?: string }>;
  jobs(): Promise<JobRow[]>;
  fleet(): Promise<FleetState>;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

export function createSocheli(opts: { apiKey?: string; baseUrl?: string }): SocheliClient {
  const baseUrl = (opts.baseUrl ?? "https://api.socheli.com").replace(/\/$/, "");
  const apiKey = opts.apiKey;

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!res.ok) throw new SocheliError((data as any)?.error ?? `${method} ${path} → ${res.status}`, res.status, data);
    return data as T;
  }

  return {
    health: () => req("GET", "/health"),
    items: {
      list: (p = {}) => req("GET", `/items${qs({ limit: p.limit, channel: p.channel })}`),
      get: (id) => req("GET", `/items/${encodeURIComponent(id)}`),
      publish: (id, input = {}) => req("POST", `/items/${encodeURIComponent(id)}/publish`, input),
    },
    generate: (input) => req("POST", "/generate", input),
    jobs: () => req("GET", "/jobs"),
    fleet: () => req("GET", "/fleet"),
  };
}
