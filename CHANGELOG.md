# Changelog

## 0.6.0 - 2026-06-23

- Added Vue-specific performance checks for async computed getters, sync-flush watchers, and inline object/function component props in templates.
- Added accessibility checks for unlabeled form controls and clickable non-interactive elements without keyboard support.
- Added public client env secret detection plus full-project package health diagnostics for mixed lockfiles, package-manager mismatches, and risky install lifecycle scripts.
- Added Socket.dev supply-chain scoring for direct dependencies with `low-supply-chain-score`, `--supply-chain` / `--no-supply-chain`, `--offline`, cache, timeout, severity, and devDependency config support.
- Added Vue/Vite/Nuxt-aware import graph dead-code analysis for unreachable source files, unused named exports, unused runtime dependencies, and circular imports, with `--dead-code` / `--no-dead-code` and boolean/object `deadCode` config support.
- Moved dead-code analysis behind a timeout-bounded worker in packaged CLI runs so stalled analysis fails open instead of blocking the scan.
- Added the publishable `oxlint-plugin-vue-doctor` workspace package for script-level Vue Doctor rules that oxlint can run directly.
- Added `warnings` config support and `--warnings` / `--no-warnings` CLI flags to hide advisory diagnostics when users want error-only reports.
- Refined the interactive CLI opening sequence to show a richer Vue Doctor scan intro before analysis begins.

## 0.5.1

- Added an interactive post-scan setup prompt so first-run users can add the project script, dependency, GitHub Actions workflow, hooks, and agent skill from the same CLI flow.
- Added JS/TS config loading with a typed `defineConfig` helper, plus lint and coverage scripts for stronger release verification.
- Fixed stale inline PR review comments when a later run has diagnostics but no commentable changed lines.
- Moved GitHub Action feedback logic into a tested helper and refreshed local testing docs for the current `--blocking` and packaged-tarball workflows.

## 0.5.0

- Added PR-focused scan scopes with `--scope changed`, `--scope lines`, `--scope files`, and `--base` so CI can report introduced diagnostics or changed-line-only diagnostics instead of every pre-existing issue in touched files.
- Added `blocking` as the preferred CLI/config/action gate setting while keeping `failOn` and `fail-on` as backwards-compatible aliases.
- Added `vue-doctor rules` commands for listing, explaining, enabling, disabling, and bulk-updating rules/categories from the CLI.
- Expanded the GitHub Action with inline PR review comments, commit status publishing, `fixed-issues` output, and matching scope/base handling for JSON, Markdown, and SARIF reports.

## 0.4.2

- Refined the default human CLI output to use a lean scan header, one-line project stack summary, and React Doctor-style category-only diagnostics.
- Slowed the interactive score animation slightly and kept rule messages, file locations, and source frames in `--verbose` output.

## 0.4.1

- Fixed non-Vue repositories being reported as a perfect 100 health score by adding a `vue-project-not-found` diagnostic when no Vue dependency, Vue framework, or `.vue` source files are detected.
- Refined the coding-agent setup hint to match the install handoff flow: ask the user first, then run `npx @rekl0w/vue-doctor@latest install --yes`.
- Replaced numeric interactive prompts with arrow-key menus for scan selection, diagnostics handoff, setup confirmations, and agent skill installation.
- Added Space-toggle multi-select support for choosing which detected coding agents receive the bundled Vue Doctor skill.
- Added interactive terminal polish with paced diagnostic rendering and an animated score bar while keeping CI and structured outputs stable.

## 0.4.0

- Expanded `vue-doctor install` into full project onboarding: package script, dev dependency install, GitHub Actions workflow, Git pre-commit hook support, bundled agent skill install, dry-run previews, and optional native Claude/Cursor edit hooks.
- Added an interactive install wizard for choosing package script, dependency, agent skill, Git hook, GitHub Action, and native agent hook setup.
- Added agent handoff flows for diagnostics, including focused prompt generation, full diagnostics directories, clipboard copy, prompt printing, and best-effort Codex/Claude/Cursor CLI launch modes.
- Added branded human CLI output, scan progress steps, interactive changed/staged/full scan selection, and once-per-project setup hints in coding-agent environments.
- Added `--changed-files-from` for CI systems that provide an authoritative changed-file list without relying on local branch checkout state.
- Added `--experimental-parallel [workers]` for worker-thread scanning on larger Vue repositories.
- Added lightweight source frames in verbose diagnostic output.
- Reworked the composite GitHub Action to use pull request file discovery through the GitHub API, sticky PR comments with the built-in token, annotation rendering from JSON, `non-blocking` mode, package `version` selection, and issue-count outputs.
- Added a `version` subcommand, config JSON schema, and schema generation script.

## 0.3.0

- Added `--markdown` and `--sarif` report formats, plus Node API helpers for generating Markdown and SARIF from JSON reports.
- Added `recommended`, `strict`, and `design` presets with CLI and config support.
- Added diagnostics baseline support through `--update-baseline`, `--baseline`, and the matching config field.
- Added Vue/Nuxt-focused checks for public runtime secrets, top-level SSR browser globals, and hydration-unstable template expressions.
- Reworked script scanning to use parser-aware AST traversal instead of raw regex matching for imports, eval, prop mutation, watcher cleanup, secrets, deprecated Vue 2 APIs, and deep watchers.
- Fixed noisy false positives from fixture strings, regex literals, rule title maps, bound `rel` attributes, and buttons with nested text.
- Fixed `v-for` index alias detection for two-alias forms such as `(item, idx) in items`.
- Added CLI smoke tests for JSON, Markdown, SARIF, and baseline behavior.
- Updated the GitHub Action with preset, baseline, Markdown, and SARIF inputs and pinned the internal npm invocation to the action release version.

## 0.2.0

- Added React Doctor-style CLI workflows: `--diff`, `--staged`, `--project`, `--full`, `--json-compact`, `--offline`, and `--explain`.
- Added the `vue-doctor install` command and bundled coding-agent skill instructions.
- Added GitHub Action inputs for `project`, `diff`, and `offline`.
- Added bundle-size, design, and style-performance rule families.
- Changed the recommended one-shot command to `npx @rekl0w/vue-doctor@latest`.
- Avoided reporting a misleading score when `--staged --score` has no staged Vue source files.

## 0.1.3

- Changed GitHub Action pull request comments to render Markdown summaries from JSON reports instead of raw ANSI terminal output.

## 0.1.2

- Added GitHub Action inputs for `annotations`, `json`, and `report-path`.
- Added a `report-path` action output for JSON report artifact workflows.
- Kept the human-readable PR comment output separate from GitHub Actions annotations.
- Kept score/report/comment steps running even when the configured CI gate fails.
- Documented score outputs, annotations, and JSON artifact usage in CI.

## 0.1.1

- Renamed the GitHub Marketplace action to `Rekl0w Vue Doctor` so it can be published with a unique Marketplace name.
- Kept the CLI command as `vue-doctor` and the npm package as `@rekl0w/vue-doctor`.
- Refreshed package metadata for npm publishing.

## 0.1.0

- Initial Vue Doctor CLI and Node API.
- Vue SFC scanning through the official Vue compiler.
- Diagnostics for security, correctness, performance, accessibility, architecture, and maintainability.
- JSON reports, score-only output, GitHub Actions annotations, config file support, ignores, and inline suppressions.
