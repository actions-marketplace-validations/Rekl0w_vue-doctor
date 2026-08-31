import { SCORE_GOOD_THRESHOLD, SCORE_OK_THRESHOLD } from "../constants.js";
import type { Diagnostic, DiagnosticCategory, ScoreResult, Severity } from "../types.js";

interface ScoreOptions {
  totalSourceFiles?: number;
}

const CATEGORY_CAPS: Record<DiagnosticCategory, number> = {
  Security: 20,
  Correctness: 20,
  Performance: 10,
  Accessibility: 6,
  Architecture: 12,
  Maintainability: 3,
  "Bundle Size": 8,
  Design: 5,
};

const SEVERITY_BASE_PENALTY: Record<Severity, number> = {
  error: 4,
  warning: 1.5,
};

const SEVERITY_GROWTH_PENALTY: Record<Severity, number> = {
  error: 1.4,
  warning: 0.65,
};

const SEVERITY_RULE_CAP: Record<Severity, number> = {
  error: 9,
  warning: 4.5,
};

const groupDiagnosticsByCategoryAndRule = (
  diagnostics: Diagnostic[],
): Map<DiagnosticCategory, Map<string, Diagnostic[]>> => {
  const categoryGroups = new Map<DiagnosticCategory, Map<string, Diagnostic[]>>();

  for (const diagnostic of diagnostics) {
    const ruleGroups = categoryGroups.get(diagnostic.category) ?? new Map<string, Diagnostic[]>();
    const ruleDiagnostics = ruleGroups.get(diagnostic.rule) ?? [];
    ruleDiagnostics.push(diagnostic);
    ruleGroups.set(diagnostic.rule, ruleDiagnostics);
    categoryGroups.set(diagnostic.category, ruleGroups);
  }

  return categoryGroups;
};

const getWorstSeverity = (diagnostics: Diagnostic[]): Severity =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "warning";

const calculateRulePenalty = (diagnostics: Diagnostic[]): number => {
  const severity = getWorstSeverity(diagnostics);
  const countGrowth = Math.log2(diagnostics.length + 1);
  return Math.min(
    SEVERITY_RULE_CAP[severity],
    SEVERITY_BASE_PENALTY[severity] + SEVERITY_GROWTH_PENALTY[severity] * countGrowth,
  );
};

const calculateAffectedFilePenalty = (
  diagnostics: Diagnostic[],
  totalSourceFiles: number | undefined,
): number => {
  const affectedFileCount = new Set(diagnostics.map((diagnostic) => diagnostic.filePath)).size;
  if (affectedFileCount === 0) return 0;
  if (totalSourceFiles && totalSourceFiles > 0) {
    return Math.min(7, (affectedFileCount / totalSourceFiles) * 7);
  }
  return Math.min(7, Math.log2(affectedFileCount + 1));
};

export const calculateScore = (
  diagnostics: Diagnostic[],
  options: ScoreOptions = {},
): ScoreResult => {
  const categoryGroups = groupDiagnosticsByCategoryAndRule(diagnostics);
  let categoryPenalty = 0;

  for (const [category, ruleGroups] of categoryGroups) {
    const uncappedPenalty = [...ruleGroups.values()].reduce(
      (total, ruleDiagnostics) => total + calculateRulePenalty(ruleDiagnostics),
      0,
    );
    categoryPenalty += Math.min(CATEGORY_CAPS[category], uncappedPenalty);
  }

  const affectedFilePenalty = calculateAffectedFilePenalty(diagnostics, options.totalSourceFiles);
  const totalPenalty = Math.round(categoryPenalty + affectedFilePenalty);
  const rawScore = Math.max(0, 100 - totalPenalty);
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const hasSecurityError = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error" && diagnostic.category === "Security",
  );
  const score = hasSecurityError ? Math.min(rawScore, 70) : hasError ? Math.min(rawScore, 74) : rawScore;

  if (score >= SCORE_GOOD_THRESHOLD) return { score, label: "Great" };
  if (score >= SCORE_OK_THRESHOLD) return { score, label: "Needs work" };
  return { score, label: "Critical" };
};
