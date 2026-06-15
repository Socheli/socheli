"use client";

import { useState } from "react";
import type { AdPlan } from "@os/schemas";
import { Modal } from "../Modal";
import { InkUnderline } from "../../components/sketch";
import type { BoostItem, CallTool } from "./AdsClient";

/* The boost drafting wizard. Three steps, all of them spend-free:
     1. pick a post that is actually published to Instagram;
     2. ads_plan drafts a budget/duration/audience with a rationale — every
        suggestion stays editable;
     3. review the commitment and save a DRAFT via ads_create.
   This component NEVER calls ads_launch (or approve) — going live is the
   separate human gate in ApproveDialog. */

type Step = 0 | 1 | 2;

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

export function BoostWizard({
  items,
  channelNameOf,
  onClose,
  onDone,
  callTool,
}: {
  items: BoostItem[];
  channelNameOf: (id: string) => string;
  onClose: () => void;
  onDone: (msg: string) => void;
  callTool: CallTool;
}) {
  const [step, setStep] = useState<Step>(0);
  const [item, setItem] = useState<BoostItem | null>(null);
  const [plan, setPlan] = useState<Partial<AdPlan> | null>(null);
  const [boostWarn, setBoostWarn] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  // editable draft parameters (prefilled by the plan, never locked to it)
  const [daily, setDaily] = useState("5");
  const [days, setDays] = useState("7");
  const [countries, setCountries] = useState("US");

  const parsedCountries = countries
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const dailyNum = Number(daily);
  const daysNum = Math.round(Number(days));
  const paramsValid =
    Number.isFinite(dailyNum) && dailyNum > 0 && Number.isFinite(daysNum) && daysNum >= 1 && daysNum <= 30 && parsedCountries.length > 0;

  const pick = async (it: BoostItem) => {
    setItem(it);
    setStep(1);
    setBusy("plan");
    setErr("");
    setBoostWarn("");
    setPlan(null);
    try {
      const d = await callTool("ads_plan", { itemId: it.id, channel: it.channel });
      if (d?.boostable === false) setBoostWarn(typeof d?.reason === "string" ? d.reason : "this item is not boostable");
      const p = (d?.plan ?? d ?? {}) as Partial<AdPlan>;
      setPlan(p);
      if (typeof p.suggestedDailyBudgetUsd === "number") setDaily(String(p.suggestedDailyBudgetUsd));
      if (typeof p.suggestedDurationDays === "number") setDays(String(p.suggestedDurationDays));
      if (Array.isArray(p.suggestedCountries) && p.suggestedCountries.length) setCountries(p.suggestedCountries.join(", "));
    } catch (e) {
      // The plan is advisory — its failure never blocks drafting by hand.
      setErr(e instanceof Error ? e.message : "plan failed");
    } finally {
      setBusy("");
    }
  };

  const saveDraft = async () => {
    if (!item || !paramsValid) return;
    setBusy("create");
    setErr("");
    try {
      const fullPlan =
        plan &&
        typeof plan.rationale === "string" &&
        typeof plan.suggestedDailyBudgetUsd === "number" &&
        typeof plan.suggestedDurationDays === "number" &&
        Array.isArray(plan.suggestedCountries)
          ? (plan as AdPlan)
          : undefined;
      await callTool("ads_create", {
        itemId: item.id,
        channel: item.channel,
        dailyBudgetUsd: dailyNum,
        durationDays: daysNum,
        countries: parsedCountries,
        ...(fullPlan ? { plan: fullPlan } : {}),
      });
      onDone("Boost draft saved — nothing spends until it is approved and launched.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "draft save failed");
      setBusy("");
    }
  };

  const STEPS = ["Pick a post", "Plan", "Review draft"];

  return (
    <Modal open onClose={onClose} title="Draft a boost" subtitle="Drafting is free — launch is a separate human gate." width={620}>
      {/* step rail */}
      <div className="ads-row" style={{ marginBottom: 16 }}>
        {STEPS.map((s, i) => (
          <span
            key={s}
            className="ads-meta"
            style={{ color: i === step ? "var(--text-primary)" : undefined, fontWeight: i === step ? 700 : 400 }}
          >
            {i + 1}. {s}
            {i < STEPS.length - 1 ? "  →" : ""}
          </span>
        ))}
      </div>

      {step === 0 && (
        <>
          {items.length === 0 ? (
            <div className="ads-empty" style={{ padding: "28px 18px" }}>
              <div className="sub">Nothing here can be boosted yet — publish a post to Instagram first.</div>
            </div>
          ) : (
            <div className="np-ideas" style={{ maxHeight: 380, overflowY: "auto" }}>
              {items.map((it) => (
                <button key={it.id} className="np-idea" onClick={() => pick(it)} type="button">
                  <div className="np-idea-top">
                    <span className="np-fmt">{channelNameOf(it.channel)}</span>
                    <span className="np-fmt">published {it.publishedAt.slice(0, 10)}</span>
                    {it.mood && <span className="np-mood">{it.mood.replace(/_/g, " ")}</span>}
                  </div>
                  <div className="np-idea-topic">{it.title}</div>
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={onClose} type="button">Cancel</button>
          </div>
        </>
      )}

      {step === 1 && item && (
        <>
          <div className="np-idea-topic" style={{ marginBottom: 2 }}>{item.title}</div>
          <span style={{ display: "inline-block", width: 180, color: "var(--text-muted)" }}>
            <InkUnderline />
          </span>

          {busy === "plan" && <div className="sub" style={{ margin: "14px 0" }}>Drafting a plan…</div>}

          {boostWarn && (
            <div style={{ margin: "12px 0", fontSize: 12.5, color: "var(--error)" }}>Not boostable: {boostWarn}</div>
          )}

          {plan?.rationale && (
            <div className="card" style={{ padding: 14, margin: "14px 0" }}>
              <div className="stat-label">Plan rationale</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, marginTop: 8, color: "var(--text-secondary)" }}>{plan.rationale}</div>
              {plan.hookNote && (
                <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 8, color: "var(--text-muted)" }}>
                  Hook: {plan.hookNote}
                </div>
              )}
            </div>
          )}
          {err && busy !== "plan" && (
            <div style={{ margin: "12px 0", fontSize: 12.5, color: "var(--warning, #e8b755)" }}>
              Plan unavailable ({err}) — set the budget by hand below.
            </div>
          )}

          {busy !== "plan" && (
            <div className="bw-budget-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 6 }}>
              <label>
                <span className="stat-label" style={{ display: "block", marginBottom: 6 }}>Daily budget (USD)</span>
                <input className="input" type="number" min={1} step={1} value={daily} onChange={(e) => setDaily(e.target.value)} />
              </label>
              <label>
                <span className="stat-label" style={{ display: "block", marginBottom: 6 }}>Duration (days, 1–30)</span>
                <input className="input" type="number" min={1} max={30} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                <span className="stat-label" style={{ display: "block", marginBottom: 6 }}>Countries (ISO codes, comma-separated)</span>
                <input className="input" value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="US, GB, DE" />
              </label>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={() => { setStep(0); setErr(""); }} type="button">Back</button>
            <button className="btn btn-primary" onClick={() => { setStep(2); setErr(""); }} disabled={busy === "plan" || !paramsValid} type="button">
              Review
            </button>
          </div>
        </>
      )}

      {step === 2 && item && (
        <>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div className="stat-label">Draft summary</div>
            <div style={{ fontSize: 14.5, fontWeight: 600, marginTop: 10 }}>{item.title}</div>
            <div className="ads-row" style={{ marginTop: 8 }}>
              <span className="ads-money">
                {fmtUsd(dailyNum)}/day × {daysNum}d = {fmtUsd(dailyNum * daysNum)}
              </span>
              <span className="ads-meta">→ {parsedCountries.join(", ")}</span>
              <span className="ads-meta">{channelNameOf(item.channel)}</span>
            </div>
          </div>
          <div className="sub" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.55 }}>
            Saves a DRAFT only. Spending requires the approve gate and then a dry-run-first launch — both separate,
            explicit steps.
          </div>
          {err && <div style={{ marginBottom: 12, fontSize: 12.5, color: "var(--error)" }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => { setStep(1); setErr(""); }} type="button">Back</button>
            <button className="btn btn-primary" onClick={saveDraft} disabled={busy === "create" || !paramsValid} type="button">
              {busy === "create" ? "Saving…" : "Save draft"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
