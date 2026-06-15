"use client";
import { useState } from "react";
import { useOrganizationList } from "@clerk/nextjs";
import { Field, Notice } from "../Modal";

/* Custom create-organization form — replaces Clerk's <CreateOrganization>. */
export function CreateOrgForm({ onDone, compact }: { onDone?: (id: string) => void; compact?: boolean }) {
  const { createOrganization, setActive, isLoaded } = useOrganizationList();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const create = async () => {
    if (!isLoaded) return;
    setBusy(true); setErr("");
    try {
      const org = await createOrganization!({ name });
      await setActive!({ organization: org.id });
      onDone?.(org.id);
    } catch (e: any) { setErr(e?.errors?.[0]?.longMessage ?? e?.message ?? "Could not create organization"); }
    setBusy(false);
  };

  return (
    <div>
      <Notice>{err}</Notice>
      <Field label="Organization name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Studio" onKeyDown={(e) => e.key === "Enter" && name && create()} /></Field>
      <div style={{ display: "flex", justifyContent: compact ? "flex-end" : "flex-start" }}>
        <button className="btn btn-primary" onClick={create} disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create organization"}</button>
      </div>
    </div>
  );
}
