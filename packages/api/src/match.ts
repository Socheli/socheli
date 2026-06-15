import type { Device } from "@socheli/sdk";

/* Central scheduler — capability-aware job→device matching. Derives a job's
   capability requirements, then picks the best-fit device from the live fleet.
   Cap vocabulary mirrors packages/engine/src/fleet.ts (keep in sync). */

export type Requirements = { hard: string[]; prefer: string[] };

export function jobRequirements(job: { type?: string; voice?: boolean }): Requirements {
  if (job.type === "ping") return { hard: [], prefer: [] };
  // Any generation job needs a render-capable device. Music/b-roll/premium voice
  // are quality preferences — a minimal device still renders (degrades gracefully).
  const prefer = ["music:musicgen", "broll:sdturbo", "broll:pexels"];
  if (job.voice) prefer.unshift("voice:eleven");
  return { hard: ["render"], prefer };
}

export type Match = { device?: Device; reason: string; matched: string[] };

export function pickDevice(devices: Device[], reqs: Requirements): Match {
  const online = devices.filter((d) => d.status !== "offline");
  const capable = online.filter((d) => reqs.hard.every((c) => (d.caps ?? []).includes(c)));
  if (!capable.length) {
    return { reason: reqs.hard.length ? `no online device with required cap(s): ${reqs.hard.join(", ")}` : "no online device", matched: [] };
  }
  const score = (d: Device) => {
    let s = d.status === "idle" ? 100 : 0; // strongly prefer an idle device
    for (const c of reqs.prefer) if ((d.caps ?? []).includes(c)) s += 10;
    s += (d.profile?.ramGb ?? 0) / 8; // tie-break: more RAM
    return s;
  };
  const best = capable.slice().sort((a, b) => score(b) - score(a))[0];
  const matched = [...reqs.hard, ...reqs.prefer].filter((c) => (best.caps ?? []).includes(c));
  return { device: best, reason: `${best.status} · ${matched.length}/${reqs.hard.length + reqs.prefer.length} caps`, matched };
}
