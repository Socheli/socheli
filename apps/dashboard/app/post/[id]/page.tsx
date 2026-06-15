import Link from "next/link";
import { Layers, Image } from "lucide-react";
import { ownsRecord } from "@os/schemas";
import { getItemFor } from "../../../lib/data";
import { currentContext, ctxCan } from "../../../lib/tenancy";
import { StatusBadge, QABars, fmtCost } from "../../ui";
import { CaptionsPanel } from "./CaptionsPanel";
import { PreviewVideo } from "./PreviewVideo";
import { PublishPanel } from "./PublishPanel";
import { RunLog } from "./RunLog";

export const dynamic = "force-dynamic";

export default async function PreviewRoom({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  const it = getItemFor(id, ctx.workspaceId);
  // No rendered run for this id. Instead of a dead 404 (which any stale or
  // planned-post deep-link could hit), show a friendly recovery page that points
  // back to where the post actually lives.
  if (!it) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">// preview room</div>
          <h1 className="h1">Post not found</h1>
        </div>
        <div className="card empty" style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start", maxWidth: 580 }}>
          <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            There’s no rendered post for <code style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{id}</code>.
            It may be a <strong>planned post</strong> that hasn’t been generated yet, or it was removed.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Link href="/calendar" className="btn"><span className="ico">CA</span>Open calendar</Link>
            <Link href="/library" className="btn"><span className="ico">LI</span>Library</Link>
            <Link href="/queue" className="btn btn-primary"><span className="ico">QU</span>Queue</Link>
          </div>
        </div>
      </>
    );
  }
  const dur = it.storyboard?.scenes.reduce((a, s) => a + s.durationSec, 0) ?? 0;
  // The Edit button only shows when the caller may edit this post: any-editor, or
  // own-editor when they authored it.
  const canEdit = ctxCan(ctx, "content.edit.any") || ctxCan(ctx, "content.edit.own", { isOwnerOfRecord: ownsRecord(it, ctx) });

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">// preview room / {it.channel.replace(/_/g, " ")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <h1 className="h1">{it.pkg?.title ?? it.idea?.topic ?? it.seedIdea}</h1>
          <StatusBadge status={it.status} />
          {canEdit && <Link href={`/post/${it.id}/edit`} className="btn btn-primary" style={{ marginLeft: "auto" }}><span className="ico">ED</span>Edit</Link>}
        </div>
      </div>

      <div className="grid cols-2 post-grid" style={{ alignItems: "start" }}>
        {/* video / static / carousel */}
        <div className="post-aside">
          {it.kind === "static_image" && it.staticImagePath ? (
            /* Static image viewer */
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div className="post-static-head">
                <Image size={13} strokeWidth={1.8} />
                <span>Static Post</span>
              </div>
              <img
                src={`/api/media?path=${encodeURIComponent(it.staticImagePath)}`}
                alt={it.pkg?.title ?? "Static image"}
                className="post-static-img"
              />
            </div>
          ) : it.kind === "carousel" && it.carouselSlides && it.carouselSlides.length > 0 ? (
            /* Carousel viewer */
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div className="post-static-head">
                <Layers size={13} strokeWidth={1.8} />
                <span>Carousel</span>
                <span className="post-slide-count">{it.carouselSlides.length} slides</span>
              </div>
              <div className="post-carousel-strip">
                {it.carouselSlides.map((slide, i) => (
                  <a
                    key={i}
                    href={`/api/media?path=${encodeURIComponent(slide)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="post-carousel-thumb"
                    title={`Slide ${i + 1}`}
                  >
                    <img
                      src={`/api/media?path=${encodeURIComponent(slide)}`}
                      alt={`Slide ${i + 1}`}
                      loading="lazy"
                    />
                    <span className="post-carousel-n">{i + 1}</span>
                  </a>
                ))}
              </div>
            </div>
          ) : it.videoPath ? (
            <>
              <div className="video-frame">
                <PreviewVideo id={it.id} aspect={it.kind === "longform" ? 16 / 9 : 9 / 16} />
              </div>
              <a
                href={`/api/thumb/${it.id}`}
                download={`${it.id}_thumbnail.jpg`}
                className="btn"
                style={{ marginTop: 12, width: "100%", display: "inline-flex", justifyContent: "center", gap: 8 }}
              >
                <span className="ico">DL</span>Download thumbnail
              </a>
            </>
          ) : (
            <div className="card empty">No render yet - stopped at {it.status}.</div>
          )}
          <div className="card" style={{ marginTop: 16 }}>
            <div className="stat-label">Cost ledger</div>
            <div style={{ marginTop: 12 }}>
              {it.ledger.entries.map((e, i) => (
                <div className="kv" key={i}>
                  <span className="kv-k">{e.stage}</span>
                  <span className="kv-v">{fmtCost(e.usd)}</span>
                </div>
              ))}
              <div className="kv" style={{ marginTop: 4 }}>
                <span className="kv-k" style={{ color: "var(--accent)" }}>total</span>
                <span className="kv-v" style={{ color: "var(--accent)", fontWeight: 600 }}>{fmtCost(it.ledger.totalUsd)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* meta */}
        <div className="grid" style={{ gap: 20 }}>
          {it.qa && (
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                <h2 className="h2" style={{ margin: 0 }}>QA Council</h2>
                <span style={{ fontSize: 26, fontWeight: 700, color: "var(--accent)", letterSpacing: "-0.03em" }}>
                  {it.qa.overall.toFixed(1)}<span style={{ fontSize: 13, color: "var(--text-muted)" }}>/10</span>
                </span>
              </div>
              <QABars scores={it.qa.scores} />
              {it.qa.notes.length > 0 && (
                <ul className="notes" style={{ marginTop: 16, paddingLeft: 18 }}>
                  {it.qa.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </div>
          )}

          {it.storyboard && (
            <div className="card">
              <h2 className="h2">Storyboard / {dur}s</h2>
              <div className="flow">
                {it.storyboard.scenes.map((s, i) => (
                  <span className="scene-chip" key={s.id}>
                    <span className="n">{i + 1}</span>{s.type}<span style={{ color: "var(--text-muted)" }}>{s.durationSec}s</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {it.videoPath && <PublishPanel id={it.id} publish={it.publish} />}

          {it.videoPath && <CaptionsPanel id={it.id} pkg={it.pkg} />}

          {it.script && (
            <div className="card">
              <h2 className="h2">Script</h2>
              <div className="kv"><span className="kv-k">hook</span><span className="kv-v">{it.script.hook}</span></div>
              <div style={{ marginTop: 12 }}>
                {it.script.narration.map((n, i) => <div className="log-line" key={i} style={{ color: "var(--text-secondary)" }}>"{n}"</div>)}
              </div>
            </div>
          )}

          <RunLog id={it.id} initial={it} />
        </div>
      </div>

      <div style={{ marginTop: 32 }}><Link href="/queue" className="btn"><span className="ico">BK</span>Back to queue</Link></div>
    </>
  );
}
