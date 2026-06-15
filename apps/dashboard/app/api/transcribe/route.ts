import { hasOpenRouterKey } from "../../../lib/agent/openrouter";
import { currentContext } from "../../../lib/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Voice transcription for the Soli composer.
   POST { audio: <base64 audio>, mime: "audio/webm;codecs=opus" } -> { text } | { error }.

   Auth mirrors /api/agent: Clerk middleware already requires a session on every
   /api route, and the caller's tenant is re-resolved server-side from that
   session — NEVER from the request body. The audio is held in memory only for
   the duration of the upstream call; it is never logged and never persisted. */

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TRANSCRIBE_MODEL = "google/gemini-2.5-flash";

/* ~2.5MB of raw audio (≈60s of opus); base64 inflates by 4/3. */
const MAX_AUDIO_BYTES = 2.5 * 1024 * 1024;
const MAX_AUDIO_B64 = Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/* "audio/webm;codecs=opus" -> "webm". Normalize the odd MIME spellings to the
   format tokens OpenRouter's input_audio part expects. */
function audioFormat(mime: unknown): string {
  const subtype =
    String(mime ?? "").split(";")[0].split("/").pop()?.trim().toLowerCase() || "";
  if (subtype === "mpeg" || subtype === "mpga") return "mp3";
  if (subtype === "m4a" || subtype === "x-m4a") return "mp4";
  return subtype || "webm";
}

export async function POST(req: Request): Promise<Response> {
  // Same gating as /api/agent: session-resolved tenant, body never trusted.
  const tenant = await currentContext();
  if (!tenant.userId) return jsonError("unauthorized", 401);

  if (!hasOpenRouterKey()) {
    return jsonError("Set OPENROUTER_API_KEY to enable voice transcription.", 503);
  }

  const body = (await req.json().catch(() => ({}))) as { audio?: unknown; mime?: unknown };
  const audio = typeof body.audio === "string" ? body.audio.trim() : "";
  if (!audio) return jsonError("missing audio", 400);
  if (audio.length > MAX_AUDIO_B64) return jsonError("audio too large (max ~2.5MB)", 413);
  if (!/^[A-Za-z0-9+/=]+$/.test(audio)) return jsonError("audio must be base64", 400);

  const model = process.env.TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;

  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // Same attribution headers as lib/agent/openrouter.ts.
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://app.socheli.com",
        "X-Title": process.env.OPENROUTER_APP_NAME || "Soli",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Transcribe this audio verbatim. Return ONLY the transcription.",
              },
              {
                type: "input_audio",
                input_audio: { data: audio, format: audioFormat(body.mime) },
              },
            ],
          },
        ],
      }),
    });
  } catch {
    return jsonError("transcription service unreachable", 502);
  }

  let data: {
    choices?: { message?: { content?: unknown } }[];
    error?: { message?: string };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return jsonError("bad response from transcription model", 502);
  }
  if (!res.ok) {
    const message =
      typeof data?.error?.message === "string" && data.error.message
        ? data.error.message
        : `transcription failed (${res.status})`;
    return jsonError(message, 502);
  }

  // Content is a plain string for most models, an array of parts for some.
  const content = data.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((p) =>
              p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
                ? (p as { text: string }).text
                : "",
            )
            .join("")
        : "";
  const trimmed = text.trim();
  if (!trimmed) return jsonError("empty transcription", 502);

  return Response.json({ text: trimmed });
}
