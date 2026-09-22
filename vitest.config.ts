import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The integration files share one Postgres and each resets its tables in
    // beforeEach. Run files one at a time so they cannot wipe each other's rows
    // mid-test. Unit files are fast enough that this costs nothing.
    fileParallelism: false,
  },
});
