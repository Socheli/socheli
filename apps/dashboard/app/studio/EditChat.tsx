"use client";

import { useState } from "react";
import { Check, X, Send, Loader2 } from "lucide-react";
import type { EditOp, EditPlan } from "./types";

/* The CHAT surface — the primary action layer (Odysser model). Type an edit
   ("subtitle it", "make a 30s highlight reel", "cut the dead air", "grade it
   warm"); in GUIDED mode it returns a PROPOSED EditPlan rendered as an approval
   card (each op + the evidence it cites) you Approve / Reject; in AUTONOMOUS mode
   it routes+applies in one shot. Approving applies the plan and (with "render")
   re-renders the hybrid mp4 as a job the parent polls.

   This component is presentational + local-input only — every engine call is the
   parent's (POST /api/studio/[id]/edit), so the parent owns the job/preview
   refresh. */

/* The one-tap recipes that seed the chat. These are plain-language asks the
   router grounds against the run's understanding. */
const SUGGESTIONS = [
  "Subtitle it",
  "Cut the dead air",
  "Make a 30s highlight reel",
  "Grade it warm and cinematic",
  "Remove the filler words",
  "Tighten it into a teaser",
];

/* Human-readable one-liner for an op — what it does + a unit-bearing detail.
   Defensive: a partial op from a degraded model still renders something useful. */
function describeOp(op: EditOp): string {
  const s = (n?: number) => (typeof n === "number" ? `${Math.round(n * 10) / 10}s` : "");
  switch (op.kind) {
    case "ripple_trim":
      return `Trim the ${op.edge ?? ""} edge by ${s(op.deltaSec)} and ripple the rest of the cut`;
    case "razor":
      return `Split the clip at ${s(op.atSec)}`;
    case "jl_cut":
      return `J/L cut — lead the audio by ${s(op.leadSec)} against the picture`;
    case "slip":
      return `Slip the source window by ${s(op.deltaSec)} (timeline position unchanged)`;
    case "slide":
      return `Slide the clip by ${s(op.deltaSec)} and ripple its neighbours`;
    case "insert_broll":
      return `Insert b-roll at ${s(op.atSec)}${op.query ? ` — "${op.query}"` : ""}`;
    case "remove_clip":
      return "Remove this clip from the cut";
    case "reorder":
      return `Reorder ${op.order?.length ?? 0} clip(s) into a new sequence`;
    case "subtitle":
      return `Build the caption track${op.preset ? ` (${op.preset} style)` : ""}`;
    case "grade":
      return `Grade ${op.scope === "scene" ? "this scene" : "the whole video"}${op.intent ? ` — ${op.intent}` : ""}`;
    case "mix":
      return `Adjust the audio mix — ${op.intent ?? ""}`;
    case "select_highlight":
      return op.maxSec
        ? `Keep only the strongest moments to fit ${s(op.maxSec)}`
        : `Keep the top ${op.topN ?? ""} highlights`;
    default:
      return op.kind.replace(/_/g, " ");
  }
}

export function EditChat({
  plan,
  busy,
  canEdit,
  onSubmit,
  onApprove,
  onReject,
}: {
  plan: EditPlan | null;
  busy: boolean;
  canEdit: boolean;
  onSubmit: (request: string, mode: "guided" | "autonomous") => void;
  onApprove: (plan: EditPlan, render: boolean) => void;
  onReject: () => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"guided" | "autonomous">("guided");
  const [render, setRender] = useState(true);

  const fire = (request: string) => {
    const r = request.trim();
    if (!r || busy || !canEdit) return;
    onSubmit(r, mode);
    setText("");
  };

  return (
    <div className="st-chat">
      <div className="st-section-head" style={{ margin: 0 }}>
        <span className="st-section-title">Edit by chat</span>
        {/* guided ↔ autonomous — the approval model toggle */}
        <div className="st-mode">
          {(["guided", "autonomous"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              className={`btn${mode === m ? " btn-primary" : ""}`}
              style={{ padding: "5px 11px", fontSize: 11.5 }}
              onClick={() => setMode(m)}
              title={m === "guided" ? "Propose a plan you approve before it runs" : "Apply the edit immediately, no gate"}
            >
              {m === "guided" ? "Guided" : "Autonomous"}
            </button>
          ))}
        </div>
      </div>

      {/* one-tap recipes */}
      <div className="st-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="st-chip-btn" disabled={busy || !canEdit} onClick={() => fire(s)}>
            {s}
          </button>
        ))}
      </div>

      {/* composer */}
      <div className="st-composer">
        <input
          className="input"
          placeholder={mode === "guided" ? "Describe an edit — you'll approve the plan…" : "Describe an edit — it runs immediately…"}
          value={text}
          disabled={busy || !canEdit}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fire(text)}
        />
        <button className="btn btn-primary" disabled={busy || !canEdit || !text.trim()} onClick={() => fire(text)}>
          {busy ? <Loader2 size={14} className="spin" style={{ animation: "st-spin .8s linear infinite" }} /> : <Send size={14} />}
          {mode === "guided" ? "Propose" : "Run"}
        </button>
      </div>

      {/* PROPOSED plan — approval card (guided gate) */}
      {plan && (
        <div className="st-plan">
          <div className="st-plan-head">
            <div>
              <div className="st-plan-req">{plan.request}</div>
              <div className="st-plan-rationale">{plan.rationale}</div>
            </div>
            <span className="st-plan-mode">{plan.ops.length} op{plan.ops.length === 1 ? "" : "s"}{plan.montage ? " · montage" : ""}</span>
          </div>

          {plan.ops.length > 0 ? (
            <div className="st-ops">
              {plan.ops.map((op, i) => (
                <div className="st-op" key={i}>
                  <span className="st-op-kind">{op.kind}</span>
                  <div className="st-op-body">
                    <div className="st-op-what">{describeOp(op)}</div>
                    {op.evidence && (
                      <div className="st-op-evidence"><b>evidence</b> · {op.evidence}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="sub" style={{ fontSize: 12 }}>
              No grounded ops — the request couldn&apos;t be tied to anything in the analysis. Try rephrasing, or run Understand first.
            </div>
          )}

          <div className="st-plan-foot">
            <label className="st-check">
              <input type="checkbox" checked={render} onChange={(e) => setRender(e.target.checked)} disabled={busy} />
              Re-render after applying
            </label>
            <span className="grow" />
            <button className="btn" disabled={busy} onClick={onReject}>
              <X size={14} /> Reject
            </button>
            <button className="btn btn-primary" disabled={busy || plan.ops.length === 0} onClick={() => onApprove(plan, render)}>
              {busy ? <Loader2 size={14} className="spin" style={{ animation: "st-spin .8s linear infinite" }} /> : <Check size={14} />}
              Approve &amp; apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
