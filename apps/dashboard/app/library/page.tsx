import Link from "next/link";
import type { CSSProperties } from "react";
import { Film, Image, Layers, Video } from "lucide-react";
import { PageHead } from "../PageHead";
import { listItemsFor, isVerified, type Item } from "../../lib/data";
import { currentWorkspaceId } from "../../lib/tenancy";
import { StatusBadge, CHANNELS, MOODS, channelName, moodName, kindLabel } from "../ui";
import { LibPoster } from "./LibPoster";

export const dynamic = "force-dynamic";

type Params = { channel?: string; type?: string; mood?: string; verified?: string; pub?: string; view?: string };

/* A post is "generated" once it produced its final asset: a rendered video for
   shorts/long-form, the PNG for a static image, the slides for a carousel.
   Everything else (stopped at idea/script/storyboard/QA, or outright failed)
   never produced an asset — it does NOT belong in the main library grid; it
   lives under the "Failed" view instead. */
function isGenerated(it: Item, verified: boolean): boolean {
  if (it.kind === "static_image") return !!it.staticImagePath;
  if (it.kind === "carousel") return !!(it.carouselSlides && it.carouselSlides.length);
  return verified; // a real rendered video exists on disk
}

/* One-line reason a run never produced an asset — QA rejection note, the last
   recorded warning, or the last log line. */
function failReason(it: Item): string {
  if (it.qa?.verdict === "fail" && it.qa.notes?.length) return `QA failed — ${it.qa.notes[0]}`;
  const warns = (it as Item & { warnings?: { message: string }[] }).warnings;
  if (warns?.length) return warns[warns.length - 1].message;
  const last = it.log?.[it.log.length - 1]?.msg;
  return last ? last : "Generation did not finish — no asset was produced.";
}

/* Platforms we surface a publish status for, in display order. */
const PUB_PLATFORMS: { id: string; abbr: string }[] = [
  { id: "instagram", abbr: "IG" },
  { id: "tiktok", abbr: "TT" },
  { id: "youtube", abbr: "YT" },
  { id: "x", abbr: "X" },
];

/* The effective publish status per platform from the ledger (last entry wins). */
function pubEntries(it: Item): { platform: string; status: string }[] {
  const byPlatform = new Map<string, string>();
  for (const e of it.publish ?? []) byPlatform.set(e.platform, e.status);
  return PUB_PLATFORMS.filter((p) => byPlatform.has(p.id)).map((p) => ({ platform: p.id, status: byPlatform.get(p.id)! }));
}

/* Per-platform status chips (IG · draft / published / …). */
function PubStatus({ it }: { it: Item }) {
  const entries = pubEntries(it);
  if (!entries.length) return null;
  const abbr = (id: string) => PUB_PLATFORMS.find((p) => p.id === id)?.abbr ?? id.slice(0, 2).toUpperCase();
  return (
    <div className="lib-pub">
      {entries.map((e) => (
        <span key={e.platform} className={`pub-chip ${e.status}`} title={`${e.platform}: ${e.status}`}>
          {abbr(e.platform)} · {e.status}
        </span>
      ))}
    </div>
  );
}

/* Build a /library href that flips ONE filter while preserving the others. */
function href(cur: Params, key: keyof Params, val: string): string {
  const next: Params = { ...cur, [key]: val || undefined };
  const qs = Object.entries(next)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
  return "/library" + (qs ? `?${qs}` : "");
}

function FilterRow({ label, k, options, cur }: { label: string; k: keyof Params; options: { id: string; name: string }[]; cur: Params }) {
  const tabs = [{ id: "", name: "All" }, ...options];
  return (
    <div className="lib-filter">
      <span className="lib-filter-label">{label}</span>
      <div className="chan-filter" style={{ margin: 0 }}>
        {tabs.map((t) => (
          <Link key={t.id || "all"} href={href(cur, k, t.id)} className={`chan-tab${(cur[k] ?? "") === t.id ? " on" : ""}`}>
            {t.name}
          </Link>
        ))}
      </div>
    </div>
  );
}

export default async function Library({ searchParams }: { searchParams: Promise<Params> }) {
  const cur = await searchParams;
  const all = listItemsFor(await currentWorkspaceId());
  // Decorate every item with its real output type + verified + generated status once.
  const decorated = all.map((it) => {
    const verified = isVerified(it);
    return { it, verified, type: it.kind === "longform" ? "longform" : "short", generated: isGenerated(it, verified) };
  });

  const view = cur.view === "failed" ? "failed" : "generated";
  const generatedCount = decorated.filter((d) => d.generated).length;
  const failedCount = decorated.length - generatedCount;

  // The two pools never mix: the main grid is generated-only; the Failed view is
  // the not-generated runs. Channel/type/mood filters apply to both; verified +
  // publish filters only make sense for generated items.
  const pool = decorated.filter((d) => (view === "failed" ? !d.generated : d.generated));
  const items = pool.filter((d) => {
    if (cur.channel && d.it.channel !== cur.channel) return false;
    if (cur.type && d.type !== cur.type) return false;
    if (cur.mood && (d.it.mood ?? "") !== cur.mood) return false;
    if (view === "generated") {
      if (cur.verified === "1" && !d.verified) return false;
      if (cur.pub && !(d.it.publish ?? []).some((e) => e.status === cur.pub)) return false;
    }
    return true;
  });

  const draftCount = decorated.filter((d) => (d.it.publish ?? []).some((e) => e.status === "draft")).length;
  const publishedCount = decorated.filter((d) => (d.it.publish ?? []).some((e) => e.status === "published")).length;

  const verifiedCount = decorated.filter((d) => d.verified).length;
  const longformCount = decorated.filter((d) => d.type === "longform").length;
  // only surface moods that actually appear, in the canonical order
  const presentMoods = new Set(all.map((i) => i.mood).filter(Boolean) as string[]);
  const moodOptions = MOODS.filter((m) => presentMoods.has(m.id));
  // only surface channels that actually have content
  const presentChannels = new Set(all.map((i) => i.channel));
  const channelOptions = CHANNELS.filter((c) => presentChannels.has(c.id));

  return (
    <>
      <PageHead
        section="publish"
        title="Library"
        sub={<>{generatedCount} generated · {verifiedCount} verified · {publishedCount} published · {draftCount} draft · {longformCount} long-form{failedCount > 0 && <> · {failedCount} failed</>}</>}
      />

      <div className="lib-filters">
        {/* Primary split: finished assets vs. runs that never produced one. */}
        <div className="lib-filter">
          <span className="lib-filter-label">Show</span>
          <div className="chan-filter" style={{ margin: 0 }}>
            <Link href={href(cur, "view", "")} className={`chan-tab${view === "generated" ? " on" : ""}`}>Generated · {generatedCount}</Link>
            <Link href={href(cur, "view", "failed")} className={`chan-tab${view === "failed" ? " on" : ""}`}>Failed · {failedCount}</Link>
          </div>
        </div>
        <FilterRow label="Project" k="channel" options={channelOptions} cur={cur} />
        <FilterRow label="Type" k="type" options={[{ id: "short", name: "Short" }, { id: "longform", name: "Long-form" }]} cur={cur} />
        <FilterRow label="Mood" k="mood" options={moodOptions} cur={cur} />
        {view === "generated" && (
          <>
            <FilterRow label="Status" k="verified" options={[{ id: "1", name: "Verified only" }]} cur={cur} />
            <FilterRow label="Publish" k="pub" options={[{ id: "draft", name: "Draft" }, { id: "published", name: "Published" }]} cur={cur} />
          </>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty">{view === "failed" ? "No failed generations — every run produced an asset." : "Nothing matches these filters."}</div>
      ) : (
        <div className="lib-grid">
          {view === "failed"
            ? items.map(({ it }, i) => <FailedCard key={it.id} it={it} i={i} />)
            : items.map(({ it, verified, type }, i) => <LibCard key={it.id} it={it} verified={verified} type={type} i={i} />)}
        </div>
      )}
    </>
  );
}

function FormatBadge({ kind }: { kind?: string }) {
  if (kind === "longform") return (
    <span className="lib-fmt-badge" title="Long-form"><Video size={11} strokeWidth={1.8} /><span>Long-form</span></span>
  );
  if (kind === "static_image") return (
    <span className="lib-fmt-badge" title="Static Post"><Image size={11} strokeWidth={1.8} /><span>Static</span></span>
  );
  if (kind === "carousel") return (
    <span className="lib-fmt-badge" title="Carousel"><Layers size={11} strokeWidth={1.8} /><span>Carousel</span></span>
  );
  return (
    <span className="lib-fmt-badge" title="Reel"><Film size={11} strokeWidth={1.8} /><span>Reel</span></span>
  );
}

/* A run that never produced an asset. No poster — a compact failure banner with
   where it stopped + the reason, linking to the run log (where Retry/Dismiss
   and the full degradation report live). */
function FailedCard({ it, i = 0 }: { it: Item; i?: number }) {
  const title = it.idea?.topic ?? it.storyboard?.topic ?? it.pkg?.title ?? it.seedIdea;
  return (
    <Link href={`/post/${it.id}`} className="lib-card lib-card-failed blk-in" style={{ "--i": i + 1 } as CSSProperties}>
      <div className="lib-failed-banner">
        <span className="lib-failed-icon">⚠</span>
        <span className="lib-failed-stage">stopped at {String(it.status).replace(/_/g, " ")}</span>
      </div>
      <div className="lib-body">
        <div className="lib-title">{title}</div>
        <div className="lib-fail-reason">{failReason(it)}</div>
        <div className="lib-chips">
          <span className="lib-chip proj">{channelName(it.channel)}</span>
          {it.mood && <span className="lib-chip mood">{moodName(it.mood)}</span>}
          <FormatBadge kind={it.kind ?? it.formatKind} />
          <StatusBadge status={it.status} />
        </div>
      </div>
    </Link>
  );
}

function LibCard({ it, verified, type, i = 0 }: { it: Item; verified: boolean; type: string; i?: number }) {
  const title = it.pkg?.title ?? it.idea?.topic ?? it.storyboard?.topic ?? it.seedIdea;
  const longform = type === "longform";
  return (
    <Link href={`/post/${it.id}`} className="lib-card blk-in" style={{ "--i": i + 1 } as CSSProperties}>
      <LibPoster id={it.id} verified={verified} wide={longform} placeholder={channelName(it.channel)[0]}>
        <span className={`lib-vbadge${verified ? " ok" : ""}`}>{verified ? "✓ verified" : "no render"}</span>
        <span className="lib-type">{kindLabel(it.kind)}</span>
      </LibPoster>
      <div className="lib-body">
        <div className="lib-title">{title}</div>
        <div className="lib-chips">
          <span className="lib-chip proj">{channelName(it.channel)}</span>
          {it.mood && <span className="lib-chip mood">{moodName(it.mood)}</span>}
          <FormatBadge kind={it.kind ?? it.formatKind} />
          <StatusBadge status={it.status} />
        </div>
        <PubStatus it={it} />
      </div>
    </Link>
  );
}
