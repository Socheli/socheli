import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import "./globals.css";
import "./mega-menu.css";
import "./chats.css";
import "./copilot/execution.css";
import "./copilot/tasks-viz.css";
import "./copilot/json-tree.css";
import "./hyper-search.css";
import "./studio.css";
import "./mobile-shell.css";
import "./mobile-chat.css";
import "./mobile-pages.css";
import type { ReactNode } from "react";
import { AppShell } from "./AppShell";
import { Copilot } from "./copilot/Copilot";
import { HyperSearch } from "./HyperSearch";

export const metadata = {
  title: "Socheli",
  description: "Socheli, the agentic content engine",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Socheli" },
};

export const viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

/* Clerk themed to the product's premium near-monochrome dark design so the auth
   surfaces read as one continuous product, not a bolted-on third party. */
const clerkAppearance = {
  baseTheme: dark,
  variables: {
    colorPrimary: "#f5f5f5",
    colorText: "#ededed",
    colorTextSecondary: "#a3a3a3",
    colorBackground: "#141414", // card surface — visible against the #0a0a0a page
    colorInputBackground: "#1c1c1c",
    colorInputText: "#ffffff",
    borderRadius: "10px",
    fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
  },
  elements: {
    // real CSS (objects), not Tailwind classes — this app has no Tailwind
    card: { backgroundColor: "#141414", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 24px 60px rgba(0,0,0,0.5)" },
    formButtonPrimary: { backgroundColor: "#f5f5f5", color: "#0a0a0a", fontWeight: 600 },
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ClerkProvider appearance={clerkAppearance}>
          <AppShell>{children}</AppShell>
          <Copilot />
          <HyperSearch />
        </ClerkProvider>
      </body>
    </html>
  );
}