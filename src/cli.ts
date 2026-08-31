import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Command } from "commander";
import pc from "picocolors";
import { DEFAULT_FAIL_ON, VERSION } from "./constants.js";
import {
  diagnose,
  summarizeDiagnostics,
  toJsonReportFromScans,
} from "./scanner.js";
import { toMarkdownReport, toSarifReport } from "./reporters.js";
import { normalizeRuleName, rules } from "./rules/index.js";
import type {
  Diagnostic,
  ChangedLineRanges,
  DiffInfo,
  DiagnoseResult,
  FailOnLevel,
  JsonReport,
  JsonReportMode,
  RuleDefinition,
  RuleLevel,
  ScanScope,
  ScoreResult,
  VueDoctorConfig,
  VueDoctorPreset,
} from "./types.js";
import {
  getChangedLineRanges,
  getDiffInfo,
  getMergeBase,
  getStagedSourceFiles,
  filterSourceFiles,
  readChangedFilesFromFile,
  readGitFileAtRef,
} from "./utils/git.js";
import { loadConfig, mergeConfig } from "./utils/config.js";
import { toRelativePath } from "./utils/path.js";
import { runInstallOnboarding } from "./utils/install-onboarding.js";
import { runAgentHandoff, type HandoffMode } from "./utils/agent-handoff.js";
import { maybeOfferProjectSetup } from "./utils/setup-hint.js";
import { canPrompt, promptChoice, runProductStep } from "./utils/terminal.js";
import { selectProjectDirectories } from "./utils/workspaces.js";
import { calculateScore } from "./utils/scoring.js";
import { filterDiagnosticsByBaseline, readBaselineKeys, writeBaseline } from "./utils/baseline.js";

interface CliFlags {
  verbose?: boolean;
  warnings?: boolean;
  deadCode?: boolean;
  json?: boolean;
  markdown?: boolean;
  sarif?: boolean;
  jsonCompact?: boolean;
  score?: boolean;
  annotations?: boolean;
  prComment?: boolean;
  yes?: boolean;
  full?: boolean;
  staged?: boolean;
  offline?: boolean;
  supplyChain?: boolean;
  scope?: string;
  base?: string;
  diff?: boolean | string;
  changedFilesFrom?: string;
  project?: string;
  blocking?: string;
  failOn?: string;
  preset?: string;
  baseline?: string;
  updateBaseline?: string;
  config?: string;
  include?: string[];
  explain?: string;
  why?: string;
  respectInlineDisables?: boolean;
  handoff?: string | boolean;
  copyPrompt?: boolean;
  printPrompt?: boolean;
  color?: boolean;
  experimentalParallel?: string | boolean;
}

interface InstallFlags {
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
  cwd?: string | undefined;
  agentHooks?: boolean | undefined;
  gitHook?: boolean | undefined;
  githubAction?: boolean | undefined;
}

interface CompletedScan {
  directory: string;
  result: DiagnoseResult;
}

const VALID_FAIL_ON_LEVELS = new Set<FailOnLevel>(["error", "warning", "none"]);
const VALID_SCOPES = new Set<ScanScope>(["full", "files", "changed", "lines"]);
const VALID_PRESETS = new Set<VueDoctorPreset>(["recommended", "strict", "design"]);
const VALID_HANDOFF_MODES = new Set<HandoffMode>(["prompt", "copy", "print", "codex", "claude", "cursor", "skip"]);
const SCORE_BAR_WIDTH = 44;
const SCORE_ANIMATION_FRAMES = 40;
const SCORE_ANIMATION_DELAY_MS = 32;
const DIAGNOSTIC_ANIMATION_BUDGET_MS = 1200;
const SYMBOLS = {
  ok: "OK",
  error: "x",
  warning: "!",
  arrow: "->",
};

const parseInclude = (value: string, previous: string[] = []): string[] => [
  ...previous,
  ...value.split(",").map((entry) => entry.trim()).filter(Boolean),
];

const isWithinDirectory = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const filterChangedFilesForProject = (
  rootDirectory: string,
  projectDirectory: string,
  changedFiles: string[],
): string[] => {
  const resolvedFiles = changedFiles.map((filePath) =>
    path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(rootDirectory, filePath),
  );
  return resolvedFiles
    .filter((filePath) => isWithinDirectory(projectDirectory, filePath) || filePath === projectDirectory)
    .map((filePath) => path.relative(projectDirectory, filePath));
};

const colorByScore = (score: ScoreResult): ((text: string) => string) => {
  if (score.score >= 75) return pc.green;
  if (score.score >= 50) return pc.yellow;
  return pc.red;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const easeOutCubic = (progress: number): number => 1 - (1 - progress) ** 3;

const shouldAnimateCliOutput = (): boolean =>
  canPrompt() && process.env.VUE_DOCTOR_NO_ANIMATION !== "true";

const printTypeLine = async (message: string, enabled: boolean): Promise<void> => {
  if (!enabled) return;
  for (const character of message) {
    process.stdout.write(character);
    await sleep(10);
  }
  process.stdout.write("\n");
};

const printOpeningSequence = async (
  rootDirectory: string,
  projectCount: number,
  enabled: boolean,
): Promise<void> => {
  if (!enabled) return;
  const relativeRoot = path.relative(process.cwd(), rootDirectory) || ".";
  const face = [
    "  +-----+",
    "  | o o |  Vue Doctor",
    "  |  v  |  templates, scripts, styles, package health",
    "  +-----+",
  ];
  for (const line of face) {
    console.log(pc.green(line));
    await sleep(24);
  }
  console.log("");
  await printTypeLine(`Inspecting ${relativeRoot}.`, true);
  await printTypeLine(`Scanning ${projectCount === 1 ? "one project" : `${projectCount} projects`} with Vue performance, security, accessibility, and package checks.`, true);
  await sleep(120);
  console.log("");
};

const shouldFail = (diagnostics: Diagnostic[], failOn: FailOnLevel): boolean => {
  if (failOn === "none") return false;
  if (failOn === "warning") return diagnostics.length > 0;
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
};

const resolveFailOn = (value: string | undefined, label: string): FailOnLevel | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (VALID_FAIL_ON_LEVELS.has(normalized as FailOnLevel)) return normalized as FailOnLevel;
  throw new Error(`${label} "${value}" is not supported. Use error, warning, or none.`);
};

const resolveBlocking = (flags: CliFlags, config: VueDoctorConfig): FailOnLevel =>
  resolveFailOn(flags.blocking, "Blocking level") ??
  resolveFailOn(flags.failOn, "Fail-on level") ??
  config.blocking ??
  config.failOn ??
  DEFAULT_FAIL_ON;

const resolveScopeValue = (value: string | undefined): ScanScope | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (VALID_SCOPES.has(normalized as ScanScope)) return normalized as ScanScope;
  throw new Error(`Scope "${value}" is not supported. Use full, files, changed, or lines.`);
};

const resolvePreset = (value: string | undefined): VueDoctorPreset | undefined => {
  if (value === undefined) return undefined;
  if (VALID_PRESETS.has(value as VueDoctorPreset)) return value as VueDoctorPreset;
  throw new Error(`Preset "${value}" is not supported. Use recommended, strict, or design.`);
};

const buildConfigOverride = (
  preset: VueDoctorPreset | undefined,
  flags: CliFlags,
): VueDoctorConfig | undefined => {
  const config: VueDoctorConfig = {};
  if (preset) config.preset = preset;
  if (flags.warnings !== undefined) config.warnings = flags.warnings;
  if (flags.deadCode !== undefined) config.deadCode = flags.deadCode;
  if (flags.supplyChain !== undefined) config.supplyChain = { enabled: flags.supplyChain };
  if (flags.offline) config.supplyChain = { ...config.supplyChain, enabled: false };
  return Object.keys(config).length > 0 ? config : undefined;
};

interface RulesFlags {
  cwd?: string;
  json?: boolean;
  category?: string;
  configured?: boolean;
  severity?: string;
}

interface EffectiveRuleLevel {
  level: RuleLevel;
  source: "rule" | "category" | "preset" | "default";
}

interface RuleConfigTarget {
  filePath: string;
  isPackageJson: boolean;
  root: Record<string, unknown>;
  config: Record<string, unknown>;
  exists: boolean;
  writable: boolean;
}

const normalizeCategoryName = (category: string): string =>
  category.toLowerCase().replace(/[\s_-]+/g, "-");

const ruleKey = (rule: RuleDefinition): string => `vue-doctor/${rule.name}`;

const parseRuleLevel = (value: string | undefined): RuleLevel | null => {
  if (value === "error" || value === "warning" || value === "off") return value;
  if (value === "warn") return "warning";
  return null;
};

const formatRuleLevel = (level: RuleLevel): string => (level === "warning" ? "warn" : level);

const getConfiguredCategoryLevel = (
  config: VueDoctorConfig,
  category: string,
): RuleLevel | undefined => {
  const normalized = normalizeCategoryName(category);
  for (const [configuredCategory, level] of Object.entries(config.categories ?? {})) {
    if (normalizeCategoryName(configuredCategory) === normalized) return level;
  }
  return undefined;
};

const resolveEffectiveRuleLevel = (
  config: VueDoctorConfig,
  rule: RuleDefinition,
): EffectiveRuleLevel => {
  const configuredRuleLevel = config.rules?.[rule.name] ?? config.rules?.[ruleKey(rule)];
  if (configuredRuleLevel) return { level: configuredRuleLevel, source: "rule" };

  const categoryLevel = getConfiguredCategoryLevel(config, rule.category);
  if (categoryLevel) return { level: categoryLevel, source: "category" };

  if (config.preset === "strict" && rule.defaultSeverity === "warning") {
    return { level: "error", source: "preset" };
  }
  if (
    config.preset === "design" &&
    !["Security", "Correctness", "Accessibility", "Design"].includes(rule.category)
  ) {
    return { level: "off", source: "preset" };
  }

  return { level: rule.defaultSeverity, source: "default" };
};

const findRule = (query: string): RuleDefinition | null => {
  const normalized = normalizeRuleName(query);
  return rules.find((rule) => rule.name === normalized) ?? null;
};

const readJsonObject = (filePath: string): Record<string, unknown> => {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const resolveRuleConfigTarget = (cwd: string | undefined): RuleConfigTarget => {
  const requestedDirectory = path.resolve(cwd ?? process.cwd());
  const loaded = loadConfig(requestedDirectory);
  const sourcePath = loaded.sourcePath ?? path.join(requestedDirectory, "vue-doctor.config.json");
  const isPackageJson = path.basename(sourcePath) === "package.json";
  const writable = isPackageJson || path.extname(sourcePath) === ".json";
  const root = readJsonObject(sourcePath);
  const embeddedConfig = isPackageJson && root.vueDoctor && typeof root.vueDoctor === "object" && !Array.isArray(root.vueDoctor)
    ? (root.vueDoctor as Record<string, unknown>)
    : {};
  return {
    filePath: sourcePath,
    isPackageJson,
    root,
    config: isPackageJson ? embeddedConfig : root,
    exists: existsSync(sourcePath),
    writable,
  };
};

const writeRuleConfigTarget = (target: RuleConfigTarget, config: Record<string, unknown>): void => {
  mkdirSync(path.dirname(target.filePath), { recursive: true });
  const root = target.isPackageJson ? { ...target.root, vueDoctor: config } : config;
  writeFileSync(target.filePath, `${JSON.stringify(root, null, 2)}\n`);
};

const describeRuleConfigTarget = (target: RuleConfigTarget): string => {
  const relative = path.relative(process.cwd(), target.filePath);
  const display = relative && !relative.startsWith("..") ? relative : target.filePath;
  return target.exists ? display : `${display} (created)`;
};

const updateRuleConfig = (
  flags: RulesFlags,
  update: (config: Record<string, unknown>) => Record<string, unknown>,
): RuleConfigTarget => {
  const target = resolveRuleConfigTarget(flags.cwd);
  if (!target.writable) {
    throw new Error(
      `Cannot update ${target.filePath}. Rule management writes JSON config files only; edit JS/TS configs manually.`,
    );
  }
  const nextConfig = update({ ...target.config });
  writeRuleConfigTarget(target, nextConfig);
  return target;
};

const runRulesList = async (flags: RulesFlags): Promise<void> => {
  const loaded = loadConfig(path.resolve(flags.cwd ?? process.cwd()));
  const categoryFilter = flags.category ? normalizeCategoryName(flags.category) : null;
  const rows = rules
    .filter((rule) => !categoryFilter || normalizeCategoryName(rule.category) === categoryFilter)
    .map((rule) => ({ rule, effective: resolveEffectiveRuleLevel(loaded.config, rule) }))
    .filter(({ effective }) => !flags.configured || effective.source !== "default");

  if (flags.json) {
    console.log(JSON.stringify(rows.map(({ rule, effective }) => ({
      key: ruleKey(rule),
      name: rule.name,
      category: rule.category,
      defaultSeverity: rule.defaultSeverity,
      severity: effective.level,
      source: effective.source,
      description: rule.description,
    })), null, 2));
    return;
  }

  console.log(pc.bold("Vue Doctor rules"));
  for (const { rule, effective } of rows) {
    const source = effective.source === "default" ? "" : pc.dim(` (${effective.source})`);
    console.log(
      `${pc.cyan(ruleKey(rule)).padEnd(45)} ${formatRuleLevel(effective.level).padEnd(7)} ${pc.dim(rule.category)}${source}`,
    );
  }
};

const runRulesExplain = async (ruleQuery: string, flags: RulesFlags): Promise<void> => {
  const rule = findRule(ruleQuery);
  if (!rule) throw new Error(`Unknown rule "${ruleQuery}". Run vue-doctor rules list.`);
  const loaded = loadConfig(path.resolve(flags.cwd ?? process.cwd()));
  const effective = resolveEffectiveRuleLevel(loaded.config, rule);

  if (flags.json) {
    console.log(JSON.stringify({
      key: ruleKey(rule),
      name: rule.name,
      category: rule.category,
      defaultSeverity: rule.defaultSeverity,
      severity: effective.level,
      source: effective.source,
      description: rule.description,
    }, null, 2));
    return;
  }

  console.log(pc.bold(ruleKey(rule)));
  console.log(`${pc.dim("Category:")} ${rule.category}`);
  console.log(`${pc.dim("Default:")} ${formatRuleLevel(rule.defaultSeverity)}`);
  console.log(`${pc.dim("Current:")} ${formatRuleLevel(effective.level)}${effective.source === "default" ? "" : ` (${effective.source})`}`);
  console.log("");
  console.log(rule.description);
  console.log("");
  console.log(pc.dim(`Configure with: vue-doctor rules set ${ruleKey(rule)} <error|warn|off>`));
};

const setRuleLevel = (config: Record<string, unknown>, key: string, level: RuleLevel): Record<string, unknown> => ({
  ...config,
  rules: {
    ...((config.rules && typeof config.rules === "object" && !Array.isArray(config.rules)) ? config.rules : {}),
    [key]: level,
  },
});

const setCategoryLevel = (config: Record<string, unknown>, category: string, level: RuleLevel): Record<string, unknown> => ({
  ...config,
  categories: {
    ...((config.categories && typeof config.categories === "object" && !Array.isArray(config.categories)) ? config.categories : {}),
    [category]: level,
  },
});

const runRulesSet = async (
  ruleQuery: string,
  levelValue: string,
  flags: RulesFlags,
): Promise<void> => {
  const rule = findRule(ruleQuery);
  if (!rule) throw new Error(`Unknown rule "${ruleQuery}". Run vue-doctor rules list.`);
  const level = parseRuleLevel(levelValue);
  if (!level) throw new Error(`Invalid severity "${levelValue}". Use error, warn, warning, or off.`);
  const target = updateRuleConfig(flags, (config) => setRuleLevel(config, ruleKey(rule), level));
  console.log(`Set ${ruleKey(rule)} -> ${formatRuleLevel(level)}`);
  console.log(pc.dim(`Updated ${describeRuleConfigTarget(target)}`));
};

const runRulesEnable = async (ruleQuery: string, flags: RulesFlags): Promise<void> => {
  const rule = findRule(ruleQuery);
  if (!rule) throw new Error(`Unknown rule "${ruleQuery}". Run vue-doctor rules list.`);
  const level = flags.severity ? parseRuleLevel(flags.severity) : rule.defaultSeverity;
  if (!level || level === "off") throw new Error("Enable severity must be error, warn, or warning.");
  const target = updateRuleConfig(flags, (config) => setRuleLevel(config, ruleKey(rule), level));
  console.log(`Enabled ${ruleKey(rule)} -> ${formatRuleLevel(level)}`);
  console.log(pc.dim(`Updated ${describeRuleConfigTarget(target)}`));
};

const runRulesDisable = async (ruleQuery: string, flags: RulesFlags): Promise<void> => {
  await runRulesSet(ruleQuery, "off", flags);
};

const runRulesCategory = async (
  categoryQuery: string,
  levelValue: string,
  flags: RulesFlags,
): Promise<void> => {
  const category = [...new Set(rules.map((rule) => rule.category))].find(
    (candidate) => normalizeCategoryName(candidate) === normalizeCategoryName(categoryQuery),
  );
  if (!category) throw new Error(`Unknown category "${categoryQuery}". Run vue-doctor rules list.`);
  const level = parseRuleLevel(levelValue);
  if (!level) throw new Error(`Invalid severity "${levelValue}". Use error, warn, warning, or off.`);
  const target = updateRuleConfig(flags, (config) => setCategoryLevel(config, category, level));
  console.log(`Set category ${category} -> ${formatRuleLevel(level)}`);
  console.log(pc.dim(`Updated ${describeRuleConfigTarget(target)}`));
};

const resolveHandoffMode = (flags: CliFlags): HandoffMode | undefined => {
  if (flags.copyPrompt) return "copy";
  if (flags.printPrompt) return "print";
  if (flags.handoff === undefined || flags.handoff === false) return undefined;
  if (flags.handoff === true) return "prompt";
  const mode = flags.handoff.trim();
  if (VALID_HANDOFF_MODES.has(mode as HandoffMode)) return mode as HandoffMode;
  throw new Error(`Handoff mode "${mode}" is not supported. Use prompt, copy, print, codex, claude, cursor, or skip.`);
};

const resolveOptionalPath = (rootDirectory: string, value: string | undefined): string | undefined =>
  value ? path.resolve(rootDirectory, value) : undefined;

const filterScanByBaseline = (scan: CompletedScan, baselineKeys: Set<string>): CompletedScan => {
  const diagnostics = filterDiagnosticsByBaseline(scan.result.diagnostics, baselineKeys);
  return {
    directory: scan.directory,
    result: {
      ...scan.result,
      diagnostics,
      score: calculateScore(diagnostics, {
        totalSourceFiles: scan.result.project.sourceFileCount,
      }),
    },
  };
};

const normalizeRelativePath = (filePath: string): string =>
  filePath.replaceAll("\\", "/").replace(/^\.\//, "");

const createMovedDiagnosticKey = (diagnostic: Diagnostic): string =>
  [
    normalizeRelativePath(diagnostic.relativePath),
    diagnostic.rule,
    diagnostic.message,
  ].join("\0");

const withFilteredDiagnostics = (
  scan: CompletedScan,
  diagnostics: Diagnostic[],
): CompletedScan => ({
  directory: scan.directory,
  result: {
    ...scan.result,
    diagnostics,
    score: calculateScore(diagnostics, {
      totalSourceFiles: scan.result.project.sourceFileCount,
    }),
  },
});

const filterScanByChangedLineRanges = (
  scan: CompletedScan,
  changedLineRanges: ChangedLineRanges[] | null,
): CompletedScan => {
  if (!changedLineRanges || changedLineRanges.length === 0) return scan;
  const rangesByFile = new Map(
    changedLineRanges.map((entry) => [normalizeRelativePath(entry.file), entry.ranges]),
  );
  const diagnostics = scan.result.diagnostics.filter((diagnostic) => {
    const ranges = rangesByFile.get(normalizeRelativePath(diagnostic.relativePath));
    return ranges?.some(([start, end]) => diagnostic.line >= start && diagnostic.line <= end) ?? false;
  });
  return withFilteredDiagnostics(scan, diagnostics);
};

const filterScanByBaseDiagnostics = (
  headScan: CompletedScan,
  baseDiagnostics: Diagnostic[],
): { scan: CompletedScan; fixedCount: number; baseTotalCount: number } => {
  const baseKeys = new Set(baseDiagnostics.map(createMovedDiagnosticKey));
  const headKeys = new Set(headScan.result.diagnostics.map(createMovedDiagnosticKey));
  const diagnostics = headScan.result.diagnostics.filter(
    (diagnostic) => !baseKeys.has(createMovedDiagnosticKey(diagnostic)),
  );
  const fixedCount = baseDiagnostics.filter(
    (diagnostic) => !headKeys.has(createMovedDiagnosticKey(diagnostic)),
  ).length;
  return {
    scan: withFilteredDiagnostics(headScan, diagnostics),
    fixedCount,
    baseTotalCount: baseDiagnostics.length,
  };
};

const writeSnapshotFile = (rootDirectory: string, relativePath: string, content: string): void => {
  const filePath = path.join(rootDirectory, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
};

const copyCurrentProjectFile = (
  projectDirectory: string,
  snapshotDirectory: string,
  relativePath: string,
): void => {
  const sourcePath = path.join(projectDirectory, relativePath);
  if (!existsSync(sourcePath)) return;
  writeSnapshotFile(snapshotDirectory, relativePath, readFileSync(sourcePath, "utf-8"));
};

const diagnoseBaseSnapshot = async (
  projectDirectory: string,
  baseRef: string,
  includePaths: string[],
  flags: CliFlags,
  loadedConfig: VueDoctorConfig,
  configOverride?: VueDoctorConfig,
): Promise<Diagnostic[]> => {
  const snapshotDirectory = mkdtempSync(path.join(tmpdir(), "vue-doctor-base-"));
  try {
    copyCurrentProjectFile(projectDirectory, snapshotDirectory, "package.json");
    const baseIncludePaths: string[] = [];
    for (const includePath of includePaths) {
      const source = readGitFileAtRef(projectDirectory, baseRef, includePath);
      if (source === null) continue;
      writeSnapshotFile(snapshotDirectory, includePath, source);
      baseIncludePaths.push(includePath);
    }
    if (baseIncludePaths.length === 0) return [];

    const snapshotConfig = mergeConfig(
      {
        ...loadedConfig,
        rootDir: undefined,
        baseline: undefined,
        diff: false,
        scope: "full",
      },
      configOverride,
    );
    const baseResult = await diagnose(snapshotDirectory, {
      config: snapshotConfig,
      includePaths: baseIncludePaths,
      respectInlineDisables: resolveRespectInlineDisables(flags),
      parallelWorkers: resolveParallelWorkers(flags),
    });
    return baseResult.diagnostics;
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
};

const buildScoreLines = (score: ScoreResult, displayScore = score.score): string[] => {
  const color = colorByScore(score);
  const normalizedDisplayScore = Math.max(0, Math.min(100, Math.round(displayScore)));
  const filled = Math.round((normalizedDisplayScore / 100) * SCORE_BAR_WIDTH);
  const bar = `${color("#".repeat(filled))}${pc.dim("-".repeat(SCORE_BAR_WIDTH - filled))}`;
  const face = score.score >= 75 ? "^_^" : score.score >= 50 ? "-_-" : "x_x";
  const scoreLine = `${color(String(normalizedDisplayScore))} ${pc.dim("/ 100")} ${color(score.label)}`;

  return [
    `  +-------+  ${scoreLine}`,
    `  | ${face.padEnd(5, " ")} |  ${bar}`,
    `  +-------+  ${pc.bold("Vue Doctor")}`,
  ];
};

const writeScoreLines = (lines: string[]): void => {
  for (const line of lines) {
    process.stdout.write(`\r${line}\x1b[K\n`);
  }
};

const printScore = async (score: ScoreResult, animate: boolean): Promise<void> => {
  if (!animate) {
    for (const line of buildScoreLines(score)) console.log(line);
    return;
  }

  process.stdout.write("\x1b[?25l");
  try {
    for (let frame = 0; frame <= SCORE_ANIMATION_FRAMES; frame += 1) {
      if (frame > 0) process.stdout.write("\x1b[3A");
      const progress = easeOutCubic(frame / SCORE_ANIMATION_FRAMES);
      writeScoreLines(buildScoreLines(score, score.score * progress));
      if (frame < SCORE_ANIMATION_FRAMES) await sleep(SCORE_ANIMATION_DELAY_MS);
    }
  } finally {
    process.stdout.write("\x1b[?25h");
  }
};

const groupDiagnostics = (diagnostics: Diagnostic[]): Map<string, Diagnostic[]> => {
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const list = grouped.get(diagnostic.category) ?? [];
    list.push(diagnostic);
    grouped.set(diagnostic.category, list);
  }
  return grouped;
};

const formatSeverity = (diagnostic: Diagnostic): string =>
  diagnostic.severity === "error" ? pc.red("error") : pc.yellow("warn");

const formatIssueCount = (count: number): string => `${count} ${count === 1 ? "issue" : "issues"}`;

const formatSourceFileCount = (count: number): string =>
  `${count} source ${count === 1 ? "file" : "files"}`;

const sortGroupsByImportance = (groups: Array<[string, Diagnostic[]]>): Array<[string, Diagnostic[]]> =>
  [...groups].sort(([, leftDiagnostics], [, rightDiagnostics]) => {
    const leftSeverity = leftDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? 0 : 1;
    const rightSeverity = rightDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? 0 : 1;
    if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
    if (leftDiagnostics.length !== rightDiagnostics.length) return rightDiagnostics.length - leftDiagnostics.length;
    return leftDiagnostics[0]!.rule.localeCompare(rightDiagnostics[0]!.rule);
  });

const formatCategoryIssueSummary = (diagnostics: Diagnostic[]): string => {
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warningCount = diagnostics.length - errorCount;
  const parts: string[] = [];
  if (errorCount > 0) parts.push(pc.red(`${errorCount} ${errorCount === 1 ? "error" : "errors"}`));
  if (warningCount > 0) {
    parts.push(pc.yellow(`${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`));
  }
  return parts.length > 0 ? parts.join(pc.dim(", ")) : pc.dim(formatIssueCount(diagnostics.length));
};

const buildCompactDiagnosticsLines = (diagnostics: Diagnostic[]): string[] => {
  if (diagnostics.length === 0) {
    return [pc.green("No Vue Doctor diagnostics found.")];
  }

  const lines: string[] = [];
  const categoryGroups = sortGroupsByImportance([...groupDiagnostics(diagnostics).entries()]);
  for (const [category, categoryDiagnostics] of categoryGroups) {
    lines.push(`${pc.bold(category)} ${pc.dim(SYMBOLS.arrow)} ${formatCategoryIssueSummary(categoryDiagnostics)}`);
  }

  return lines;
};

const printAnimatedLines = async (lines: string[], animate: boolean): Promise<void> => {
  if (!animate || lines.length <= 1) {
    for (const line of lines) console.log(line);
    return;
  }

  const visibleLineCount = Math.max(1, lines.filter((line) => line.trim().length > 0).length);
  const delay = Math.max(20, Math.min(100, Math.floor(DIAGNOSTIC_ANIMATION_BUDGET_MS / visibleLineCount)));
  for (const [index, line] of lines.entries()) {
    console.log(line);
    if (line.trim().length > 0 && index < lines.length - 1) await sleep(delay);
  }
};

const printVerboseDiagnostics = (diagnostics: Diagnostic[]): void => {
  if (diagnostics.length === 0) {
    console.log(pc.green("No Vue Doctor diagnostics found."));
    return;
  }

  const grouped = groupDiagnostics(diagnostics);
  for (const [category, categoryDiagnostics] of grouped) {
    console.log("");
    console.log(pc.bold(category));
    for (const diagnostic of categoryDiagnostics) {
      const location = `${diagnostic.relativePath}:${diagnostic.line}:${diagnostic.column}`;
      console.log(`  ${formatSeverity(diagnostic)} ${pc.bold(`vue-doctor/${diagnostic.rule}`)} ${pc.dim(location)}`);
      console.log(`    ${diagnostic.message}`);
      console.log(pc.dim(`    ${diagnostic.help}`));
      printCodeFrame(diagnostic);
    }
  }
};

const printCodeFrame = (diagnostic: Diagnostic): void => {
  try {
    const lines = readFileSync(diagnostic.filePath, "utf-8").split(/\r?\n/);
    const sourceLine = lines[diagnostic.line - 1];
    if (!sourceLine) return;
    const lineNumber = String(diagnostic.line).padStart(4, " ");
    const caretOffset = Math.max(0, diagnostic.column - 1);
    console.log(pc.dim(`    ${lineNumber} | ${sourceLine.trimEnd()}`));
    console.log(pc.dim(`         | ${" ".repeat(caretOffset)}^`));
  } catch {}
};

const printDiagnostics = async (
  diagnostics: Diagnostic[],
  verbose: boolean,
  animate: boolean,
): Promise<void> => {
  if (verbose) {
    printVerboseDiagnostics(diagnostics);
    return;
  }

  const lines = buildCompactDiagnosticsLines(diagnostics);
  await printAnimatedLines(lines, animate);
};

const encodeAnnotationValue = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A").replaceAll(",", "%2C");

const printAnnotations = (diagnostics: Diagnostic[]): void => {
  for (const diagnostic of diagnostics) {
    const level = diagnostic.severity === "error" ? "error" : "warning";
    const file = encodeAnnotationValue(diagnostic.relativePath);
    const title = encodeAnnotationValue(`vue-doctor/${diagnostic.rule}`);
    const message = encodeAnnotationValue(diagnostic.message);
    console.log(`::${level} file=${file},line=${diagnostic.line},col=${diagnostic.column},title=${title}::${message}`);
  }
};

const writeFullReport = (directory: string, report: JsonReport): string => {
  const outputDirectory = join(tmpdir(), `vue-doctor-${randomUUID()}`);
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, "report.json");
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
};

const formatElapsed = (milliseconds: number): string =>
  milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${Math.round(milliseconds)}ms`;

const formatFrameworkName = (framework: DiagnoseResult["project"]["framework"]): string => {
  const names: Record<DiagnoseResult["project"]["framework"], string> = {
    nuxt: "Nuxt",
    vite: "Vite",
    "vue-cli": "Vue CLI",
    quasar: "Quasar",
    vitepress: "VitePress",
    vuepress: "VuePress",
    unknown: "Vue",
  };
  return names[framework];
};

const formatScanMode = (mode: JsonReportMode): string => {
  const labels: Record<JsonReportMode, string> = {
    full: "Full project",
    diff: "Changed files",
    staged: "Staged files",
    "changed-files": "Changed-file list",
    baseline: "Introduced issues",
  };
  return labels[mode];
};

const formatDisplayScanMode = (mode: JsonReportMode, flags: CliFlags): string => {
  if (flags.include && flags.include.length > 0) return "Included paths";
  return formatScanMode(mode);
};

const printInspectHeader = (
  mode: JsonReportMode,
  flags: CliFlags,
  workspaceCount: number,
  parallelWorkers: number | undefined,
): void => {
  const workspaceLabel = `${workspaceCount} ${workspaceCount === 1 ? "workspace" : "workspaces"}`;
  const parallelLabel = parallelWorkers ? `${parallelWorkers} workers` : "single-threaded";
  console.log(`${pc.bold("vue-doctor")} ${pc.dim(`v${VERSION}`)}`);
  console.log(pc.dim(`${formatDisplayScanMode(mode, flags)} - ${workspaceLabel} - ${parallelLabel}`));
  console.log("");
};

const formatProjectStack = (result: DiagnoseResult): string => {
  if (!result.project.hasVue) {
    return `${pc.red(SYMBOLS.error)} Vue project was not detected ${pc.dim(`- ${formatSourceFileCount(result.project.sourceFileCount)}`)}`;
  }

  const framework = formatFrameworkName(result.project.framework);
  const parts = [
    framework,
    result.project.vueVersion ? `Vue ${result.project.vueVersion}` : "Vue",
    result.project.hasTypeScript ? "TypeScript" : "JavaScript",
  ];
  if (result.project.hasPinia) parts.push("Pinia");
  if (result.project.hasVueRouter) parts.push("Vue Router");
  parts.push(formatSourceFileCount(result.project.sourceFileCount));
  return `${pc.green(SYMBOLS.ok)} ${parts.join(pc.dim(" / "))}`;
};

const printRunHeader = (result: DiagnoseResult, verbose: boolean): void => {
  const framework = formatFrameworkName(result.project.framework);
  console.log("");
  console.log(`${pc.bold("Project:")} ${result.project.projectName}`);

  if (!verbose) {
    console.log(formatProjectStack(result));
    return;
  }

  if (result.project.hasVue) {
    console.log(`${pc.green(SYMBOLS.ok)} Detecting framework. Found ${framework}.`);
  } else {
    console.log(`${pc.red(SYMBOLS.error)} Detecting Vue framework. Not found.`);
  }
  console.log(
    `${pc.green(SYMBOLS.ok)} Detecting Vue version. ${
      result.project.vueVersion ? `Found Vue ${result.project.vueVersion}.` : "No Vue dependency found."
    }`,
  );
  console.log(
    `${pc.green(SYMBOLS.ok)} Detecting language. Found ${
      result.project.hasTypeScript ? "TypeScript" : "JavaScript"
    }.`,
  );
  if (result.project.hasPinia) {
    console.log(`${pc.green(SYMBOLS.ok)} Detecting Pinia. Found.`);
  }
  if (result.project.hasVueRouter) {
    console.log(`${pc.green(SYMBOLS.ok)} Detecting Vue Router. Found.`);
  }
  console.log(`${pc.green(SYMBOLS.ok)} Found ${formatSourceFileCount(result.project.sourceFileCount)}.`);
};

const printRunFooter = async (
  result: DiagnoseResult,
  fullDiagnosticsPath: string | null,
  animate: boolean,
): Promise<void> => {
  const summary = summarizeDiagnostics(result.diagnostics);
  console.log("");
  await printScore(result.score, animate);
  console.log("");
  console.log(
    pc.dim(
      `${formatIssueCount(summary.totalDiagnosticCount)} across ${summary.affectedFileCount}/${result.project.sourceFileCount} files in ${formatElapsed(result.elapsedMilliseconds)}`,
    ),
  );
  if (summary.totalDiagnosticCount > 0) {
    console.log(pc.dim(`Run npx @rekl0w/vue-doctor@latest --verbose to list every issue with source frames.`));
  }
  if (fullDiagnosticsPath) {
    console.log(pc.dim(`Full diagnostics written to ${fullDiagnosticsPath}`));
  }
};

const coerceDiffValue = (value: unknown): boolean | string | undefined => {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed.length > 0 ? trimmed : true;
};

const resolveDiffValue = (flags: CliFlags, configDiff: boolean | string | undefined): boolean | string | undefined => {
  if (flags.full) return false;
  return coerceDiffValue(flags.diff ?? configDiff);
};

const resolveScanScope = (flags: CliFlags, config: VueDoctorConfig): ScanScope => {
  if (flags.full) return "full";
  const flagScope = resolveScopeValue(flags.scope);
  if (flagScope) return flagScope;
  if (config.scope) return config.scope;

  const diffValue = resolveDiffValue(flags, config.diff);
  if (diffValue === false) return "full";
  if (diffValue !== undefined) return "changed";
  if (flags.changedFilesFrom) return "changed";
  return "full";
};

const resolveBaseRef = (flags: CliFlags, config: VueDoctorConfig): string | undefined => {
  if (flags.base && flags.base.trim().length > 0) return flags.base.trim();
  if (config.base && config.base.trim().length > 0) return config.base.trim();
  const diffValue = resolveDiffValue(flags, config.diff);
  if (typeof diffValue === "string") return diffValue;
  const envBase = process.env.VUE_DOCTOR_BASE_SHA ?? process.env.VUE_DOCTOR_BASE_REF;
  return envBase && envBase.trim().length > 0 ? envBase.trim() : undefined;
};

const getWorstScore = (scans: CompletedScan[]): ScoreResult => {
  if (scans.length === 0) return { score: 100, label: "Great" };
  return scans
    .map((scan) => scan.result.score)
    .sort((left, right) => left.score - right.score)[0]!;
};

const getAllDiagnostics = (scans: CompletedScan[]): Diagnostic[] =>
  scans.flatMap((scan) => scan.result.diagnostics);

type InteractiveScanChoice = "changed" | "staged" | "full";

const hasExplicitScanMode = (
  flags: CliFlags,
  configDiff: boolean | string | undefined,
  configScope: ScanScope | undefined,
): boolean =>
  Boolean(
    flags.full ||
    flags.staged ||
    flags.scope !== undefined ||
    flags.diff !== undefined ||
    flags.changedFilesFrom ||
    configScope !== undefined ||
    configDiff !== undefined ||
    (flags.include && flags.include.length > 0),
  );

const applyInteractiveScanMode = async (
  rootDirectory: string,
  flags: CliFlags,
  configDiff: boolean | string | undefined,
  configScope: ScanScope | undefined,
  quiet: boolean,
): Promise<void> => {
  if (quiet || flags.yes || !canPrompt() || hasExplicitScanMode(flags, configDiff, configScope)) return;

  const choices: Array<{ value: InteractiveScanChoice; label: string; hint?: string }> = [];
  let defaultValue: InteractiveScanChoice = "full";

  try {
    const diffInfo = getDiffInfo(rootDirectory);
    const changedSourceFiles = diffInfo ? filterSourceFiles(diffInfo.changedFiles) : [];
    if (changedSourceFiles.length > 0) {
      choices.push({
        value: "changed",
        label: "Changed files",
        hint: `${changedSourceFiles.length} source ${changedSourceFiles.length === 1 ? "file" : "files"}`,
      });
      defaultValue = "changed";
    }
  } catch {}

  const stagedSourceFiles = getStagedSourceFiles(rootDirectory);
  if (stagedSourceFiles.length > 0) {
    choices.push({
      value: "staged",
      label: "Staged files",
      hint: `${stagedSourceFiles.length} source ${stagedSourceFiles.length === 1 ? "file" : "files"}`,
    });
    if (defaultValue === "full") defaultValue = "staged";
  }

  choices.push({
    value: "full",
    label: "Full project",
    hint: "scan every Vue source file",
  });

  if (choices.length <= 1) return;

  const selected = await promptChoice("What should Vue Doctor scan?", choices, defaultValue);
  if (selected === "changed") flags.scope = "changed";
  if (selected === "staged") flags.staged = true;
  if (selected === "full") flags.full = true;
};

const resolveRespectInlineDisables = (flags: CliFlags): boolean | undefined =>
  typeof flags.respectInlineDisables === "boolean" ? flags.respectInlineDisables : undefined;

const resolveParallelWorkers = (flags: CliFlags): number | undefined => {
  const raw = flags.experimentalParallel ?? process.env.VUE_DOCTOR_PARALLEL ?? process.env.REACT_DOCTOR_PARALLEL;
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return 4;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error("Expected --experimental-parallel to be a positive integer worker count.");
  }
  return workers;
};

const parseExplainTarget = (value: string): { file: string; line: number } => {
  const match = value.match(/^(.*):(\d+)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error("Expected --explain value to look like src/App.vue:42.");
  }
  return { file: match[1], line: Number(match[2]) };
};

const runExplain = async (
  rootDirectory: string,
  flags: CliFlags,
  explainValue: string,
  configOverride?: VueDoctorConfig,
): Promise<void> => {
  const target = parseExplainTarget(explainValue);
  const activeResult = await diagnose(rootDirectory, {
    configPath: flags.config,
    config: configOverride,
    includePaths: [target.file],
    respectInlineDisables: resolveRespectInlineDisables(flags),
    parallelWorkers: resolveParallelWorkers(flags),
  });
  const auditResult = await diagnose(rootDirectory, {
    configPath: flags.config,
    config: configOverride,
    includePaths: [target.file],
    respectInlineDisables: false,
    parallelWorkers: resolveParallelWorkers(flags),
  });

  const isSameDiagnostic = (left: Diagnostic, right: Diagnostic): boolean =>
    left.rule === right.rule && left.relativePath === right.relativePath && left.line === right.line && left.column === right.column;
  const nearTarget = (diagnostic: Diagnostic): boolean =>
    diagnostic.relativePath === toRelativePath(path.resolve(rootDirectory, target.file), rootDirectory) &&
    Math.abs(diagnostic.line - target.line) <= 1;
  const active = activeResult.diagnostics.filter(nearTarget);
  const suppressed = auditResult.diagnostics
    .filter(nearTarget)
    .filter((diagnostic) => !activeResult.diagnostics.some((activeDiagnostic) => isSameDiagnostic(activeDiagnostic, diagnostic)));

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: VERSION,
          ok: true,
          explain: {
            file: target.file,
            line: target.line,
            diagnostics: active,
            suppressed,
          },
        },
        null,
        flags.jsonCompact ? 0 : 2,
      )}\n`,
    );
    return;
  }

  console.log(`Vue Doctor explain: ${target.file}:${target.line}`);
  if (active.length === 0 && suppressed.length === 0) {
    console.log(pc.green("No Vue Doctor diagnostics found at this line."));
    return;
  }

  if (active.length > 0) {
    console.log("");
    console.log(pc.bold("Active diagnostics"));
    printVerboseDiagnostics(active);
  }
  if (suppressed.length > 0) {
    console.log("");
    console.log(pc.bold("Suppressed diagnostics"));
    printVerboseDiagnostics(suppressed);
  }
};

const runInspect = async (directory: string, flags: CliFlags): Promise<void> => {
  const requestedDirectory = path.resolve(directory);
  const start = performance.now();
  const loaded = loadConfig(requestedDirectory, flags.config);
  const rootDirectory = loaded.rootDirectory;
  const failOn = resolveBlocking(flags, loaded.config);
  const preset = resolvePreset(flags.preset ?? loaded.config.preset);
  const configOverride = buildConfigOverride(preset, flags);
  const baselinePath = resolveOptionalPath(rootDirectory, flags.baseline ?? loaded.config.baseline);
  const updateBaselinePath = resolveOptionalPath(rootDirectory, flags.updateBaseline);
  const explainValue = flags.explain ?? flags.why;

  if (explainValue) {
    await runExplain(rootDirectory, flags, explainValue, configOverride);
    return;
  }

  const quiet = Boolean(flags.json || flags.markdown || flags.sarif || flags.score || flags.annotations);
  await applyInteractiveScanMode(rootDirectory, flags, loaded.config.diff, loaded.config.scope, quiet);
  const projectDirectories = selectProjectDirectories(rootDirectory, flags.project, Boolean(flags.yes));
  const scope = resolveScanScope(flags, loaded.config);
  const explicitBase = resolveBaseRef(flags, loaded.config);
  const parallelWorkers = resolveParallelWorkers(flags);
  const changedFilesFromPath = flags.changedFilesFrom
    ? path.resolve(rootDirectory, flags.changedFilesFrom)
    : undefined;
  const changedFilesFrom = changedFilesFromPath ? readChangedFilesFromFile(changedFilesFromPath) : [];
  let mode: JsonReportMode = flags.staged
    ? "staged"
    : changedFilesFromPath
      ? "changed-files"
      : scope !== "full"
        ? "diff"
        : "full";
  let scans: CompletedScan[] = [];
  let reportDiff: DiffInfo | null = null;
  let baselineBaseRef: string | null = null;
  let baselineFixedCount = 0;
  let baselineBaseTotalCount = 0;

  if (!quiet) {
    printInspectHeader(mode, flags, projectDirectories.length, parallelWorkers);
    await printOpeningSequence(rootDirectory, projectDirectories.length, shouldAnimateCliOutput() && !flags.verbose);
  }

  if (flags.offline && !quiet) {
    console.log(pc.dim("Offline mode enabled. Socket.dev supply-chain scoring is skipped."));
    console.log("");
  }

  for (const projectDirectory of projectDirectories) {
    let includePaths = flags.include && flags.include.length > 0 ? flags.include : undefined;
    let changedLineRanges: ChangedLineRanges[] | null = null;
    let baseRefForComparison: string | undefined;

    if (flags.staged) {
      const stagedFiles = getStagedSourceFiles(projectDirectory);
      if (stagedFiles.length === 0) {
        continue;
      }
      includePaths = stagedFiles;
      if (scope === "lines") {
        changedLineRanges = getChangedLineRanges(projectDirectory, {
          cached: true,
          files: stagedFiles,
        });
      }
    } else if (changedFilesFromPath) {
      const projectChangedFiles = filterSourceFiles(
        filterChangedFilesForProject(rootDirectory, projectDirectory, changedFilesFrom),
      );
      const comparisonBase = explicitBase ? (getMergeBase(projectDirectory, explicitBase) ?? explicitBase) : undefined;
      if (projectDirectory === projectDirectories[0]) {
        reportDiff = {
          currentBranch: "HEAD",
          baseBranch: explicitBase ?? changedFilesFromPath,
          baseRef: comparisonBase,
          changedFiles: changedFilesFrom,
        };
      }
      if (projectChangedFiles.length === 0) {
        if (!quiet) console.log(pc.dim(`No changed source files in ${projectDirectory}, skipping.`));
        continue;
      }
      includePaths = projectChangedFiles;
      baseRefForComparison = comparisonBase;
      if (scope === "lines" && comparisonBase) {
        changedLineRanges = getChangedLineRanges(projectDirectory, {
          baseRef: comparisonBase,
          files: projectChangedFiles,
        });
      }
      if (!quiet) {
        console.log(`Scanning changed files from ${changedFilesFromPath}.`);
        console.log("");
      }
    } else if (scope !== "full") {
      const diffInfo = getDiffInfo(projectDirectory, explicitBase);
      if (projectDirectory === projectDirectories[0]) reportDiff = diffInfo;
      if (diffInfo) {
        const changedSourceFiles = filterSourceFiles(diffInfo.changedFiles);
        if (changedSourceFiles.length === 0) {
          if (!quiet) console.log(pc.dim(`No changed source files in ${projectDirectory}, skipping.`));
          continue;
        }
        includePaths = changedSourceFiles;
        baseRefForComparison = diffInfo.baseRef;
        if (scope === "lines" && diffInfo.baseRef) {
          changedLineRanges = getChangedLineRanges(projectDirectory, {
            baseRef: diffInfo.baseRef,
            files: changedSourceFiles,
          });
        }
        if (!quiet) {
          if (diffInfo.isCurrentChanges) {
            console.log("Scanning uncommitted changes.");
          } else {
            console.log(`Scanning changes: ${diffInfo.currentBranch} -> ${diffInfo.baseBranch}`);
          }
          console.log("");
        }
      } else if (!quiet) {
        console.log(pc.dim(`Cannot detect diff for ${projectDirectory}; scanning all files.`));
        console.log("");
      }
    }

    const diagnoseOptions = {
      verbose: flags.verbose,
      configPath: flags.config,
      config: configOverride,
      includePaths,
      respectInlineDisables: resolveRespectInlineDisables(flags),
      parallelWorkers,
    };
    const result = quiet
      ? await diagnose(projectDirectory, diagnoseOptions)
      : await runProductStep(
          "Analyzing Vue source...",
          () => diagnose(projectDirectory, diagnoseOptions),
          (scanResult) =>
            `${formatSourceFileCount(scanResult.project.sourceFileCount)}, ${formatIssueCount(scanResult.diagnostics.length)}`,
          );
    scans.push({ directory: projectDirectory, result });
    const scanIndex = scans.length - 1;
    const headScan = scans[scanIndex]!;
    if (scope === "lines") {
      scans[scanIndex] = filterScanByChangedLineRanges(headScan, changedLineRanges);
    } else if (scope === "changed" && baseRefForComparison && includePaths && includePaths.length > 0) {
      const baseDiagnostics = await diagnoseBaseSnapshot(
        projectDirectory,
        baseRefForComparison,
        includePaths,
        flags,
        loaded.config,
        configOverride,
      );
      const filtered = filterScanByBaseDiagnostics(headScan, baseDiagnostics);
      scans[scanIndex] = filtered.scan;
      baselineBaseRef = baseRefForComparison;
      baselineFixedCount += filtered.fixedCount;
      baselineBaseTotalCount += filtered.baseTotalCount;
      mode = "baseline";
    }
  }

  const rawDiagnostics = getAllDiagnostics(scans);
  if (updateBaselinePath) {
    writeBaseline(updateBaselinePath, rawDiagnostics);
    if (!quiet) {
      console.log(pc.dim(`Baseline written to ${updateBaselinePath}`));
      console.log("");
    }
  }

  if (baselinePath) {
    const baselineKeys = readBaselineKeys(baselinePath);
    scans = scans.map((scan) => filterScanByBaseline(scan, baselineKeys));
  }

  const report = toJsonReportFromScans(rootDirectory, scans, {
    mode,
    diff: mode === "diff" || mode === "changed-files" || mode === "baseline" ? reportDiff : null,
    baseline: baselineBaseRef
      ? {
          baseRef: baselineBaseRef,
          newCount: getAllDiagnostics(scans).length,
          fixedCount: baselineFixedCount,
          baseTotalCount: baselineBaseTotalCount,
        }
      : undefined,
    elapsedMilliseconds: performance.now() - start,
  });
  const diagnostics = getAllDiagnostics(scans);

  if (flags.staged && scans.length === 0) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report, null, flags.jsonCompact ? 0 : 2)}\n`);
    } else if (flags.sarif) {
      process.stdout.write(`${JSON.stringify(toSarifReport(report), null, flags.jsonCompact ? 0 : 2)}\n`);
    } else if (flags.markdown) {
      process.stdout.write(toMarkdownReport(report));
    } else if (!flags.score && !flags.annotations) {
      console.log(pc.dim("No staged source files found."));
    }
    return;
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, flags.jsonCompact ? 0 : 2)}\n`);
  } else if (flags.sarif) {
    process.stdout.write(`${JSON.stringify(toSarifReport(report), null, flags.jsonCompact ? 0 : 2)}\n`);
  } else if (flags.markdown) {
    process.stdout.write(toMarkdownReport(report));
  } else if (flags.score) {
    process.stdout.write(`${getWorstScore(scans).score}\n`);
  } else if (flags.annotations) {
    printAnnotations(diagnostics);
  } else if (scans.length === 0) {
    console.log(pc.green("No Vue source files matched this scan."));
    await printScore({ score: 100, label: "Great" }, shouldAnimateCliOutput());
  } else {
    const fullDiagnosticsPath =
      flags.verbose || diagnostics.length === 0 ? null : writeFullReport(rootDirectory, report);
    const animateOutput = shouldAnimateCliOutput() && !flags.verbose && !flags.prComment && scans.length === 1;
    for (const [index, scan] of scans.entries()) {
      if (scans.length > 1) {
        console.log(pc.bold(`Project ${index + 1}/${scans.length}: ${scan.result.project.projectName}`));
        console.log("");
      }
      printRunHeader(scan.result, Boolean(flags.verbose));
      await printDiagnostics(scan.result.diagnostics, Boolean(flags.verbose || flags.prComment), animateOutput);
      await printRunFooter(scan.result, scans.length === 1 ? fullDiagnosticsPath : null, animateOutput);
      if (index < scans.length - 1) console.log("");
    }
    if (scans.length > 1 && fullDiagnosticsPath) {
      console.log("");
      console.log(pc.dim(`Full diagnostics written to ${fullDiagnosticsPath}`));
    }
  }

  if (!quiet && report.project.hasVue && diagnostics.length > 0) {
    await runAgentHandoff(report, {
      cwd: rootDirectory,
      mode: resolveHandoffMode(flags) ?? "prompt",
    });
  }
  if (!quiet && report.project.hasVue) await maybeOfferProjectSetup(rootDirectory);

  process.exitCode = shouldFail(diagnostics, failOn) ? 1 : 0;
};

const runInstall = async (flags: InstallFlags): Promise<void> => {
  await runInstallOnboarding({
    yes: flags.yes,
    dryRun: flags.dryRun,
    cwd: flags.cwd,
    agentHooks: flags.agentHooks,
    gitHook: flags.gitHook,
    githubAction: flags.githubAction,
  });
};

export const runCli = async (argv = process.argv): Promise<void> => {
  const program = new Command();
  program
    .name("vue-doctor")
    .description("Scan Vue codebases for security, performance, correctness, accessibility, bundle-size, design, and architecture issues.")
    .argument("[directory]", "project directory to scan", ".")
    .version(VERSION, "-v, --version")
    .option("--verbose", "show every diagnostic", false)
    .option("--warnings", "show warning-severity diagnostics")
    .option("--no-warnings", "hide warning-severity diagnostics")
    .option("--dead-code", "enable import graph and dead-code analysis")
    .option("--no-dead-code", "skip import graph and dead-code analysis")
    .option("--json", "output a single structured JSON report", false)
    .option("--markdown", "output a Markdown report", false)
    .option("--sarif", "output a SARIF 2.1.0 report", false)
    .option("--json-compact", "with --json, emit compact JSON", false)
    .option("--score", "output only the score", false)
    .option("--annotations", "output GitHub Actions annotations", false)
    .option("--pr-comment", "tune terminal output for sticky PR comments", false)
    .option("-y, --yes", "skip prompts and scan all detected workspace projects", false)
    .option("--full", "force a full scan and ignore config diff / --diff", false)
    .option("--project <name>", "workspace project(s) to scan; repeat by comma-separating names")
    .option("--scope <value>", "scan/report scope: full, files, changed, or lines")
    .option("--base <ref>", "base git ref for files, changed, and lines scopes")
    .option("--diff [base]", "deprecated alias for --scope changed; pass false to disable")
    .option("--changed-files-from <path>", "scan source files listed in a newline, NUL, or JSON file")
    .option("--staged", "scan staged git files", false)
    .option("--offline", "skip network-backed checks such as Socket.dev supply-chain scoring", false)
    .option("--supply-chain", "enable Socket.dev supply-chain dependency scoring")
    .option("--no-supply-chain", "skip Socket.dev supply-chain dependency scoring")
    .option("--experimental-parallel [workers]", "scan files in worker threads; defaults to 4 workers")
    .option("--blocking <level>", "severity that exits non-zero: error, warning, none")
    .option("--fail-on <level>", "deprecated alias for --blocking <level>")
    .option("--preset <name>", "rule preset: recommended, strict, design")
    .option("--baseline <path>", "ignore diagnostics already present in a baseline file")
    .option("--update-baseline <path>", "write the current diagnostics to a baseline file")
    .option("--config <path>", "path to vue-doctor.config.json")
    .option("--include <path>", "file or directory to scan; can be repeated or comma-separated", parseInclude, [])
    .option("--explain <file:line>", "show diagnostics and suppressed diagnostics near a specific location")
    .option("--why <file:line>", "alias for --explain")
    .option("--handoff [mode]", "handoff diagnostics to an agent: prompt, copy, print, codex, claude, cursor, skip")
    .option("--copy-prompt", "copy an agent-ready diagnostics prompt to the clipboard", false)
    .option("--print-prompt", "print an agent-ready diagnostics prompt", false)
    .option("--color", "force color output")
    .option("--no-color", "disable color output")
    .option("--respect-inline-disables", "respect inline vue-doctor/eslint/oxlint disable comments")
    .option("--no-respect-inline-disables", "audit mode: ignore inline disable comments")
    .allowExcessArguments(false)
    .action(runInspect);

  program
    .command("install")
    .alias("setup")
    .description("Install the vue-doctor skill into detected coding agents")
    .option("-y, --yes", "skip prompts and install for all detected agents", false)
    .option("--dry-run", "show what would be installed without writing files", false)
    .option("--agent-hooks", "install native Claude/Cursor edit hooks when project folders exist", false)
    .option("--no-git-hook", "skip Git pre-commit hook setup")
    .option("--no-github-action", "skip GitHub Actions workflow setup")
    .option("-c, --cwd <cwd>", "working directory", process.cwd())
    .action(runInstall);

  program
    .command("version")
    .description("Print Vue Doctor, Node.js, and platform information")
    .action(() => {
      console.log(`vue-doctor ${VERSION}`);
      console.log(`node ${process.version}`);
      console.log(`${process.platform} ${process.arch}`);
    });

  const rulesCommand = program
    .command("rules")
    .description("List, explain, and configure Vue Doctor rules");

  rulesCommand
    .command("list")
    .description("List rules and their effective severity")
    .option("--category <name>", "only show one category")
    .option("--configured", "only show rules changed by config or preset", false)
    .option("--json", "output a structured JSON array", false)
    .option("-c, --cwd <cwd>", "working directory", process.cwd())
    .action((_options, command) => runRulesList(command.optsWithGlobals()));

  rulesCommand
    .command("explain <rule>")
    .description("Explain one rule and how it is configured")
    .option("--json", "output a structured JSON object", false)
    .option("-c, --cwd <cwd>", "working directory", process.cwd())
    .action((rule, _options, command) => runRulesExplain(rule, command.optsWithGlobals()));

  rulesCommand
    .command("set <rule> <severity>")
    .description("Set a rule severity: error, warn, warning, or off")
    .option("-c, --cwd <cwd>", "working directory", process.cwd())
    .action((rule, severity, _options, command) => runRulesSet(rule, severity, command.optsWithGlobals()));

  rulesCommand
    .command("enable <rule>")
    .description("Enable a rule at its default severity, or pass --severity")
    .option("--severity <level>", "severity to enable at: error, warn, or warning")
    .option("-c, --cwd <cwd>", "working directory", process.cwd())
    .action((rule, _options, command) => runRulesEnable(rule, command.optsWithGlobals()));

  rulesCommand
    .command("disable <rule>")
    .description("Disable a rule")
    .option("-c, --cwd <cwd>", "working directory", process.cwd())
    .action((rule, _options, command) => runRulesDisable(rule, command.optsWithGlobals()));

  rulesCommand
    .command("category <category> <severity>")
    .description("Set a whole category severity: error, warn, warning, or off")
    .option("-c, --cwd <cwd>", "working directory", process.cwd())
    .action((category, severity, _options, command) => runRulesCategory(category, severity, command.optsWithGlobals()));

  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const flags = program.opts<CliFlags>();
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            version: VERSION,
            ok: false,
            directory: path.resolve(program.args[0] ?? "."),
            error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
          },
          null,
          flags.jsonCompact ? 0 : 2,
        )}\n`,
      );
    } else {
      console.error(pc.red("Vue Doctor failed"));
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
};

void runCli();
