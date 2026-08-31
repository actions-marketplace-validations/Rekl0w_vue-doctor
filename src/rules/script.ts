import { parse } from "@babel/parser";
import type { DiagnosticInput, ScanContext } from "../types.js";
import { getLineColumn } from "../utils/location.js";

type AnyNode = {
  type?: string | undefined;
  start?: number | null | undefined;
  end?: number | null | undefined;
  loc?: unknown;
  [key: string]: unknown;
};

const SECRET_VARIABLE_PATTERN = /\b(?:api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|secret)\b/i;
const SECRET_LITERAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9]{24,}\b/,
  /\b(?:xoxb|xoxp)-[A-Za-z0-9-]{24,}\b/,
];
const SECRET_FALSE_POSITIVE_SUFFIXES = new Set(["label", "title", "placeholder", "message"]);
const HEAVY_STATIC_IMPORTS = new Set([
  "monaco-editor",
  "echarts",
  "chart.js",
  "three",
  "mapbox-gl",
  "pdfjs-dist",
]);
const SSR_FRAMEWORKS = new Set(["nuxt", "vitepress", "vuepress"]);
const BROWSER_GLOBALS = new Set(["window", "document", "localStorage", "sessionStorage", "navigator"]);
const PUBLIC_ENV_PREFIXES = ["VITE_", "VUE_APP_", "NUXT_PUBLIC_", "PUBLIC_"];

const reportAtIndex = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  index: number,
  diagnostic: Omit<DiagnosticInput, "line" | "column">,
): void => {
  const location = getLineColumn(source, index, lineOffset);
  context.report({
    ...diagnostic,
    line: location.line,
    column: location.column,
  });
};

const reportAtNode = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
  diagnostic: Omit<DiagnosticInput, "line" | "column">,
): void => {
  reportAtIndex(context, source, lineOffset, node.start ?? 0, diagnostic);
};

const parseScriptAst = (source: string): AnyNode | null => {
  try {
    return parse(source, {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        "decorators-legacy",
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

const isNode = (value: unknown): value is AnyNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AnyNode).type === "string";

const traverseAst = (
  root: AnyNode,
  visit: (node: AnyNode) => void,
): void => {
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

const getName = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return typeof node.name === "string" ? node.name : null;
  if (node.type === "StringLiteral") return typeof node.value === "string" ? node.value : null;
  if (node.type === "NumericLiteral") return typeof node.value === "number" ? String(node.value) : null;
  if (node.type === "PrivateName") return getName(node.id);
  return null;
};

const getStringValue = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === "StringLiteral") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const first = quasis[0] as { value?: { cooked?: unknown } } | undefined;
    if (typeof first?.value?.cooked === "string") {
      return first.value.cooked;
    }
  }
  return null;
};

const getCalleeName = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return getName(node);
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return getName(node.property);
  }
  return null;
};

const getMemberChain = (node: unknown): string[] => {
  if (!isNode(node)) return [];
  if (node.type === "Identifier") return [getName(node) ?? ""].filter(Boolean);
  if (node.type === "ThisExpression") return ["this"];
  if (node.type === "MetaProperty") {
    const meta = getName(node.meta);
    const property = getName(node.property);
    return [meta, property].filter((part): part is string => Boolean(part));
  }
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    const calleeName = getCalleeName(node.callee);
    return calleeName ? [`${calleeName}()`] : [];
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return [...getMemberChain(node.object), getName(node.property) ?? ""].filter(Boolean);
  }
  return [];
};

const getObjectName = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return getName(node);
  if (node.type === "ThisExpression") return "this";
  return null;
};

const getMemberParts = (node: unknown): { objectName: string | null; propertyName: string | null } => {
  if (!isNode(node) || (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression")) {
    return { objectName: null, propertyName: null };
  }
  return {
    objectName: getObjectName(node.object),
    propertyName: getName(node.property),
  };
};

const getCallArguments = (node: AnyNode): AnyNode[] =>
  Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];

const normalizeSecretName = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");

const getSecretNameSuffix = (name: string): string =>
  normalizeSecretName(name).split(/[_-]/).pop()?.toLowerCase() ?? "";

const isSecretishName = (name: string): boolean => {
  const suffix = getSecretNameSuffix(name);
  const looksLikeRuleName = /^(?:no|require|prefer|watch)-/.test(name);
  return (
    !looksLikeRuleName &&
    SECRET_VARIABLE_PATTERN.test(normalizeSecretName(name)) &&
    !SECRET_FALSE_POSITIVE_SUFFIXES.has(suffix)
  );
};

const reportSecretIfNeeded = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  name: string,
  value: string,
  node: AnyNode,
): void => {
  if (
    value.length >= 12 &&
    isSecretishName(name)
  ) {
    reportAtNode(context, source, lineOffset, node, {
      rule: "no-hardcoded-secret",
      severity: "error",
      category: "Security",
      message: `Possible hardcoded secret in "${name}".`,
      help: "Move secrets to server-side storage or environment variables that are never bundled into the client.",
    });
    return;
  }

  if (SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(value))) {
    reportAtNode(context, source, lineOffset, node, {
      rule: "no-hardcoded-secret",
      severity: "error",
      category: "Security",
      message: "Hardcoded credential-like literal detected.",
      help: "Rotate the value if it is real, then load it from a server-side secret store.",
    });
  }
};

const collectOptionsApiPropNames = (ast: AnyNode): Set<string> => {
  const propNames = new Set<string>();
  traverseAst(ast, (node) => {
    if (node.type !== "ObjectProperty" && node.type !== "ObjectMethod") return;
    if (getName(node.key) !== "props") return;
    const value = isNode(node.value) ? node.value : null;
    if (!value || value.type !== "ObjectExpression" || !Array.isArray(value.properties)) return;

    for (const property of value.properties) {
      if (!isNode(property)) continue;
      const name = getName(property.key);
      if (name) propNames.add(name);
    }
  });
  return propNames;
};

const reportPropMutation = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
  target: unknown,
  propNames: Set<string>,
): void => {
  const { objectName, propertyName } = getMemberParts(target);
  if (objectName === "props" && propertyName) {
    reportAtNode(context, source, lineOffset, node, {
      rule: "no-mutating-props",
      severity: "error",
      category: "Correctness",
      message: "Props are readonly; mutating them makes parent and child state diverge.",
      help: "Emit an event or copy the prop into local state before editing it.",
    });
    return;
  }

  if (objectName === "this" && propertyName && propNames.has(propertyName)) {
    reportAtNode(context, source, lineOffset, node, {
      rule: "no-mutating-props",
      severity: "error",
      category: "Correctness",
      message: `Prop "${propertyName}" is mutated directly.`,
      help: "Emit an update event or use a local ref initialized from the prop.",
    });
  }
};

const countObjectProperties = (node: AnyNode): number =>
  Array.isArray(node.properties)
    ? node.properties.filter((property) => isNode(property) && property.type !== "SpreadElement").length
    : 0;

const getObjectProperties = (node: AnyNode): AnyNode[] =>
  Array.isArray(node.properties) ? node.properties.filter(isNode) : [];

const findObjectProperty = (node: AnyNode, name: string): AnyNode | null =>
  getObjectProperties(node).find((property) => getName(property.key) === name) ?? null;

const reportTooManyProps = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
  count: number,
): void => {
  const maxProps = context.config.maxProps ?? 14;
  if (count <= maxProps) return;
  reportAtNode(context, source, lineOffset, node, {
    rule: "no-too-many-props",
    severity: "warning",
    category: "Architecture",
    message: `Component exposes ${count} props, which is a broad public API.`,
    help: "Split the component, group related options into objects, or move behavior into composables.",
  });
};

const containsIdentifier = (node: AnyNode, names: Set<string>): boolean => {
  let found = false;
  traverseAst(node, (child) => {
    if (found) return;
    if (child.type === "Identifier" && typeof child.name === "string" && names.has(child.name)) {
      found = true;
    }
  });
  return found;
};

const containsWatcherWork = (node: AnyNode): boolean => {
  if (node.async === true) return true;
  let found = false;
  traverseAst(node, (child) => {
    if (found) return;
    if (child.type !== "CallExpression" && child.type !== "OptionalCallExpression" && child.type !== "NewExpression") return;
    const calleeName = getCalleeName(child.callee);
    const objectName = isNode(child.callee) ? getMemberParts(child.callee).objectName : null;
    if (
      calleeName === "fetch" ||
      calleeName === "setTimeout" ||
      calleeName === "setInterval" ||
      (objectName === "axios" && child.type !== "NewExpression")
    ) {
      found = true;
    }
  });
  return found;
};

const hasWatcherCleanup = (node: AnyNode): boolean => {
  const params = Array.isArray(node.params) ? node.params.filter(isNode) : [];
  if (params.length > 0 && containsIdentifier(params[params.length - 1]!, new Set(["onCleanup", "onInvalidate"]))) {
    return true;
  }

  return containsIdentifier(
    node,
    new Set([
      "onCleanup",
      "onWatcherCleanup",
      "onInvalidate",
      "AbortController",
      "clearTimeout",
      "clearInterval",
    ]),
  );
};

const reportWatcherCleanup = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
): void => {
  const calleeName = getCalleeName(node.callee);
  if (calleeName !== "watch" && calleeName !== "watchEffect") return;
  const args = getCallArguments(node);
  const callback = calleeName === "watch" ? args[1] : args[0];
  if (!callback || !["ArrowFunctionExpression", "FunctionExpression"].includes(callback.type ?? "")) return;
  if (!containsWatcherWork(callback) || hasWatcherCleanup(callback)) return;

  reportAtNode(context, source, lineOffset, node, {
    rule: "watch-requires-cleanup",
    severity: "warning",
    category: "Performance",
    message: "Async watcher has no cleanup or cancellation path.",
    help: "Use onCleanup/onWatcherCleanup with AbortController or clear pending timers between runs.",
  });
};

const reportSyncWatchFlush = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
): void => {
  const calleeName = getCalleeName(node.callee);
  if (calleeName !== "watch" && calleeName !== "watchEffect" && calleeName !== "watchPostEffect") return;

  const syncFlush = getCallArguments(node)
    .filter((argument) => argument.type === "ObjectExpression")
    .map((argument) => findObjectProperty(argument, "flush"))
    .find((property) => property && getStringValue(property.value) === "sync");

  if (!syncFlush) return;
  reportAtNode(context, source, lineOffset, syncFlush, {
    rule: "no-sync-watch-flush",
    severity: "warning",
    category: "Performance",
    message: "Watcher uses flush: 'sync', so it runs inside Vue's synchronous update path.",
    help: "Prefer the default async flush or flush: 'post' unless this watcher is tiny and documented.",
  });
};

const reportAsyncComputed = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
): void => {
  if (getCalleeName(node.callee) !== "computed") return;
  const [getterOrOptions] = getCallArguments(node);
  if (!getterOrOptions) return;

  const getterIsAsync =
    (["ArrowFunctionExpression", "FunctionExpression"].includes(getterOrOptions.type ?? "") &&
      getterOrOptions.async === true) ||
    (getterOrOptions.type === "ObjectExpression" &&
      Boolean(findObjectProperty(getterOrOptions, "get")?.async));

  if (!getterIsAsync) return;
  reportAtNode(context, source, lineOffset, node, {
    rule: "no-async-computed",
    severity: "error",
    category: "Correctness",
    message: "computed() getter is async, so Vue cannot cache a stable synchronous value.",
    help: "Use a ref plus watch/watchEffect for async work, then expose a synchronous computed projection.",
  });
};

const looksLikePublicEnvName = (name: string): boolean =>
  PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));

const stripPublicEnvPrefix = (name: string): string =>
  name.slice(PUBLIC_ENV_PREFIXES.find((prefix) => name.startsWith(prefix))?.length ?? 0);

const reportPublicEnvSecret = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
): void => {
  const chain = getMemberChain(node);
  const envName = chain.at(-1);
  if (!envName || !looksLikePublicEnvName(envName) || !isSecretishName(stripPublicEnvPrefix(envName))) return;

  const isKnownPublicEnvAccess =
    chain.join(".").startsWith("import.meta.env.") ||
    chain.join(".").startsWith("process.env.") ||
    chain.includes("public");
  if (!isKnownPublicEnvAccess) return;

  reportAtNode(context, source, lineOffset, node, {
    rule: "no-public-env-secret",
    severity: "error",
    category: "Security",
    message: `Public client env variable "${envName}" looks secret-like.`,
    help: "Values with public env prefixes are bundled for the browser; keep tokens and secrets server-side.",
  });
};

const packageMatches = (source: string, packageName: string): boolean =>
  source === packageName || source.startsWith(`${packageName}/`);

const reportImportQuality = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  packageName: string,
  node: AnyNode,
): void => {
  if (packageName === "lodash") {
    reportAtNode(context, source, lineOffset, node, {
      rule: "no-full-lodash-import",
      severity: "warning",
      category: "Bundle Size",
      message: "Full lodash import pulls a large utility bundle into client code.",
      help: "Import the specific function path, use lodash-es tree-shaken imports, or prefer native JavaScript.",
    });
  }

  if (packageName === "moment") {
    reportAtNode(context, source, lineOffset, node, {
      rule: "no-moment",
      severity: "warning",
      category: "Bundle Size",
      message: "moment is heavy for browser bundles and is rarely tree-shaken.",
      help: "Prefer Intl APIs, dayjs, date-fns, or a route-level dynamic import if moment is unavoidable.",
    });
  }

  if ([...HEAVY_STATIC_IMPORTS].some((heavyPackage) => packageMatches(packageName, heavyPackage))) {
    reportAtNode(context, source, lineOffset, node, {
      rule: "prefer-dynamic-import",
      severity: "warning",
      category: "Bundle Size",
      message: "Heavy browser-only dependency is imported eagerly.",
      help: "Use dynamic import() inside the route, component, or interaction that needs this library.",
    });
  }
};

const reportVue2DeprecatedApi = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
): void => {
  if (!context.project.vueVersion || !/[\^~>=<\s]*3/.test(context.project.vueVersion)) return;

  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const { objectName, propertyName } = getMemberParts(node);
    if (objectName === "this" && propertyName === "$listeners") {
      reportAtNode(context, source, lineOffset, node, {
        rule: "no-vue2-deprecated-api",
        severity: "warning",
        category: "Correctness",
        message: "this.$listeners is a Vue 2 API and is not compatible with Vue 3.",
        help: "Use the Vue 3 migration equivalent before upgrading or publishing reusable components.",
      });
    }
  }

  if ((node.type === "ObjectProperty" || node.type === "ObjectMethod") && ["beforeDestroy", "destroyed"].includes(getName(node.key) ?? "")) {
    const label = getName(node.key) ?? "lifecycle hook";
    reportAtNode(context, source, lineOffset, node, {
      rule: "no-vue2-deprecated-api",
      severity: "warning",
      category: "Correctness",
      message: `${label} is a Vue 2 API and is not compatible with Vue 3.`,
      help: "Use the Vue 3 migration equivalent before upgrading or publishing reusable components.",
    });
  }
};

const reportPublicRuntimeConfigSecrets = (
  context: ScanContext,
  source: string,
  lineOffset: number,
  node: AnyNode,
): void => {
  if (node.type !== "ObjectProperty" || getName(node.key) !== "runtimeConfig") return;
  const runtimeConfig = isNode(node.value) && node.value.type === "ObjectExpression" ? node.value : null;
  if (!runtimeConfig) return;

  const publicConfig = findObjectProperty(runtimeConfig, "public");
  const publicValue = isNode(publicConfig?.value) && publicConfig.value.type === "ObjectExpression"
    ? publicConfig.value
    : null;
  if (!publicValue) return;

  for (const property of getObjectProperties(publicValue)) {
    const keyName = getName(property.key);
    if (!keyName || !isSecretishName(keyName)) continue;
    reportAtNode(context, source, lineOffset, property, {
      rule: "no-public-runtime-secret",
      severity: "error",
      category: "Security",
      message: `Nuxt public runtime config exposes secret-like key "${keyName}" to the browser.`,
      help: "Keep secrets under private runtimeConfig keys and expose only non-sensitive public values.",
    });
  }
};

const findBrowserGlobal = (node: AnyNode): AnyNode | null => {
  let found: AnyNode | null = null;
  traverseAst(node, (child) => {
    if (found) return;
    if (child.type === "Identifier" && typeof child.name === "string" && BROWSER_GLOBALS.has(child.name)) {
      found = child;
    }
  });
  return found;
};

const scanTopLevelBrowserGlobals = (
  ast: AnyNode,
  source: string,
  lineOffset: number,
  context: ScanContext,
): void => {
  if (!SSR_FRAMEWORKS.has(context.project.framework)) return;
  const program = isNode(ast.program) ? ast.program : null;
  const body = Array.isArray(program?.body) ? program.body.filter(isNode) : [];

  for (const statement of body) {
    if (statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration") continue;
    if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") continue;

    const statementSource = source.slice(statement.start ?? 0, statement.end ?? statement.start ?? 0);
    if (/typeof\s+(?:window|document|navigator)\s*!==?\s*["']undefined["']/.test(statementSource)) {
      continue;
    }

    const browserGlobal = findBrowserGlobal(statement);
    if (!browserGlobal) continue;
    const globalName = typeof browserGlobal.name === "string" ? browserGlobal.name : "browser global";
    reportAtNode(context, source, lineOffset, browserGlobal, {
      rule: "no-ssr-browser-global",
      severity: "warning",
      category: "Correctness",
      message: `${globalName} is read at module/setup time in an SSR-capable project.`,
      help: "Guard browser-only globals with process.client/import.meta.client checks or move them into onMounted.",
    });
  }
};

const scanAst = (
  ast: AnyNode,
  source: string,
  lineOffset: number,
  context: ScanContext,
): void => {
  const propNames = collectOptionsApiPropNames(ast);
  scanTopLevelBrowserGlobals(ast, source, lineOffset, context);

  traverseAst(ast, (node) => {
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const calleeName = getCalleeName(node.callee);
      const args = getCallArguments(node);

      if (calleeName === "eval") {
        reportAtNode(context, source, lineOffset, node, {
          rule: "no-eval",
          severity: "error",
          category: "Security",
          message: "eval() executes arbitrary code.",
          help: "Use data structures, explicit dispatch tables, or safe parsers instead.",
        });
      }

      if ((calleeName === "setTimeout" || calleeName === "setInterval") && getStringValue(args[0]) !== null) {
        reportAtNode(context, source, lineOffset, node, {
          rule: "no-eval",
          severity: "error",
          category: "Security",
          message: "String timers execute code dynamically.",
          help: "Pass a function to setTimeout or setInterval.",
        });
      }

      if (calleeName === "require") {
        const packageName = getStringValue(args[0]);
        if (packageName) reportImportQuality(context, source, lineOffset, packageName, node);
      }

      if (calleeName === "defineProps") {
        const firstArg = args[0];
        if (firstArg?.type === "ObjectExpression") {
          reportTooManyProps(context, source, lineOffset, node, countObjectProperties(firstArg));
        }
      }

      reportWatcherCleanup(context, source, lineOffset, node);
      reportSyncWatchFlush(context, source, lineOffset, node);
      reportAsyncComputed(context, source, lineOffset, node);
    }

    if (node.type === "NewExpression" && getCalleeName(node.callee) === "Function") {
      reportAtNode(context, source, lineOffset, node, {
        rule: "no-eval",
        severity: "error",
        category: "Security",
        message: "new Function() executes dynamically generated code.",
        help: "Avoid dynamic code execution in browser bundles.",
      });
    }

    if (node.type === "ImportDeclaration") {
      const packageName = getStringValue(node.source);
      if (packageName) reportImportQuality(context, source, lineOffset, packageName, node);
    }

    if (node.type === "VariableDeclarator") {
      const name = getName(node.id);
      const value = getStringValue(node.init);
      if (name && value) reportSecretIfNeeded(context, source, lineOffset, name, value, node);
    }

    if (node.type === "ObjectProperty") {
      const keyName = getName(node.key);
      const stringValue = getStringValue(node.value);
      if (keyName && stringValue) reportSecretIfNeeded(context, source, lineOffset, keyName, stringValue, node);

      if (keyName === "props" && isNode(node.value) && node.value.type === "ObjectExpression") {
        reportTooManyProps(context, source, lineOffset, node, countObjectProperties(node.value));
      }

      if (keyName === "deep" && isNode(node.value) && node.value.type === "BooleanLiteral" && node.value.value === true) {
        reportAtNode(context, source, lineOffset, node, {
          rule: "no-deep-watch",
          severity: "warning",
          category: "Performance",
          message: "deep: true makes Vue traverse the whole watched object graph.",
          help: "Watch a narrower source, use a computed projection, or document why deep traversal is bounded.",
        });
      }
    }

    if (node.type === "AssignmentExpression") {
      reportPropMutation(context, source, lineOffset, node, node.left, propNames);
      const name = getName(node.left);
      const value = getStringValue(node.right);
      if (name && value) reportSecretIfNeeded(context, source, lineOffset, name, value, node);
    }

    if (node.type === "UpdateExpression") {
      reportPropMutation(context, source, lineOffset, node, node.argument, propNames);
    }

    reportVue2DeprecatedApi(context, source, lineOffset, node);
    reportPublicRuntimeConfigSecrets(context, source, lineOffset, node);
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      reportPublicEnvSecret(context, source, lineOffset, node);
    }
  });
};

export const scanScript = (source: string, lineOffset: number, context: ScanContext): void => {
  const ast = parseScriptAst(source);
  if (!ast) return;
  scanAst(ast, source, lineOffset, context);
};
