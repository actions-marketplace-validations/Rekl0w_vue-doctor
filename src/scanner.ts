import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { parse } from "@vue/compiler-sfc";
import { minimatch } from "minimatch";
import {
  DEAD_CODE_TIMEOUT_CEILING_MS,
  DEAD_CODE_TIMEOUT_MS_PER_SOURCE_FILE,
  DEAD_CODE_WORKER_TIMEOUT_MS,
  PLUGIN_NAME,
  VERSION,
} from "./constants.js";
import { normalizeRuleName, ruleByName } from "./rules/index.js";
import { scanScript } from "./rules/script.js";
import { scanSfcStructure } from "./rules/sfc.js";
import { scanTemplate } from "./rules/template.js";
import type {
  Diagnostic,
  DiagnosticInput,
  DiffInfo,
  DiagnoseOptions,
  DiagnoseResult,
  JsonReport,
  JsonReportMode,
  ProjectInfo,
  RuleLevel,
  ScanContext,
  Severity,
  VueDoctorConfig,
} from "./types.js";
import { loadConfig, mergeConfig } from "./utils/config.js";
import { discoverProject } from "./utils/project.js";
import { calculateScore } from "./utils/scoring.js";
import { analyzeDeadCode, type DeadCodeFinding } from "./utils/dead-code.js";
import { discoverSourceFiles } from "./utils/source-files.js";
import { checkSupplyChain, isSupplyChainEnabled, type SupplyChainFinding } from "./utils/supply-chain.js";
import { isSuppressedAtLine } from "./utils/suppressions.js";
import { toRelativePath } from "./utils/path.js";
import { getLineColumn } from "./utils/location.js";

const getRuleLevel = (config: VueDoctorConfig, ruleName: string): RuleLevel | undefined => {
  const rules = config.rules ?? {};
  return rules[ruleName] ?? rules[`${PLUGIN_NAME}/${ruleName}`];
};

const normalizeCategoryName = (category: string): string =>
  category.toLowerCase().replace(/[\s_-]+/g, "-");

const getCategoryLevel = (
  config: VueDoctorConfig,
  category: string,
): RuleLevel | undefined => {
  const categories = config.categories ?? {};
  const normalizedCategory = normalizeCategoryName(category);
  for (const [configuredCategory, level] of Object.entries(categories)) {
    if (normalizeCategoryName(configuredCategory) === normalizedCategory) return level;
  }
  return undefined;
};

const getPresetLevel = (
  config: VueDoctorConfig,
  category: string,
  fallback: Severity,
): Severity | "off" | undefined => {
  if (config.preset === "strict") return fallback === "warning" ? "error" : fallback;
  if (config.preset === "design") {
    return ["Security", "Correctness", "Accessibility", "Design"].includes(category)
      ? fallback
      : "off";
  }
  return undefined;
};

const resolveSeverity = (
  config: VueDoctorConfig,
  ruleName: string,
  category: string,
  fallback: Severity,
): Severity | "off" =>
  getRuleLevel(config, ruleName) ??
  getCategoryLevel(config, category) ??
  getPresetLevel(config, category, fallback) ??
  fallback;

const ruleIsGloballyIgnored = (config: VueDoctorConfig, ruleName: string): boolean => {
  const ignoredRules = config.ignore?.rules ?? [];
  return ignoredRules.some((rule) => normalizeRuleName(rule) === ruleName || rule === "*");
};

const ruleIsIgnoredForFile = (
  config: VueDoctorConfig,
  relativePath: string,
  ruleName: string,
): boolean => {
  const overrides = config.ignore?.overrides ?? [];
  return overrides.some((override) => {
    const matchesFile = override.files.some((pattern) =>
      minimatch(relativePath, pattern, { dot: true, nocase: process.platform === "win32" }),
    );
    if (!matchesFile) return false;
    const rules = override.rules ?? ["*"];
    return rules.some((rule) => normalizeRuleName(rule) === ruleName || rule === "*");
  });
};

const toDiagnostic = (
  input: DiagnosticInput,
  context: Omit<ScanContext, "report">,
): Diagnostic | null => {
  const ruleName = normalizeRuleName(input.rule);
  const definition = ruleByName.get(ruleName);
  const defaultSeverity = input.severity ?? definition?.defaultSeverity ?? "warning";
  const severity = resolveSeverity(context.config, ruleName, input.category, defaultSeverity);

  if (severity === "off") return null;
  if (context.config.warnings === false && severity === "warning") return null;
  if (ruleIsGloballyIgnored(context.config, ruleName)) return null;
  if (ruleIsIgnoredForFile(context.config, context.relativePath, ruleName)) return null;
  if (context.config.respectInlineDisables !== false && isSuppressedAtLine(context.source, input.line, ruleName)) {
    return null;
  }

  return {
    filePath: context.filePath,
    relativePath: context.relativePath,
    plugin: PLUGIN_NAME,
    rule: ruleName,
    severity,
    category: input.category,
    message: input.message,
    help: input.help,
    line: Math.max(1, input.line),
    column: Math.max(1, input.column ?? 1),
  };
};

const createContext = (
  filePath: string,
  rootDirectory: string,
  source: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
  diagnostics: Diagnostic[],
): ScanContext => {
  const relativePath = toRelativePath(filePath, rootDirectory);
  const baseContext = {
    rootDirectory,
    relativePath,
    filePath,
    source,
    config,
    project,
  };

  return {
    ...baseContext,
    report: (input) => {
      const diagnostic = toDiagnostic(input, baseContext);
      if (diagnostic) diagnostics.push(diagnostic);
    },
  };
};

const scanVueFile = (
  filePath: string,
  rootDirectory: string,
  source: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const context = createContext(filePath, rootDirectory, source, config, project, diagnostics);
  const parseResult = parse(source, { filename: filePath });

  for (const error of parseResult.errors) {
    const message = typeof error === "string" ? error : error.message;
    context.report({
      rule: "parse-sfc",
      severity: "error",
      category: "Correctness",
      message,
      help: "Fix the SFC parse error before relying on diagnostics for this file.",
      line: 1,
      column: 1,
    });
  }

  const { descriptor } = parseResult;
  scanSfcStructure(descriptor, context);

  if (descriptor.template) {
    scanTemplate(descriptor.template.content, descriptor.template.loc.start.line, context);
  }

  if (descriptor.script) {
    scanScript(descriptor.script.content, descriptor.script.loc.start.line, context);
  }

  if (descriptor.scriptSetup) {
    scanScript(descriptor.scriptSetup.content, descriptor.scriptSetup.loc.start.line, context);
  }

  return diagnostics;
};

const scanScriptFile = (
  filePath: string,
  rootDirectory: string,
  source: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const context = createContext(filePath, rootDirectory, source, config, project, diagnostics);
  scanScript(source, 0, context);
  return diagnostics;
};

export const scanFile = (
  filePath: string,
  rootDirectory: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
): Diagnostic[] => {
  const source = fs.readFileSync(filePath, "utf-8");
  if (path.extname(filePath) === ".vue") {
    return scanVueFile(filePath, rootDirectory, source, config, project);
  }
  return scanScriptFile(filePath, rootDirectory, source, config, project);
};

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
}

const LOCKFILES = [
  { filename: "package-lock.json", manager: "npm" },
  { filename: "npm-shrinkwrap.json", manager: "npm" },
  { filename: "pnpm-lock.yaml", manager: "pnpm" },
  { filename: "yarn.lock", manager: "yarn" },
  { filename: "bun.lock", manager: "bun" },
  { filename: "bun.lockb", manager: "bun" },
] as const;

const INSTALL_LIFECYCLE_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare"]);

const REMOTE_EXECUTION_SCRIPT_PATTERN =
  /(?:curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]*(?:\|\s*(?:sh|bash|zsh|fish|powershell|pwsh|iex)|\b(?:sh|bash|zsh|fish|powershell|pwsh)\b)/i;

const readPackageJsonForScan = (rootDirectory: string): { filePath: string; source: string; json: PackageJson | null } | null => {
  const filePath = path.join(rootDirectory, "package.json");
  if (!fs.existsSync(filePath)) return null;
  const source = fs.readFileSync(filePath, "utf-8");
  try {
    return {
      filePath,
      source,
      json: JSON.parse(source) as PackageJson,
    };
  } catch {
    return { filePath, source, json: null };
  }
};

const packageJsonKeyLocation = (
  source: string,
  key: string,
): { line: number; column: number } => {
  const index = source.indexOf(`"${key}"`);
  return getLineColumn(source, index >= 0 ? index : 0, 1);
};

const reportProjectDiagnostic = (
  diagnostics: Diagnostic[],
  rootDirectory: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
  filePath: string,
  source: string,
  input: DiagnosticInput,
): void => {
  const context = createContext(filePath, rootDirectory, source, config, project, diagnostics);
  context.report(input);
};

const scanProjectHealth = (
  rootDirectory: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const packageJson = readPackageJsonForScan(rootDirectory);
  if (!packageJson) return diagnostics;

  const presentLockfiles = LOCKFILES.filter((lockfile) =>
    fs.existsSync(path.join(rootDirectory, lockfile.filename)),
  );
  if (presentLockfiles.length > 1) {
    reportProjectDiagnostic(diagnostics, rootDirectory, config, project, packageJson.filePath, packageJson.source, {
      rule: "no-mixed-lockfiles",
      severity: "warning",
      category: "Maintainability",
      message: `Multiple package-manager lockfiles found: ${presentLockfiles.map((lockfile) => lockfile.filename).join(", ")}.`,
      help: "Keep only the lockfile for the package manager this project actually uses.",
      line: 1,
      column: 1,
    });
  }

  const declaredManager = packageJson.json?.packageManager?.split("@")[0]?.trim();
  if (declaredManager && presentLockfiles.length > 0) {
    const mismatchedLockfiles = presentLockfiles.filter((lockfile) => lockfile.manager !== declaredManager);
    if (mismatchedLockfiles.length > 0) {
      const location = packageJsonKeyLocation(packageJson.source, "packageManager");
      reportProjectDiagnostic(diagnostics, rootDirectory, config, project, packageJson.filePath, packageJson.source, {
        rule: "package-manager-lockfile-mismatch",
        severity: "warning",
        category: "Maintainability",
        message: `packageManager is "${declaredManager}" but ${mismatchedLockfiles.map((lockfile) => lockfile.filename).join(", ")} is committed.`,
        help: "Align packageManager and lockfiles so agents and CI install the same dependency graph.",
        line: location.line,
        column: location.column,
      });
    }
  }

  for (const [scriptName, script] of Object.entries(packageJson.json?.scripts ?? {})) {
    if (!INSTALL_LIFECYCLE_SCRIPTS.has(scriptName)) continue;
    if (!REMOTE_EXECUTION_SCRIPT_PATTERN.test(script)) continue;

    const location = packageJsonKeyLocation(packageJson.source, scriptName);
    reportProjectDiagnostic(diagnostics, rootDirectory, config, project, packageJson.filePath, packageJson.source, {
      rule: "no-risky-postinstall",
      severity: "error",
      category: "Security",
      message: `${scriptName} script downloads and executes remote code.`,
      help: "Vendor the installer, pin the package that owns the setup, or make the step explicit in documented setup instructions.",
      line: location.line,
      column: location.column,
    });
  }

  return diagnostics;
};

const shouldScanProjectHealth = (includePaths: string[]): boolean =>
  includePaths.length === 0 ||
  includePaths.some((includePath) => {
    const normalized = includePath.replaceAll("\\", "/");
    return normalized === "package.json" ||
      normalized.endsWith("/package.json") ||
      LOCKFILES.some((lockfile) => normalized === lockfile.filename || normalized.endsWith(`/${lockfile.filename}`));
  });

const isDeadCodeEnabled = (config: VueDoctorConfig): boolean => {
  if (typeof config.deadCode === "object") return config.deadCode.enabled !== false;
  return config.deadCode !== false;
};

const shouldScanDeadCode = (includePaths: string[], config: VueDoctorConfig): boolean =>
  isDeadCodeEnabled(config) && includePaths.length === 0;

const shouldScanSupplyChain = (includePaths: string[], config: VueDoctorConfig): boolean =>
  includePaths.length === 0 && isSupplyChainEnabled(config);

const configuredDeadCodeTimeoutMs = (config: VueDoctorConfig): number | undefined => {
  if (typeof config.deadCode === "object") return config.deadCode.timeoutMs;
  return undefined;
};

const positiveIntegerFromEnv = (name: string): number | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const resolveDeadCodeTimeoutMs = (config: VueDoctorConfig, fileCount: number): number =>
  configuredDeadCodeTimeoutMs(config) ??
  positiveIntegerFromEnv("VUE_DOCTOR_DEAD_CODE_TIMEOUT_MS") ??
  Math.min(
    DEAD_CODE_TIMEOUT_CEILING_MS,
    Math.max(DEAD_CODE_WORKER_TIMEOUT_MS, fileCount * DEAD_CODE_TIMEOUT_MS_PER_SOURCE_FILE),
  );

const findingsToDiagnostics = (
  rootDirectory: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
  findings: Array<DeadCodeFinding | SupplyChainFinding>,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const finding of findings) {
    const source = fs.existsSync(finding.filePath) ? fs.readFileSync(finding.filePath, "utf-8") : "";
    reportProjectDiagnostic(
      diagnostics,
      rootDirectory,
      config,
      project,
      finding.filePath,
      source,
      finding.input,
    );
  }
  return diagnostics;
};

interface DeadCodeWorkerSuccessMessage {
  ok: true;
  findings: DeadCodeFinding[];
}

interface DeadCodeWorkerFailureMessage {
  ok: false;
  error: {
    message?: string;
  };
}

type DeadCodeWorkerMessage = DeadCodeWorkerSuccessMessage | DeadCodeWorkerFailureMessage;

const isDeadCodeWorkerMessage = (message: unknown): message is DeadCodeWorkerMessage =>
  typeof message === "object" &&
  message !== null &&
  "ok" in message &&
  ((message as { ok?: unknown }).ok === true || (message as { ok?: unknown }).ok === false);

const testRuntimeUsesDirectDeadCode = (): boolean =>
  process.env.VITEST === "true" || process.env.NODE_ENV === "test";

const runDeadCodeWorker = (
  rootDirectory: string,
  files: string[],
  project: ProjectInfo,
  timeoutMs: number,
): Promise<DeadCodeFinding[]> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dead-code-worker.js", import.meta.url), {
      workerData: { rootDirectory, files, project },
    });
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      callback();
    };

    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`Dead-code analysis timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
    timeout.unref?.();

    worker.once("message", (message: unknown) => {
      if (!isDeadCodeWorkerMessage(message)) {
        settle(() => reject(new Error("Dead-code worker returned an invalid message.")));
        return;
      }
      if (!message.ok) {
        settle(() => reject(new Error(message.error.message ?? "Dead-code worker failed.")));
        return;
      }
      settle(() => resolve(message.findings));
    });
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0 && !settled) {
        settle(() => reject(new Error(`Dead-code worker exited with code ${code}.`)));
      }
    });
  });

const scanDeadCode = async (
  rootDirectory: string,
  files: string[],
  config: VueDoctorConfig,
  project: ProjectInfo,
): Promise<Diagnostic[]> => {
  try {
    const findings = testRuntimeUsesDirectDeadCode()
      ? analyzeDeadCode(rootDirectory, files, project)
      : await runDeadCodeWorker(rootDirectory, files, project, resolveDeadCodeTimeoutMs(config, files.length));
    return findingsToDiagnostics(rootDirectory, config, project, findings);
  } catch {
    return [];
  }
};

const scanSupplyChain = async (
  rootDirectory: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
): Promise<Diagnostic[]> => {
  try {
    return findingsToDiagnostics(rootDirectory, config, project, await checkSupplyChain(rootDirectory, config));
  } catch {
    return [];
  }
};

const createVueProjectNotFoundDiagnostic = (
  rootDirectory: string,
): Diagnostic => {
  const packageJsonPath = path.join(rootDirectory, "package.json");
  const fallbackPath = fs.existsSync(packageJsonPath) ? packageJsonPath : rootDirectory;
  return {
    filePath: fallbackPath,
    relativePath: fs.existsSync(packageJsonPath) ? "package.json" : ".",
    plugin: PLUGIN_NAME,
    rule: "vue-project-not-found",
    severity: "error",
    category: "Correctness",
    message: "Vue project was not detected.",
    help: "Run Vue Doctor from a Vue/Nuxt project, or add a vue dependency or .vue source files before relying on Vue diagnostics.",
    line: 1,
    column: 1,
  };
};

const MAX_PARALLEL_WORKERS = 8;

const normalizeWorkerCount = (requested: number | undefined, fileCount: number): number => {
  if (!requested || requested <= 1 || fileCount < 2) return 1;
  return Math.max(1, Math.min(MAX_PARALLEL_WORKERS, fileCount, Math.floor(requested)));
};

const chunkFiles = (files: string[], workerCount: number): string[][] => {
  const chunks = Array.from({ length: workerCount }, () => [] as string[]);
  files.forEach((filePath, index) => {
    chunks[index % workerCount]!.push(filePath);
  });
  return chunks.filter((chunk) => chunk.length > 0);
};

const scanFileChunkInWorker = (
  files: string[],
  rootDirectory: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
): Promise<Diagnostic[]> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
      workerData: {
        files,
        rootDirectory,
        config,
        project,
      },
    });
    worker.once("message", (message: { diagnostics: Diagnostic[] }) => {
      resolve(message.diagnostics);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Vue Doctor scan worker exited with code ${code}.`));
    });
  });

const scanFiles = async (
  files: string[],
  rootDirectory: string,
  config: VueDoctorConfig,
  project: ProjectInfo,
  parallelWorkers?: number,
): Promise<Diagnostic[]> => {
  const workerCount = normalizeWorkerCount(parallelWorkers, files.length);
  if (workerCount <= 1) {
    return files.flatMap((filePath) => scanFile(filePath, rootDirectory, config, project));
  }

  const chunks = chunkFiles(files, workerCount);
  const chunkDiagnostics = await Promise.all(
    chunks.map((chunk) => scanFileChunkInWorker(chunk, rootDirectory, config, project)),
  );
  return chunkDiagnostics.flat();
};

export const diagnose = async (
  directory = ".",
  options: DiagnoseOptions = {},
): Promise<DiagnoseResult> => {
  const start = performance.now();
  const loaded = loadConfig(directory, options.configPath);
  const config = mergeConfig(loaded.config, options.config);
  if (options.verbose !== undefined) config.verbose = options.verbose;
  if (options.warnings !== undefined) config.warnings = options.warnings;
  if (options.deadCode !== undefined) config.deadCode = options.deadCode;
  if (options.respectInlineDisables !== undefined) {
    config.respectInlineDisables = options.respectInlineDisables;
  }

  const rootDirectory = loaded.rootDirectory;
  const includePaths = options.includePaths ?? config.include ?? [];
  const project = discoverProject(rootDirectory);
  const files = discoverSourceFiles(rootDirectory, includePaths, {}, config);

  if (!project.hasVue) {
    const diagnostics = [createVueProjectNotFoundDiagnostic(rootDirectory)];
    return {
      diagnostics,
      score: calculateScore(diagnostics, { totalSourceFiles: Math.max(files.length, 1) }),
      project: {
        ...project,
        sourceFileCount: files.length,
      },
      elapsedMilliseconds: performance.now() - start,
    };
  }

  const supplyChainDiagnostics = shouldScanSupplyChain(includePaths, config)
    ? scanSupplyChain(rootDirectory, config, project)
    : Promise.resolve([]);
  const sourceDiagnostics = await scanFiles(
    files,
    rootDirectory,
    config,
    project,
    options.parallelWorkers,
  );
  const diagnostics = [
    ...(shouldScanProjectHealth(includePaths) ? scanProjectHealth(rootDirectory, config, project) : []),
    ...(await supplyChainDiagnostics),
    ...sourceDiagnostics,
    ...(shouldScanDeadCode(includePaths, config) ? await scanDeadCode(rootDirectory, files, config, project) : []),
  ];
  const score = calculateScore(diagnostics, { totalSourceFiles: files.length });

  return {
    diagnostics: diagnostics.sort((left, right) => {
      if (left.relativePath !== right.relativePath) return left.relativePath.localeCompare(right.relativePath);
      if (left.line !== right.line) return left.line - right.line;
      return left.rule.localeCompare(right.rule);
    }),
    score,
    project: {
      ...project,
      sourceFileCount: files.length,
    },
    elapsedMilliseconds: performance.now() - start,
  };
};

export const summarizeDiagnostics = (diagnostics: Diagnostic[]) => ({
  errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
  warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
  affectedFileCount: new Set(diagnostics.map((diagnostic) => diagnostic.filePath)).size,
  totalDiagnosticCount: diagnostics.length,
});

export const toJsonReport = (
  directory: string,
  result: DiagnoseResult,
): JsonReport => {
  const summary = summarizeDiagnostics(result.diagnostics);
  return {
    schemaVersion: 1,
    version: VERSION,
    ok: true,
    directory: path.resolve(directory),
    project: result.project,
    diagnostics: result.diagnostics,
    summary: {
      ...summary,
      score: result.score.score,
      scoreLabel: result.score.label,
    },
    elapsedMilliseconds: result.elapsedMilliseconds,
  };
};

interface JsonReportScan {
  directory: string;
  result: DiagnoseResult;
}

const scoreLabelFromValue = (score: number): DiagnoseResult["score"]["label"] => {
  if (score >= 75) return "Great";
  if (score >= 50) return "Needs work";
  return "Critical";
};

const buildAggregateProject = (directory: string, scans: JsonReportScan[]): ProjectInfo => {
  if (scans.length === 1) return scans[0]!.result.project;
  return {
    rootDirectory: path.resolve(directory),
    projectName: path.basename(path.resolve(directory)),
    vueVersion: null,
    hasVue: scans.some((scan) => scan.result.project.hasVue),
    framework: "unknown",
    hasTypeScript: scans.some((scan) => scan.result.project.hasTypeScript),
    hasPinia: scans.some((scan) => scan.result.project.hasPinia),
    hasVueRouter: scans.some((scan) => scan.result.project.hasVueRouter),
    sourceFileCount: scans.reduce((total, scan) => total + scan.result.project.sourceFileCount, 0),
  };
};

export const toJsonReportFromScans = (
  directory: string,
  scans: JsonReportScan[],
  options: {
    mode?: JsonReportMode;
    diff?: DiffInfo | null;
    baseline?: JsonReport["baseline"] | undefined;
    elapsedMilliseconds?: number;
  } = {},
): JsonReport => {
  if (scans.length === 1) {
    const report = toJsonReport(scans[0]!.directory, scans[0]!.result);
    return {
      ...report,
      directory: path.resolve(directory),
      mode: options.mode,
      diff: options.diff,
      baseline: options.baseline,
      projects: [
        {
          directory: path.resolve(scans[0]!.directory),
          project: scans[0]!.result.project,
          diagnostics: scans[0]!.result.diagnostics,
          summary: report.summary,
          elapsedMilliseconds: scans[0]!.result.elapsedMilliseconds,
        },
      ],
      elapsedMilliseconds: options.elapsedMilliseconds ?? report.elapsedMilliseconds,
    };
  }

  const diagnostics = scans.flatMap((scan) => scan.result.diagnostics);
  const summary = summarizeDiagnostics(diagnostics);
  const score = scans.length > 0
    ? Math.min(...scans.map((scan) => scan.result.score.score))
    : 100;
  const aggregateProject = buildAggregateProject(directory, scans);

  return {
    schemaVersion: 1,
    version: VERSION,
    ok: true,
    directory: path.resolve(directory),
    mode: options.mode,
    diff: options.diff,
    baseline: options.baseline,
    project: aggregateProject,
    projects: scans.map((scan) => {
      const projectSummary = summarizeDiagnostics(scan.result.diagnostics);
      return {
        directory: path.resolve(scan.directory),
        project: scan.result.project,
        diagnostics: scan.result.diagnostics,
        summary: {
          ...projectSummary,
          score: scan.result.score.score,
          scoreLabel: scan.result.score.label,
        },
        elapsedMilliseconds: scan.result.elapsedMilliseconds,
      };
    }),
    diagnostics,
    summary: {
      ...summary,
      score,
      scoreLabel: scoreLabelFromValue(score),
    },
    elapsedMilliseconds:
      options.elapsedMilliseconds ??
      scans.reduce((total, scan) => total + scan.result.elapsedMilliseconds, 0),
  };
};
