import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // The CLI, and one import path per provider for deploy.ts files.
    entry: {
      index: "src/index.ts",
      "deploy/cloudflare": "src/resources/cloudflare/index.ts",
    },
    // TypeScript 7 makes tsgo the default declaration generator.
    dts: true,
    exports: true,
  },
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    // Test deploy.ts files import the package by name; resolve it to the source, so they share the
    // CLI's resource list instead of loading the built dist/ as a second copy.
    alias: {
      "@dankudev/danku/deploy/cloudflare": fileURLToPath(
        new URL("src/resources/cloudflare/index.ts", import.meta.url),
      ),
    },
  },
});
