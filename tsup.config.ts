import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/rules/index.ts", "src/scan-worker.ts", "src/dead-code-worker.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: {
    js: "import { createRequire as __vueDoctorCreateRequire } from 'node:module'; const require = __vueDoctorCreateRequire(import.meta.url);",
  },
});
