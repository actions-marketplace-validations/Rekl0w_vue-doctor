import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts", "scripts/**/*.mjs", "scripts/**/*.cjs"],
      exclude: ["src/scan-worker.ts"],
      thresholds: {
        statements: 30,
        branches: 25,
        functions: 35,
        lines: 30,
      },
    },
  },
});
