import type { MetadataRoute } from "next";

/* PWA manifest — makes the dashboard installable to a phone home screen with a
   standalone, app-like chrome. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Socheli",
    short_name: "Socheli",
    description: "Agentic content engine: generate, manage, and publish from anywhere.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    orientation: "portrait",
    icons: [
      { src: "/rem/logos/socheli-mark-light.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/rem/logos/socheli-mark-light.png", sizes: "192x192", type: "image/png", purpose: "any" },
    ],
  };
}
