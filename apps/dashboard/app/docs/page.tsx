import Link from "next/link";
import { DOC_NAV } from "../../lib/docs";
import { PageHead } from "../PageHead";

export const dynamic = "force-dynamic";

export default function DocsIndex() {
  return (
    <>
      <PageHead
        section="account"
        title="Docs"
        sub="Everything to build on Socheli — API, SDK, CLI, MCP, and the fleet."
      />
      <div className="grid cols-2" style={{ gap: 12 }}>
        {DOC_NAV.map((d) => (
          <Link key={d.slug} href={`/docs/${d.slug}`} className="card" style={{ display: "block" }}>
            <div style={{ fontSize: 16, fontWeight: 650, letterSpacing: "-0.01em" }}>{d.title}</div>
            <div className="sub" style={{ marginTop: 6 }}>{d.blurb}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
