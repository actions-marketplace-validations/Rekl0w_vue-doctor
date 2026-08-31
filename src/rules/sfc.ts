import type { SFCDescriptor } from "@vue/compiler-sfc";
import { DEFAULT_MAX_COMPONENT_LINES } from "../constants.js";
import type { ScanContext } from "../types.js";
import { findLineMatches } from "../utils/location.js";

const reportStylePattern = (
  context: ScanContext,
  content: string,
  lineOffset: number,
  pattern: RegExp,
  rule: string,
  message: string,
  help: string,
  category: "Performance" | "Design" = "Design",
): void => {
  for (const match of findLineMatches(content, pattern, lineOffset)) {
    context.report({
      rule,
      severity: "warning",
      category,
      message,
      help,
      line: match.line,
      column: match.column,
    });
  }
};

const scanReadableFontSizes = (context: ScanContext, content: string, lineOffset: number): void => {
  const fontSizePattern = /font-size\s*:\s*([0-9]*\.?[0-9]+)(px|rem)\b/gi;
  for (const match of findLineMatches(content, fontSizePattern, lineOffset)) {
    const value = Number(match.match[1]);
    const unit = match.match[2];
    if (!Number.isFinite(value)) continue;
    const isTiny = unit === "px" ? value < 12 : value < 0.75;
    if (!isTiny) continue;
    context.report({
      rule: "no-tiny-text",
      severity: "warning",
      category: "Design",
      message: `Text size ${value}${unit} is difficult to read.`,
      help: "Keep body and control text at readable sizes, usually 12px/0.75rem or larger.",
      line: match.line,
      column: match.column,
    });
  }
};

const scanStyleQuality = (context: ScanContext, content: string, lineOffset: number): void => {
  reportStylePattern(
    context,
    content,
    lineOffset,
    /transition(?:-property)?\s*:\s*all\b/gi,
    "no-transition-all",
    "transition: all can animate layout and paint-heavy properties.",
    "List the exact properties that should animate, such as opacity or transform.",
    "Performance",
  );
  reportStylePattern(
    context,
    content,
    lineOffset,
    /will-change\s*:\s*(?!auto\b|contents\b|scroll-position\b)[^;]+/gi,
    "no-permanent-will-change",
    "Persistent will-change keeps browser layers promoted.",
    "Apply will-change briefly during the interaction, then remove it.",
    "Performance",
  );
  reportStylePattern(
    context,
    content,
    lineOffset,
    /outline\s*:\s*(?:0|none)\b/gi,
    "no-outline-none",
    "Focus outline is removed.",
    "Keep the browser outline or replace it with a visible :focus-visible style.",
  );
  reportStylePattern(
    context,
    content,
    lineOffset,
    /letter-spacing\s*:\s*(-[0-9.]+|[0-9.]+(?:em|rem|px))/gi,
    "no-wide-letter-spacing",
    "Letter spacing is customized and may hurt readability.",
    "Use normal letter spacing unless the design system explicitly defines this text treatment.",
  );
  reportStylePattern(
    context,
    content,
    lineOffset,
    /z-index\s*:\s*(?:9999|\d{5,})\b/gi,
    "no-z-index-9999",
    "Magic z-index value makes layering hard to maintain.",
    "Use a small tokenized z-index scale shared by overlays, drawers, and modals.",
  );
  reportStylePattern(
    context,
    content,
    lineOffset,
    /background(?:-color)?\s*:\s*(?:#000(?:000)?\b|black\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/gi,
    "no-pure-black-background",
    "Pure black background can create harsh contrast and visual fatigue.",
    "Use a near-black surface token when a dark background is needed.",
  );
  if (/(?:linear-gradient|radial-gradient|conic-gradient)\s*\(/i.test(content)) {
    reportStylePattern(
      context,
      content,
      lineOffset,
      /(?:background-clip|-webkit-background-clip)\s*:\s*text/gi,
      "no-gradient-text",
      "Gradient text is hard to keep readable and consistent.",
      "Use solid text colors unless a brand-approved treatment requires gradient text.",
    );
  }
  scanReadableFontSizes(context, content, lineOffset);
};

export const scanSfcStructure = (descriptor: SFCDescriptor, context: ScanContext): void => {
  const maxLines = context.config.maxComponentLines ?? DEFAULT_MAX_COMPONENT_LINES;
  const totalLines = context.source.split(/\r?\n/).length;
  if (totalLines > maxLines) {
    context.report({
      rule: "no-large-component",
      severity: "warning",
      category: "Architecture",
      message: `This component is ${totalLines} lines long.`,
      help: `Keep SFCs below ${maxLines} lines by extracting child components or composables.`,
      line: 1,
      column: 1,
    });
  }

  for (const style of descriptor.styles) {
    scanStyleQuality(context, style.content, style.loc.start.line);

    if (style.scoped || style.module) continue;
    const content = style.content.trim();
    if (content.length === 0) continue;
    const isClearlyGlobal = /^(?::root|html|body|@font-face|@layer|@tailwind)\b/.test(content);
    if (isClearlyGlobal) continue;

    context.report({
      rule: "prefer-scoped-style",
      severity: "warning",
      category: "Maintainability",
      message: "SFC style block is global.",
      help: "Add scoped/module, or move intentional global CSS to a dedicated global stylesheet.",
      line: style.loc.start.line,
      column: style.loc.start.column,
    });
  }
};
