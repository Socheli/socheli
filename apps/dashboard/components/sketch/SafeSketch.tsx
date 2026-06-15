"use client";
import { useEffect, useMemo, useState, type JSX } from "react";

/* SafeSketch — SECURITY BOUNDARY for model-generated SVG.

   Soli can hand-draw explanatory ink sketches as raw SVG markup (via a
   `sketch` ui_render block or a ```sketch code fence). That markup comes from
   a language model, so it is treated as HOSTILE input. This component is the
   single sanitizer between that input and the DOM:

   - parse with DOMParser as XML (image/svg+xml) — never as HTML;
   - strict ELEMENT allowlist (anything else is removed WITH its subtree:
     script, foreignObject, image, animate, set, iframe, …);
   - strict ATTRIBUTE allowlist (every `on*` handler stripped, `style`
     stripped, href/xlink:href only for same-document "#…" references);
   - hard input-size cap; reject on any parse error or non-<svg> root.

   The sanitized tree is re-serialized and injected with
   dangerouslySetInnerHTML. That is the ONLY acceptable use of
   dangerouslySetInnerHTML here, because the markup it receives is the output
   of THIS sanitizer — never the model's raw string. Do not "simplify" this
   to render the input directly. */

const MAX_SVG_LEN = 20000;

/* Exact element allowlist (SVG names are case-sensitive: clipPath). */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "rect",
  "text",
  "use",
  "defs",
  "clipPath",
]);

/* Exact attribute allowlist. href/xlink:href are handled separately (allowed
   only when the value is a same-document "#…" reference). */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  "d",
  "points",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "transform",
  "pathLength",
  "font-size",
  "font-family",
  "text-anchor",
  "clip-path",
  "id",
  "class",
]);

const HREF_ATTRS: ReadonlySet<string> = new Set(["href", "xlink:href"]);

function sanitizeAttributes(el: Element): void {
  // Snapshot first: removing while iterating a live NamedNodeMap skips items.
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    // Same-document references only ("#id"); any other target is stripped.
    if (HREF_ATTRS.has(name)) {
      if (!attr.value.trim().startsWith("#")) el.removeAttributeNode(attr);
      continue;
    }
    // Event handlers (onload, onerror, onclick, …) and style: always stripped.
    if (name.toLowerCase().startsWith("on") || !ALLOWED_ATTRS.has(name)) {
      el.removeAttributeNode(attr);
    }
  }
}

function sanitizeTree(el: Element): void {
  sanitizeAttributes(el);
  // Snapshot children before mutating the tree underneath us.
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;
      if (!ALLOWED_ELEMENTS.has(childEl.tagName)) {
        // Remove the element WITH its whole subtree — never unwrap, so nothing
        // nested inside a hostile element survives.
        childEl.remove();
      } else {
        sanitizeTree(childEl);
      }
    } else if (
      child.nodeType !== Node.TEXT_NODE &&
      child.nodeType !== Node.CDATA_SECTION_NODE
    ) {
      // Comments, processing instructions, etc. carry no value — drop them.
      child.remove();
    }
  }
}

/* Returns sanitized SVG markup, or null when the input must not render. */
function sanitizeSvg(svg: string, maxHeight: number): string | null {
  if (typeof svg !== "string") return null;
  if (svg.length > MAX_SVG_LEN) return null;
  const trimmed = svg.trim();
  if (!trimmed) return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(trimmed, "image/svg+xml");
  } catch {
    return null;
  }
  // XML parse failures surface as an embedded <parsererror> document.
  if (doc.getElementsByTagName("parsererror").length > 0) return null;

  const root = doc.documentElement;
  if (!root || root.tagName !== "svg") return null;

  sanitizeTree(root);

  // House framing forced onto the root (after sanitization, so these can never
  // be overridden by allowlisted input attributes).
  const px = Number.isFinite(maxHeight) && maxHeight > 0 ? Math.round(maxHeight) : 280;
  root.setAttribute("width", "100%");
  root.setAttribute("height", String(px));
  root.setAttribute("role", "img");
  // `ink-sketch` marks THIS component's root so size rules (e.g. the soli-chat
  // 420px sketch height) can target sanitized sketches without catching the
  // many other ink-drawable svgs that live inside chat messages (block frames,
  // today rings, timeline connectors…).
  const cls = root.getAttribute("class");
  root.setAttribute("class", cls ? `${cls} ink-drawable ink-sketch` : "ink-drawable ink-sketch");

  // Normalize stroked paths so the draw-in animation (stroke-dashoffset over
  // a unit path) works regardless of real path length. `stroke` is usually
  // inherited from a parent <g> in the house style, so resolve it upward.
  for (const p of Array.from(root.getElementsByTagName("path"))) {
    let node: Element | null = p;
    let stroke: string | null = null;
    while (node && stroke == null) {
      stroke = node.getAttribute("stroke");
      node = node.parentElement;
    }
    if (stroke && stroke !== "none") p.setAttribute("pathLength", "1");
  }

  return new XMLSerializer().serializeToString(root);
}

export function SafeSketch({
  svg,
  caption,
  maxHeight = 280,
  className,
}: {
  svg: string;
  caption?: string;
  maxHeight?: number;
  className?: string;
}): JSX.Element | null {
  // Client-only: DOMParser/XMLSerializer don't exist during SSR, so render
  // nothing until mounted (the sketch then appears on hydration).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const clean = useMemo(
    () => (mounted ? sanitizeSvg(svg, maxHeight) : null),
    [mounted, svg, maxHeight],
  );

  if (!clean) return null;

  return (
    <figure className={className}>
      {/* Safe by construction: `clean` is the output of sanitizeSvg above. */}
      <div dangerouslySetInnerHTML={{ __html: clean }} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export default SafeSketch;
