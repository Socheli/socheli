import { loadPlan } from "./content-plan";

/* Minimal Notion integration: push the content plan into a Notion database so the
   plan shows up in Notion's (excellent) calendar/board views. Uses the Notion REST
   API with a token + database id from the environment. No SDK dependency.

   Setup: create an internal integration at notion.so/my-integrations, share the
   target database with it, then set NOTION_TOKEN + NOTION_DATABASE_ID. */

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

const CHANNEL_NAMES: Record<string, string> = {
  labrinox: "Labrinox", claude_code_lab: "Code Labrinox", agentic_builder: "Agentic Builder", moltjobs: "MoltJobs", cognitivx: "iCog",
};

export type NotionStatus = { connected: boolean; hasToken: boolean; hasDatabase: boolean; databaseTitle?: string; error?: string };

function creds() {
  return { token: process.env.NOTION_TOKEN || "", database: process.env.NOTION_DATABASE_ID || "" };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}

/* Discover the database's title (and the names of its title + date properties). */
async function describeDatabase(token: string, database: string): Promise<{ title: string; titleProp: string; dateProp?: string }> {
  const res = await fetch(`${API}/databases/${database}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const db = (await res.json()) as { title?: { plain_text?: string }[]; properties?: Record<string, { type: string }> };
  const props = db.properties ?? {};
  const titleProp = Object.keys(props).find((k) => props[k].type === "title") ?? "Name";
  const dateProp = Object.keys(props).find((k) => props[k].type === "date");
  const title = db.title?.map((t) => t.plain_text).join("") || "Notion database";
  return { title, titleProp, dateProp };
}

export async function notionStatus(): Promise<NotionStatus> {
  const { token, database } = creds();
  const base = { connected: false, hasToken: !!token, hasDatabase: !!database };
  if (!token || !database) return base;
  try {
    const d = await describeDatabase(token, database);
    return { ...base, connected: true, databaseTitle: d.title };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "connection failed" };
  }
}

/* Push every non-dropped planned post to the Notion database. Idempotency is
   best-effort: callers can clear and re-sync; we don't dedupe server-side yet. */
export async function syncPlanToNotion(): Promise<{ created: number; skipped: number; error?: string }> {
  const { token, database } = creds();
  if (!token || !database) return { created: 0, skipped: 0, error: "NOTION_TOKEN + NOTION_DATABASE_ID required" };
  let desc;
  try {
    desc = await describeDatabase(token, database);
  } catch (e) {
    return { created: 0, skipped: 0, error: e instanceof Error ? e.message : "describe failed" };
  }
  const posts = loadPlan().filter((p) => p.status !== "dropped");
  let created = 0;
  let skipped = 0;
  for (const p of posts) {
    const title = `[${CHANNEL_NAMES[p.channel] ?? p.channel} · ${p.platform}] ${p.topic}`;
    const properties: Record<string, unknown> = {
      [desc.titleProp]: { title: [{ text: { content: title.slice(0, 200) } }] },
    };
    if (desc.dateProp) properties[desc.dateProp] = { date: { start: `${p.date}T${p.time}:00` } };
    const body = {
      parent: { database_id: database },
      properties,
      children: [
        { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: p.angle.slice(0, 1800) } }] } },
        ...(p.algoLever ? [{ object: "block", type: "callout", callout: { rich_text: [{ text: { content: `Algo lever: ${p.algoLever}` } }] } }] : []),
      ],
    };
    try {
      const res = await fetch(`${API}/pages`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
      if (res.ok) created++;
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { created, skipped };
}
