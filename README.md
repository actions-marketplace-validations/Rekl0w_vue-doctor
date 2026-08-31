<h1>Vue Doctor</h1>

[![version](https://img.shields.io/npm/v/%40rekl0w%2Fvue-doctor?style=flat)](https://www.npmjs.com/package/@rekl0w/vue-doctor)
[![license](https://img.shields.io/github/license/Rekl0w/vue-doctor?style=flat)](./LICENSE)

Your agent writes risky Vue. This catches the boring mistakes before they ship.

Vue Doctor scans Vue codebases and returns a 0 to 100 health score with actionable diagnostics for security, correctness, performance, accessibility, and component architecture.

It understands Vue single-file components through the official Vue compiler, so it can inspect real `<template>`, `<script setup>`, classic `<script>`, and `<style>` blocks instead of pretending `.vue` files are plain text.

When Vue Doctor is run outside a Vue project, it reports `vue-doctor/vue-project-not-found` instead of returning a misleading perfect score.

## Install

Run this at your project root:

```bash
npx @rekl0w/vue-doctor@latest
```

Teach your coding agent the same Vue rules:

```bash
npx @rekl0w/vue-doctor@latest install
```

`install` now opens an arrow-key setup wizard in interactive terminals and configures the project, not only the agent skill. It can add a `doctor` package script, install the dev dependency, write a GitHub Actions workflow, wire a pre-commit hook, and install the bundled coding-agent skill. Use `--yes` to accept the recommended setup without prompts, `--agent-hooks` to add native Claude/Cursor edit hooks when those project folders exist, or `--dry-run` to preview the exact work.

Or install it in a repo:

```bash
npm install -D @rekl0w/vue-doctor
npx vue-doctor
```

Script-level rules are also available as an oxlint plugin package:

```bash
npm install -D oxlint-plugin-vue-doctor
```

The oxlint plugin covers JavaScript and TypeScript rules that oxlint can run directly, such as `no-eval`, `no-public-env-secret`, `no-hardcoded-secret`, `no-async-computed`, `no-sync-watch-flush`, `no-full-lodash-import`, and `no-moment`. Keep using the main CLI for Vue template, style, dead-code, package-health, and supply-chain checks.

The CLI prints a score:

- 75 to 100: Great
- 50 to 74: Needs work
- 0 to 49: Critical

Default output is compact and product-focused: Vue Doctor prints a lean run header, shows scan progress, summarizes diagnostics by category, animates the score bar at the bottom in interactive terminals, and writes the full JSON report to a temp file. Use `--verbose` when you want every rule and file-level diagnostic with a source frame in the terminal.

## What It Checks

Vue Doctor ships with focused rules that catch problems Vue teams repeatedly review by hand:

| Category | Rules |
| --- | --- |
| Security | `no-v-html`, `no-target-blank-without-rel`, `no-eval`, `no-hardcoded-secret`, `no-public-runtime-secret`, `no-public-env-secret`, `no-risky-postinstall`, `low-supply-chain-score` |
| Correctness | `vue-project-not-found`, `require-v-for-key`, `no-index-key`, `no-v-if-with-v-for`, `no-template-side-effects`, `no-mutating-props`, `no-vue2-deprecated-api`, `no-ssr-browser-global`, `no-hydration-unstable-template` |
| Performance | `no-expensive-template-expression`, `no-deep-watch`, `watch-requires-cleanup`, `no-async-computed`, `no-sync-watch-flush`, `no-inline-template-object`, `no-inline-template-function`, `no-transition-all`, `no-permanent-will-change` |
| Accessibility | `require-img-alt`, `require-button-name`, `require-form-control-label`, `no-click-without-keyboard`, `no-autofocus`, `no-disabled-zoom` |
| Architecture | `no-large-component`, `no-too-many-props` |
| Maintainability | `prefer-scoped-style`, `no-mixed-lockfiles`, `package-manager-lockfile-mismatch`, `no-unused-file`, `no-unused-export`, `no-unused-dependency`, `no-circular-import` |
| Bundle Size | `no-full-lodash-import`, `no-moment`, `prefer-dynamic-import` |
| Design | `no-outline-none`, `no-tiny-text`, `no-wide-letter-spacing`, `no-z-index-9999`, `no-pure-black-background`, `no-gradient-text` |

The scanner respects `.gitignore`, `.eslintignore`, `.prettierignore`, `.vue-doctorignore`, and `vue-doctor.config.json` ignores.
Full-project scans also inspect package metadata for package-manager lockfile drift, risky install lifecycle scripts, and direct dependency supply-chain risk through Socket.dev's free PURL endpoint. Supply-chain scoring is fail-open: network failures, timeouts, and unscored packages do not fail the scan.
By default, full-project scans also build a local Vue/Vite/Nuxt-aware import graph to find unreachable source files, unused named exports, circular import chains, and runtime dependencies that are not imported by scanned source or config files. This pass understands relative imports, common `@/*` path aliases, dynamic `import()`, `require()`, and `import.meta.glob()` route/view patterns. It is skipped automatically for changed-file, staged, include-only, and baseline comparison scans because reachability is a whole-project property.

## CLI

```text
Usage: vue-doctor [directory] [options]

Options:
  -v, --version          display the version number
  --verbose              show every diagnostic
  --json                 output a structured JSON report
  --markdown             output a Markdown report
  --sarif                output a SARIF 2.1.0 report
  --json-compact         with --json, emit compact JSON
  --score                output only the numeric score
  --annotations          output GitHub Actions annotations
  --warnings             show warning-severity diagnostics
  --no-warnings          hide warning-severity diagnostics
  --dead-code            enable import graph and dead-code analysis
  --no-dead-code         skip import graph and dead-code analysis
  --supply-chain         enable Socket.dev supply-chain dependency scoring
  --no-supply-chain      skip Socket.dev supply-chain dependency scoring
  --project <name>       workspace project(s) to scan
  --scope <value>        scan/report scope: full, files, changed, or lines
  --base <ref>           base git ref for files, changed, and lines scopes
  --diff [base]          deprecated alias for --scope changed
  --changed-files-from <path> scan source files listed in a newline, NUL, or JSON file
  --staged               scan staged git files
  --full                 force a full scan
  --offline              skip network-backed checks such as Socket.dev supply-chain scoring
  --experimental-parallel [workers] scan files in worker threads
  --blocking <level>     severity that exits non-zero: error, warning, none
  --fail-on <level>      deprecated alias for --blocking <level> (default: error)
  --preset <name>        rule preset: recommended, strict, design
  --baseline <path>      ignore diagnostics already present in a baseline file
  --update-baseline <path> write the current diagnostics to a baseline file
  --config <path>        path to vue-doctor.config.json
  --include <path>       file or directory to scan; repeat or comma-separate
  --explain <file:line>  show active and suppressed diagnostics near a line
  --handoff [mode]       hand diagnostics to an agent: prompt, copy, print, codex, claude, cursor, skip
  --copy-prompt          copy an agent-ready diagnostics prompt to the clipboard
  --print-prompt         print an agent-ready diagnostics prompt
  -h, --help             display help
```

Examples:

```bash
npx @rekl0w/vue-doctor@latest
npx vue-doctor apps/web --verbose
npx vue-doctor --scope changed --base main --blocking warning
npx vue-doctor --scope lines --base main --blocking warning
npx vue-doctor --no-warnings --blocking none
npx vue-doctor --no-dead-code --blocking none
npx vue-doctor --no-supply-chain --blocking none
npx vue-doctor --offline --blocking none
npx vue-doctor --experimental-parallel 4 --blocking none
npx vue-doctor --staged
npx vue-doctor --changed-files-from /tmp/changed-files.txt
npx vue-doctor --project web,admin --json
npx vue-doctor --json > vue-doctor-report.json
npx vue-doctor --markdown > vue-doctor-report.md
npx vue-doctor --sarif > vue-doctor.sarif
npx vue-doctor --update-baseline vue-doctor-baseline.json --blocking none
npx vue-doctor --baseline vue-doctor-baseline.json --blocking warning
npx vue-doctor rules list
npx vue-doctor rules explain vue-doctor/no-v-html
npx vue-doctor rules disable vue-doctor/require-img-alt
npx vue-doctor --copy-prompt --blocking none
npx vue-doctor --blocking warning
```

When diagnostics are found in an interactive terminal, Vue Doctor can hand them to an agent through an arrow-key menu. It writes a full diagnostics directory, builds a focused repair prompt, and can launch Codex, Claude Code, or Cursor Agent when their CLIs are available. Non-interactive runs skip the prompt unless you pass `--copy-prompt`, `--print-prompt`, or `--handoff <mode>`.

After the first local scan in an interactive project, Vue Doctor can also offer to keep watching the repo. Choose the setup wizard to add a `doctor` package script, the dev dependency, GitHub Actions PR review workflow, Git hook, and bundled agent skill from the same flow.

If you do not pass `--scope`, `--diff`, `--staged`, `--full`, `--include`, or `--changed-files-from`, interactive terminals can ask whether to scan changed files, staged files, or the full project with arrow-key navigation. In coding-agent environments, Vue Doctor shows the repo setup hint once per project when the package script/dependency is not installed yet.

## Configuration

Create `vue-doctor.config.json` in your repo:

```json
{
  "$schema": "https://raw.githubusercontent.com/Rekl0w/vue-doctor/main/schema/config.json",
  "preset": "recommended",
  "warnings": true,
  "deadCode": {
    "enabled": true,
    "timeoutMs": 120000
  },
  "supplyChain": {
    "enabled": true,
    "minScore": 50,
    "severity": "error",
    "includeDevDependencies": true,
    "cache": true
  },
  "blocking": "warning",
  "scope": "changed",
  "base": "main",
  "baseline": "vue-doctor-baseline.json",
  "maxComponentLines": 320,
  "maxProps": 12,
  "categories": {
    "Design": "off",
    "Bundle Size": "warning"
  },
  "ignore": {
    "rules": ["vue-doctor/prefer-scoped-style"],
    "files": ["src/generated/**"],
    "overrides": [
      {
        "files": ["src/legacy/**"],
        "rules": ["vue-doctor/no-vue2-deprecated-api"]
      }
    ]
  },
  "rules": {
    "vue-doctor/no-v-html": "error",
    "vue-doctor/no-deep-watch": "warning",
    "vue-doctor/require-button-name": "off"
  }
}
```

You can also place the same object under `vueDoctor` in `package.json`. Legacy `failOn` and `diff` config fields are still accepted, but new projects should prefer `blocking`, `scope`, and `base`.

`deadCode` can be either a boolean or an object with `enabled` and `timeoutMs`. `supplyChain` runs only for full-project scans, caches Socket.dev responses outside the repo, and can be disabled with config, `--no-supply-chain`, or `--offline`.

Typed configs are supported too:

```ts
import { defineConfig } from "@rekl0w/vue-doctor";

export default defineConfig({
  preset: "strict",
  scope: "changed",
  base: "main",
  blocking: "warning",
});
```

### Presets and Baselines

Use `preset` or `--preset` to tune the rule set:

- `recommended`: default Vue Doctor behavior.
- `strict`: upgrades default warnings to errors.
- `design`: keeps security, correctness, accessibility, and design checks on while turning broader performance, architecture, maintainability, and bundle-size checks off unless explicitly re-enabled.

Use baselines when adopting Vue Doctor in an existing codebase:

```bash
npx vue-doctor --update-baseline vue-doctor-baseline.json --blocking none
npx vue-doctor --baseline vue-doctor-baseline.json --blocking warning
```

The baseline stores current diagnostics by file, rule, location, and message. Future scans with `--baseline` report only new or moved diagnostics.

### Pull Request Scopes

Use `--scope` with `--base` when you want CI to focus on reviewable changes:

| Scope | Behavior |
| --- | --- |
| `changed` | Scan changed files, compare against the base ref, and report only introduced or moved diagnostics. JSON reports include `mode: "baseline"` and fixed/new/base counts. |
| `lines` | Scan changed files, then keep only diagnostics whose primary location is on a changed hunk line. |
| `files` | Report every diagnostic inside changed source files. |
| `full` | Scan the full Vue project. |

`--base` can be a branch, tag, commit SHA, or merge-base candidate. `VUE_DOCTOR_BASE_SHA` and `VUE_DOCTOR_BASE_REF` are also honored when a CI system provides the base ref through the environment.

### Rule Management

Manage project rules without hand-editing JSON:

```bash
npx vue-doctor rules list
npx vue-doctor rules list --category Accessibility --configured
npx vue-doctor rules explain require-img-alt
npx vue-doctor rules set vue-doctor/no-v-html error
npx vue-doctor rules enable require-button-name --severity warning
npx vue-doctor rules disable no-outline-none
npx vue-doctor rules category Design off
```

`rules set`, `rules enable`, `rules disable`, and `rules category` update the nearest Vue Doctor config file, or create `vue-doctor.config.json` at the project root when none exists.

### Inline Suppressions

Use the narrowest suppression possible:

```vue
<!-- vue-doctor-disable-next-line vue-doctor/no-v-html -->
<div v-html="trustedHtml" />
```

Script comments work too:

```ts
// vue-doctor-disable-next-line vue-doctor/no-hardcoded-secret
const demoToken = "not-a-real-token-for-docs";
```

## GitHub Actions

This repository includes a composite action. Use it from this repo after publishing or referencing a tag:

```yaml
name: Vue Doctor

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]

permissions:
  contents: read
  issues: write
  pull-requests: write
  statuses: write

concurrency:
  group: vue-doctor-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  vue-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Rekl0w/vue-doctor@v0.6.0
        id: vue-doctor
        with:
          directory: .
          preset: strict
          scope: changed
          blocking: warning
          annotations: true
          comment: true
          review-comments: true
          commit-status: true
          json: true
          report-path: vue-doctor-report.json
          sarif: true
          sarif-report-path: vue-doctor.sarif

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: vue-doctor-report
          path: |
            ${{ steps.vue-doctor.outputs['report-path'] }}
            ${{ steps.vue-doctor.outputs['sarif-report-path'] }}
```

On pull requests, the action asks GitHub for the changed file list, fetches the base SHA, and defaults to `scope: changed`. That reports only diagnostics introduced by the PR while also counting diagnostics fixed compared with the base. Use `scope: lines` for changed-hunk-only review, `scope: files` for every issue in touched files, or `scope: full` for full-project gating. Non-PR events always scan the full project.

With `comment: true`, the action updates one sticky Vue Doctor summary comment. With `review-comments: true`, it posts inline review comments only on commentable PR lines. With `commit-status: true`, it publishes a `Vue Doctor` commit status containing the score and issue counts. Set `non-blocking: true` when you want annotations, comments, and statuses without failing the workflow.

The action exposes health and issue metrics as outputs:

```yaml
${{ steps.vue-doctor.outputs.score }}
${{ steps.vue-doctor.outputs.total-issues }}
${{ steps.vue-doctor.outputs.fixed-issues }}
${{ steps.vue-doctor.outputs.error-count }}
${{ steps.vue-doctor.outputs.warning-count }}
${{ steps.vue-doctor.outputs.affected-files }}
```

Inputs: `directory`, `verbose`, `project`, `scope`, `diff`, `preset`, `baseline`, `update-baseline`, `github-token`, `blocking`, `fail-on`, `offline`, `experimental-parallel`, `annotations`, `comment`, `review-comments`, `commit-status`, `non-blocking`, `json`, `report-path`, `markdown`, `markdown-report-path`, `sarif`, `sarif-report-path`, `version`, and `node-version`. Legacy `diff` and `fail-on` inputs still work for older workflows.

Prefer not to use the action? The package works directly:

```yaml
- run: npx @rekl0w/vue-doctor@latest --blocking warning --annotations
- run: npx @rekl0w/vue-doctor@latest --json --blocking none > vue-doctor-report.json
- run: npx @rekl0w/vue-doctor@latest --sarif --blocking none > vue-doctor.sarif
```

## Node API

```ts
import { diagnose, toJsonReport, toMarkdownReport, toSarifReport } from "@rekl0w/vue-doctor/api";

const result = await diagnose("./apps/web", {
  config: { preset: "strict" },
});
const report = toJsonReport("./apps/web", result);

console.log(result.score);
console.log(result.diagnostics);
console.log(toMarkdownReport(report));
console.log(toSarifReport(report));
```

## References

Vue Doctor was built with [`millionco/react-doctor`](https://github.com/millionco/react-doctor) as the product and package-quality reference: CLI-first workflow, score output, CI action, JSON reports, config ergonomics, and open-source repository hygiene. The implementation here is Vue-native rather than a port: it uses the official Vue compiler to inspect SFC templates, scripts, and styles.

## License

MIT
