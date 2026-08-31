---
name: vue-doctor
description: Use before committing Vue, Nuxt, Vite Vue, Vue CLI, Quasar, VitePress, or VuePress code, or when cleaning up Vue code quality. Checks for score regressions, security, correctness, performance, accessibility, bundle-size, design, and component architecture diagnostics.
---

# Vue Doctor

Vue Doctor scans Vue codebases and returns a 0-100 health score with actionable diagnostics.

If Vue Doctor reports `vue-doctor/vue-project-not-found`, stop and confirm the target is actually a Vue/Nuxt repository before making Vue-specific changes.

## Quick Checks

Before committing Vue changes, run:

```bash
npx @rekl0w/vue-doctor@latest --verbose --diff
```

If the score drops or new errors appear, fix those regressions before committing.

## Full Scan

Run a full codebase scan when starting cleanup work:

```bash
npx @rekl0w/vue-doctor@latest --verbose --full
```

Fix errors first, then warnings. Use focused flags for automation:

| Flag | Purpose |
| --- | --- |
| `--diff [base]` | Scan changed Vue source files vs the base branch |
| `--changed-files-from <path>` | Scan an authoritative changed-file list from CI |
| `--staged` | Scan staged source files for pre-commit workflows |
| `--project <name>` | Scan one or more workspace projects |
| `--experimental-parallel [workers]` | Use worker-thread scanning on larger repositories |
| `--score` | Output only the numeric health score |
| `--json` | Output a structured machine-readable report |
| `--markdown` | Output a Markdown report |
| `--sarif` | Output a SARIF 2.1.0 report |
| `--preset <name>` | Use `recommended`, `strict`, or `design` rule behavior |
| `--baseline <path>` | Ignore diagnostics already present in a baseline file |
| `--update-baseline <path>` | Write the current diagnostics baseline |
| `--fail-on warning` | Fail on any diagnostic |
| `--copy-prompt` | Copy a focused repair prompt and diagnostics path for an agent |
| `--print-prompt` | Print the focused repair prompt instead of copying it |

When Vue Doctor prints or copies a handoff prompt, use the diagnostics directory named in the prompt as the source of truth. Fix root causes instead of suppressing rules, then rerun Vue Doctor with `--verbose --fail-on none`.

In interactive terminals, Vue Doctor may ask whether to scan changed files, staged files, or the full project when no scan mode is provided. For automated agent runs, pass the intended mode explicitly, for example `--diff`, `--staged`, or `--full`.

## Suppressions

Prefer fixing findings. When a suppression is intentional, keep it narrow:

```vue
<!-- vue-doctor-disable-next-line vue-doctor/no-v-html -->
<div v-html="trustedHtml" />
```

Use `--no-respect-inline-disables` for an audit scan that ignores local suppressions.
