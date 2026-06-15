import Link from "next/link";
import { notFound } from "next/navigation";
import { getDoc, docTitle, DOC_NAV } from "../../../lib/docs";
import { Markdown } from "../Markdown";

export const dynamic = "force-dynamic";

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const md = getDoc(slug);
  if (!md) return notFound();
  return (
    <div className="split-2">
      <div style={{ position: "sticky", top: 80 }}>
        <div className="nav-section">docs</div>
        {DOC_NAV.map((d) => (
          <Link key={d.slug} href={`/docs/${d.slug}`} className={`nav-link${d.slug === slug ? " active" : ""}`}>
            <span className="dot" />{d.title}
          </Link>
        ))}
      </div>
      <article style={{ minWidth: 0, maxWidth: 820 }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>// {docTitle(slug)}</div>
        <Markdown>{md}</Markdown>
      </article>
    </div>
  );
}
