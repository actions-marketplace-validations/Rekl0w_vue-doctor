import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as semver from "semver";
import {
  SOCKET_FREE_PURL_API_BASE,
  SOCKET_FREE_USER_AGENT,
  SOCKET_PACKAGE_PAGE_BASE,
  SOCKET_SCORE_SCALE,
  SUPPLY_CHAIN_ALERT_NOTE_MAX_CHARS,
  SUPPLY_CHAIN_CACHE_HASH_LENGTH,
  SUPPLY_CHAIN_CACHE_SUBDIR,
  SUPPLY_CHAIN_CACHE_TTL_MS,
  SUPPLY_CHAIN_DEFAULT_MIN_SCORE,
  SUPPLY_CHAIN_FETCH_CONCURRENCY,
  SUPPLY_CHAIN_FETCH_TIMEOUT_MS,
  SUPPLY_CHAIN_MAX_ALERTS_SHOWN,
  SUPPLY_CHAIN_TOTAL_TIMEOUT_MS,
} from "../constants.js";
import type { DiagnosticInput, Severity, VueDoctorConfig } from "../types.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface DependencyToScore {
  name: string;
  spec: string;
  version: string;
  section: "dependencies" | "devDependencies";
  line: number;
  column: number;
}

interface SocketScore {
  overall: number;
  license: number;
  maintenance: number;
  quality: number;
  supplyChain: number;
  vulnerability: number;
}

interface SocketAlert {
  type: string;
  severity: string;
  file?: string | null;
  props?: {
    note?: string | null;
  } | null;
}

interface SocketArtifact {
  score: SocketScore;
  alerts: SocketAlert[];
}

interface SupplyChainOptions {
  minScore: number;
  severity: Severity;
  includeDevDependencies: boolean;
  cache: boolean;
  timeoutMs: number;
  totalTimeoutMs: number;
}

export interface SupplyChainFinding {
  filePath: string;
  input: DiagnosticInput;
}

const GATED_AXES = [
  {
    key: "supplyChain",
    label: "supply chain",
    meaning:
      "risky install-time behavior, package identity risk, obfuscated code, or unusual network/filesystem/shell access",
    remediation:
      "confirm this is the package you meant to install, and prefer a more established audited alternative",
  },
  {
    key: "vulnerability",
    label: "vulnerability",
    meaning: "known security vulnerabilities affecting this version",
    remediation: "upgrade to a version with no known advisories, or replace the dependency",
  },
] as const;

const CONTEXT_AXES = [
  { key: "maintenance", label: "maintenance" },
  { key: "quality", label: "quality" },
  { key: "license", label: "license" },
] as const;

type GatedAxis = (typeof GATED_AXES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clampScore = (score: number): number => {
  if (!Number.isFinite(score)) return SUPPLY_CHAIN_DEFAULT_MIN_SCORE;
  return Math.max(0, Math.min(SOCKET_SCORE_SCALE, score));
};

const toHundred = (score: number): number =>
  Math.round(clampScore(score * SOCKET_SCORE_SCALE));

const resolveOptions = (config: VueDoctorConfig): SupplyChainOptions => ({
  minScore: clampScore(config.supplyChain?.minScore ?? SUPPLY_CHAIN_DEFAULT_MIN_SCORE),
  severity: config.supplyChain?.severity ?? "error",
  includeDevDependencies: config.supplyChain?.includeDevDependencies !== false,
  cache: config.supplyChain?.cache !== false && !isCacheDisabledByEnv(),
  timeoutMs: config.supplyChain?.timeoutMs ?? SUPPLY_CHAIN_FETCH_TIMEOUT_MS,
  totalTimeoutMs: config.supplyChain?.totalTimeoutMs ?? SUPPLY_CHAIN_TOTAL_TIMEOUT_MS,
});

const isTestRuntime = (): boolean =>
  process.env.VITEST === "true" || process.env.NODE_ENV === "test";

export const isSupplyChainEnabled = (config: VueDoctorConfig): boolean => {
  if (config.supplyChain?.enabled !== undefined) return config.supplyChain.enabled;
  return !isTestRuntime();
};

const readJson = (filePath: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readPackageJson = (rootDirectory: string): { filePath: string; source: string; json: PackageJson } | null => {
  const filePath = path.join(rootDirectory, "package.json");
  if (!fs.existsSync(filePath)) return null;
  const source = fs.readFileSync(filePath, "utf-8");
  const json = readJson(filePath);
  const parsedPackageJson: PackageJson = {};
  const dependencies = toStringRecord(json?.dependencies);
  const devDependencies = toStringRecord(json?.devDependencies);
  if (dependencies) parsedPackageJson.dependencies = dependencies;
  if (devDependencies) parsedPackageJson.devDependencies = devDependencies;
  return {
    filePath,
    source,
    json: parsedPackageJson,
  };
};

const toStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const resolveConcreteVersion = (spec: string): string | null => {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(":")) return null;
  const range = semver.validRange(trimmed);
  if (range === null || range === "*") return null;
  return semver.minVersion(trimmed)?.version ?? null;
};

const locateDependencyKey = (
  packageJsonSource: string,
  section: DependencyToScore["section"],
  name: string,
): { line: number; column: number } => {
  const lines = packageJsonSource.split(/\r?\n/);
  const sectionPattern = new RegExp(`"${section}"\\s*:\\s*\\{`);
  const needle = `"${name}"`;
  let insideSection = false;
  let depth = 0;

  for (const [index, line] of lines.entries()) {
    if (!insideSection) {
      if (sectionPattern.test(line)) {
        insideSection = true;
        depth = 1;
      }
      continue;
    }

    const column = line.indexOf(needle);
    if (column >= 0 && /^\s*:/.test(line.slice(column + needle.length))) {
      return { line: index + 1, column: column + 1 };
    }

    for (const character of line) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    if (depth <= 0) break;
  }

  return { line: 1, column: 1 };
};

const collectDependenciesToScore = (
  packageJson: PackageJson,
  packageJsonSource: string,
  includeDevDependencies: boolean,
): DependencyToScore[] => {
  const dependencies: DependencyToScore[] = [];
  const addSection = (section: DependencyToScore["section"], entries: Record<string, string> | undefined): void => {
    for (const [name, spec] of Object.entries(entries ?? {})) {
      const version = resolveConcreteVersion(spec);
      if (!version) continue;
      dependencies.push({
        name,
        spec,
        version,
        section,
        ...locateDependencyKey(packageJsonSource, section, name),
      });
    }
  };

  addSection("dependencies", packageJson.dependencies);
  if (includeDevDependencies) addSection("devDependencies", packageJson.devDependencies);
  return dependencies;
};

const toPurl = (dependency: DependencyToScore): string =>
  `pkg:npm/${dependency.name}@${dependency.version}`;

const isSocketScore = (value: unknown): value is SocketScore =>
  isRecord(value) &&
  ["overall", "license", "maintenance", "quality", "supplyChain", "vulnerability"].every(
    (key) => typeof value[key] === "number",
  );

const parseSocketAlert = (value: unknown): SocketAlert | null => {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.severity !== "string") {
    return null;
  }
  const props = isRecord(value.props) ? value.props : null;
  return {
    type: value.type,
    severity: value.severity,
    file: typeof value.file === "string" ? value.file : null,
    props: props
      ? {
          note: typeof props.note === "string" ? props.note : null,
        }
      : null,
  };
};

const parseSocketArtifact = (body: string): SocketArtifact | null => {
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isSocketScore(parsed.score)) continue;
    const alerts = Array.isArray(parsed.alerts)
      ? parsed.alerts.map(parseSocketAlert).filter((alert): alert is SocketAlert => alert !== null)
      : [];
    return { score: parsed.score, alerts };
  }
  return null;
};

const isCacheDisabledByEnv = (): boolean => {
  const value = process.env.VUE_DOCTOR_NO_CACHE?.toLowerCase();
  return value === "1" || value === "true";
};

const resolveCacheDirectory = (rootDirectory: string): string => {
  const base =
    process.env.VUE_DOCTOR_CACHE_DIR ??
    process.env.XDG_CACHE_HOME ??
    process.env.LOCALAPPDATA ??
    path.join(os.homedir(), ".cache");
  const rootHash = crypto.createHash("sha256").update(path.resolve(rootDirectory)).digest("hex").slice(0, 10);
  return path.join(base, "vue-doctor", rootHash);
};

const cacheFileForDependency = (cacheDirectory: string, dependency: DependencyToScore): string => {
  const hash = crypto
    .createHash("sha256")
    .update(toPurl(dependency))
    .digest("hex")
    .slice(0, SUPPLY_CHAIN_CACHE_HASH_LENGTH);
  return path.join(cacheDirectory, SUPPLY_CHAIN_CACHE_SUBDIR, `${hash}.json`);
};

const readCachedBody = (filePath: string): string | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.fetchedAtMs === "number" &&
      typeof parsed.body === "string" &&
      Date.now() - parsed.fetchedAtMs <= SUPPLY_CHAIN_CACHE_TTL_MS
    ) {
      return parsed.body;
    }
  } catch {
    // Cache misses and malformed entries both fall back to the network.
  }
  return null;
};

const writeCachedBody = (filePath: string, body: string): void => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ fetchedAtMs: Date.now(), body }));
  } catch {
    // Cache write failures must never sink a scan.
  }
};

const fetchSocketArtifact = async (
  dependency: DependencyToScore,
  options: SupplyChainOptions,
  cacheDirectory: string | null,
): Promise<SocketArtifact | null> => {
  const cacheFile = cacheDirectory ? cacheFileForDependency(cacheDirectory, dependency) : null;
  if (cacheFile) {
    const cachedBody = readCachedBody(cacheFile);
    const cachedArtifact = cachedBody ? parseSocketArtifact(cachedBody) : null;
    if (cachedArtifact) return cachedArtifact;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${SOCKET_FREE_PURL_API_BASE}/${encodeURIComponent(toPurl(dependency))}`, {
      headers: { "User-Agent": SOCKET_FREE_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.text();
    const artifact = parseSocketArtifact(body);
    if (artifact && cacheFile) writeCachedBody(cacheFile, body);
    return artifact;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const mapWithConcurrency = async <Input, Output>(
  items: Input[],
  concurrency: number,
  mapper: (item: Input) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]!);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

const withTotalTimeout = async <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const worstGatedAxis = (score: SocketScore): GatedAxis => {
  let worst: GatedAxis = GATED_AXES[0]!;
  for (const axis of GATED_AXES) {
    if (score[axis.key] < score[worst.key]) worst = axis;
  }
  return worst;
};

const sanitizeRemoteText = (value: string): string =>
  [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character !== "`" && code >= 32 && code !== 127;
    })
    .join("")
    .trim();

const humanizeAlertType = (value: string): string =>
  sanitizeRemoteText(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase());

const summarizeAlertNote = (note: string): string => {
  const collapsed = sanitizeRemoteText(note.replace(/\s+/g, " "));
  const firstSentence = collapsed.split(/(?<=\.)\s/)[0] ?? collapsed;
  if (firstSentence.length <= SUPPLY_CHAIN_ALERT_NOTE_MAX_CHARS) {
    return firstSentence.replace(/\.$/, "");
  }
  return `${firstSentence.slice(0, SUPPLY_CHAIN_ALERT_NOTE_MAX_CHARS).trimEnd()}...`;
};

const severityRank = (severity: string): number => {
  const normalized = severity.toLowerCase();
  if (normalized === "critical") return 4;
  if (normalized === "high") return 3;
  if (normalized === "middle" || normalized === "medium") return 2;
  if (normalized === "low") return 1;
  return 0;
};

const topAlerts = (alerts: SocketAlert[]): SocketAlert[] =>
  [...alerts]
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, SUPPLY_CHAIN_MAX_ALERTS_SHOWN);

const formatAlertReason = (alerts: SocketAlert[]): string | null => {
  const selectedAlerts = topAlerts(alerts);
  if (selectedAlerts.length === 0) return null;
  if (selectedAlerts.length === 1) {
    const alert = selectedAlerts[0]!;
    const file = alert.file ? ` in ${sanitizeRemoteText(alert.file)}` : "";
    const note = alert.props?.note ? `: ${summarizeAlertNote(alert.props.note)}` : "";
    return `Socket flagged a ${sanitizeRemoteText(alert.severity.toLowerCase())} ${humanizeAlertType(alert.type)} alert${file}${note}.`;
  }

  const labels = selectedAlerts.map((alert) => humanizeAlertType(alert.type)).join(", ");
  const more = alerts.length > selectedAlerts.length ? ` (+${alerts.length - selectedAlerts.length} more)` : "";
  return `Socket flagged ${alerts.length} alerts (${labels}${more}); most severe: ${sanitizeRemoteText(selectedAlerts[0]!.severity.toLowerCase())}.`;
};

const formatOtherAxisScores = (score: SocketScore, failingKey: keyof SocketScore): string =>
  [...GATED_AXES, ...CONTEXT_AXES]
    .filter((axis) => axis.key !== failingKey)
    .map((axis) => `${axis.label} ${toHundred(score[axis.key])}`)
    .join(", ");

const buildDiagnostic = (
  packageJsonPath: string,
  dependency: DependencyToScore,
  artifact: SocketArtifact,
  axis: GatedAxis,
  options: SupplyChainOptions,
): SupplyChainFinding => {
  const packagePageUrl = `${SOCKET_PACKAGE_PAGE_BASE}/${dependency.name}/overview/${dependency.version}`;
  const failingScore = toHundred(artifact.score[axis.key]);
  const identity = semver.valid(dependency.spec)
    ? `${dependency.name}@${dependency.version}`
    : `${dependency.name}@${dependency.version} (lowest version "${dependency.spec}" allows)`;
  const alertReason = formatAlertReason(artifact.alerts);
  const reason = alertReason ?? `This points to ${axis.meaning}.`;
  const entry = `"${dependency.name}": "${dependency.spec}"`;

  return {
    filePath: packageJsonPath,
    input: {
      rule: "low-supply-chain-score",
      severity: options.severity,
      category: "Security",
      message: `${identity} scored ${failingScore}/${SOCKET_SCORE_SCALE} on Socket's ${axis.label} axis (minimum ${options.minScore}). ${reason} Other axes: ${formatOtherAxisScores(artifact.score, axis.key)}.`,
      help: `${axis.remediation}; update ${entry} in package.json. Full report: ${packagePageUrl}. If you've reviewed and accepted this package, raise supplyChain.minScore or set supplyChain.severity to "warning".`,
      line: dependency.line,
      column: dependency.column,
    },
  };
};

export const checkSupplyChain = async (
  rootDirectory: string,
  config: VueDoctorConfig,
): Promise<SupplyChainFinding[]> => {
  if (!isSupplyChainEnabled(config)) return [];
  const packageJson = readPackageJson(rootDirectory);
  if (!packageJson) return [];

  const options = resolveOptions(config);
  const dependencies = collectDependenciesToScore(
    packageJson.json,
    packageJson.source,
    options.includeDevDependencies,
  );
  if (dependencies.length === 0) return [];

  const cacheDirectory = options.cache ? resolveCacheDirectory(rootDirectory) : null;
  try {
    const artifacts = await withTotalTimeout(
      mapWithConcurrency(
        dependencies,
        SUPPLY_CHAIN_FETCH_CONCURRENCY,
        (dependency) => fetchSocketArtifact(dependency, options, cacheDirectory),
      ),
      options.totalTimeoutMs,
      [],
    );
    const findings: SupplyChainFinding[] = [];

    for (const [index, artifact] of artifacts.entries()) {
      if (!artifact) continue;
      const dependency = dependencies[index];
      if (!dependency) continue;
      const axis = worstGatedAxis(artifact.score);
      if (toHundred(artifact.score[axis.key]) >= options.minScore) continue;
      findings.push(buildDiagnostic(packageJson.filePath, dependency, artifact, axis, options));
    }

    return findings;
  } catch {
    return [];
  }
};
