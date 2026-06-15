"use client";

import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Modal } from "./Modal";

/* Promise-based confirm/prompt that replace the native browser dialogs
   (window.confirm / window.alert / window.prompt). Built on <Modal>, so every
   confirmation looks like the rest of the platform — themed dark, blurred
   backdrop, Escape/backdrop to cancel — instead of an "app.socheli.com says…"
   system box. Usage:

     if (await confirmDialog({ title: "Delete this?", danger: true })) …
     const name = await promptDialog({ title: "Rename", defaultValue: cur });
*/

type ConfirmOpts = { title: string; message?: ReactNode; confirmText?: string; cancelText?: string; danger?: boolean };
type PromptOpts = { title: string; message?: ReactNode; defaultValue?: string; placeholder?: string; confirmText?: string; cancelText?: string };

// Mount a transient dialog into its own root and tear it down once resolved.
function mount<T>(render: (done: (value: T) => void) => ReactNode): Promise<T> {
  return new Promise<T>((resolve) => {
    if (typeof document === "undefined") return;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (value: T) => {
      resolve(value);
      // Defer teardown so the closing render commits first.
      setTimeout(() => { root.unmount(); host.remove(); }, 0);
    };
    root.render(render(done));
  });
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return mount<boolean>((done) => <ConfirmCard opts={opts} done={done} />);
}

export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return mount<string | null>((done) => <PromptCard opts={opts} done={done} />);
}

type AlertOpts = { title: string; message?: ReactNode; confirmText?: string; danger?: boolean };
export function alertDialog(opts: AlertOpts): Promise<void> {
  return mount<void>((done) => <AlertCard opts={opts} done={done} />);
}

function AlertCard({ opts, done }: { opts: AlertOpts; done: (v: void) => void }) {
  const [open, setOpen] = useState(true);
  const close = () => { setOpen(false); done(); };
  return (
    <Modal open={open} onClose={close} title={opts.title} width={420}>
      {opts.message && <div className="sub" style={{ marginBottom: 18, lineHeight: 1.55 }}>{opts.message}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className={opts.danger ? "btn danger" : "btn btn-primary"} autoFocus onClick={close}>{opts.confirmText ?? "OK"}</button>
      </div>
    </Modal>
  );
}

function ConfirmCard({ opts, done }: { opts: ConfirmOpts; done: (v: boolean) => void }) {
  const [open, setOpen] = useState(true);
  const close = (v: boolean) => { setOpen(false); done(v); };
  return (
    <Modal open={open} onClose={() => close(false)} title={opts.title} width={420}>
      {opts.message && <div className="sub" style={{ marginBottom: 18, lineHeight: 1.55 }}>{opts.message}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => close(false)}>{opts.cancelText ?? "Cancel"}</button>
        <button className={opts.danger ? "btn danger" : "btn btn-primary"} autoFocus onClick={() => close(true)}>{opts.confirmText ?? "Confirm"}</button>
      </div>
    </Modal>
  );
}

function PromptCard({ opts, done }: { opts: PromptOpts; done: (v: string | null) => void }) {
  const [open, setOpen] = useState(true);
  const [val, setVal] = useState(opts.defaultValue ?? "");
  const close = (v: string | null) => { setOpen(false); done(v); };
  const submit = () => { const t = val.trim(); close(t ? t : null); };
  return (
    <Modal open={open} onClose={() => close(null)} title={opts.title} width={420}>
      {opts.message && <div className="sub" style={{ marginBottom: 12, lineHeight: 1.55 }}>{opts.message}</div>}
      <input
        className="input"
        autoFocus
        value={val}
        placeholder={opts.placeholder}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        style={{ marginBottom: 16 }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => close(null)}>{opts.cancelText ?? "Cancel"}</button>
        <button className="btn btn-primary" onClick={submit}>{opts.confirmText ?? "Save"}</button>
      </div>
    </Modal>
  );
}
