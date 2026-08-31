import fs from "node:fs";
import path from "node:path";
import { parse as parseJavaScript } from "@babel/parser";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { minimatch } from "minimatch";
import type { DiagnosticInput, ProjectInfo } from "../types.js";
import { toPosixPath } from "./path.js";

type AnyNode = {
  type?: string | undefined;
  start?: number | null | undefined;
  loc?: { start?: { line?: number; column?: number } } | null | undefined;
  [key: string]: unknown;
};

interface SourceUnit {
  filePath: string;
  source: string;
  scriptBlocks: ScriptBlock[];
}

interface ScriptBlock {
  source: string;
  lineOffset: number;
}

interface ImportReference {
  specifier: string;
  namedImports: Set<string>;
  namespace: boolean;
}

interface ExportReference {
  name: string;
  line: number;
  column: number;
}

interface SourceAnalysis {
  imports: ImportReference[];
  globImports: string[];
  exports: ExportReference[];
}

interface GraphNode {
  filePath: string;
  edges: Set<string>;
}

export interface DeadCodeFinding {
  filePath: string;
  input: DiagnosticInput;
}

const RESOLUTION_EXTENSIONS = [
  ".vue",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
];

const CONFIG_ENTRY_FILENAMES = [
  "vue-doctor.config.ts",
  "vue-doctor.config.mts",
  "vue-doctor.config.cts",
  "vue-doctor.config.js",
  "vue-doctor.config.mjs",
  "vue-doctor.config.cjs",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.ts",
  "nuxt.config.mts",
];

const KNOWN_SCRIPT_COMMAND_DEPENDENCIES = new Set([
  "vite",
  "vitest",
  "nuxt",
  "vue-cli-service",
  "eslint",
  "prettier",
  "release-it",
  "tailwindcss",
  "postcss",
  "sass",
  "env-cmd",
]);

const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".pcss", ".postcss"]);
const STYLE_IMPORT_PATTERN = /@(?:import|use|forward)\s+(?:url\()?["']([^"']+)["']/gi;
const STYLE_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".nuxt",
  ".output",
  "coverage",
  "dist",
  "node_modules",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNode = (value: unknown): value is AnyNode =>
  isRecord(value) && typeof value.type === "string";

const getName = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return typeof node.name === "string" ? node.name : null;
  if (node.type === "StringLiteral") return typeof node.value === "string" ? node.value : null;
  if (node.type === "NumericLiteral") return typeof node.value === "number" ? String(node.value) : null;
  return null;
};

const getStringValue = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === "StringLiteral") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const first = quasis[0] as { value?: { cooked?: unknown } } | undefined;
    return typeof first?.value?.cooked === "string" ? first.value.cooked : null;
  }
  return null;
};

const traverseAst = (root: AnyNode, visit: (node: AnyNode) => void): void => {
  const seen = new WeakSet<object>();
  const walk = (node: AnyNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    visit(node);

    for (const [key, value] of Object.entries(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "errors" ||
        key === "comments" ||
        key === "tokens" ||
        key === "extra"
      ) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          if (isNode(entry)) walk(entry);
        }
        continue;
      }

      if (isNode(value)) walk(value);
    }
  };

  walk(root);
};

const parseScript = (source: string): AnyNode | null => {
  try {
    return parseJavaScript(source, {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        "decorators-legacy",
        "dynamicImport",
        "importAttributes",
        "jsx",
        "typescript",
      ],
      sourceType: "unambiguous",
    }) as unknown as AnyNode;
  } catch {
    return null;
  }
};

const getScriptBlocks = (filePath: string, source: string): ScriptBlock[] => {
  if (path.extname(filePath) !== ".vue") return [{ source, lineOffset: 0 }];

  const descriptor = parseSfc(source, { filename: filePath }).descriptor;
  return [descriptor.script, descriptor.scriptSetup]
    .filter((block): block is NonNullable<typeof block> => Boolean(block))
    .map((block) => ({
      source: block.content,
      lineOffset: block.loc.start.line - 1,
    }));
};

const analyzeSourceUnit = (unit: SourceUnit): SourceAnalysis => {
  const imports: ImportReference[] = [];
  const globImports: string[] = [];
  const exports: ExportReference[] = [];

  for (const block of unit.scriptBlocks) {
    const ast = parseScript(block.source);
    if (!ast) continue;

    traverseAst(ast, (node) => {
      if (node.type === "ImportDeclaration") {
        const specifier = getStringValue(node.source);
        if (!specifier) return;
        const namedImports = new Set<string>();
        let namespace = false;
        for (const imported of Array.isArray(node.specifiers) ? node.specifiers : []) {
          if (!isNode(imported)) continue;
          if (imported.type === "ImportNamespaceSpecifier") namespace = true;
          if (imported.type === "ImportSpecifier") {
            const importedName = getName(imported.imported);
            if (importedName) namedImports.add(importedName);
          }
        }
        imports.push({ specifier, namedImports, namespace });
        return;
      }

      if (node.type === "ExportAllDeclaration") {
        const specifier = getStringValue(node.source);
        if (specifier) imports.push({ specifier, namedImports: new Set(["*"]), namespace: true });
        return;
      }

      if (node.type === "ExportNamedDeclaration") {
        const reexportSource = getStringValue(node.source);
        if (reexportSource) {
          const names = new Set<string>();
          for (const specifier of Array.isArray(node.specifiers) ? node.specifiers : []) {
            if (!isNode(specifier)) continue;
            const localName = getName(specifier.local);
            if (localName) names.add(localName);
          }
          imports.push({ specifier: reexportSource, namedImports: names, namespace: false });
        }

        const declaration = isNode(node.declaration) ? node.declaration : null;
        if (declaration) {
          collectDeclarationExports(declaration, block.lineOffset, exports);
        }
        for (const specifier of Array.isArray(node.specifiers) ? node.specifiers : []) {
          if (!isNode(specifier)) continue;
          const exportedName = getName(specifier.exported);
          if (exportedName) {
            exports.push({
              name: exportedName,
              line: block.lineOffset + (specifier.loc?.start?.line ?? 1),
              column: (specifier.loc?.start?.column ?? 0) + 1,
            });
          }
        }
        return;
      }

      if (node.type === "ImportExpression") {
        const specifier = getStringValue(node.source);
        if (specifier) imports.push({ specifier, namedImports: new Set(), namespace: false });
        return;
      }

      if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;

      const firstArgument = Array.isArray(node.arguments) ? node.arguments.find(isNode) : undefined;
      const stringArgument = getStringValue(firstArgument);
      if (!stringArgument) return;

      if (isImportCall(node) || getName(node.callee) === "require") {
        imports.push({ specifier: stringArgument, namedImports: new Set(), namespace: false });
        return;
      }

      if (isImportMetaGlobCall(node)) {
        globImports.push(stringArgument);
      }
    });
  }

  return { imports, globImports, exports };
};

const collectDeclarationExports = (
  declaration: AnyNode,
  lineOffset: number,
  exports: ExportReference[],
): void => {
  if (declaration.type === "VariableDeclaration") {
    for (const declarator of Array.isArray(declaration.declarations) ? declaration.declarations : []) {
      if (!isNode(declarator)) continue;
      const name = getName(declarator.id);
      if (!name) continue;
      exports.push({
        name,
        line: lineOffset + (declarator.loc?.start?.line ?? 1),
        column: (declarator.loc?.start?.column ?? 0) + 1,
      });
    }
    return;
  }

  const name = getName(declaration.id);
  if (!name) return;
  exports.push({
    name,
    line: lineOffset + (declaration.loc?.start?.line ?? 1),
    column: (declaration.loc?.start?.column ?? 0) + 1,
  });
};

const isImportCall = (node: AnyNode): boolean =>
  isNode(node.callee) && node.callee.type === "Import";

const isImportMetaGlobCall = (node: AnyNode): boolean => {
  if (!isNode(node.callee) || node.callee.type !== "MemberExpression") return false;
  if (getName(node.callee.property) !== "glob") return false;
  const object = isNode(node.callee.object) ? node.callee.object : null;
  if (!object || object.type !== "MetaProperty") return false;
  return getName(object.meta) === "import" && getName(object.property) === "meta";
};

interface PathAlias {
  prefix: string;
  suffix: string;
  replacementPrefix: string;
  replacementSuffix: string;
}

const readJson = (filePath: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const collectPathAliases = (rootDirectory: string): PathAlias[] => {
  const aliases: PathAlias[] = [];
  for (const filename of ["tsconfig.json", "jsconfig.json"]) {
    const config = readJson(path.join(rootDirectory, filename));
    const compilerOptions = isRecord(config?.compilerOptions) ? config.compilerOptions : null;
    const paths = isRecord(compilerOptions?.paths) ? compilerOptions.paths : null;
    const baseUrl = typeof compilerOptions?.baseUrl === "string" ? compilerOptions.baseUrl : ".";
    if (!paths) continue;

    for (const [key, rawTargets] of Object.entries(paths)) {
      const [target] = Array.isArray(rawTargets) ? rawTargets : [];
      if (typeof target !== "string") continue;
      aliases.push(createPathAlias(key, path.resolve(rootDirectory, baseUrl, target)));
    }
  }

  const srcDirectory = path.join(rootDirectory, "src");
  if (fs.existsSync(srcDirectory)) {
    aliases.push({
      prefix: "@/",
      suffix: "",
      replacementPrefix: `${srcDirectory}${path.sep}`,
      replacementSuffix: "",
    });
  }

  return aliases;
};

const createPathAlias = (key: string, target: string): PathAlias => {
  const keyParts = key.split("*");
  const targetParts = target.split("*");
  return {
    prefix: keyParts[0] ?? key,
    suffix: keyParts[1] ?? "",
    replacementPrefix: targetParts[0] ?? target,
    replacementSuffix: targetParts[1] ?? "",
  };
};

const applyAlias = (specifier: string, aliases: PathAlias[]): string | null => {
  for (const alias of aliases) {
    if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
    const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
    return `${alias.replacementPrefix}${middle}${alias.replacementSuffix}`;
  }
  return null;
};

const stripImportQuery = (specifier: string): string => specifier.replace(/[?#].*$/, "");

const isExternalSpecifier = (specifier: string): boolean =>
  !specifier.startsWith(".") &&
  !specifier.startsWith("/") &&
  !specifier.startsWith("@/") &&
  !specifier.startsWith("~/") &&
  !specifier.startsWith("#");

const packageNameFromSpecifier = (specifier: string): string | null => {
  if (!isExternalSpecifier(specifier) || specifier.startsWith("node:") || specifier.startsWith("virtual:")) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0] ?? null;
};

const resolveSourceFile = (
  importerPath: string,
  specifier: string,
  rootDirectory: string,
  sourceFileSet: ReadonlySet<string>,
  aliases: PathAlias[],
): string | null => {
  const cleanSpecifier = stripImportQuery(specifier);
  const basePath = cleanSpecifier.startsWith(".")
    ? path.resolve(path.dirname(importerPath), cleanSpecifier)
    : cleanSpecifier.startsWith("/")
      ? path.resolve(rootDirectory, cleanSpecifier.slice(1))
      : applyAlias(cleanSpecifier, aliases);
  if (!basePath) return null;

  return resolveSourceCandidate(basePath, sourceFileSet);
};

const resolveSourceCandidate = (
  candidatePath: string,
  sourceFileSet: ReadonlySet<string>,
): string | null => {
  const resolved = path.resolve(candidatePath);
  if (sourceFileSet.has(resolved)) return resolved;

  for (const extension of RESOLUTION_EXTENSIONS) {
    const withExtension = `${resolved}${extension}`;
    if (sourceFileSet.has(withExtension)) return withExtension;
  }

  for (const extension of RESOLUTION_EXTENSIONS) {
    const indexFile = path.join(resolved, `index${extension}`);
    if (sourceFileSet.has(indexFile)) return indexFile;
  }

  return null;
};

const resolveGlobPattern = (
  importerPath: string,
  pattern: string,
  rootDirectory: string,
  sourceFiles: ReadonlyArray<string>,
  aliases: PathAlias[],
): string[] => {
  const cleanPattern = stripImportQuery(pattern);
  const absolutePattern = cleanPattern.startsWith(".")
    ? path.resolve(path.dirname(importerPath), cleanPattern)
    : cleanPattern.startsWith("/")
      ? path.resolve(rootDirectory, cleanPattern.slice(1))
      : applyAlias(cleanPattern, aliases);
  if (!absolutePattern) return [];

  const normalizedPattern = toPosixPath(absolutePattern);
  return sourceFiles.filter((filePath) =>
    minimatch(toPosixPath(filePath), normalizedPattern, {
      dot: true,
      nocase: process.platform === "win32",
    }),
  );
};

const readSourceUnits = (files: string[]): SourceUnit[] =>
  files.map((filePath) => {
    const source = fs.readFileSync(filePath, "utf-8");
    return {
      filePath,
      source,
      scriptBlocks: getScriptBlocks(filePath, source),
    };
  });

const collectEntryFiles = (
  rootDirectory: string,
  sourceFileSet: ReadonlySet<string>,
): Set<string> => {
  const entries = new Set<string>();
  for (const filename of CONFIG_ENTRY_FILENAMES) {
    const filePath = path.join(rootDirectory, filename);
    if (sourceFileSet.has(filePath)) entries.add(filePath);
  }

  const indexHtmlPath = path.join(rootDirectory, "index.html");
  if (fs.existsSync(indexHtmlPath)) {
    const html = fs.readFileSync(indexHtmlPath, "utf-8");
    const scriptPattern = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    for (const match of html.matchAll(scriptPattern)) {
      const source = match[1];
      if (!source) continue;
      const resolved = resolveSourceCandidate(path.resolve(rootDirectory, source.replace(/^\//, "")), sourceFileSet);
      if (resolved) entries.add(resolved);
    }
  }

  for (const entryPattern of ["src/main", "src/App", "app", "pages/index"]) {
    const resolved = resolveSourceCandidate(path.join(rootDirectory, entryPattern), sourceFileSet);
    if (resolved) entries.add(resolved);
  }

  return entries;
};

const isConventionallyReachable = (
  relativePath: string,
  project: ProjectInfo,
  packageJson: PackageJson,
): boolean => {
  const normalized = toPosixPath(relativePath);
  if (project.framework === "nuxt") {
    return /^(app\.vue|pages\/|layouts\/|plugins\/|middleware\/|server\/|components\/)/.test(normalized);
  }
  if (hasDependency(packageJson, "unplugin-vue-components") && normalized.startsWith("src/components/")) {
    return true;
  }
  return /^(src\/pages\/|src\/layouts\/|src\/plugins\/|src\/middleware\/)/.test(normalized);
};

const isTestOrStoryFile = (relativePath: string): boolean =>
  /(^|\/)(tests?|__tests__)\//.test(relativePath) ||
  /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(relativePath) ||
  /\.(?:test|spec|stories)\.vue$/.test(relativePath);

const isDeclarationFile = (relativePath: string): boolean => /\.d\.[cm]?ts$/.test(relativePath);

const isConfigEntry = (relativePath: string): boolean =>
  CONFIG_ENTRY_FILENAMES.includes(relativePath) ||
  /(^|\/)(?:eslint\.config|postcss\.config|tailwind\.config|stylelint\.config|prettier\.config|vitest\.config|playwright\.config|cypress\.config|commitlint\.config)\.[cm]?[jt]s$/.test(relativePath) ||
  /(^|\/)\.eslintrc\.[cm]?js$/.test(relativePath);

const findReachableFiles = (entries: ReadonlySet<string>, graph: ReadonlyMap<string, GraphNode>): Set<string> => {
  const reachable = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of graph.get(current)?.edges ?? []) {
      stack.push(edge);
    }
  }
  return reachable;
};

const findCircularImports = (graph: ReadonlyMap<string, GraphNode>): string[][] => {
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (filePath: string): void => {
    if (visiting.has(filePath)) {
      const startIndex = stack.indexOf(filePath);
      if (startIndex < 0) return;
      const cycle = [...stack.slice(startIndex), filePath];
      const key = [...new Set(cycle)].sort().join("\0");
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(filePath)) return;

    visiting.add(filePath);
    stack.push(filePath);
    for (const edge of graph.get(filePath)?.edges ?? []) visit(edge);
    stack.pop();
    visiting.delete(filePath);
    visited.add(filePath);
  };

  for (const filePath of graph.keys()) visit(filePath);
  return cycles;
};

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const readPackageJson = (rootDirectory: string): PackageJson => {
  const parsed = readJson(path.join(rootDirectory, "package.json"));
  return isRecord(parsed) ? parsed : {};
};

const hasDependency = (packageJson: PackageJson, name: string): boolean =>
  Boolean(packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name]);

const collectScriptCommandUsage = (packageJson: PackageJson): Set<string> => {
  const used = new Set<string>();
  for (const script of Object.values(packageJson.scripts ?? {})) {
    for (const dependency of KNOWN_SCRIPT_COMMAND_DEPENDENCIES) {
      const command = dependency.includes("/") ? dependency.split("/").at(-1)! : dependency;
      if (new RegExp(`(^|[\\s;&|])${escapeRegExp(command)}($|[\\s:&|])`).test(script)) {
        used.add(dependency);
      }
    }
  }
  return used;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collectImplicitDependencyUsage = (
  packageJson: PackageJson,
  project: ProjectInfo,
  rootDirectory: string,
  units: ReadonlyArray<SourceUnit>,
): Set<string> => {
  const used = collectScriptCommandUsage(packageJson);
  for (const dependency of collectStylePackageUsage(rootDirectory, units)) used.add(dependency);
  if (project.hasVue) used.add("vue");
  if (project.framework !== "unknown") used.add(project.framework);
  if (project.hasPinia) used.add("pinia");
  if (project.hasVueRouter) used.add("vue-router");
  return used;
};

const collectStylePackageUsage = (
  rootDirectory: string,
  units: ReadonlyArray<SourceUnit>,
): Set<string> => {
  const used = new Set<string>();
  const addFromContent = (content: string): void => {
    for (const match of content.matchAll(STYLE_IMPORT_PATTERN)) {
      const specifier = match[1];
      const packageName = specifier ? packageNameFromSpecifier(specifier.replace(/^~/, "")) : null;
      if (packageName) used.add(packageName);
    }
  };

  for (const unit of units) addFromContent(unit.source);

  for (const filePath of collectStyleFiles(rootDirectory)) {
    addFromContent(fs.readFileSync(filePath, "utf-8"));
  }

  return used;
};

const collectStyleFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!STYLE_IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        files.push(...collectStyleFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && STYLE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
};

const buildGraph = (
  rootDirectory: string,
  units: ReadonlyArray<SourceUnit>,
  analyses: ReadonlyMap<string, SourceAnalysis>,
): {
  graph: Map<string, GraphNode>;
  namedImportsByFile: Map<string, Set<string>>;
  namespaceImportsByFile: Set<string>;
  usedPackages: Set<string>;
} => {
  const sourceFiles = units.map((unit) => unit.filePath);
  const sourceFileSet = new Set(sourceFiles);
  const aliases = collectPathAliases(rootDirectory);
  const graph = new Map<string, GraphNode>();
  const namedImportsByFile = new Map<string, Set<string>>();
  const namespaceImportsByFile = new Set<string>();
  const usedPackages = new Set<string>();

  for (const unit of units) {
    const node: GraphNode = { filePath: unit.filePath, edges: new Set() };
    const analysis = analyses.get(unit.filePath);
    if (!analysis) continue;

    for (const reference of analysis.imports) {
      const packageName = packageNameFromSpecifier(reference.specifier);
      if (packageName) usedPackages.add(packageName);

      const resolved = resolveSourceFile(unit.filePath, reference.specifier, rootDirectory, sourceFileSet, aliases);
      if (!resolved) continue;
      node.edges.add(resolved);
      if (reference.namespace) namespaceImportsByFile.add(resolved);
      const namedImports = namedImportsByFile.get(resolved) ?? new Set<string>();
      for (const name of reference.namedImports) namedImports.add(name);
      namedImportsByFile.set(resolved, namedImports);
    }

    for (const globPattern of analysis.globImports) {
      for (const resolved of resolveGlobPattern(unit.filePath, globPattern, rootDirectory, sourceFiles, aliases)) {
        node.edges.add(resolved);
      }
    }

    graph.set(unit.filePath, node);
  }

  return { graph, namedImportsByFile, namespaceImportsByFile, usedPackages };
};

const toRelative = (rootDirectory: string, filePath: string): string =>
  toPosixPath(path.relative(rootDirectory, filePath));

export const analyzeDeadCode = (
  rootDirectory: string,
  files: string[],
  project: ProjectInfo,
): DeadCodeFinding[] => {
  if (!fs.existsSync(path.join(rootDirectory, "package.json"))) return [];

  const units = readSourceUnits(files);
  const analyses = new Map(units.map((unit) => [unit.filePath, analyzeSourceUnit(unit)]));
  const packageJson = readPackageJson(rootDirectory);
  const entries = collectEntryFiles(rootDirectory, new Set(files));
  const {
    graph,
    namedImportsByFile,
    namespaceImportsByFile,
    usedPackages,
  } = buildGraph(rootDirectory, units, analyses);
  const reachable = entries.size > 0 ? findReachableFiles(entries, graph) : new Set(files);
  const findings: DeadCodeFinding[] = [];

  for (const filePath of files) {
    const relativePath = toRelative(rootDirectory, filePath);
    if (
      reachable.has(filePath) ||
      entries.has(filePath) ||
      isConfigEntry(relativePath) ||
      isDeclarationFile(relativePath) ||
      isTestOrStoryFile(relativePath) ||
      isConventionallyReachable(relativePath, project, packageJson)
    ) {
      continue;
    }

    findings.push({
      filePath,
      input: {
        rule: "no-unused-file",
        severity: "warning",
        category: "Maintainability",
        message: "Source file is not reachable from any detected app entry point.",
        help: "Delete the file if it is obsolete, or import it from an entry, route, component, or import.meta.glob pattern.",
        line: 1,
        column: 1,
      },
    });
  }

  for (const cycle of findCircularImports(graph).slice(0, 25)) {
    const [filePath] = cycle;
    if (!filePath) continue;
    findings.push({
      filePath,
      input: {
        rule: "no-circular-import",
        severity: "warning",
        category: "Maintainability",
        message: `Circular import cycle: ${cycle.map((entry) => toRelative(rootDirectory, entry)).join(" -> ")}.`,
        help: "Break the cycle by moving shared state, constants, or helpers into a third module.",
        line: 1,
        column: 1,
      },
    });
  }

  for (const [filePath, analysis] of analyses.entries()) {
    if (!reachable.has(filePath) || entries.has(filePath) || namespaceImportsByFile.has(filePath)) continue;
    if (isTestOrStoryFile(toRelative(rootDirectory, filePath))) continue;
    const usedNames = namedImportsByFile.get(filePath) ?? new Set<string>();
    for (const exported of analysis.exports) {
      if (usedNames.has(exported.name) || usedNames.has("*")) continue;
      findings.push({
        filePath,
        input: {
          rule: "no-unused-export",
          severity: "warning",
          category: "Maintainability",
          message: `Export "${exported.name}" is not imported by any local source file.`,
          help: "Remove the export if it is internal, or import it from the module that owns the behavior.",
          line: exported.line,
          column: exported.column,
        },
      });
    }
  }

  const implicitUsage = collectImplicitDependencyUsage(packageJson, project, rootDirectory, units);
  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    if (usedPackages.has(dependencyName) || implicitUsage.has(dependencyName)) continue;
    findings.push({
      filePath: path.join(rootDirectory, "package.json"),
      input: {
        rule: "no-unused-dependency",
        severity: "warning",
        category: "Maintainability",
        message: `Dependency "${dependencyName}" is not imported by scanned source or config files.`,
        help: "Remove the dependency if it is obsolete, or add an ignore override if it is loaded externally at runtime.",
        line: 1,
        column: 1,
      },
    });
  }

  return findings;
};
