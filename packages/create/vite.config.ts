import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // TypeScript 7 makes tsgo the default declaration generator.
    dts: true,
    exports: true,
  },
  test: {
    restoreMocks: true,
  },
});
