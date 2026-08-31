import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { CONFIG_FILENAMES } from "../constants.js";
import type {
  FailOnLevel,
  RuleLevel,
  ScanScope,
  Severity,
  VueDoctorConfig,
  VueDoctorDeadCodeConfig,
  VueDoctorPreset,
  VueDoctorSupplyChainConfig,
} from "../types.js";

export interface LoadedConfig {
  config: VueDoctorConfig;
  sourcePath: string | null;
  rootDirectory: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const unwrapConfigModule = (value: unknown): Record<string, unknown> | null => {
  const candidate = isObject(value) && "default" in value ? value.default : value;
  return isObject(candidate) ? candidate : null;
};

const readConfigFile = (filePath: string): Record<string, unknown> | null => {
  const extension = path.extname(filePath);
  if (extension === ".json") return readJsonFile(filePath);

  try {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    return unwrapConfigModule(jiti(filePath));
  } catch {
    return null;
  }
};

const asStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : undefined;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asPositiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const asScore = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;

const asSeverity = (value: unknown): Severity | undefined => {
  if (value === "error" || value === "warning") return value;
  if (value === "warn") return "warning";
  return undefined;
};

const asFailOn = (value: unknown): FailOnLevel | undefined => {
  if (value === "error" || value === "warning" || value === "none") return value;
  return undefined;
};

const asScope = (value: unknown): ScanScope | undefined => {
  if (value === "full" || value === "files" || value === "changed" || value === "lines") return value;
  return undefined;
};

const asDiff = (value: unknown): boolean | string | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "false") return false;
    if (trimmed === "true") return true;
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
};

const asPreset = (value: unknown): VueDoctorPreset | undefined => {
  if (value === "recommended" || value === "strict" || value === "design") return value;
  return undefined;
};

const asRuleLevelMap = (value: unknown): Record<string, RuleLevel> | undefined => {
  if (!isObject(value)) return undefined;
  const result: Record<string, RuleLevel> = {};
  for (const [rule, level] of Object.entries(value)) {
    if (level === "error" || level === "warning" || level === "off") {
      result[rule] = level;
    } else if (level === "warn") {
      result[rule] = "warning";
    }
  }
  return result;
};

const asDeadCodeConfig = (value: unknown): boolean | VueDoctorDeadCodeConfig | undefined => {
  if (typeof value === "boolean") return value;
  if (!isObject(value)) return undefined;
  const config: VueDoctorDeadCodeConfig = {};
  const enabled = asBoolean(value.enabled);
  const timeoutMs = asPositiveInteger(value.timeoutMs);
  if (enabled !== undefined) config.enabled = enabled;
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  return Object.keys(config).length > 0 ? config : undefined;
};

const asSupplyChainConfig = (value: unknown): VueDoctorSupplyChainConfig | undefined => {
  if (!isObject(value)) return undefined;
  const config: VueDoctorSupplyChainConfig = {};
  const enabled = asBoolean(value.enabled);
  const minScore = asScore(value.minScore);
  const severity = asSeverity(value.severity);
  const includeDevDependencies = asBoolean(value.includeDevDependencies);
  const cache = asBoolean(value.cache);
  const timeoutMs = asPositiveInteger(value.timeoutMs);
  const totalTimeoutMs = asPositiveInteger(value.totalTimeoutMs);

  if (enabled !== undefined) config.enabled = enabled;
  if (minScore !== undefined) config.minScore = minScore;
  if (severity !== undefined) config.severity = severity;
  if (includeDevDependencies !== undefined) config.includeDevDependencies = includeDevDependencies;
  if (cache !== undefined) config.cache = cache;
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (totalTimeoutMs !== undefined) config.totalTimeoutMs = totalTimeoutMs;

  return Object.keys(config).length > 0 ? config : undefined;
};

const normalizeConfig = (raw: Record<string, unknown>): VueDoctorConfig => {
  const ignore = isObject(raw.ignore) ? raw.ignore : {};
  const overrides = Array.isArray(ignore.overrides)
    ? ignore.overrides
        .filter(isObject)
        .map((override) => ({
          files: asStringArray(override.files) ?? [],
          rules: asStringArray(override.rules),
        }))
        .filter((override) => override.files.length > 0)
    : undefined;

  return {
    rootDir: typeof raw.rootDir === "string" ? raw.rootDir : undefined,
    preset: asPreset(raw.preset),
    verbose: asBoolean(raw.verbose),
    warnings: asBoolean(raw.warnings),
    deadCode: asDeadCodeConfig(raw.deadCode),
    supplyChain: asSupplyChainConfig(raw.supplyChain),
    blocking: asFailOn(raw.blocking),
    failOn: asFailOn(raw.failOn),
    scope: asScope(raw.scope),
    base: typeof raw.base === "string" && raw.base.trim().length > 0 ? raw.base.trim() : undefined,
    diff: asDiff(raw.diff),
    baseline: typeof raw.baseline === "string" ? raw.baseline : undefined,
    include: asStringArray(raw.include),
    maxComponentLines: asPositiveInteger(raw.maxComponentLines),
    maxProps: asPositiveInteger(raw.maxProps),
    respectInlineDisables: asBoolean(raw.respectInlineDisables),
    rules: asRuleLevelMap(raw.rules),
    categories: asRuleLevelMap(raw.categories),
    ignore: {
      rules: asStringArray(ignore.rules),
      files: asStringArray(ignore.files),
      overrides,
    },
  };
};

const findUp = (startDirectory: string, filenames: string[]): string | null => {
  let current = path.resolve(startDirectory);
  while (true) {
    for (const filename of filenames) {
      const candidate = path.join(current, filename);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const loadPackageJsonConfig = (startDirectory: string): { path: string; raw: Record<string, unknown> } | null => {
  const packageJsonPath = findUp(startDirectory, ["package.json"]);
  if (!packageJsonPath) return null;
  const packageJson = readJsonFile(packageJsonPath);
  if (!packageJson || !isObject(packageJson.vueDoctor)) return null;
  return { path: packageJsonPath, raw: packageJson.vueDoctor };
};

export const loadConfig = (directory: string, explicitConfigPath?: string): LoadedConfig => {
  const requestedDirectory = path.resolve(directory);
  const explicitPath = explicitConfigPath ? path.resolve(explicitConfigPath) : null;
  const configPath = explicitPath ?? findUp(requestedDirectory, CONFIG_FILENAMES);

  let sourcePath: string | null = null;
  let rawConfig: Record<string, unknown> = {};

  if (configPath) {
    rawConfig = readConfigFile(configPath) ?? {};
    sourcePath = configPath;
  } else {
    const packageConfig = loadPackageJsonConfig(requestedDirectory);
    if (packageConfig) {
      rawConfig = packageConfig.raw;
      sourcePath = packageConfig.path;
    }
  }

  const config = normalizeConfig(rawConfig);
  const sourceDirectory = sourcePath ? path.dirname(sourcePath) : requestedDirectory;
  const rootDirectory = config.rootDir
    ? path.resolve(sourceDirectory, config.rootDir)
    : requestedDirectory;

  return { config, sourcePath, rootDirectory };
};

export const mergeConfig = (
  loadedConfig: VueDoctorConfig,
  override: VueDoctorConfig | null | undefined,
): VueDoctorConfig => {
  if (!override) return loadedConfig;
  return {
    ...loadedConfig,
    ...override,
    ignore: {
      ...loadedConfig.ignore,
      ...override.ignore,
      rules: override.ignore?.rules ?? loadedConfig.ignore?.rules,
      files: override.ignore?.files ?? loadedConfig.ignore?.files,
      overrides: override.ignore?.overrides ?? loadedConfig.ignore?.overrides,
    },
    rules: {
      ...loadedConfig.rules,
      ...override.rules,
    },
    categories: {
      ...loadedConfig.categories,
      ...override.categories,
    },
    supplyChain: {
      ...loadedConfig.supplyChain,
      ...override.supplyChain,
    },
  };
};
