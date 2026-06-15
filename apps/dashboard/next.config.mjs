import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const pkg = (p) => resolve(here, "..", "..", "packages", p, "src");

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: false,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ["@os/remotion", "@os/schemas", "@os/tokens", "remotion", "@remotion/player", "@remotion/transitions", "@remotion/google-fonts"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@os/schemas": resolve(pkg("schemas"), "index.ts"),
      "@os/tokens": resolve(pkg("tokens"), "index.ts"),
    };
    // allow extensionless plus .js to .ts/.tsx resolution for the remotion source imports
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};
