"use client";

import { useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";

/* The 5 render themes — each pins a typeface + default accent + sensibility.
   The brand can override the accent with its own colour. */
const THEMES = [
  { id: "concept", label: "Concept", font: "Sora", accent: "#4f8ff7", desc: "Clean modern geometric — broad flagship" },
  { id: "lab", label: "Lab", font: "Space Grotesk", accent: "#ff8a3d", desc: "Engineered, terminal, mono accents" },
  { id: "builder", label: "Builder", font: "Manrope", accent: "#6366f1", desc: "Systems architect, structured" },
  { id: "magma", label: "Magma", font: "Archivo", accent: "#FF4400", desc: "Industrial, heavy, on-chain" },
  { id: "cognitivx", label: "Cognitive", font: "Fraunces", accent: "#8B5CF6", desc: "Literary serif, intimate" },
] as const;
const MOODS = ["explainer", "business", "tech", "motivational", "mindfulness"];

export type BrandForm = {
  id?: string;
  name: string;
  website?: string;
  slogan?: string;
  logo?: string;
  logoCandidates?: string[];
  accent?: string;
  theme: string;
  audience: string;
  tone: string;
  visualStyle: string;
  archetype?: string;
  handle?: string;
  site?: string;
  socials?: string[];
  moods?: string[];
  preferredHooks: string[];
  bannedPatterns: string[];
  voice?: string;
  elevenVoice?: string;
  voiceSpeed?: number;
};

const EMPTY: BrandForm = {
  name: "",
  theme: "concept",
  audience: "",
  tone: "",
  visualStyle: "",
  preferredHooks: [],
  bannedPatterns: [],
  moods: ["explainer"],
};

const STEPS = ["Start", "Identity", "Look", "Voice", "Review"];

export function BrandWizard({
  initial,
  mode,
  onClose,
  onSaved,
}: {
  initial?: any;
  mode: "create" | "edit";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState(mode === "edit" ? 1 : 0);
  const [form, setForm] = useState<BrandForm>(() => normalize(initial));
  const [crawling, setCrawling] = useState(false);
  const [crawlMsg, setCrawlMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);

  const set = (patch: Partial<BrandForm>) => setForm((f) => ({ ...f, ...patch }));

  async function crawl() {
    if (!form.website?.trim()) return;
    setCrawling(true);
    setCrawlMsg(null);
    try {
      const r = await fetch(`/api/brands/crawl?url=${encodeURIComponent(form.website.trim())}`);
      const j = await r.json();
      if (!r.ok) {
        setCrawlMsg(j.error || "Couldn't read that site.");
      } else {
        const d = j.draft || {};
        setForm((f) => ({
          ...f,
          name: f.name || d.name || "",
          slogan: d.slogan ?? f.slogan,
          logo: d.logo ?? f.logo,
          logoCandidates: d.logoCandidates ?? f.logoCandidates,
          accent: d.accent ?? f.accent,
          website: d.website ?? f.website,
          theme: d.theme ?? f.theme,
          audience: d.audience ?? f.audience,
          tone: d.tone ?? f.tone,
          visualStyle: d.visualStyle ?? f.visualStyle,
          archetype: d.archetype ?? f.archetype,
          preferredHooks: Array.isArray(d.preferredHooks) && d.preferredHooks.length ? d.preferredHooks : f.preferredHooks,
          bannedPatterns: Array.isArray(d.bannedPatterns) && d.bannedPatterns.length ? d.bannedPatterns : f.bannedPatterns,
        }));
        setCrawlMsg(d.aiDrafted ? "Pre-filled from the site + AI draft. Tune anything below." : "Pre-filled from the site. Tune anything below.");
      }
    } catch {
      setCrawlMsg("Couldn't reach that site.");
    } finally {
      setCrawling(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setLimitHit(false);
    const payload = {
      ...form,
      moods: (form.moods ?? []).map((id) => ({ id })),
      logoCandidates: undefined,
    };
    try {
      const r =
        mode === "edit" && form.id
          ? await fetch(`/api/brands/${form.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
          : await fetch(`/api/brands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok) {
        if (j.code === "limit") setLimitHit(true);
        setError(j.error || "Couldn't save the brand.");
      } else {
        onSaved();
      }
    } catch {
      setError("Network error saving the brand.");
    } finally {
      setSaving(false);
    }
  }

  const canNext =
    step === 0 ? true :
    step === 1 ? form.name.trim().length > 0 :
    step === 2 ? !!form.theme :
    step === 3 ? form.audience.trim() && form.tone.trim() && form.visualStyle.trim() :
    true;

  return (
    <div className="bw-overlay" onMouseDown={onClose}>
      {/* load the specimen fonts so the theme cards render in the real typeface */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@600;800&family=Space+Grotesk:wght@500;700&family=Manrope:wght@600;800&family=Archivo:wght@700;900&family=Fraunces:opsz,wght@9..144,500;9..144,700&display=swap" />
      <div className="bw" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bw-head">
          <div>
            <div className="eyebrow">// {mode === "edit" ? "edit brand" : "new brand"}</div>
            <div className="bw-title">{form.name || "Untitled brand"}</div>
          </div>
          <button className="bw-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="bw-steps">
          {STEPS.map((s, i) => (
            <button
              key={s}
              className={`bw-step${i === step ? " on" : ""}${i < step ? " done" : ""}`}
              onClick={() => (mode === "edit" || i <= step ? setStep(i) : null)}
              disabled={mode === "create" && i > step}
            >
              <span className="bw-step-n">{i < step ? "✓" : i + 1}</span>
              {s}
            </button>
          ))}
        </div>

        <div className="bw-body">
          {step === 0 && (
            <div className="bw-panel">
              <p className="bw-lead">Start from a website and we'll pull the name, logo, colours, and voice — or skip and fill it in by hand.</p>
              <Field label="Brand name">
                <input className="bw-input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Labrinox" autoFocus />
              </Field>
              <Field label="Website (optional)" hint="We'll crawl it to pre-fill everything.">
                <div className="bw-row">
                  <input className="bw-input" value={form.website ?? ""} onChange={(e) => set({ website: e.target.value })} placeholder="example.com" onKeyDown={(e) => e.key === "Enter" && crawl()} />
                  <button className="bw-btn primary" onClick={crawl} disabled={crawling || !form.website?.trim()}>
                    {crawling ? "Reading…" : "Crawl"}
                  </button>
                </div>
              </Field>
              {crawlMsg && <div className="bw-note">{crawlMsg}</div>}
            </div>
          )}

          {step === 1 && (
            <div className="bw-panel">
              <Field label="Brand name"><input className="bw-input" value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
              <Field label="Slogan / tagline"><input className="bw-input" value={form.slogan ?? ""} onChange={(e) => set({ slogan: e.target.value })} placeholder="One punchy line" /></Field>
              <Field label="Logo" hint="Pick a detected logo or paste a URL.">
                {!!form.logoCandidates?.length && (
                  <div className="bw-logos">
                    {form.logoCandidates.map((u) => (
                      <button key={u} className={`bw-logo${form.logo === u ? " on" : ""}`} onClick={() => set({ logo: u })} title={u}>
                        <img src={u} alt="" />
                      </button>
                    ))}
                  </div>
                )}
                <input className="bw-input" value={form.logo ?? ""} onChange={(e) => set({ logo: e.target.value })} placeholder="https://…/logo.png" />
              </Field>
              <div className="bw-row">
                <Field label="@handle"><input className="bw-input" value={form.handle ?? ""} onChange={(e) => set({ handle: e.target.value })} placeholder="@brand" /></Field>
                <Field label="Site"><input className="bw-input" value={form.site ?? ""} onChange={(e) => set({ site: e.target.value })} placeholder="brand.com" /></Field>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="bw-panel">
              <Field label="Theme" hint="Typeface + motion + treatment. The brand colour can override the accent.">
                <div className="bw-themes">
                  {THEMES.map((t) => (
                    <button key={t.id} className={`bw-theme${form.theme === t.id ? " on" : ""}`} onClick={() => set({ theme: t.id, accent: form.accent ?? t.accent })}>
                      <span className="bw-theme-spec" style={{ fontFamily: `'${t.font}', sans-serif`, color: form.accent && form.theme === t.id ? form.accent : t.accent }}>Aa</span>
                      <span className="bw-theme-meta">
                        <span className="bw-theme-name">{t.label}</span>
                        <span className="bw-theme-font">{t.font}</span>
                      </span>
                      <span className="bw-theme-desc">{t.desc}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <div className="bw-row" style={{ alignItems: "flex-start" }}>
                <Field label="Brand colour" hint="Becomes the on-screen accent everywhere.">
                  <div className="bw-color">
                    <HexColorPicker color={form.accent ?? "#4f8ff7"} onChange={(c) => set({ accent: c })} />
                    <input className="bw-input bw-hex" value={form.accent ?? ""} onChange={(e) => set({ accent: e.target.value })} placeholder="#4f8ff7" />
                  </div>
                </Field>
                <Field label="Visual style" hint="The on-screen look in a phrase.">
                  <textarea className="bw-input bw-area" value={form.visualStyle} onChange={(e) => set({ visualStyle: e.target.value })} placeholder="premium cool-neutral, electric-blue accent, one idea per scene" />
                </Field>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="bw-panel">
              <Field label="Audience"><input className="bw-input" value={form.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="who the videos are for" /></Field>
              <Field label="Tone / voice"><input className="bw-input" value={form.tone} onChange={(e) => set({ tone: e.target.value })} placeholder="clear, friendly, vivid, never dumbed-down" /></Field>
              <Field label="Editorial archetype" hint="How this brand conceives a video."><textarea className="bw-input bw-area" value={form.archetype ?? ""} onChange={(e) => set({ archetype: e.target.value })} placeholder="THE LUCID ESSAYIST. One clear idea per scene…" /></Field>
              <Field label="Content moods" hint="The clusters this brand publishes.">
                <div className="bw-chips-pick">
                  {MOODS.map((m) => {
                    const on = form.moods?.includes(m);
                    return (
                      <button key={m} className={`bw-pick${on ? " on" : ""}`} onClick={() => set({ moods: on ? form.moods!.filter((x) => x !== m) : [...(form.moods ?? []), m] })}>{m}</button>
                    );
                  })}
                </div>
              </Field>
              <div className="bw-row" style={{ alignItems: "flex-start" }}>
                <Field label="Preferred hooks"><ChipEditor value={form.preferredHooks} onChange={(v) => set({ preferredHooks: v })} placeholder="Add a hook + Enter" /></Field>
                <Field label="Banned patterns"><ChipEditor value={form.bannedPatterns} onChange={(v) => set({ bannedPatterns: v })} placeholder="Add a no-go + Enter" danger /></Field>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="bw-panel">
              <div className="bw-review">
                <div className="bw-review-head">
                  {form.logo ? <img className="bw-review-logo" src={form.logo} alt="" /> : <span className="bw-review-dot" style={{ background: form.accent ?? "#888" }} />}
                  <div>
                    <div className="bw-review-name">{form.name || "Untitled"}</div>
                    {form.slogan && <div className="bw-review-slogan">{form.slogan}</div>}
                  </div>
                  <span className="bw-swatch" style={{ background: form.accent ?? "#888" }} title={form.accent} />
                </div>
                <Row k="theme" v={THEMES.find((t) => t.id === form.theme)?.label ?? form.theme} />
                <Row k="audience" v={form.audience} />
                <Row k="tone" v={form.tone} />
                <Row k="visual" v={form.visualStyle} />
                {form.archetype && <Row k="archetype" v={form.archetype} />}
                <Row k="moods" v={(form.moods ?? []).join(", ") || "—"} />
                <Row k="hooks" v={form.preferredHooks.join(" · ") || "—"} />
                <Row k="banned" v={form.bannedPatterns.join(" · ") || "—"} />
              </div>
              {error && <div className={`bw-error${limitHit ? " limit" : ""}`}>{error}</div>}
            </div>
          )}
        </div>

        <div className="bw-foot">
          <button className="bw-btn ghost" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>{step === 0 ? "Cancel" : "Back"}</button>
          <div className="bw-foot-r">
            {step < STEPS.length - 1 ? (
              <button className="bw-btn primary" onClick={() => setStep(step + 1)} disabled={!canNext}>Continue</button>
            ) : (
              <button className="bw-btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : mode === "edit" ? "Save changes" : "Create brand"}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function normalize(initial?: any): BrandForm {
  if (!initial) return { ...EMPTY };
  return {
    ...EMPTY,
    ...initial,
    moods: Array.isArray(initial.moods) ? initial.moods.map((m: any) => (typeof m === "string" ? m : m.id)) : EMPTY.moods,
    preferredHooks: initial.preferredHooks ?? [],
    bannedPatterns: initial.bannedPatterns ?? [],
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="bw-field">
      <span className="bw-label">{label}{hint && <span className="bw-hint">{hint}</span>}</span>
      {children}
    </label>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="bw-rrow"><span className="bw-rk">{k}</span><span className="bw-rv">{v}</span></div>;
}

function ChipEditor({ value, onChange, placeholder, danger }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; danger?: boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div className="bw-chips">
      <div className="bw-chips-list">
        {value.map((c) => (
          <span key={c} className={`bw-chip${danger ? " danger" : ""}`}>{c}<button onClick={() => onChange(value.filter((x) => x !== c))}>✕</button></span>
        ))}
      </div>
      <input className="bw-input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} onBlur={add} placeholder={placeholder} />
    </div>
  );
}
