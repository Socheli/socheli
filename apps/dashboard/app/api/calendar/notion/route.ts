import { notionStatus, syncPlanToNotion } from "../../../../lib/notion";

/* Notion connection: GET status, POST to sync the content plan into the database. */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return Response.json(await notionStatus());
}

export async function POST() {
  const result = await syncPlanToNotion();
  return Response.json(result, { status: result.error ? 400 : 200 });
}
