import { hasOpenRouterKey, makeModel } from "../../../../lib/agent/openrouter";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* ─── Website → brand DNA ───────────────────────────────────────────────────
   Fetch a homepage, pull the obvious brand signals from the markup (name, tagline,
   logo candidates, theme colour), then — if an OpenRouter key is set — ask the
   model to draft the deeper DNA (audience, tone, visual style, archetype, theme,
   hooks, banned). Everything returned is a SUGGESTION the wizard pre-fills and the
   user can override. */

function abs(href: string, base: URL): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
function meta(html: string, re: RegExp): string | undefined {
  const m = re.exec(html);
  return m ? decodeHtml(m[1].trim()) : undefined;
}
function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

const THEMES = ["concept", "lab", "builder", "magma", "cognitivx"] as const;

export async function GET(req: Request) {
  // Crawling drafts a new brand — only brand managers may run it.
  const ctx = await currentContext();
  try {
    assertCan(ctx, "brand.manage");
  } catch {
    return forbidden("brand.manage");
  }

  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return Response.json({ error: "missing url" }, { status: 400 });
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return Response.json({ error: "invalid url" }, { status: 400 });
  }

  let html = "";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SocheliBrandBot/1.0)", Accept: "text/html" },
    });
    clearTimeout(to);
    if (!res.ok) return Response.json({ error: `site returned ${res.status}` }, { status: 502 });
    html = (await res.text()).slice(0, 600_000);
  } catch {
    return Response.json({ error: "could not reach the site" }, { status: 502 });
  }

  const title = meta(html, /<title[^>]*>([^<]+)<\/title>/i);
  const ogSite = meta(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  const ogTitle = meta(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const ogDesc = meta(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const metaDesc = meta(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  const themeColor = meta(html, /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);

  // logo candidates, most-specific first
  const logos: string[] = [];
  const push = (h?: string) => h && logos.push(abs(h, url));
  push(meta(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i));
  push(meta(html, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i));
  for (const m of html.matchAll(/<link[^>]+rel=["'][^"']*(?:apple-touch-icon|icon|shortcut icon)[^"']*["'][^>]+href=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*(?:apple-touch-icon|icon)[^"']*["']/gi)) push(m[1]);
  push(abs("/favicon.ico", url));
  const logoCandidates = [...new Set(logos)].slice(0, 8);

  const name = (ogSite || ogTitle || title || url.hostname.replace(/^www\./, "")).split(/[|–—·-]/)[0].trim();
  const slogan = ogDesc || metaDesc || "";

  const draft: Record<string, unknown> = {
    name,
    slogan,
    website: url.toString(),
    accent: themeColor && /^#?[0-9a-f]{3,8}$/i.test(themeColor) ? (themeColor.startsWith("#") ? themeColor : `#${themeColor}`) : undefined,
    logoCandidates,
    logo: logoCandidates[0],
  };

  // optional AI draft of the deeper brand DNA
  if (hasOpenRouterKey()) {
    try {
      const model = makeModel({ streaming: false, temperature: 0.4 });
      const prompt = `You are a brand strategist. From this website, draft a faceless-video channel's DNA.
SITE: ${url.toString()}
NAME: ${name}
TAGLINE/DESCRIPTION: ${slogan}
PAGE TEXT (excerpt): ${html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2500)}

Return ONLY minified JSON with exactly these keys:
{"audience": "<who the videos are for, one sentence>",
 "tone": "<the voice/tone in 6-12 words>",
 "visualStyle": "<the on-screen look in 6-14 words>",
 "archetype": "<editorial archetype: how this brand conceives a video, 1-2 sentences>",
 "theme": "<one of: concept | lab | builder | magma | cognitivx — closest visual theme>",
 "slogan": "<a punchy 3-7 word tagline>",
 "preferredHooks": ["<hook shape>", "<hook shape>", "<hook shape>"],
 "bannedPatterns": ["<thing to never do>", "<thing to never do>", "<thing to never do>"]}`;
      const out = await model.invoke(prompt);
      const text = typeof out.content === "string" ? out.content : Array.isArray(out.content) ? out.content.map((c: any) => (typeof c === "string" ? c : c.text ?? "")).join("") : "";
      const jm = /\{[\s\S]*\}/.exec(text);
      if (jm) {
        const ai = JSON.parse(jm[0]) as Record<string, unknown>;
        for (const k of ["audience", "tone", "visualStyle", "archetype", "preferredHooks", "bannedPatterns"]) {
          if (ai[k] != null) draft[k] = ai[k];
        }
        if (typeof ai.slogan === "string" && ai.slogan) draft.slogan = ai.slogan;
        if (typeof ai.theme === "string" && (THEMES as readonly string[]).includes(ai.theme)) draft.theme = ai.theme;
        draft.aiDrafted = true;
      }
    } catch {
      /* AI draft is best-effort — meta fields still pre-fill */
    }
  }

  return Response.json({ draft });
}
