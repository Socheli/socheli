"use client";
import { useEffect, useRef, useState } from "react";
import { useUser, useClerk } from "@clerk/nextjs";
import { Modal, Field, Notice } from "../Modal";
import { confirmDialog } from "../confirm";

/* Custom account management — fully replaces Clerk's <UserProfile>. Built on the
   useUser() resource: profile, email addresses (with code verification), password,
   active sessions, and account deletion. Styled like the rest of the platform. */

export function AccountSettings() {
  const { user, isLoaded } = useUser();
  if (!isLoaded || !user) return <div className="card"><div className="sub">Loading account…</div></div>;
  return (
    <div className="card" style={{ padding: "4px 22px" }}>
      <ProfileSection />
      <EmailSection />
      <PasswordSection />
      <SessionsSection />
      <DangerSection />
    </div>
  );
}

const Initials = ({ name, size = 56 }: { name?: string; size?: number }) => (
  <span style={{ width: size, height: size, borderRadius: "50%", background: "var(--accent-surface)", border: "1px solid var(--border-subtle)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.4, fontWeight: 600 }}>{(name ?? "?")[0]?.toUpperCase()}</span>
);

function ProfileSection() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState(user!.firstName ?? "");
  const [last, setLast] = useState(user!.lastName ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    setBusy(true); setErr("");
    try { await user!.update({ firstName: first, lastName: last }); setOpen(false); }
    catch (e: any) { setErr(e?.errors?.[0]?.longMessage ?? e?.message ?? "Could not update"); }
    setBusy(false);
  };
  const pickAvatar = async (f: File) => {
    setBusy(true); setErr("");
    try { await user!.setProfileImage({ file: f }); await user!.reload(); }
    catch (e: any) { setErr(e?.errors?.[0]?.longMessage ?? "Upload failed"); }
    setBusy(false);
  };

  return (
    <div className="set-section">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {user!.hasImage ? <img src={user!.imageUrl} alt="" className="set-avatar" /> : <Initials name={user!.fullName ?? user!.primaryEmailAddress?.emailAddress} />}
        <div style={{ flex: 1 }}>
          <div className="set-section-title">{user!.fullName || "Add your name"}</div>
          <div className="set-section-sub">{user!.primaryEmailAddress?.emailAddress}</div>
        </div>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy} style={{ padding: "8px 14px", fontSize: 12 }}>Photo</button>
        <button className="btn" onClick={() => setOpen(true)} style={{ padding: "8px 14px", fontSize: 12 }}>Edit</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])} />
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit profile" width={420}>
        <Notice>{err}</Notice>
        <Field label="First name"><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
        <Field label="Last name"><input className="input" value={last} onChange={(e) => setLast(e.target.value)} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </Modal>
    </div>
  );
}

function EmailSection() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"enter" | "verify">("enter");
  const [pending, setPending] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const start = async () => {
    setBusy(true); setErr("");
    try {
      const e = await user!.createEmailAddress({ email });
      await e.prepareVerification({ strategy: "email_code" });
      setPending(e); setStage("verify");
    } catch (x: any) { setErr(x?.errors?.[0]?.longMessage ?? "Could not add email"); }
    setBusy(false);
  };
  const verify = async () => {
    setBusy(true); setErr("");
    try { await pending.attemptVerification({ code }); await user!.reload(); reset(); }
    catch (x: any) { setErr(x?.errors?.[0]?.longMessage ?? "Invalid code"); }
    setBusy(false);
  };
  const reset = () => { setOpen(false); setEmail(""); setCode(""); setStage("enter"); setPending(null); setErr(""); };
  const remove = async (id: string) => { const ea = user!.emailAddresses.find((e) => e.id === id); if (ea && await confirmDialog({ title: "Remove this email?", confirmText: "Remove", danger: true })) { await ea.destroy(); await user!.reload(); } };
  const makePrimary = async (id: string) => { await user!.update({ primaryEmailAddressId: id }); await user!.reload(); };

  return (
    <div className="set-section">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <div><div className="set-section-title">Email addresses</div><div className="set-section-sub">Used to sign in and for notifications.</div></div>
        <button className="btn" onClick={() => setOpen(true)} style={{ marginLeft: "auto", padding: "8px 14px", fontSize: 12 }}>+ Add email</button>
      </div>
      {user!.emailAddresses.map((e) => (
        <div key={e.id} className="set-row">
          <span style={{ flex: 1 }}>{e.emailAddress}</span>
          {e.id === user!.primaryEmailAddressId && <span className="badge b-accent"><span className="d" />primary</span>}
          {e.verification?.status !== "verified" && <span className="badge b-warn"><span className="d" />unverified</span>}
          {e.id !== user!.primaryEmailAddressId && e.verification?.status === "verified" && <button className="btn" onClick={() => makePrimary(e.id)} style={{ padding: "5px 10px", fontSize: 11 }}>Make primary</button>}
          {user!.emailAddresses.length > 1 && <button className="btn danger" onClick={() => remove(e.id)} style={{ padding: "5px 10px", fontSize: 11 }}>Remove</button>}
        </div>
      ))}
      <Modal open={open} onClose={reset} title="Add email address" subtitle={stage === "verify" ? "Enter the code we sent." : undefined} width={420}>
        <Notice>{err}</Notice>
        {stage === "enter" ? (
          <>
            <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" onClick={reset}>Cancel</button><button className="btn btn-primary" onClick={start} disabled={busy || !email}>{busy ? "Sending…" : "Send code"}</button></div>
          </>
        ) : (
          <>
            <Field label={`Verification code sent to ${email}`}><input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" /></Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" onClick={() => setStage("enter")}>Back</button><button className="btn btn-primary" onClick={verify} disabled={busy || !code}>{busy ? "Verifying…" : "Verify"}</button></div>
          </>
        )}
      </Modal>
    </div>
  );
}

function PasswordSection() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [ok, setOk] = useState("");

  const save = async () => {
    setBusy(true); setErr(""); setOk("");
    try { await user!.updatePassword({ newPassword: next, ...(user!.passwordEnabled ? { currentPassword: cur } : {}), signOutOfOtherSessions: true }); setOk("Password updated."); setCur(""); setNext(""); setTimeout(() => setOpen(false), 900); }
    catch (x: any) { setErr(x?.errors?.[0]?.longMessage ?? "Could not update password"); }
    setBusy(false);
  };

  return (
    <div className="set-section">
      <div style={{ display: "flex", alignItems: "center" }}>
        <div><div className="set-section-title">Password</div><div className="set-section-sub">{user!.passwordEnabled ? "Set — change it anytime." : "Not set — add one for password sign-in."}</div></div>
        <button className="btn" onClick={() => setOpen(true)} style={{ marginLeft: "auto", padding: "8px 14px", fontSize: 12 }}>{user!.passwordEnabled ? "Change" : "Set password"}</button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={user!.passwordEnabled ? "Change password" : "Set password"} width={420}>
        <Notice>{err}</Notice><Notice kind="ok">{ok}</Notice>
        {user!.passwordEnabled && <Field label="Current password"><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>}
        <Field label="New password" hint="At least 8 characters."><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={busy || next.length < 8}>{busy ? "Saving…" : "Save"}</button></div>
      </Modal>
    </div>
  );
}

function SessionsSection() {
  const { user } = useUser();
  const { session: activeSession } = useClerk();
  const [sessions, setSessions] = useState<any[]>([]);
  useEffect(() => { user!.getSessions().then(setSessions).catch(() => {}); }, [user]);
  const revoke = async (s: any) => { if (await confirmDialog({ title: "Sign out this device?", message: "This device will need to sign in again.", confirmText: "Sign out", danger: true })) { await s.revoke(); setSessions((xs) => xs.filter((x) => x.id !== s.id)); } };
  return (
    <div className="set-section">
      <div className="set-section-title">Active devices</div>
      <div className="set-section-sub" style={{ marginBottom: 6 }}>Where you're signed in. Revoke any you don't recognize.</div>
      {sessions.length === 0 && <div className="sub" style={{ padding: "8px 0" }}>This device only.</div>}
      {sessions.map((s) => {
        const a = s.latestActivity ?? {};
        const isCurrent = s.id === activeSession?.id;
        return (
          <div key={s.id} className="set-row">
            <span style={{ flex: 1 }}>{[a.browserName, a.deviceType, a.city, a.country].filter(Boolean).join(" · ") || "Unknown device"}{isCurrent && <span className="badge b-ok" style={{ marginLeft: 8 }}><span className="d" />this device</span>}</span>
            {!isCurrent && <button className="btn danger" onClick={() => revoke(s)} style={{ padding: "5px 10px", fontSize: 11 }}>Sign out</button>}
          </div>
        );
      })}
    </div>
  );
}

function DangerSection() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [confirmTxt, setConfirmTxt] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const del = async () => {
    setBusy(true); setErr("");
    try { await user!.delete(); await signOut({ redirectUrl: "/sign-in" }); }
    catch (x: any) { setErr(x?.errors?.[0]?.longMessage ?? "Could not delete"); setBusy(false); }
  };
  return (
    <div className="set-section">
      <div style={{ display: "flex", alignItems: "center" }}>
        <div><div className="set-section-title" style={{ color: "var(--error)" }}>Delete account</div><div className="set-section-sub">Permanently remove your account and data.</div></div>
        <button className="btn danger" onClick={() => setOpen(true)} style={{ marginLeft: "auto", padding: "8px 14px", fontSize: 12 }}>Delete</button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete account" subtitle="This cannot be undone." width={420}>
        <Notice>{err}</Notice>
        <Field label='Type "DELETE" to confirm'><input className="input" value={confirmTxt} onChange={(e) => setConfirmTxt(e.target.value)} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn danger" onClick={del} disabled={busy || confirmTxt !== "DELETE"}>{busy ? "Deleting…" : "Delete account"}</button></div>
      </Modal>
    </div>
  );
}
