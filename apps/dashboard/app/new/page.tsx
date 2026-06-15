"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Film, Image, Layers } from "lucide-react";
import { AiThinking } from "../AiThinking";
import { PageHead } from "../PageHead";

/* ─── Multi-step post builder ───────────────────────────────────────────────
   The manual, human-in-the-loop counterpart to one-shot generation: pick the
   format + brand + mood, then go idea → script → storyboard → render,
   generating each stage with AI, hand-editing it, or regenerating with
   guidance before moving on. Drives the same draft_* tools the MCP / SDK /
   CLI expose, via POST /api/tools/<name> (which spawns the engine tool runner). */

const MOODS = ["explainer", "business", "tech", "motivational", "mindfulness", "cinematic", "motion_graphics", "ops_room", "war_economy"];
// Steps: Format, Setup, Idea, Script, Storyboard, Render
const STEPS = ["Format", "Setup", "Idea", "Script", "Storyboard", "Render"];

/* ─── Format type definitions ──────────────────────────────────────────────── */
type FormatKind = "short" | "static_image" | "carousel";

const LAYOUT_VARIANTS = [
  { id: "highlight_bar", label: "Highlight Bar" },
  { id: "text_only", label: "Text Only" },
  { id: "text_over_image", label: "Text Over Image" },
  { id: "split", label: "Split" },
  { id: "stat_card", label: "Stat Card" },
] as const;

const SLIDE_COUNTS = [3, 5, 6, 8] as const;

/* ─── Aspect presets (canvas shape) ────────────────────────────────────────
   Mirrors packages/engine/src/format.ts ASPECT_PRESETS — the ONE source of
   truth for aspect → dimensions. Default Vertical so the 9:16 baseline never
   regresses. A custom W×H overrides the preset (shared wire contract). */
type AspectId = "9:16" | "1:1" | "16:9";
const ASPECTS = [
  { id: "9:16" as AspectId, label: "Vertical", hint: "9:16 · reels / shorts" },
  { id: "1:1" as AspectId, label: "Square", hint: "1:1 · feed" },
  { id: "16:9" as AspectId, label: "Wide", hint: "16:9 · youtube" },
];

/* ─── Content format icons (custom inline vectors, no dependency) ──────────── */
const svg = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, width: 22, height: 22 };
const IconFix = () => (
  // wrench — "fix the mistake"
  <svg {...svg}><path d="M15.5 6.5a3.6 3.6 0 0 1-4.6 4.6L5 17v2h2l5.9-5.9a3.6 3.6 0 0 0 4.6-4.6l-2.2 2.2-2-2 2.2-2.2Z" /></svg>
);
const IconTerminal = () => (
  // terminal window with a prompt
  <svg {...svg}><rect x="3" y="4" width="18" height="16" rx="2.2" /><path d="M7 9.5l2.6 2.5L7 14.5" /><path d="M12.5 15h4.5" /></svg>
);
const IconBeforeAfter = () => (
  // a frame split down the middle, arrows facing out — comparison
  <svg {...svg}><rect x="3" y="5" width="18" height="14" rx="2.2" /><path d="M12 5v14" /><path d="M7.5 9.5 5.5 12l2 2.5" /><path d="M16.5 9.5 18.5 12l-2 2.5" /></svg>
);
const IconWarning = () => (
  // warning triangle over a baseline — architecture caution
  <svg {...svg}><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>
);
const FORMAT_META = [
  { id: "mistake_fix", label: "Mistake → Fix", Icon: IconFix },
  { id: "terminal_tip", label: "Terminal Tip", Icon: IconTerminal },
  { id: "before_after", label: "Before / After", Icon: IconBeforeAfter },
  { id: "architecture_warning", label: "Architecture Warning", Icon: IconWarning },
] as const;

type Tool = { ok: boolean; data?: any; message?: string; error?: string };
async function callTool(name: string, body: any): Promise<Tool> {
  const r = await fetch(`/api/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  // Surface the tool's OWN message (validation errors, engine detail) instead of
  // a generic "tool failed". The route returns the real ToolResult on ok:false.
  if (!r.ok || j.ok === false) {
    const reason = (j.message || j.detail || j.error || "tool failed").toString().slice(0, 600);
    return { ok: false, error: reason };
  }
  return j as Tool;
}

const linesToArr = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const arrToLines = (a?: string[]) => (a ?? []).join("\n");

export default function NewPost() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [brands, setBrands] = useState<{ id: string; name: string }[]>([]);
  const [channel, setChannel] = useState("labrinox");
  const [mood, setMood] = useState("explainer");
  const [seed, setSeed] = useState("");

  // Format selection (step 0)
  const [formatKind, setFormatKind] = useState<FormatKind>("short");
  const [layoutVariant, setLayoutVariant] = useState<string>("highlight_bar");
  const [slideCount, setSlideCount] = useState<number>(6);
  // Canvas shape — default Vertical (keeps the 9:16 baseline). A custom W×H,
  // when both are set, overrides the preset per the shared wire contract.
  const [aspect, setAspect] = useState<AspectId>("9:16");
  const [customW, setCustomW] = useState<string>("");
  const [customH, setCustomH] = useState<string>("");

  const [ideas, setIdeas] = useState<any[]>([]);
  const [idea, setIdea] = useState<any | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  const [script, setScript] = useState<any | null>(null);
  const [scriptGuide, setScriptGuide] = useState("");

  const [storyboard, setStoryboard] = useState<any | null>(null);
  const [sbGuide, setSbGuide] = useState("");

  const [media, setMedia] = useState({ voice: true, music: true, broll: true });

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/brands").then((r) => r.json()).then((j) => {
      const bs = (j.brands ?? []).map((b: any) => ({ id: b.id, name: b.name }));
      setBrands(bs);
      if (bs.length && !bs.find((b: any) => b.id === channel)) setChannel(bs[0].id);
    }).catch(() => {});
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  async function genIdeas() {
    await run("ideas", async () => {
      const r = await callTool("draft_ideas", { channel, seed, n: 3 });
      if (!r.ok) throw new Error(r.error || r.message);
      setIdeas(r.data.ideas);
    });
  }

  async function commitIdeaAndNext() {
    if (!idea) return;
    // Canvas shape per the shared wire contract: a valid custom W×H wins,
    // otherwise carry the named aspect preset.
    const cw = Number(customW), ch = Number(customH);
    const custom = cw > 0 && ch > 0;
    await run("setidea", async () => {
      const r = await callTool("draft_set_idea", {
        id: draftId ?? undefined, channel, seed, mood, idea,
        kind: formatKind,
        ...(custom ? { width: cw, height: ch } : { aspect }),
        ...(formatKind === "static_image" ? { layoutVariant } : {}),
        ...(formatKind === "carousel" ? { slideCount } : {}),
      });
      if (!r.ok) throw new Error(r.error || r.message);
      setDraftId(r.data.id);
      setStep(3);
    });
  }

  async function genScript() {
    if (!draftId) return;
    await run("script", async () => {
      const r = await callTool("draft_script", { id: draftId, guidance: scriptGuide });
      if (!r.ok) throw new Error(r.error || r.message);
      setScript(r.data.script);
    });
  }

  async function commitScriptAndNext() {
    if (!draftId || !script) return;
    await run("setscript", async () => {
      const r = await callTool("draft_set_script", { id: draftId, script });
      if (!r.ok) throw new Error(r.error || r.message);
      setStep(4);
    });
  }

  async function genStoryboard() {
    if (!draftId) return;
    await run("sb", async () => {
      const r = await callTool("draft_storyboard", { id: draftId, guidance: sbGuide });
      if (!r.ok) throw new Error(r.error || r.message);
      setStoryboard(r.data.storyboard);
    });
  }

  async function renderNow() {
    if (!draftId) return;
    await run("render", async () => {
      const r = await callTool("draft_render", { id: draftId, ...media });
      if (!r.ok) throw new Error(r.error || r.message);
      router.push(`/post/${draftId}`);
    });
  }

  const brandTabs = brands.length ? brands : [{ id: "labrinox", name: "Labrinox" }];

  return (
    <>
      <PageHead
        section="create"
        title="Build a post"
        sub="Generate each stage with AI, edit anything, or regenerate with direction — idea → script → storyboard → render."
      />

      <div className="np-steps">
        {STEPS.map((s, i) => (
          <button key={s} className={`bw-step${i === step ? " on" : ""}${i < step ? " done" : ""}`} disabled={i > step} onClick={() => i <= step && setStep(i)}>
            <span className="bw-step-n">{i < step ? "✓" : i + 1}</span>{s}
          </button>
        ))}
      </div>

      <div className="card np-card">
        {/* ── Step 0: Format picker ──────────────────────────────────────────── */}
        {step === 0 && (
          <div className="np-panel">
            <div className="bw-label">Output Format</div>
            <div className="np-fsel np-fsel-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              <button
                type="button"
                className={`np-fcard${formatKind === "short" ? " on" : ""}`}
                onClick={() => setFormatKind("short")}
                aria-pressed={formatKind === "short"}
              >
                <span className="np-fico"><Film size={22} strokeWidth={1.6} /></span>
                <span className="np-flabel">Reel</span>
                <span className="np-fhint">9:16 · vertical</span>
              </button>
              <button
                type="button"
                className={`np-fcard${formatKind === "static_image" ? " on" : ""}`}
                onClick={() => setFormatKind("static_image")}
                aria-pressed={formatKind === "static_image"}
              >
                <span className="np-fico"><Image size={22} strokeWidth={1.6} /></span>
                <span className="np-flabel">Static Post</span>
                <span className="np-fhint">single image</span>
              </button>
              <button
                type="button"
                className={`np-fcard${formatKind === "carousel" ? " on" : ""}`}
                onClick={() => setFormatKind("carousel")}
                aria-pressed={formatKind === "carousel"}
              >
                <span className="np-fico"><Layers size={22} strokeWidth={1.6} /></span>
                <span className="np-flabel">Carousel</span>
                <span className="np-fhint">multi-slide</span>
              </button>
            </div>

            {/* Aspect (canvas shape) — presets first, optional custom W×H */}
            <div>
              <div className="bw-label" style={{ marginBottom: 8 }}>Aspect</div>
              <div className="np-chip-row">
                {ASPECTS.map(({ id, label, hint }) => (
                  <button
                    key={id}
                    type="button"
                    className={`np-chip${!(Number(customW) > 0 && Number(customH) > 0) && aspect === id ? " on" : ""}`}
                    onClick={() => { setAspect(id); setCustomW(""); setCustomH(""); }}
                    title={hint}
                  >
                    {label} <span className="bw-hint">{id}</span>
                  </button>
                ))}
              </div>
              <div className="bw-label" style={{ margin: "10px 0 8px" }}>Custom size <span className="bw-hint">optional — both W and H override the preset</span></div>
              <div className="np-chip-row">
                <input className="bw-input" style={{ maxWidth: 110 }} type="number" inputMode="numeric" min={2} value={customW} onChange={(e) => setCustomW(e.target.value)} placeholder="width" />
                <span style={{ alignSelf: "center", opacity: 0.5 }}>×</span>
                <input className="bw-input" style={{ maxWidth: 110 }} type="number" inputMode="numeric" min={2} value={customH} onChange={(e) => setCustomH(e.target.value)} placeholder="height" />
              </div>
            </div>

            {/* Static: layout variant picker */}
            {formatKind === "static_image" && (
              <div>
                <div className="bw-label" style={{ marginBottom: 8 }}>Layout Variant</div>
                <div className="np-chip-row">
                  {LAYOUT_VARIANTS.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      className={`np-chip${layoutVariant === id ? " on" : ""}`}
                      onClick={() => setLayoutVariant(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Carousel: slide count picker */}
            {formatKind === "carousel" && (
              <div>
                <div className="bw-label" style={{ marginBottom: 8 }}>Slide Count</div>
                <div className="np-chip-row">
                  {SLIDE_COUNTS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`np-chip${slideCount === n ? " on" : ""}`}
                      onClick={() => setSlideCount(n)}
                    >
                      {n} slides
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="np-foot"><span /><button className="bw-btn primary" onClick={() => setStep(1)}>Continue</button></div>
          </div>
        )}

        {/* ── Step 1: Setup ─────────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="np-panel">
            <div className="bw-label">Brand</div>
            <div className="chan-filter" style={{ margin: "0 0 8px" }}>
              {brandTabs.map((b) => <button key={b.id} className={`chan-tab${channel === b.id ? " on" : ""}`} onClick={() => setChannel(b.id)}>{b.name}</button>)}
            </div>
            <div className="bw-label">Mood</div>
            <div className="chan-filter" style={{ margin: "0 0 8px" }}>
              {MOODS.map((m) => <button key={m} className={`chan-tab${mood === m ? " on" : ""}`} style={{ textTransform: "capitalize" }} onClick={() => setMood(m)}>{m}</button>)}
            </div>
            <div className="bw-label">Direction <span className="bw-hint">optional — a topic or angle to build from, or leave blank for fresh ideas</span></div>
            <textarea className="bw-input bw-area" rows={3} value={seed} onChange={(e) => setSeed(e.target.value)} placeholder='e.g. "why parallel tool calls beat sequential ones in agent loops"' />
            <div className="np-foot"><button className="bw-btn ghost" onClick={() => setStep(0)}>Back</button><button className="bw-btn primary" onClick={() => setStep(2)}>Continue</button></div>
          </div>
        )}

        {/* ── Step 2: Idea ──────────────────────────────────────────────────── */}
        {step === 2 && (
          <div className="np-panel">
            <div className="np-row-head">
              <div className="bw-label" style={{ margin: 0 }}>Idea</div>
              <button className="bw-btn" onClick={genIdeas} disabled={busy === "ideas"}>{busy === "ideas" ? "Thinking…" : ideas.length ? "↻ Regenerate" : "✦ Generate ideas"}</button>
            </div>
            {busy === "ideas" && ideas.length === 0 && (
              <AiThinking phases={["Scanning trends + your learnings…", "Shaping distinct angles…", "Scoring against the algorithm…"]} lines={3} />
            )}
            {ideas.length > 0 && (
              <div className="np-ideas">
                {ideas.map((o, i) => (
                  <button key={i} className={`np-idea${idea === o ? " on" : ""}`} onClick={() => setIdea(o)}>
                    <div className="np-idea-top"><span className="np-fmt">{o.format}</span><span className="np-mood">{o.mood}</span></div>
                    <div className="np-idea-topic">{o.topic}</div>
                    <div className="np-idea-angle">{o.angle}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="np-or">or write / edit it yourself</div>
            <Editable label="Topic" value={idea?.topic ?? ""} onChange={(v) => setIdea({ ...(idea ?? { format: "before_after", mood }), topic: v })} />
            <Editable label="Angle" value={idea?.angle ?? ""} onChange={(v) => setIdea({ ...(idea ?? {}), angle: v })} />
            <div className="bw-field">
              <span className="bw-label">Format</span>
              <div className="np-fsel">
                {FORMAT_META.map(({ id, label, Icon }) => {
                  const on = (idea?.format ?? "before_after") === id;
                  return (
                    <button key={id} type="button" className={`np-fcard${on ? " on" : ""}`} onClick={() => setIdea({ ...(idea ?? { mood }), format: id })} aria-pressed={on}>
                      <span className="np-fico"><Icon /></span>
                      <span className="np-flabel">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <Editable label="Rationale" value={idea?.rationale ?? ""} onChange={(v) => setIdea({ ...(idea ?? {}), rationale: v })} />
            <div className="np-foot"><button className="bw-btn ghost" onClick={() => setStep(1)}>Back</button><button className="bw-btn primary" disabled={!idea?.topic || busy === "setidea"} onClick={commitIdeaAndNext}>{busy === "setidea" ? "Saving…" : "Continue"}</button></div>
          </div>
        )}

        {/* ── Step 3: Script ────────────────────────────────────────────────── */}
        {step === 3 && (
          <div className="np-panel">
            <div className="np-row-head">
              <div className="bw-label" style={{ margin: 0 }}>Script</div>
              <div className="np-guide">
                <input className="bw-input" value={scriptGuide} onChange={(e) => setScriptGuide(e.target.value)} placeholder="direction for the AI (optional)" />
                <button className="bw-btn" onClick={genScript} disabled={busy === "script"}>{busy === "script" ? "Writing…" : script ? "↻ Regenerate" : "✦ Generate"}</button>
              </div>
            </div>
            {busy === "script" ? (
              <AiThinking phases={["Researching the angle…", "Drafting the hook…", "Writing the beats…", "Tightening the narration…"]} lines={4} />
            ) : script ? (
              <>
                <Editable label="Hook" value={script.hook ?? ""} onChange={(v) => setScript({ ...script, hook: v })} />
                <Multi label="Beats (one per line)" value={arrToLines(script.beats)} onChange={(v) => setScript({ ...script, beats: linesToArr(v) })} />
                <Multi label="Narration (one per line)" value={arrToLines(script.narration)} onChange={(v) => setScript({ ...script, narration: linesToArr(v) })} />
                <Editable label="CTA" value={script.cta ?? ""} onChange={(v) => setScript({ ...script, cta: v })} />
              </>
            ) : <div className="np-empty">Generate a script, then edit anything by hand.</div>}
            <div className="np-foot"><button className="bw-btn ghost" onClick={() => setStep(2)}>Back</button><button className="bw-btn primary" disabled={!script || busy === "setscript"} onClick={commitScriptAndNext}>{busy === "setscript" ? "Saving…" : "Continue"}</button></div>
          </div>
        )}

        {/* ── Step 4: Storyboard ────────────────────────────────────────────── */}
        {step === 4 && (
          <div className="np-panel">
            <div className="np-row-head">
              <div className="bw-label" style={{ margin: 0 }}>Storyboard</div>
              <div className="np-guide">
                <input className="bw-input" value={sbGuide} onChange={(e) => setSbGuide(e.target.value)} placeholder="direction for the AI (optional)" />
                <button className="bw-btn" onClick={genStoryboard} disabled={busy === "sb"}>{busy === "sb" ? "Building…" : storyboard ? "↻ Regenerate" : "✦ Generate"}</button>
              </div>
            </div>
            {busy === "sb" ? (
              <AiThinking phases={["Mapping scenes to the script…", "Choosing visuals + b-roll…", "Timing the cuts…", "Composing the storyboard…"]} lines={6} />
            ) : storyboard ? (
              <>
                <div className="np-scenes">
                  {(storyboard.scenes ?? []).map((s: any, i: number) => (
                    <div className="np-scene" key={i}>
                      <span className="np-scene-n">{i + 1}</span>
                      <span className="np-scene-type">{s.type}</span>
                      <span className="np-scene-say">{s.say ?? s.text ?? s.caption ?? s.value ?? s.title ?? ""}</span>
                      <span className="np-scene-dur">{s.durationSec}s</span>
                    </div>
                  ))}
                </div>
                <div className="np-hint-row">Fine-tune individual scenes after rendering, in the full editor.</div>
              </>
            ) : <div className="np-empty">Generate the scene-by-scene storyboard from your script.</div>}
            <div className="np-foot"><button className="bw-btn ghost" onClick={() => setStep(3)}>Back</button><button className="bw-btn primary" disabled={!storyboard} onClick={() => setStep(5)}>Continue</button></div>
          </div>
        )}

        {/* ── Step 5: Render ────────────────────────────────────────────────── */}
        {step === 5 && (
          <div className="np-panel">
            <div className="bw-label">Media</div>
            <div className="np-toggles">
              {(["voice", "music", "broll"] as const).map((k) => (
                <button key={k} className={`np-toggle${(media as any)[k] ? " on" : ""}`} onClick={() => setMedia({ ...media, [k]: !(media as any)[k] })}>
                  <span className="np-toggle-dot" />{k === "broll" ? "B-roll" : k[0].toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
            <div className="np-summary">
              <Row k="format" v={formatKind === "short" ? "Reel" : formatKind === "static_image" ? `Static Post — ${LAYOUT_VARIANTS.find((l) => l.id === layoutVariant)?.label ?? layoutVariant}` : `Carousel — ${slideCount} slides`} />
              <Row k="aspect" v={Number(customW) > 0 && Number(customH) > 0 ? `${Number(customW)}×${Number(customH)}` : (ASPECTS.find((a) => a.id === aspect)?.label ?? aspect) + ` (${aspect})`} />
              <Row k="brand" v={brandTabs.find((b) => b.id === channel)?.name ?? channel} />
              <Row k="mood" v={mood} />
              <Row k="idea" v={idea?.topic ?? "—"} />
              <Row k="hook" v={script?.hook ?? "—"} />
              <Row k="scenes" v={String(storyboard?.scenes?.length ?? 0)} />
            </div>
            <div className="np-foot"><button className="bw-btn ghost" onClick={() => setStep(4)}>Back</button><button className="bw-btn primary" disabled={busy === "render"} onClick={renderNow}>{busy === "render" ? "Starting render…" : "Render post →"}</button></div>
          </div>
        )}

        {err && <div className="bw-error" style={{ marginTop: 14 }}>{err}</div>}
      </div>
    </>
  );
}

function Editable({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="bw-field"><span className="bw-label">{label}</span><input className="bw-input" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Multi({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="bw-field"><span className="bw-label">{label}</span><textarea className="bw-input bw-area" rows={4} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="bw-rrow"><span className="bw-rk">{k}</span><span className="bw-rv">{v}</span></div>;
}
