import type { ReactNode } from "react";
import { InkDivider } from "../components/sketch";

/* The ONE page header for every interior page — so Create / Publish / Grow /
   Engage / Manage all read identically. The eyebrow is always the mega-menu
   SECTION (every Create page shows "// create", etc.), the title is the page
   name, an optional sub explains it, and a hand-drawn ink rule closes the header
   in the house sketch style. Pages pass `aside` for any inline header extras
   (stat strips, etc.) and `icon` for a leading title mark. */
export function PageHead({
  section,
  title,
  sub,
  icon,
  aside,
}: {
  section: string;
  title: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="eyebrow">// {section}</div>
      <h1 className="h1">
        {icon ? <span className="page-head-icon">{icon}</span> : null}
        {title}
      </h1>
      {aside}
      {sub ? <div className="sub">{sub}</div> : null}
      <div className="page-head-rule" aria-hidden="true"><InkDivider /></div>
    </div>
  );
}
