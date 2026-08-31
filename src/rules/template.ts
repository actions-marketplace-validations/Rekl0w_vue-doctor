import {
  type AttributeNode,
  baseParse,
  type DirectiveNode,
  ElementTypes,
  type ElementNode,
  NodeTypes,
  type RootNode,
  type TemplateChildNode,
} from "@vue/compiler-dom";
import type { DiagnosticInput, ScanContext } from "../types.js";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea"]);
const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "summary"]);
const INLINE_PROP_SKIP_ARGS = new Set(["class", "style"]);

const isDirective = (prop: ElementNode["props"][number]): prop is DirectiveNode =>
  prop.type === NodeTypes.DIRECTIVE;

const isAttribute = (prop: ElementNode["props"][number]): prop is AttributeNode =>
  prop.type === NodeTypes.ATTRIBUTE;

const getDirective = (node: ElementNode, name: string, argument?: string): DirectiveNode | null =>
  node.props.find((prop): prop is DirectiveNode => {
    if (!isDirective(prop) || prop.name !== name) return false;
    if (!argument) return true;
    return prop.arg?.loc.source === argument;
  }) ?? null;

const hasDirective = (node: ElementNode, name: string, argument?: string): boolean =>
  Boolean(getDirective(node, name, argument));

const getAttribute = (node: ElementNode, name: string): AttributeNode | null =>
  node.props.find((prop): prop is AttributeNode => isAttribute(prop) && prop.name === name) ?? null;

const getAttributeValue = (node: ElementNode, name: string): string | null => {
  const attr = getAttribute(node, name);
  return attr?.value?.content ?? null;
};

const getBoundExpression = (node: ElementNode, name: string): string | null => {
  const directive = getDirective(node, "bind", name);
  return directive?.exp?.loc.source ?? null;
};

const hasKey = (node: ElementNode): boolean =>
  Boolean(getAttribute(node, "key") ?? getDirective(node, "bind", "key"));

const getKeyExpression = (node: ElementNode): string | null =>
  getAttributeValue(node, "key") ?? getBoundExpression(node, "key");

const makeDiagnostic = (
  rule: string,
  lineOffset: number,
  line: number,
  input: Omit<DiagnosticInput, "rule" | "line">,
): DiagnosticInput => ({
  ...input,
  rule,
  line: lineOffset + line - 1,
});

const parseIndexAlias = (expression: string): string | null => {
  const aliasMatch = expression.match(/^\s*(.*?)\s+(?:in|of)\s+/);
  const aliasSource = aliasMatch?.[1]?.trim().replace(/^\(|\)$/g, "") ?? "";
  const aliases = aliasSource
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
  if (aliases.length === 2) return aliases[1]!;
  if (aliases.length >= 3) return aliases[2]!;
  return null;
};

const normalizeExpression = (expression: string): string =>
  expression.trim().replace(/^['"`]|['"`]$/g, "");

const normalizeStaticId = (value: string | null): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const stripStringLiterals = (expression: string): string =>
  expression
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, "\"\"")
    .replace(/`(?:\\.|[^`])*`/g, "``");

const containsSideEffect = (expression: string): boolean => {
  const withoutLiterals = stripStringLiterals(expression);
  const withoutComparisons = withoutLiterals.replace(/===|!==|==|!=|>=|<=|=>/g, "");
  return /(\+\+|--|\bdelete\b|\bawait\b|[^=!<>]=[^=>])/.test(withoutComparisons);
};

const containsExpensiveWork = (expression: string): boolean =>
  /(?:\.(?:map|filter|reduce|sort|reverse|flatMap)\s*\(|\bJSON\.stringify\s*\(|\bnew\s+Date\s*\(|\bIntl\.)/.test(
    expression,
  );

const containsHydrationUnstableWork = (expression: string): boolean =>
  /\b(?:Math\.random|Date\.now|crypto\.randomUUID)\s*\(|\bnew\s+Date\s*\(/.test(expression);

const shouldCheckDirectiveExpressionPurity = (directive: DirectiveNode): boolean =>
  directive.name !== "on" &&
  directive.name !== "model" &&
  !(directive.name === "bind" && directive.arg?.loc.source === "ref");

const getAccessibleText = (children: TemplateChildNode[]): string =>
  children
    .map((child) => {
      if (child.type === NodeTypes.TEXT || child.type === NodeTypes.INTERPOLATION) {
        return child.loc.source;
      }
      if (child.type === NodeTypes.ELEMENT) {
        return getAccessibleText(child.children);
      }
      return "";
    })
    .join("");

const hasAccessibleName = (node: ElementNode): boolean => {
  if (getAttribute(node, "aria-label") || getDirective(node, "bind", "aria-label")) return true;
  if (getAttribute(node, "aria-labelledby") || getDirective(node, "bind", "aria-labelledby")) return true;
  if (getAttribute(node, "title") || getDirective(node, "bind", "title")) return true;

  const text = getAccessibleText(node.children).trim();
  return text.length > 0;
};

const hasFormControlName = (
  node: ElementNode,
  labelTargetIds: ReadonlySet<string>,
  isInsideLabel: boolean,
): boolean => {
  if (hasAccessibleName(node)) return true;
  if (isInsideLabel) return true;
  const id = normalizeStaticId(getAttributeValue(node, "id"));
  return Boolean(id && labelTargetIds.has(id));
};

const isNativeInteractive = (node: ElementNode): boolean => {
  if (INTERACTIVE_TAGS.has(node.tag)) return true;
  if (node.tag === "a") return Boolean(getAttribute(node, "href") ?? getDirective(node, "bind", "href"));
  return false;
};

const hasKeyboardHandler = (node: ElementNode): boolean =>
  Boolean(
    getDirective(node, "on", "keydown") ??
      getDirective(node, "on", "keyup") ??
      getDirective(node, "on", "keypress"),
  );

const hasInteractiveRoleOrTabIndex = (node: ElementNode): boolean =>
  Boolean(
    getAttribute(node, "role") ??
      getDirective(node, "bind", "role") ??
      getAttribute(node, "tabindex") ??
      getDirective(node, "bind", "tabindex"),
  );

const isComponentNode = (node: ElementNode): boolean =>
  node.tagType === ElementTypes.COMPONENT || /^[A-Z]/.test(node.tag) || node.tag.includes("-");

const isInlineObjectOrArrayExpression = (expression: string): boolean => {
  const normalized = expression.trim();
  return normalized.startsWith("{") || normalized.startsWith("[");
};

const isInlineFunctionExpression = (expression: string): boolean => {
  const normalized = expression.trim();
  return normalized.startsWith("async ") ||
    normalized.startsWith("function") ||
    /^\([^)]*\)\s*=>/.test(normalized) ||
    /^[A-Za-z_$][\w$]*\s*=>/.test(normalized);
};

const visitExpression = (
  expression: string | undefined,
  lineOffset: number,
  localLine: number,
  report: ScanContext["report"],
): void => {
  if (!expression) return;
  if (containsSideEffect(expression)) {
    report(
      makeDiagnostic("no-template-side-effects", lineOffset, localLine, {
        severity: "error",
        category: "Correctness",
        message: "Template expressions should be pure; this expression appears to mutate state or await work.",
        help: "Move the mutation or async work into an event handler, method, computed value, or watcher.",
        column: 1,
      }),
    );
  }

  if (containsExpensiveWork(expression)) {
    report(
      makeDiagnostic("no-expensive-template-expression", lineOffset, localLine, {
        severity: "warning",
        category: "Performance",
        message: "This template expression performs work every render.",
        help: "Move expensive array/date/string formatting work into a computed value.",
        column: 1,
      }),
    );
  }

  if (containsHydrationUnstableWork(expression)) {
    report(
      makeDiagnostic("no-hydration-unstable-template", lineOffset, localLine, {
        severity: "warning",
        category: "Correctness",
        message: "Template expression can produce different server and client output.",
        help: "Move random, time-based, or environment-specific values into mounted client state or server-provided data.",
        column: 1,
      }),
    );
  }
};

const inspectInlineComponentProps = (
  node: ElementNode,
  lineOffset: number,
  report: ScanContext["report"],
): void => {
  if (!isComponentNode(node)) return;

  for (const prop of node.props) {
    if (!isDirective(prop) || prop.name !== "bind" || !prop.exp) continue;
    const argument = prop.arg?.loc.source ?? "";
    if (INLINE_PROP_SKIP_ARGS.has(argument)) continue;

    if (isInlineObjectOrArrayExpression(prop.exp.loc.source)) {
      report(
        makeDiagnostic("no-inline-template-object", lineOffset, prop.loc.start.line, {
          severity: "warning",
          category: "Performance",
          message: "Component prop receives a new object or array on every render.",
          help: "Move the object or array into a computed value, ref, or stable module constant.",
          column: prop.loc.start.column,
        }),
      );
    }

    if (isInlineFunctionExpression(prop.exp.loc.source)) {
      report(
        makeDiagnostic("no-inline-template-function", lineOffset, prop.loc.start.line, {
          severity: "warning",
          category: "Performance",
          message: "Component prop receives a new function on every render.",
          help: "Move the function into setup/composables so child components can receive a stable reference.",
          column: prop.loc.start.column,
        }),
      );
    }
  }
};

const inspectElement = (
  node: ElementNode,
  lineOffset: number,
  labelTargetIds: ReadonlySet<string>,
  isInsideLabel: boolean,
  report: ScanContext["report"],
): void => {
  const localLine = node.loc.start.line;

  if (hasDirective(node, "html")) {
    report(
      makeDiagnostic("no-v-html", lineOffset, localLine, {
        severity: "error",
        category: "Security",
        message: "v-html renders raw HTML and can expose users to XSS.",
        help: "Prefer normal bindings. If HTML is unavoidable, sanitize it before it reaches the component.",
        column: node.loc.start.column,
      }),
    );
  }

  const vFor = getDirective(node, "for");
  if (vFor && !hasKey(node)) {
    report(
      makeDiagnostic("require-v-for-key", lineOffset, localLine, {
        severity: "error",
        category: "Correctness",
        message: "v-for nodes need a stable :key.",
        help: "Use an id from the item instead of relying on DOM reuse.",
        column: node.loc.start.column,
      }),
    );
  }

  if (vFor && hasDirective(node, "if")) {
    report(
      makeDiagnostic("no-v-if-with-v-for", lineOffset, localLine, {
        severity: "warning",
        category: "Correctness",
        message: "v-if and v-for on the same node are hard to reason about.",
        help: "Filter the collection in a computed value or move v-if to a child wrapper.",
        column: node.loc.start.column,
      }),
    );
  }

  if (vFor) {
    const keyExpression = getKeyExpression(node);
    const indexAlias = vFor.exp ? parseIndexAlias(vFor.exp.loc.source) : null;
    if (keyExpression) {
      const normalizedKey = normalizeExpression(keyExpression);
      if (normalizedKey === "index" || normalizedKey === "$index" || normalizedKey === indexAlias) {
        report(
          makeDiagnostic("no-index-key", lineOffset, localLine, {
            severity: "warning",
            category: "Correctness",
            message: "Using the loop index as key causes state bugs when rows are inserted, removed, or sorted.",
            help: "Use a stable id from the item, such as :key=\"item.id\".",
            column: node.loc.start.column,
          }),
        );
      }
    }
  }

  if (node.tag === "a") {
    const target = getAttributeValue(node, "target") ?? getBoundExpression(node, "target");
    const normalizedTarget = target ? normalizeExpression(target) : null;
    const rel = getAttributeValue(node, "rel") ?? getBoundExpression(node, "rel") ?? "";
    const normalizedRel = normalizeExpression(rel);
    if (normalizedTarget === "_blank" && !/\bnoopener\b/.test(normalizedRel)) {
      report(
        makeDiagnostic("no-target-blank-without-rel", lineOffset, localLine, {
          severity: "error",
          category: "Security",
          message: "target=\"_blank\" without rel=\"noopener\" lets the opened page control window.opener.",
          help: "Add rel=\"noopener noreferrer\" to external links opened in a new tab.",
          column: node.loc.start.column,
        }),
      );
    }
  }

  if (node.tag === "img" && !getAttribute(node, "alt") && !getDirective(node, "bind", "alt")) {
    report(
      makeDiagnostic("require-img-alt", lineOffset, localLine, {
        severity: "warning",
        category: "Accessibility",
        message: "Images need alt text for screen readers.",
        help: "Use alt=\"\" for decorative images, or provide a meaningful alt value.",
        column: node.loc.start.column,
      }),
    );
  }

  if (node.tag === "button" && !hasAccessibleName(node)) {
    report(
      makeDiagnostic("require-button-name", lineOffset, localLine, {
        severity: "warning",
        category: "Accessibility",
        message: "Button has no accessible name.",
        help: "Add text content, aria-label, or a title for icon-only buttons.",
        column: node.loc.start.column,
      }),
    );
  }

  if (getAttribute(node, "autofocus") || getDirective(node, "bind", "autofocus")) {
    report(
      makeDiagnostic("no-autofocus", lineOffset, localLine, {
        severity: "warning",
        category: "Accessibility",
        message: "autofocus can steal focus and disorient keyboard or screen-reader users.",
        help: "Move focus intentionally after user action, or use route-level focus management.",
        column: node.loc.start.column,
      }),
    );
  }

  if (FORM_CONTROL_TAGS.has(node.tag)) {
    const inputType = normalizeExpression(getAttributeValue(node, "type") ?? "");
    if (inputType !== "hidden" && !hasFormControlName(node, labelTargetIds, isInsideLabel)) {
      report(
        makeDiagnostic("require-form-control-label", lineOffset, localLine, {
          severity: "warning",
          category: "Accessibility",
          message: "Form control has no accessible label.",
          help: "Wrap it in a label, add a label[for] target, or provide aria-label/aria-labelledby.",
          column: node.loc.start.column,
        }),
      );
    }
  }

  if (
    hasDirective(node, "on", "click") &&
    !isComponentNode(node) &&
    !isNativeInteractive(node) &&
    !hasKeyboardHandler(node) &&
    !hasInteractiveRoleOrTabIndex(node)
  ) {
    report(
      makeDiagnostic("no-click-without-keyboard", lineOffset, localLine, {
        severity: "warning",
        category: "Accessibility",
        message: "Clickable non-interactive element has no keyboard path.",
        help: "Use a button/link, or add role, tabindex, and Enter/Space keyboard handlers.",
        column: node.loc.start.column,
      }),
    );
  }

  inspectInlineComponentProps(node, lineOffset, report);

  if (node.tag === "meta") {
    const name = normalizeExpression(getAttributeValue(node, "name") ?? "");
    const content = getAttributeValue(node, "content") ?? "";
    if (
      name === "viewport" &&
      /\b(?:user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0+)?)\b/i.test(content)
    ) {
      report(
        makeDiagnostic("no-disabled-zoom", lineOffset, localLine, {
          severity: "warning",
          category: "Accessibility",
          message: "Viewport settings disable or cap user zoom.",
          help: "Let users pinch zoom; avoid user-scalable=no and maximum-scale=1.",
          column: node.loc.start.column,
        }),
      );
    }
  }

  for (const prop of node.props) {
    if (isDirective(prop) && shouldCheckDirectiveExpressionPurity(prop)) {
      visitExpression(prop.exp?.loc.source, lineOffset, prop.loc.start.line, report);
    }
  }
};

type TraversableTemplateNode = RootNode | TemplateChildNode | { type: number; children?: unknown };

const collectLabelTargetIds = (node: TraversableTemplateNode, targets = new Set<string>()): Set<string> => {
  if (node.type === NodeTypes.ELEMENT) {
    const element = node as ElementNode;
    if (element.tag === "label") {
      const target = normalizeStaticId(getAttributeValue(element, "for"));
      if (target) targets.add(target);
    }
  }

  const children = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (typeof child === "object" && child !== null && "type" in child) {
      collectLabelTargetIds(child as TraversableTemplateNode, targets);
    }
  }

  return targets;
};

const visitNode = (
  node: TraversableTemplateNode,
  lineOffset: number,
  labelTargetIds: ReadonlySet<string>,
  isInsideLabel: boolean,
  report: ScanContext["report"],
): void => {
  const childIsInsideLabel =
    isInsideLabel || (node.type === NodeTypes.ELEMENT && (node as ElementNode).tag === "label");

  if (node.type === NodeTypes.ELEMENT) {
    inspectElement(node as ElementNode, lineOffset, labelTargetIds, isInsideLabel, report);
  }

  if (node.type === NodeTypes.INTERPOLATION) {
    const interpolation = node as Extract<TemplateChildNode, { type: typeof NodeTypes.INTERPOLATION }>;
    visitExpression(interpolation.content.loc.source, lineOffset, interpolation.loc.start.line, report);
  }

  const children = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (typeof child === "object" && child !== null && "type" in child) {
      visitNode(child as TraversableTemplateNode, lineOffset, labelTargetIds, childIsInsideLabel, report);
    }
  }
};

export const scanTemplate = (
  templateContent: string,
  lineOffset: number,
  context: ScanContext,
): void => {
  let ast: RootNode;
  try {
    ast = baseParse(templateContent, {
      isVoidTag: (tag) => VOID_TAGS.has(tag),
      onError: (error) => {
        context.report({
          rule: "parse-template",
          severity: "error",
          category: "Correctness",
          message: error.message,
          help: "Fix the Vue template parse error before relying on diagnostics for this file.",
          line: lineOffset + (error.loc?.start.line ?? 1) - 1,
          column: error.loc?.start.column ?? 1,
        });
      },
    });
  } catch (error) {
    context.report({
      rule: "parse-template",
      severity: "error",
      category: "Correctness",
      message: error instanceof Error ? error.message : "Unable to parse Vue template.",
      help: "Fix the Vue template parse error before relying on diagnostics for this file.",
      line: lineOffset,
      column: 1,
    });
    return;
  }

  visitNode(ast, lineOffset, collectLabelTargetIds(ast), false, context.report);
};
