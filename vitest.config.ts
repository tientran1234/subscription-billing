import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // The email templates are JSX. Next compiles them with the automatic
  // runtime; tsconfig says `preserve` because Next owns that step, so esbuild
  // has to be told the same thing or it emits classic `React.createElement`
  // calls into files that never import React.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The integration files share one Postgres and each resets its tables in
    // beforeEach. Run files one at a time so they cannot wipe each other's rows
    // mid-test. Unit files are fast enough that this costs nothing.
    fileParallelism: false,
  },
});
