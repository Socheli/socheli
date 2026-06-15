"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SafeSketch } from "../../components/sketch/SafeSketch";

/* Comprehensive, SAFE markdown for Soli — full GFM (headings, lists, tables,
   code blocks, blockquotes, task lists, strikethrough, links). react-markdown
   does NOT render raw HTML by default (no rehype-raw — NEVER add it), so this
   is XSS-safe; we only harden link targets/rels. Styled by the .md CSS block.
   One special fence: ```sketch blocks render through the SafeSketch sanitizer
   (a strict SVG element/attribute allowlist) instead of as code. */
function isSafeHref(href?: string): href is string {
  if (!href) return false;
  return /^https?:\/\//i.test(href) || (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#");
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={isSafeHref(href) ? href : undefined} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          code: ({ className, children, node: _node, ...props }) => {
            // ```sketch fences carry model-drawn SVG — render via the
            // SafeSketch sanitizer, never as raw markup.
            if (className === "language-sketch") {
              return <SafeSketch svg={String(children)} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
