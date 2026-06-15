"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/* Client-side store for the agent job queue / task tree.

   Polls GET /api/agent/jobs (~2s while the Tasks view is open) for the whole
   tree, and — for any RUNNING job — opens an SSE to /api/agent/jobs/[id]/stream
   so live events (tokens, tool calls, spawns, status) land immediately rather
   than waiting on the poll. Exposes enqueue(title,prompt) (POST) and cancel(id)
   (DELETE). Mirrors the job shapes from lib/agent/jobs.ts. */

export type JobKind = "agent" | "team" | "workflow" | "tool" | "subagent";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type JobEventType =
  | "token"
  | "tool_call"
  | "tool_result"
  | "log"
  | "spawn"
  | "status";

export type JobEvent = {
  t: number;
  seq?: number;
  type: JobEventType;
  text?: string;
  id?: string;
  name?: string;
  args?: unknown;
  ok?: boolean;
  result?: unknown;
  childId?: string;
  role?: string;
  status?: JobStatus;
  message?: string;
  [k: string]: unknown;
};

export type Job = {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  parentId?: string;
  rootId: string;
  depth: number;
  prompt?: string;
  input?: unknown;
  model?: string;
  events: JobEvent[];
  result?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
};

type TreesResponse = {
  roots: Job[];
  trees: { root: Job; jobs: Job[] }[];
};

const POLL_MS = 2000;

function isRunning(s: JobStatus): boolean {
  return s === "queued" || s === "running";
}

export function useJobs(active: boolean) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Live events keyed by job id, merged over the polled snapshot so SSE updates
  // appear before the next poll lands.
  const liveEvents = useRef<Map<string, JobEvent[]>>(new Map());
  const liveStatus = useRef<Map<string, JobStatus>>(new Map());
  const sources = useRef<Map<string, EventSource>>(new Map());
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((n) => (n + 1) % 1_000_000), []);

  // Merge polled jobs with any live (SSE) events/status captured since.
  const merge = useCallback((snapshot: Job[]): Job[] => {
    return snapshot.map((j) => {
      const extra = liveEvents.current.get(j.id);
      const ls = liveStatus.current.get(j.id);
      if (!extra && !ls) return j;
      let events = j.events;
      if (extra && extra.length) {
        // Prefer the server-assigned monotonic seq for dedupe (tokens share a
        // millisecond t and have no id, so t:type:id collides and drops tokens).
        const keyOf = (e: JobEvent) =>
          e.seq != null ? `s:${e.seq}` : `${e.t}:${e.type}:${e.id ?? ""}`;
        const seen = new Set(j.events.map(keyOf));
        const fresh = extra.filter((e) => !seen.has(keyOf(e)));
        if (fresh.length) events = [...j.events, ...fresh];
      }
      const status = ls && isRunning(j.status) ? ls : j.status;
      return events === j.events && status === j.status ? j : { ...j, events, status };
    });
  }, []);

  const openStream = useCallback(
    (id: string) => {
      if (sources.current.has(id)) return;
      let es: EventSource;
      try {
        es = new EventSource(`/api/agent/jobs/${id}/stream`);
      } catch {
        return;
      }
      sources.current.set(id, es);
      es.onmessage = (e) => {
        let ev: JobEvent;
        try {
          ev = JSON.parse(e.data) as JobEvent;
        } catch {
          return;
        }
        const arr = liveEvents.current.get(id) ?? [];
        arr.push(ev);
        // Bound per-job live buffer.
        if (arr.length > 600) arr.splice(0, arr.length - 600);
        liveEvents.current.set(id, arr);
        if (ev.type === "status" && ev.status) {
          liveStatus.current.set(id, ev.status);
          if (ev.status !== "queued" && ev.status !== "running") {
            es.close();
            sources.current.delete(id);
          }
        }
        bump();
      };
      es.onerror = () => {
        es.close();
        sources.current.delete(id);
      };
    },
    [bump],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/jobs", { cache: "no-store" });
      if (!res.ok) {
        setError(`Failed to load jobs (${res.status})`);
        return;
      }
      const data = (await res.json()) as TreesResponse;
      const all: Job[] = [];
      for (const t of data.trees) all.push(...t.jobs);
      setError(null);
      setJobs(all);
      // Open SSE for any running job; close streams for jobs that finished.
      const runningIds = new Set(all.filter((j) => isRunning(j.status)).map((j) => j.id));
      for (const id of runningIds) openStream(id);
      for (const [id, es] of sources.current) {
        if (!runningIds.has(id)) {
          es.close();
          sources.current.delete(id);
        }
      }
      // Prune live buffers so they don't grow unbounded over a long session:
      // drop ids no longer in the snapshot, and drop live buffers for jobs the
      // snapshot already reports terminal (their persisted events are authoritative).
      const present = new Set(all.map((j) => j.id));
      for (const id of [...liveEvents.current.keys()]) {
        if (!present.has(id) || !runningIds.has(id)) {
          liveEvents.current.delete(id);
          liveStatus.current.delete(id);
        }
      }
      for (const id of [...liveStatus.current.keys()]) {
        if (!present.has(id) || !runningIds.has(id)) {
          liveStatus.current.delete(id);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [openStream]);

  // Poll while the Tasks view is active.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void refresh();
    const t = setInterval(() => {
      if (alive) void refresh();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active, refresh]);

  // Tear down all streams on unmount.
  useEffect(() => {
    const srcs = sources.current;
    return () => {
      for (const es of srcs.values()) es.close();
      srcs.clear();
    };
  }, []);

  const enqueue = useCallback(
    async (title: string, prompt: string, kind: JobKind = "agent") => {
      const p = prompt.trim();
      if (!p) return;
      try {
        await fetch("/api/agent/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim() || p.slice(0, 80), prompt: p, kind }),
        });
      } catch {
        /* surfaced via the next poll / error state */
      }
      void refresh();
    },
    [refresh],
  );

  const cancel = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/agent/jobs/${id}`, { method: "DELETE" });
      } catch {
        /* non-fatal */
      }
      void refresh();
    },
    [refresh],
  );

  const merged = merge(jobs);
  const runningCount = merged.filter((j) => isRunning(j.status)).length;

  return { jobs: merged, error, runningCount, enqueue, cancel, refresh } as const;
}
