/* Public API DTOs — the stable, lean shapes the Socheli API returns. These are
   intentionally decoupled from the engine's internal zod schemas so the public
   contract can stay stable while internals evolve. */

export type ItemStatus =
  | "idea_proposed"
  | "script_ready"
  | "storyboard_ready"
  | "qa_passed"
  | "qa_failed"
  | "rendered"
  | "packaged"
  | "failed";

export interface ItemSummary {
  id: string;
  channel: string;
  status: ItemStatus | string;
  title: string;
  createdAt: string;
  updatedAt: string;
  qa?: number;
  costUsd?: number;
  publish?: PublishEntry[];
}

export interface Item extends ItemSummary {
  idea?: { topic: string; angle: string; format: string };
  script?: { hook: string; narration: string[]; cta: string };
  storyboard?: { topic: string; format: string; scenes: { id: string; type: string; durationSec: number }[] };
  pkg?: { title: string; caption: string; hashtags: string[]; altText?: string };
  videoUrl?: string;
  // Non-fatal render degradations (caption/voice/music fallbacks).
  warnings?: { at: string; stage: string; code: string; message: string; detail?: string }[];
}

export interface PublishEntry {
  platform: string;
  status: string;
  url?: string;
  id?: string;
  at: string;
}

export type JobType = "auto" | "new" | "ping";
export interface Job {
  id: string;
  type: JobType;
  channel?: string;
  seed?: string;
  by?: string;
  createdAt: string;
}
export interface JobRow extends Job {
  status: "dispatched" | "running" | "done" | "error";
  device?: string;
  itemId?: string;
  message?: string;
  progress: { at: string; line: string }[];
  updatedAt: string;
}

export type DeviceStatus = "online" | "idle" | "busy" | "offline";
export interface DeviceProfile {
  arch: string;
  platform: string;
  cpus: number;
  ramGb: number;
  gpu: string;
}
export interface Device {
  device: string;
  status: DeviceStatus;
  host?: string;
  caps?: string[];
  profile?: DeviceProfile;
  currentJob?: string | null;
  lastSeen: string;
}

export interface GenerateInput {
  seed: string;
  channel?: string;
  mood?: string;
  voice?: boolean;
  /** Output shape — a named preset. Default 9:16 (vertical). A custom width+height overrides this. */
  aspect?: "9:16" | "1:1" | "16:9";
  /** Custom canvas width in px (requires height; overrides aspect). */
  width?: number;
  /** Custom canvas height in px (requires width; overrides aspect). */
  height?: number;
  /** "auto" also publishes after render; "new" builds only. Default "new". */
  type?: "auto" | "new";
}

export interface PublishInput {
  public?: boolean;
  /** Declare AI-generated content (defaults true). */
  aigc?: boolean;
}

export interface Schedule {
  enabled: boolean;
  timezone: string;
  graceMinutes: number;
  channels: { channel: string; enabled: boolean; slots: { time: string; channel: string; mood?: string; seed?: string; public: boolean }[] }[];
}

export interface FleetState {
  devices: Device[];
  jobs: JobRow[];
  online: number;
}

/* ── Tenancy ──────────────────────────────────────────────────────────────── */
export type Role = "owner" | "admin" | "member" | "viewer";

/** Who the current API key acts as (GET /v1/me). */
export interface Me {
  workspaceId: string;
  role: Role;
  userId: string | null;
  via: "session" | "apikey" | "system";
}

/** A workspace API key as returned by the API — never includes the secret. */
export interface ApiKey {
  id: string;
  prefix: string;
  workspaceId: string;
  createdBy: string | null;
  role: Role;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}
