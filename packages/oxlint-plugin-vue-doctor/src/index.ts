export type OxlintRuleSeverity = "error" | "warn";

interface AstNode {
  type?: string;
  name?: string;
  value?: unknown;
  async?: boolean;
  callee?: AstNode;
  arguments?: AstNode[];
  object?: AstNode;
  property?: AstNode;
  meta?: AstNode;
  source?: AstNode;
  id?: AstNode;
  init?: AstNode;
  key?: AstNode;
  properties?: AstNode[];
}

interface ReportDescriptor {
  node: AstNode;
  message: string;
}

interface RuleContext {
  report: (descriptor: ReportDescriptor) => void;
  filename?: string;
  settings?: Readonly<Record<string, unknown>>;
}

type RuleVisitors = Record<string, (node: AstNode) => void>;

interface RuleDefinition {
  id: string;
  title: string;
  severity: OxlintRuleSeverity;
  category: "Security" | "Correctness" | "Performance" | "Bundle Size";
  recommendation: string;
  create: (context: RuleContext) => RuleVisitors;
}

interface RulePlugin {
  meta: { name: string };
  rules: Record<string, RuleDefinition>;
}

const SECRET_NAME_PATTERN =
  /(?:secret|token|private|password|passwd|credential|api[_-]?key|access[_-]?key|client[_-]?secret|auth)/i;
const SECRET_VALUE_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
];
const PUBLIC_ENV_PREFIXES = ["VITE_", "VUE_APP_", "NUXT_PUBLIC_", "PUBLIC_"];

const isIdentifier = (node: AstNode | undefined, name?: string): boolean =>
  node?.type === "Identifier" && (name === undefined || node.name === name);

const getNodeName = (node: AstNode | undefined): string | null => {
  if (!node) return null;
  if (node.type === "Identifier") return typeof node.name === "string" ? node.name : null;
  if (node.type === "PrivateIdentifier") return typeof node.name === "string" ? node.name : null;
  if (node.type === "Literal" || node.type === "StringLiteral") {
    return typeof node.value === "string" ? node.value : null;
  }
  return null;
};

const getStringValue = (node: AstNode | undefined): string | null => {
  if (!node) return null;
  if (node.type === "Literal" || node.type === "StringLiteral") {
    return typeof node.value === "string" ? node.value : null;
  }
  return null;
};

const isFunctionLike = (node: AstNode | undefined): node is AstNode =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression" ||
  node?.type === "FunctionDeclaration";

const propertyKeyName = (node: AstNode | undefined): string | null =>
  getNodeName(node?.key) ?? getNodeName(node);

const memberTrail = (node: AstNode | undefined): string[] => {
  if (!node) return [];
  if (node.type === "Identifier") return node.name ? [node.name] : [];
  if (node.type === "ThisExpression") return ["this"];
  if (node.type === "MetaProperty") {
    return [getNodeName(node.meta), getNodeName(node.property)].filter((entry): entry is string => Boolean(entry));
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return [...memberTrail(node.object), ...(getNodeName(node.property) ? [getNodeName(node.property)!] : [])];
  }
  return [];
};

const isPublicEnvSecretName = (name: string): boolean =>
  PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) && SECRET_NAME_PATTERN.test(name);

const objectHasStringProperty = (node: AstNode | undefined, key: string, value: string): boolean => {
  if (node?.type !== "ObjectExpression") return false;
  return (node.properties ?? []).some((property) => propertyKeyName(property) === key && getStringValue(property.value as AstNode | undefined) === value);
};

const defineRule = (rule: RuleDefinition): RuleDefinition => rule;

const noEval = defineRule({
  id: "no-eval",
  title: "eval runs code strings",
  severity: "error",
  category: "Security",
  recommendation: "Use JSON.parse for data, or rewrite the code so it does not build and run strings.",
  create: (context) => ({
    CallExpression(node) {
      if (isIdentifier(node.callee, "eval")) {
        context.report({
          node,
          message: "eval() runs arbitrary strings as code and creates a code-injection risk.",
        });
        return;
      }

      if (
        (isIdentifier(node.callee, "setTimeout") || isIdentifier(node.callee, "setInterval")) &&
        typeof getStringValue(node.arguments?.[0]) === "string"
      ) {
        context.report({
          node,
          message: "Passing a string to a timer runs that string as code; pass a function instead.",
        });
      }
    },
    NewExpression(node) {
      if (isIdentifier(node.callee, "Function")) {
        context.report({
          node,
          message: "new Function() builds executable code from a string and creates an injection risk.",
        });
      }
    },
  }),
});

const noPublicEnvSecret = defineRule({
  id: "no-public-env-secret",
  title: "Public env secret name",
  severity: "error",
  category: "Security",
  recommendation: "Move secrets to server-only env vars; public Vue/Vite/Nuxt env names ship to the browser.",
  create: (context) => ({
    MemberExpression(node) {
      const trail = memberTrail(node);
      const last = trail.at(-1);
      const isImportMetaEnv = trail.length >= 4 && trail[0] === "import" && trail[1] === "meta" && trail[2] === "env";
      const isProcessEnv = trail.length >= 3 && trail[0] === "process" && trail[1] === "env";
      if (!last || (!isImportMetaEnv && !isProcessEnv) || !isPublicEnvSecretName(last)) return;

      context.report({
        node,
        message: `${last} looks like a secret but uses a public client env prefix, so it can be bundled into browser code.`,
      });
    },
  }),
});

const noHardcodedSecret = defineRule({
  id: "no-hardcoded-secret",
  title: "Hardcoded secret",
  severity: "error",
  category: "Security",
  recommendation: "Move secrets into server-side secret storage and read them outside browser-shipped code.",
  create: (context) => ({
    VariableDeclarator(node) {
      const variableName = getNodeName(node.id);
      const literalValue = getStringValue(node.init);
      if (!variableName || !literalValue) return;

      if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(literalValue))) {
        context.report({
          node,
          message: "This string literal looks like a real secret and should not be committed to client code.",
        });
        return;
      }

      if (SECRET_NAME_PATTERN.test(variableName) && literalValue.length >= 16) {
        context.report({
          node,
          message: `${variableName} is a secret-like name assigned to a long literal; move it out of source code.`,
        });
      }
    },
  }),
});

const noFullLodashImport = defineRule({
  id: "no-full-lodash-import",
  title: "Full lodash import",
  severity: "warn",
  category: "Bundle Size",
  recommendation: "Import from lodash-es or a narrow lodash subpath instead of pulling the whole package.",
  create: (context) => ({
    ImportDeclaration(node) {
      if (getStringValue(node.source) !== "lodash") return;
      context.report({
        node,
        message: "Importing all of lodash can add avoidable bundle weight; import only the functions you use.",
      });
    },
  }),
});

const noMoment = defineRule({
  id: "no-moment",
  title: "Moment in browser bundle",
  severity: "warn",
  category: "Bundle Size",
  recommendation: "Prefer Intl, date-fns, dayjs, or a route-level dynamic import for heavy date tooling.",
  create: (context) => ({
    ImportDeclaration(node) {
      if (getStringValue(node.source) !== "moment") return;
      context.report({
        node,
        message: "moment is large for client bundles; prefer a lighter date utility when possible.",
      });
    },
  }),
});

const noAsyncComputed = defineRule({
  id: "no-async-computed",
  title: "Async computed getter",
  severity: "error",
  category: "Correctness",
  recommendation: "Keep computed getters synchronous; move async work into watch/watchEffect or an explicit action.",
  create: (context) => ({
    CallExpression(node) {
      if (!isIdentifier(node.callee, "computed")) return;
      const getter = node.arguments?.[0];
      if (!isFunctionLike(getter) || getter.async !== true) return;
      context.report({
        node,
        message: "computed() getters should stay synchronous so Vue can cache and invalidate them predictably.",
      });
    },
  }),
});

const noSyncWatchFlush = defineRule({
  id: "no-sync-watch-flush",
  title: "Sync watcher flush",
  severity: "warn",
  category: "Performance",
  recommendation: "Use the default watcher flush timing unless the synchronous update path is deliberately bounded.",
  create: (context) => ({
    CallExpression(node) {
      if (!isIdentifier(node.callee, "watch") && !isIdentifier(node.callee, "watchEffect")) return;
      const options = isIdentifier(node.callee, "watch") ? node.arguments?.[2] : node.arguments?.[1];
      if (!objectHasStringProperty(options, "flush", "sync")) return;
      context.report({
        node,
        message: "flush: 'sync' runs inside Vue's update path and can turn reactive changes into jank.",
      });
    },
  }),
});

export const VUE_DOCTOR_OXLINT_RULES = [
  noEval,
  noPublicEnvSecret,
  noHardcodedSecret,
  noFullLodashImport,
  noMoment,
  noAsyncComputed,
  noSyncWatchFlush,
];

export const RECOMMENDED_RULES = VUE_DOCTOR_OXLINT_RULES.map((rule) => `vue-doctor/${rule.id}`);

const plugin: RulePlugin = {
  meta: { name: "vue-doctor" },
  rules: Object.fromEntries(VUE_DOCTOR_OXLINT_RULES.map((rule) => [rule.id, rule])),
};

export default plugin;
