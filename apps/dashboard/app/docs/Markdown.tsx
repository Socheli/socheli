"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/* Renders Socheli docs markdown into the dashboard's dark design. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            // keep in-app doc links internal
            const internal = href?.startsWith("docs/") || href?.startsWith("../") || (href && !href.startsWith("http") && href.endsWith(".md"));
            const h = internal ? `/docs/${String(href).replace(/^.*\//, "").replace(/\.md$/, "")}` : href;
            return <a href={h} target={internal ? undefined : "_blank"} rel="noreferrer">{children}</a>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
