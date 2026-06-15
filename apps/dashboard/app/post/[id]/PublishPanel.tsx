"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Entry = { platform: string; id?: string; url?: string; at: string; status: string };

const META: Record<string, { label: string; color: string }> = {
  youtube: { label: "YouTube", color: "#ff4e45" },
  instagram: { label: "Instagram", color: "#e1306c" },
  tiktok: { label: "TikTok", color: "#25f4ee" },
};

/* P3/P6: platforms we expose a per-platform composer for, in display order. */
const COMPOSER_PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
type Platform = (typeof COMPOSER_PLATFORMS)[number];

type Aspect = "9:16" | "1:1" | "16:9";

/* Non-destructive overrides stored under pkg.overrides[platform]. */
type Override = {
  caption?: string;
  title?: string;
  hashtags?: string[];
  aspect?: Aspect;
  firstCommentHashtags?: boolean;
};

type PlatformVariant = { platform: string; title?: string; caption: string; hashtags: string[]; keywords?: string[] };
type Pkg = {
  title?: string;
  caption?: string;
  hashtags?: string[];
  platforms?: PlatformVariant[];
  overrides?: Record<string, Override>;
};
type ItemLite = {
  pkg?: Pkg;
  derivatives?: { square?: string; wide?: string };
  videoPath?: string;
  idea?: { topic?: string };
  publish?: Entry[];
};

const STATUS_CLASS = (s: string) =>
  s === "published" ? "b-ok" : s === "error" || s === "needs-auth" ? "b-err" : "b-neutral";

const TIKTOK_AUDITED = process.env.NEXT_PUBLIC_TIKTOK_AUDITED === "1";
const TIKTOK_SANDBOX = process.env.NEXT_PUBLIC_TIKTOK_SANDBOX === "1" || !TIKTOK_AUDITED;
const TIKTOK_RATE_LIMIT = process.env.NEXT_PUBLIC_TIKTOK_RATE_LIMIT || "";

/* The generated/base values for a platform — what an override falls back to. */
function baseFor(item: ItemLite | null, platform: Platform) {
  const pkg = item?.pkg;
  const v = pkg?.platforms?.find((x) => x.platform === platform);
  return {
    title: v?.title ?? pkg?.title ?? item?.idea?.topic ?? "",
    caption: v?.caption ?? pkg?.caption ?? "",
    hashtags: v?.hashtags ?? pkg?.hashtags ?? [],
  };
}

const tagsToText = (t: string[]) => t.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
const textToTags = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((h) => h.replace(/^#+/, "").trim())
    .filter(Boolean);

export function PublishPanel({ id, publish }: { id: string; publish?: Entry[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"" | "private" | "public">("");
  const [aigc, setAigc] = useState(true);
  const [pubError, setPubError] = useState<string | null>(null);
  // Live publish entries — seeded from the server prop, then refreshed by polling
  // /api/item/{id} after a publish so platforms flip pending→published/error
  // without a full-page reload.
  const [liveEntries, setLiveEntries] = useState<Entry[]>(publish ?? []);
  const [polling, setPolling] = useState(false);
  const entries = liveEntries;

  // P3/P6/G6 — packaging editor state, hydrated from the stored item.
  const [item, setItem] = useState<ItemLite | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [active, setActive] = useState<Platform>("youtube");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);

  // keep live entries in sync if the server-provided prop updates (router.refresh)
  useEffect(() => {
    if (publish) setLiveEntries(publish);
  }, [publish]);

  useEffect(() => {
    let on = true;
    fetch(`/api/item/${id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((it: ItemLite | null) => {
        if (!on || !it) return;
        setItem(it);
        setOverrides(it.pkg?.overrides ?? {});
        if (Array.isArray(it.publish)) setLiveEntries(it.publish);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [id]);

  // After a publish is triggered, poll the item so platform statuses update
  // live (pending → published/error). Stops once nothing is pending or after a
  // generous cap so we never poll forever.
  useEffect(() => {
    if (!polling) return;
    let on = true;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const r = await fetch(`/api/item/${id}`, { cache: "no-store" });
        if (r.ok) {
          const it = (await r.json()) as ItemLite | null;
          if (on && it && Array.isArray(it.publish)) setLiveEntries(it.publish);
          const pending = it?.publish?.some((e) => e.status === "pending" || e.status === "uploading" || e.status === "queued");
          if (on && (!pending || tries >= 120)) {
            setPolling(false);
          }
        }
      } catch {
        /* transient — keep polling until the cap */
      }
      if (tries >= 120) setPolling(false);
    }, 1500);
    return () => {
      on = false;
      clearInterval(timer);
    };
  }, [polling, id]);

  const derivs = item?.derivatives ?? {};
  const aspects: Aspect[] = ["9:16", ...(derivs.square ? ["1:1" as Aspect] : []), ...(derivs.wide ? ["16:9" as Aspect] : [])];

  const cur = overrides[active] ?? {};
  const base = baseFor(item, active);
  // suggestions come from the generated per-platform variants already on the
  // item (G6) — one-click apply into the override fields, no extra round-trip.
  const variant = item?.pkg?.platforms?.find((x) => x.platform === active);

  const patch = (p: Platform, next: Partial<Override>) =>
    setOverrides((o) => {
      const merged: Override = { ...(o[p] ?? {}), ...next };
      // drop empty keys so an unset field cleanly falls back to the base value
      (Object.keys(merged) as (keyof Override)[]).forEach((k) => {
        const v = merged[k];
        if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete merged[k];
      });
      return { ...o, [p]: merged };
    });

  const saveOverrides = async () => {
    setSaving(true);
    setSaved(false);
    // persist non-destructively onto pkg.overrides; unset fields = old behavior
    await fetch(`/api/item/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides }),
    }).catch(() => {});
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const run = async (pub: boolean) => {
    setBusy(pub ? "public" : "private");
    setPubError(null);
    try {
      // persist any pending overrides first so the live publish uses them
      await fetch(`/api/item/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      const r = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, public: pub, aigc }),
      });
      if (!r.ok) {
        const msg = await r.json().catch(() => null);
        throw new Error((msg && (msg.error as string)) || `Publish failed (HTTP ${r.status})`);
      }
      // publish runs in the background — poll the item for live status updates
      // instead of a single blind refresh.
      setPolling(true);
      router.refresh();
    } catch (e) {
      setPubError(e instanceof Error ? e.message : "Publish failed");
      setTimeout(() => setPubError(null), 5000);
    } finally {
      setBusy("");
    }
  };

  const hasPkg = !!item?.pkg;
  const curTags = cur.hashtags ?? base.hashtags;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <h2 className="h2" style={{ margin: 0 }}>Publish</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => run(false)} disabled={!!busy || !aigc} title={!aigc ? "Enable AIGC disclosure to publish AI-generated content" : undefined} className="btn" style={{ padding: "8px 16px", fontSize: 12 }}>
            {busy === "private" ? "Publishing…" : "Publish (private)"}
          </button>
          <button onClick={() => run(true)} disabled={!!busy || !aigc} title={!aigc ? "Enable AIGC disclosure to publish AI-generated content" : undefined} className="btn btn-primary" style={{ padding: "8px 16px", fontSize: 12 }}>
            {busy === "public" ? "Publishing…" : "Publish public"}
          </button>
        </div>
      </div>

      {pubError && (
        <div className="sub" role="alert" style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--err, #e35)", color: "var(--err, #e35)" }}>
          {pubError}
        </div>
      )}
      {polling && !pubError && (
        <div className="sub" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <span className="d" style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, background: "var(--accent)" }} />
          Publishing in the background — statuses below update live.
        </div>
      )}

      {/* AIGC disclosure — required for TikTok when posting AI-generated content */}
      <label
        style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, cursor: "pointer" }}
        title="TikTok requires AI-generated content to be disclosed. Publishing is blocked if this is off for AI content."
      >
        <input type="checkbox" checked={aigc} onChange={(e) => setAigc(e.target.checked)} disabled={!!busy} />
        <span style={{ fontWeight: 600 }}>Disclose AI-generated content (AIGC)</span>
        <span className={`badge ${aigc ? "b-ok" : "b-err"}`}><span className="d" />{aigc ? "on" : "off — publish blocked"}</span>
      </label>
      {!aigc && (
        <div className="sub" style={{ marginBottom: 10, color: "var(--err, #e35)" }}>
          AIGC disclosure is required for AI-generated content. Publishing will be blocked until this is on.
        </div>
      )}

      {/* TikTok client posture: sandbox / unaudited + rate-limit awareness */}
      {(TIKTOK_SANDBOX || TIKTOK_RATE_LIMIT) && (
        <div className="sub" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: META.tiktok.color }} />
          <span style={{ fontWeight: 600, minWidth: 90 }}>TikTok</span>
          {TIKTOK_SANDBOX && (
            <span className="badge b-neutral" title="Unaudited / sandbox client: posts are forced to private (SELF_ONLY) until the app passes TikTok audit.">
              <span className="d" />sandbox · private only
            </span>
          )}
          {!TIKTOK_SANDBOX && (
            <span className="badge b-ok"><span className="d" />audited · public allowed</span>
          )}
          {TIKTOK_RATE_LIMIT && <span className="row-id" style={{ width: "auto" }}>rate limit: {TIKTOK_RATE_LIMIT}</span>}
          <Link href="/autopilot" className="row-id" style={{ width: "auto", color: "var(--accent)", textDecoration: "none" }} title="Configure platform credentials & connection status">
            Configure platforms ↗
          </Link>
        </div>
      )}

      {/* P3 — per-platform metadata composer (overrides on top of packaging) */}
      {hasPkg && (
        <div style={{ marginBottom: 14, border: "1px solid var(--border-subtle)", borderRadius: 10 }}>
          <button
            onClick={() => setOpen((o) => !o)}
            className="btn"
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "transparent", border: "none", fontSize: 13, fontWeight: 600 }}
            title="Edit per-platform caption, title and hashtags without touching the generated packaging"
          >
            <span>Per-platform metadata</span>
            {Object.keys(overrides).length > 0 && (
              <span className="badge b-ok" style={{ marginLeft: 4 }}><span className="d" />{Object.keys(overrides).length} edited</span>
            )}
            <span style={{ marginLeft: "auto", opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
          </button>

          {open && (
            <div style={{ padding: "0 12px 12px" }}>
              {/* platform tabs */}
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {COMPOSER_PLATFORMS.map((p) => {
                  const m = META[p];
                  const edited = !!overrides[p] && Object.keys(overrides[p]).length > 0;
                  return (
                    <button
                      key={p}
                      onClick={() => setActive(p)}
                      className="btn"
                      style={{
                        padding: "6px 12px",
                        fontSize: 12,
                        borderBottom: active === p ? `2px solid ${m.color}` : "2px solid transparent",
                        fontWeight: active === p ? 700 : 500,
                        opacity: active === p ? 1 : 0.7,
                      }}
                    >
                      {m.label}{edited ? " •" : ""}
                    </button>
                  );
                })}
              </div>

              {/* G6 — one-click apply suggested title/hashtags from the generated variant */}
              {variant && (
                <div className="sub" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
                  <span style={{ opacity: 0.7 }}>Suggested:</span>
                  {variant.title && (
                    <button className="btn" style={{ padding: "4px 8px", fontSize: 11 }} title={variant.title} onClick={() => patch(active, { title: variant.title })}>
                      apply title
                    </button>
                  )}
                  {variant.hashtags?.length > 0 && (
                    <button className="btn" style={{ padding: "4px 8px", fontSize: 11 }} title={tagsToText(variant.hashtags)} onClick={() => patch(active, { hashtags: variant.hashtags })}>
                      apply {variant.hashtags.length} hashtags
                    </button>
                  )}
                  {variant.caption && (
                    <button className="btn" style={{ padding: "4px 8px", fontSize: 11 }} onClick={() => patch(active, { caption: variant.caption })}>
                      apply caption
                    </button>
                  )}
                </div>
              )}

              {/* title (YouTube uses it as the headline) */}
              <label className="sub" style={{ display: "block", marginBottom: 4 }}>Title</label>
              <input
                className="input"
                style={{ width: "100%", marginBottom: 10 }}
                value={cur.title ?? base.title}
                placeholder={base.title || "Title"}
                onChange={(e) => patch(active, { title: e.target.value === base.title ? undefined : e.target.value })}
              />

              {/* caption */}
              <label className="sub" style={{ display: "block", marginBottom: 4 }}>Caption</label>
              <textarea
                className="input"
                style={{ width: "100%", minHeight: 80, marginBottom: 10, resize: "vertical", fontFamily: "inherit" }}
                value={cur.caption ?? base.caption}
                placeholder={base.caption || "Caption"}
                onChange={(e) => patch(active, { caption: e.target.value === base.caption ? undefined : e.target.value })}
              />

              {/* hashtags */}
              <label className="sub" style={{ display: "block", marginBottom: 4 }}>Hashtags</label>
              <input
                className="input"
                style={{ width: "100%", marginBottom: 6 }}
                value={tagsToText(curTags)}
                placeholder="#one #two #three"
                onChange={(e) => {
                  const tags = textToTags(e.target.value);
                  const same = tags.join(" ") === base.hashtags.join(" ");
                  patch(active, { hashtags: same ? undefined : tags });
                }}
              />
              <label
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, cursor: "pointer" }}
                title="Post hashtags as the first comment instead of inline in the caption (keeps the caption clean)."
              >
                <input
                  type="checkbox"
                  checked={!!cur.firstCommentHashtags}
                  onChange={(e) => patch(active, { firstCommentHashtags: e.target.checked || undefined })}
                />
                <span className="sub">Hashtags in first comment</span>
              </label>

              {/* P6 — aspect derivative choice (only aspects that are rendered) */}
              {aspects.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <label className="sub" style={{ display: "block", marginBottom: 4 }}>
                    Publish aspect{" "}
                    <span style={{ opacity: 0.6 }}>(uses a rendered derivative; falls back to 9:16)</span>
                  </label>
                  <div style={{ display: "flex", gap: 6 }}>
                    {aspects.map((a) => {
                      const sel = (cur.aspect ?? "9:16") === a;
                      return (
                        <button
                          key={a}
                          className="btn"
                          style={{ padding: "5px 10px", fontSize: 12, fontWeight: sel ? 700 : 500, opacity: sel ? 1 : 0.7, borderColor: sel ? META[active].color : undefined }}
                          onClick={() => patch(active, { aspect: a === "9:16" ? undefined : a })}
                        >
                          {a}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button className="btn btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} disabled={saving} onClick={saveOverrides}>
                  {saving ? "Saving…" : "Save overrides"}
                </button>
                {Object.keys(cur).length > 0 && (
                  <button
                    className="btn"
                    style={{ padding: "6px 12px", fontSize: 12 }}
                    onClick={() => setOverrides((o) => { const n = { ...o }; delete n[active]; return n; })}
                    title="Discard this platform's overrides and fall back to the generated packaging"
                  >
                    Reset {META[active].label}
                  </button>
                )}
                {saved && <span className="badge b-ok"><span className="d" />saved</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {entries.length === 0 ? (
        <div className="sub">Not posted yet. “Publish” uploads to every configured platform (YouTube live + IG/TikTok when a host + tokens are set), and always writes a paste-ready bundle. Runs in the background — this card updates as platforms complete.</div>
      ) : (
        <div style={{ display: "grid", gap: 9 }}>
          {entries.map((e, i) => {
            const meta = META[e.platform] ?? { label: e.platform, color: "var(--accent)" };
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: meta.color }} />
                <span style={{ fontWeight: 600, minWidth: 90 }}>{meta.label}</span>
                <span className={`badge ${STATUS_CLASS(e.status)}`}><span className="d" />{e.status}</span>
                {e.url && (e.status === "published" ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="row-id" style={{ width: "auto", color: "var(--accent)" }}>open ↗</a>
                ) : (
                  <span className="row-id" style={{ width: "auto" }}>{e.status === "ready" ? "bundle ready" : ""}</span>
                ))}
                <span className="row-cost" style={{ marginLeft: "auto" }}>{new Date(e.at).toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
