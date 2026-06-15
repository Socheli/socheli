import { loadMetaFor, addEntry, updateEntry, removeEntry, type MetaEntry } from "../../../../lib/calendar-meta";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

/* Calendar annotations API — notes + reminders per day (data/calendar-meta.json).
   GET [?date=] → entries (optionally for one day), scoped to the caller's workspace.
   POST   → add a note/reminder (stamped with workspace + author).
   PATCH  → edit text / toggle reminder done / move date / set assignee.
   DELETE → remove (?id=).
   Reads scope to ctx.workspaceId; mutations gate on `calendar.edit` + audit. */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentContext();
  const date = new URL(req.url).searchParams.get("date");
  let entries = loadMetaFor(ctx.workspaceId);
  if (date) entries = entries.filter((e) => e.date === date);
  return Response.json({ entries });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "calendar.edit");
  } catch {
    return forbidden("calendar.edit");
  }
  const b = (await req.json().catch(() => ({}))) as Partial<MetaEntry>;
  if (!b.date || !b.text?.trim()) return Response.json({ error: "date and text required" }, { status: 400 });
  const entry = addEntry(
    {
      date: b.date,
      kind: b.kind === "reminder" ? "reminder" : "note",
      text: b.text.trim(),
      channel: b.channel,
      remindAt: b.remindAt,
      assignee: b.assignee,
      done: false,
    },
    ctx,
  );
  audit(ctx, "calendar.meta.add", entry.id, { kind: entry.kind, date: entry.date });
  return Response.json({ ok: true, entry });
}

export async function PATCH(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "calendar.edit");
  } catch {
    return forbidden("calendar.edit");
  }
  const b = (await req.json().catch(() => ({}))) as { id?: string } & Partial<MetaEntry>;
  if (!b.id) return Response.json({ error: "id required" }, { status: 400 });
  const { id, ...patch } = b;
  const entry = updateEntry(id, patch, ctx.workspaceId);
  if (!entry) return Response.json({ error: "not found" }, { status: 404 });
  audit(ctx, "calendar.meta.update", id, { fields: Object.keys(patch) });
  return Response.json({ ok: true, entry });
}

export async function DELETE(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "calendar.edit");
  } catch {
    return forbidden("calendar.edit");
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const ok = removeEntry(id, ctx.workspaceId);
  if (ok) audit(ctx, "calendar.meta.remove", id);
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
