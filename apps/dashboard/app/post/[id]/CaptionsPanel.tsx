"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Platform = { platform: string; title?: string; caption: string; hashtags: string[]; keywords?: string[] };
type Pkg = { title: string; caption: string; hashtags: string[]; altText: string; platforms?: Platform[] };

const META: Record<string, { label: string; color: string }> = {
  youtube: { label: "YouTube", color: "#ff4e45" },
  instagram: { label: "Instagram", color: "#e1306c" },
  tiktok: { label: "TikTok", color: "#25f4ee" },
  x: { label: "X", color: "#e7e7e7" },
};

type Field = { key: string; label: string; value: string };

// The fields that map to the actual paste targets in each platform's compose form.
function fieldsFor(p: Platform): Field[] {
  const tags = p.hashtags.map((h) => `#${h}`).join(" ");
  const fields: Field[] = [];

  if (p.platform === "youtube") {
    // YouTube Studio has discrete inputs: Title, Description, Tags.
    if (p.title) fields.push({ key: "title", label: "Title", value: p.title });
    fields.push({ key: "description", label: "Description", value: tags ? `${p.caption}\n\n${tags}` : p.caption });
    if (p.keywords?.length) fields.push({ key: "keywords", label: "Tags / Keywords", value: p.keywords.join(", ") });
    return fields;
  }

  // IG / TikTok / X: one caption box, but hashtags are often pasted separately
  // (e.g. IG first comment), so keep them as their own copyable field.
  const captionLabel = p.platform === "x" ? "Post" : "Caption";
  if (p.title) fields.push({ key: "title", label: "Title", value: p.title });
  fields.push({ key: "caption", label: captionLabel, value: p.caption });
  if (tags) fields.push({ key: "hashtags", label: "Hashtags", value: tags });
  return fields;
}

function CopyButton({ value, label, tone }: { value: string; label?: string; tone?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      onClick={copy}
      className="btn"
      style={{ padding: "5px 12px", fontSize: 11.5, borderColor: copied ? "var(--success)" : tone, color: copied ? "var(--success)" : undefined }}
    >
      {copied ? "✓ Copied" : label ?? "Copy"}
    </button>
  );
}

function PlatformBlock({ p }: { p: Platform }) {
  const meta = META[p.platform] ?? { label: p.platform, color: "var(--accent)" };
  const fields = fieldsFor(p);
  const allText = fields.map((f) => f.value).join("\n\n");
  return (
    <div className="card" style={{ borderColor: `${meta.color}44` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: meta.color }} />
        <span style={{ fontWeight: 650, letterSpacing: "-0.01em" }}>{meta.label}</span>
        <span className="row-cost" style={{ marginLeft: 4 }}>{p.hashtags.length} tags{p.keywords?.length ? ` · ${p.keywords.length} keywords` : ""}</span>
        <span style={{ marginLeft: "auto" }}>
          <CopyButton value={allText} label="Copy all" tone={`${meta.color}66`} />
        </span>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {fields.map((f) => (
          <div key={f.key}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-muted)" }}>{f.label}</span>
              <span style={{ marginLeft: "auto" }}>
                <CopyButton value={f.value} />
              </span>
            </div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-body)",
                fontSize: 13,
                lineHeight: 1.55,
                color: "var(--text-light)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                padding: "12px 14px",
                margin: 0,
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {f.value}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CaptionsPanel({ id, pkg }: { id: string; pkg?: Pkg }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const platforms = pkg?.platforms ?? [];

  const regen = async () => {
    setBusy(true);
    setErr("");
    const r = await fetch("/api/captions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => null);
    const data = await r?.json().catch(() => ({}));
    setBusy(false);
    if (!r || !r.ok) {
      setErr(data?.error ? `Caption generation failed: ${data.error}` : "Caption generation failed. Check the engine logs.");
      return;
    }
    router.refresh();
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: platforms.length ? 18 : 8 }}>
        <h2 className="h2" style={{ margin: 0 }}>Ready to post</h2>
        <button onClick={regen} disabled={busy} className="btn" style={{ marginLeft: "auto", padding: "8px 16px", fontSize: 12, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Generating…" : platforms.length ? "↻ Regenerate" : "Generate captions"}
        </button>
      </div>
      {err && <div className="run-stalled" style={{ margin: "0 0 14px" }}>{err}</div>}
      {platforms.length === 0 ? (
        <div className="sub">No per-platform captions yet. Click “Generate captions” to research hashtags + write a tailored caption for each platform.</div>
      ) : (
        <div className="grid" style={{ gap: 14 }}>
          {platforms.map((p) => (
            <PlatformBlock key={p.platform} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
