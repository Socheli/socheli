"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Upload, Loader2, FileVideo, Scissors } from "lucide-react";
import { VideoPlayer } from "../VideoPlayer";
import { UnderstandingPanel } from "./UnderstandingPanel";
import { EditChat } from "./EditChat";
import type { IngestedSummary, StudioDetail, Understanding, EditPlan, StartedJob } from "./types";

/* Editor Studio — the chat-first client surface (Pillar 5).

   Flow it orchestrates:
     IMPORT   — drop/pick a file → POST /api/ingest (multipart). A transcode
                detaches; we poll the new run's detail until a video exists.
     SELECT   — pick an ingested run from the rail → GET /api/studio/[id] loads
                its understanding + timeline + video status.
     UNDERSTAND — if not built, "Understand" → POST /api/studio/[id]/understand
                (its own route; understanding is the grounding the chat edits
                against, not an edit op). It's a long detached worker; we poll the
                detail GET until understanding.built flips true.
     CHAT     — type an edit → POST /api/studio/[id]/edit. Guided returns an
                EditPlan (approval card); Approve → action:"apply" (+render) → a
                render job we poll; Autonomous → action:"oneshot".
     PREVIEW  — VideoPlayer pointed at /api/video/[id] (range-served, workspace
                scoped). Re-keyed after a render so the new cut loads.

   Long jobs (transcode, understand, render) all follow the detached-spawn
   contract; we poll GET /api/studio/[id] on an interval while one is in flight,
   stopping when the relevant artifact appears. */

type Job = { kind: "ingest" | "understand" | "render"; note: string };

export function Studio({
  initial,
  canEdit,
  canView,
}: {
  initial: IngestedSummary[];
  canEdit: boolean;
  canView: boolean;
}) {
  const [items, setItems] = useState<IngestedSummary[]>(initial);
  const [selId, setSelId] = useState<string | null>(initial[0]?.id ?? null);
  const [detail, setDetail] = useState<StudioDetail | null>(null);

  const [importing, setImporting] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false); // a chat/apply request is in flight
  const [job, setJob] = useState<Job | null>(null); // a long detached job we're polling
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [videoKey, setVideoKey] = useState(0); // bump to remount the player on a new render

  const fileRef = useRef<HTMLInputElement>(null);

  /* ── detail load ─────────────────────────────────────────────────────────── */
  const loadDetail = useCallback(async (id: string): Promise<StudioDetail | null> => {
    try {
      const res = await fetch(`/api/studio/${id}`, { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as StudioDetail;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!selId) { setDetail(null); return; }
    let alive = true;
    setPlan(null);
    setErr(null);
    setOkMsg(null);
    loadDetail(selId).then((d) => { if (alive) setDetail(d); });
    return () => { alive = false; };
  }, [selId, loadDetail]);

  /* refresh the rail (after an import) — re-reads the page's own list endpoint
     by reloading detail isn't enough; we re-fetch via a light list call. */
  const refreshList = useCallback(async () => {
    try {
      const res = await fetch("/api/studio", { cache: "no-store" });
      if (res.ok) setItems((await res.json()) as IngestedSummary[]);
    } catch { /* keep the current rail */ }
  }, []);

  /* ── job polling: while a transcode/understand/render runs, poll detail ────── */
  useEffect(() => {
    if (!job || !selId) return;
    let alive = true;
    const tick = async () => {
      const d = await loadDetail(selId);
      if (!alive || !d) return;
      setDetail(d);
      const built = d.understanding && (d.understanding as { built?: boolean }).built === true;
      if (job.kind === "understand" && built) { setJob(null); setOkMsg("Understanding complete."); }
      else if ((job.kind === "render" || job.kind === "ingest") && d.hasVideo) {
        setJob(null);
        setVideoKey((k) => k + 1);
        if (job.kind === "render") setOkMsg("Render complete — preview updated.");
        if (job.kind === "ingest") refreshList();
      }
    };
    const iv = setInterval(tick, 3500);
    void tick();
    return () => { alive = false; clearInterval(iv); };
  }, [job, selId, loadDetail, refreshList]);

  /* ── import ──────────────────────────────────────────────────────────────── */
  const doImport = useCallback(async (file: File) => {
    setImporting(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await refreshList();
      const newId = String(j.id ?? "");
      if (newId) {
        setSelId(newId);
        // A transcode detaches (job) — poll until the playable file lands.
        if (j.job?.status === "started") setJob({ kind: "ingest", note: "Importing & normalizing…" });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "import failed");
    } finally {
      setImporting(false);
    }
  }, [refreshList]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void doImport(f);
  };

  /* ── understand ──────────────────────────────────────────────────────────── */
  const onUnderstand = useCallback(async () => {
    if (!selId) return;
    setErr(null);
    try {
      const res = await fetch(`/api/studio/${selId}/understand`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setJob({ kind: "understand", note: "Understanding…" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "understand failed");
    }
  }, [selId]);

  /* ── chat: route (guided) or oneshot (autonomous) ────────────────────────── */
  const onSubmit = useCallback(async (request: string, mode: "guided" | "autonomous") => {
    if (!selId) return;
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    setPlan(null);
    try {
      const res = await fetch(`/api/studio/${selId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, mode, render: mode === "autonomous" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);

      if (mode === "guided") {
        // route → the EditPlan is spread at the top level of the response.
        setPlan(j as EditPlan);
      } else {
        // oneshot — applied immediately; a render detached as a job (poll it).
        applyResult(j.job as StartedJob, "Applied.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "edit failed");
    } finally {
      setBusy(false);
    }
  }, [selId]);

  /* ── approve a proposed plan → apply (+ render) ──────────────────────────── */
  const onApprove = useCallback(async (p: EditPlan, render: boolean) => {
    if (!selId) return;
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    try {
      const res = await fetch(`/api/studio/${selId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", planId: p.id, render }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setPlan(null);
      applyResult(j.job as StartedJob, render ? "Applied — rendering…" : "Applied.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "apply failed");
    } finally {
      setBusy(false);
    }
  }, [selId]);

  /* Shared tail for apply/oneshot: if a render detached, poll it; else refresh
     the preview right away (inline apply already changed the run). */
  const applyResult = (j: StartedJob, doneMsg: string) => {
    if (j && j.status === "started") {
      setJob({ kind: "render", note: "Rendering the new cut…" });
    } else {
      setOkMsg(doneMsg);
      setVideoKey((k) => k + 1);
      if (selId) loadDetail(selId).then((d) => d && setDetail(d));
    }
  };

  const onReject = () => { setPlan(null); setOkMsg("Plan discarded."); };

  /* ── derived view bits ───────────────────────────────────────────────────── */
  const built = !!detail && (detail.understanding as { built?: boolean }).built === true;
  const understanding: Understanding | null =
    built ? ((detail!.understanding as { understanding: Understanding }).understanding) : null;
  const summary = built ? (detail!.understanding as { summary?: string }).summary : undefined;
  const transcoding = !!job && job.kind === "ingest";
  const fps = understanding?.fps ?? detail?.timeline?.fps ?? 30;

  return (
    <div className="studio">
      {/* ── imports rail ── */}
      <div className="st-rail">
        <div className="st-rail-head">
          <span className="st-rail-title">Imports</span>
        </div>

        <div
          className={`st-drop${over ? " over" : ""}${importing ? " busy" : ""}`}
          onClick={() => canEdit && fileRef.current?.click()}
          onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          role="button"
          aria-disabled={!canEdit}
        >
          {importing ? (
            <Loader2 size={18} className="st-drop-ico" style={{ animation: "st-spin .8s linear infinite" }} />
          ) : (
            <Upload size={18} className="st-drop-ico" />
          )}
          <span className="st-drop-main">{importing ? "Importing…" : "Import a video"}</span>
          <span className="st-drop-sub">{canEdit ? "drop a file or click" : "view only"}</span>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ""; }}
          />
        </div>

        <div className="st-list">
          {items.length === 0 ? (
            <div className="sub" style={{ fontSize: 12, padding: "8px 2px" }}>No imports yet.</div>
          ) : (
            items.map((it) => (
              <button
                key={it.id}
                className={`st-item${it.id === selId ? " sel" : ""}`}
                onClick={() => setSelId(it.id)}
              >
                <span className="st-item-name"><FileVideo size={12} style={{ marginRight: 6, verticalAlign: "-1px", opacity: 0.6 }} />{it.name}</span>
                <span className="st-item-meta">
                  <span className={`st-flag${it.hasUnderstanding ? " on" : ""}`}>analyzed</span>
                  <span className={`st-flag${it.verified ? " on" : ""}`}>render</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── workspace ── */}
      <div className="st-work">
        {!selId ? (
          <div className="empty">Import a video to start editing by chat.</div>
        ) : (
          <>
            {err && <div className="st-err">{err}</div>}
            {okMsg && !job && <div className="st-ok">{okMsg}</div>}
            {job && (
              <div className="st-job">
                <span className="spin" />
                {job.note}
              </div>
            )}

            <div className="st-cols">
              {/* preview */}
              <div>
                <div className="st-section-head">
                  <span className="st-section-title">Preview</span>
                  <span className="grow" style={{ flex: 1 }} />
                  {/* deep-link into the frame-precision editor for this run */}
                  <Link href={`/editor/${selId}`} className="btn" style={{ padding: "5px 11px", fontSize: 11.5 }} title="Open the frame-accurate editor">
                    <Scissors size={13} /> Frame editor
                  </Link>
                </div>
                <div className="st-preview">
                  {detail?.hasVideo ? (
                    <VideoPlayer key={videoKey} src={`/api/video/${selId}?v=${videoKey}`} fps={fps} />
                  ) : (
                    <div className="st-preview-empty">
                      {transcoding ? "Normalizing the import…" : "No playable render yet."}
                    </div>
                  )}
                </div>
              </div>

              {/* content analysis */}
              <UnderstandingPanel
                understanding={understanding}
                built={built}
                summary={summary}
                building={!!job && job.kind === "understand"}
                canEdit={canEdit}
                onUnderstand={onUnderstand}
              />
            </div>

            {/* chat — the primary action surface */}
            <EditChat
              plan={plan}
              busy={busy || !!job}
              canEdit={canEdit && !!detail}
              onSubmit={onSubmit}
              onApprove={onApprove}
              onReject={onReject}
            />

            {!canView && <div className="sub" style={{ fontSize: 12 }}>You don&apos;t have access to view this run&apos;s analysis.</div>}
          </>
        )}
      </div>
    </div>
  );
}
