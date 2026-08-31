import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";

interface PackageJson {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface WorkspaceProject {
  name: string;
  directory: string;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".nuxt",
  ".output",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const readPackageJson = (directory: string): PackageJson | null => {
  const packageJsonPath = path.join(directory, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageJson;
  } catch {
    return null;
  }
};

const collectDependencies = (packageJson: PackageJson | null): Record<string, string> => ({
  ...packageJson?.peerDependencies,
  ...packageJson?.dependencies,
  ...packageJson?.devDependencies,
});

const looksLikeVueProject = (directory: string, packageJson: PackageJson | null): boolean => {
  const dependencies = collectDependencies(packageJson);
  return Boolean(
    dependencies.vue ||
      dependencies.nuxt ||
      dependencies["@vue/cli-service"] ||
      dependencies.vitepress ||
      dependencies.vuepress ||
      dependencies["vuepress-vite"] ||
      dependencies.quasar ||
      fs.existsSync(path.join(directory, "nuxt.config.ts")) ||
      fs.existsSync(path.join(directory, "vite.config.ts")) ||
      fs.existsSync(path.join(directory, "src", "App.vue")),
  );
};

const normalizePatterns = (patterns: string[]): string[] =>
  patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0 && !pattern.startsWith("!"))
    .map((pattern) => pattern.replaceAll("\\", "/").replace(/\/$/, ""));

const readPnpmWorkspacePatterns = (rootDirectory: string): string[] => {
  const workspacePath = path.join(rootDirectory, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) return [];
  const lines = fs.readFileSync(workspacePath, "utf-8").split(/\r?\n/);
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^\s*packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (inPackages && match?.[1]) patterns.push(match[1]);
  }
  return patterns;
};

const getWorkspacePatterns = (rootDirectory: string): string[] => {
  const packageJson = readPackageJson(rootDirectory);
  const workspaceValue = packageJson?.workspaces;
  const packagePatterns = Array.isArray(workspaceValue)
    ? workspaceValue
    : Array.isArray(workspaceValue?.packages)
      ? workspaceValue.packages
      : [];
  return normalizePatterns([...packagePatterns, ...readPnpmWorkspacePatterns(rootDirectory)]);
};

const walkPackageDirectories = (directory: string, rootDirectory: string): string[] => {
  const packageDirectories: string[] = [];
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;

    if (fs.existsSync(path.join(fullPath, "package.json"))) {
      packageDirectories.push(fullPath);
    }

    packageDirectories.push(...walkPackageDirectories(fullPath, rootDirectory));
  }
  return packageDirectories.filter((packageDirectory) => packageDirectory !== rootDirectory);
};

const matchesWorkspacePattern = (
  rootDirectory: string,
  packageDirectory: string,
  patterns: string[],
): boolean => {
  if (patterns.length === 0) return true;
  const relativePath = path.relative(rootDirectory, packageDirectory).replaceAll("\\", "/");
  return patterns.some((pattern) =>
    minimatch(relativePath, pattern, { dot: true }) ||
    minimatch(`${relativePath}/package.json`, `${pattern}/package.json`, { dot: true }),
  );
};

export const discoverWorkspaceProjects = (rootDirectory: string): WorkspaceProject[] => {
  const rootPackage = readPackageJson(rootDirectory);
  const patterns = getWorkspacePatterns(rootDirectory);
  const discoveredDirectories = walkPackageDirectories(rootDirectory, rootDirectory)
    .filter((packageDirectory) => matchesWorkspacePattern(rootDirectory, packageDirectory, patterns))
    .sort((left, right) => left.localeCompare(right));

  const projects = discoveredDirectories.flatMap((directory): WorkspaceProject[] => {
    const packageJson = readPackageJson(directory);
    if (!looksLikeVueProject(directory, packageJson)) return [];
    return [{ name: packageJson?.name ?? path.basename(directory), directory }];
  });

  if (projects.length > 0) return projects;
  if (looksLikeVueProject(rootDirectory, rootPackage)) {
    return [{ name: rootPackage?.name ?? path.basename(rootDirectory), directory: rootDirectory }];
  }
  return [];
};

const resolveProjectEntry = (rootDirectory: string, entry: string, projects: WorkspaceProject[]): string => {
  const requested = entry.trim();
  const matched = projects.find(
    (project) => project.name === requested || path.basename(project.directory) === requested,
  );
  if (matched) return matched.directory;

  const asPath = path.resolve(rootDirectory, requested);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) return asPath;

  const available = projects.map((project) => project.name).join(", ");
  throw new Error(`Project "${requested}" not found.${available ? ` Available: ${available}` : ""}`);
};

export const selectProjectDirectories = (
  rootDirectory: string,
  projectFlag: string | undefined,
  scanAllProjects: boolean,
): string[] => {
  const projects = discoverWorkspaceProjects(rootDirectory);
  if (projectFlag) {
    return projectFlag
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolveProjectEntry(rootDirectory, entry, projects));
  }
  if (scanAllProjects && projects.length > 0) {
    return projects.map((project) => project.directory);
  }
  return [rootDirectory];
};
