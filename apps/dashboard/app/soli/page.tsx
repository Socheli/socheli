import { redirect } from "next/navigation";

/* /soli — Soli moved home. The full-page chat now lives at / (it IS the home
   interface); this route survives only so old links and muscle memory keep
   working, with one canonical URL. The SoliPage client component still lives
   in this directory and is imported by app/page.tsx. */
export default function Page() {
  redirect("/");
}
