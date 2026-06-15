"use client";
import { useMemo, type JSX } from "react";

/* SafeHtml — SECURITY BOUNDARY for model-generated HTML/CSS/SVG.

   Soli can hand-author a custom HTML/CSS/SVG "dashboard" (via the `html`
   ui_render block) when none of the ~52 fixed block types fit. That markup
   comes from a language model, so it is treated as HOSTILE input — but unlike
   SafeSketch (which allowlists SVG element-by-element), arbitrary HTML+CSS is
   too large a surface to sanitize by allowlist. So we do NOT sanitize at all:
   we render it inside a fully LOCKED sandboxed <iframe>.

   WHY THIS IS XSS-PROOF BY CONSTRUCTION:
   - sandbox="" (empty token list) is the *maximally restrictive* setting. It
     applies ALL sandbox restrictions:
       · scripts CANNOT run (no <script>, no inline on* handlers, no
         javascript: URLs, no SVG <script>/<animate> side effects) — so the
         markup's content is inert no matter what it contains;
       · the frame is forced into a UNIQUE OPAQUE ORIGIN — it has no
         same-origin access, so even if a script *did* somehow run it could not
         read the parent document, cookies, localStorage, or Clerk session;
       · forms cannot submit, popups cannot open, top-level navigation is
         blocked, pointer-lock / presentation / downloads are all denied.
     We deliberately do NOT add `allow-scripts` or `allow-same-origin`. Adding
     EITHER would defeat the isolation; the two together would fully break it
     (the spec warns the embedder can then remove the sandbox attribute from
     itself). We need neither — the block is a STATIC visualization.
   - srcdoc carries the document inline (no network fetch, no extra origin to
     trust). referrerpolicy=no-referrer and a restrictive CSP <meta> are added
     as defense-in-depth even though the empty sandbox already blocks loads.

   Because the frame can never execute JS, there is no way for the markup to
   auto-resize itself. We therefore render at a FIXED, caller-hinted height with
   internal scrolling. Do not "improve" this by adding allow-scripts to enable
   auto-resize — that trades the entire security model for a cosmetic fit. */

const MAX_HTML_LEN = 20000;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 420;

/* House tokens injected so Soli's markup inherits the Socheli ink look without
   the author having to know the palette. The body is transparent so the iframe
   sits flush on the chat's ink background; bone (#ECE6D8) text + Inter/JBMono
   match the rest of the surface. Authors may override locally with inline
   styles — this only sets the defaults. The CSP meta is belt-and-suspenders:
   the empty sandbox already blocks scripts and network; this makes a
   policy-violation explicit (and blocks any external image/font/style too). */
function wrapDoc(html: string, clampedHeight: number): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">
<style>
  :root {
    --bone: #ECE6D8;
    --ink: #0a0a0a;
    --muted: rgba(236, 230, 216, 0.55);
    --line: rgba(236, 230, 216, 0.16);
    --accent: #e8c46b;
    --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--bone);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  body { padding: 12px; box-sizing: border-box; min-height: ${clampedHeight}px; }
  *, *::before, *::after { box-sizing: border-box; }
  a { color: var(--accent); }
  code, pre, .mono { font-family: var(--font-mono); }
  table { border-collapse: collapse; }
  th, td { border-color: var(--line); }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
</style>
</head>
<body>${html}</body>
</html>`;
}

export function SafeHtml({
  html,
  caption,
  height,
  className,
}: {
  html: string;
  caption?: string;
  height?: number;
  className?: string;
}): JSX.Element | null {
  const srcDoc = useMemo(() => {
    if (typeof html !== "string") return null;
    if (!html.trim()) return null;
    // Hard cap: oversized payloads are dropped rather than truncated mid-tag.
    if (html.length > MAX_HTML_LEN) return null;
    const px = Number.isFinite(height) && height ? Math.round(height as number) : DEFAULT_HEIGHT;
    const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, px));
    return { doc: wrapDoc(html, clamped), clamped };
  }, [html, height]);

  if (!srcDoc) return null;

  return (
    <figure className={`gu-html${className ? ` ${className}` : ""}`}>
      <iframe
        className="gu-html-frame"
        /* Empty sandbox = no scripts, opaque origin, no forms/popups/nav.
           XSS-proof by construction: the document below can never execute. */
        sandbox=""
        srcDoc={srcDoc.doc}
        referrerPolicy="no-referrer"
        loading="lazy"
        title={caption || "custom visualization"}
        aria-label={caption || "custom visualization"}
        style={{ height: srcDoc.clamped }}
      />
      {caption ? <figcaption className="gu-html-cap">{caption}</figcaption> : null}
    </figure>
  );
}

export default SafeHtml;
