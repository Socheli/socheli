import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setConcurrency(4);
Config.overrideWebpackConfig((c) => ({
  ...c,
  resolve: {
    ...c.resolve,
    alias: {
      ...(c.resolve?.alias ?? {}),
      "@os/schemas": require("path").resolve(__dirname, "../schemas/src/index.ts"),
      "@os/tokens": require("path").resolve(__dirname, "../tokens/src/index.ts"),
    },
  },
}));
