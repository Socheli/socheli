import { auth } from "@clerk/nextjs/server";
import { googleStatus, syncToGoogle } from "../../../../lib/google-calendar";

/* Google Calendar connection (Desktop-client / refresh-token model):
   GET status, POST to push the plan. Connecting is a one-time CLI step
   (scripts/mint-google-cal-token.mjs), not an in-app flow. */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response("unauthorized", { status: 401 });
  return Response.json(googleStatus());
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new Response("unauthorized", { status: 401 });
  const result = await syncToGoogle();
  return Response.json(result, { status: result.error ? 400 : 200 });
}
