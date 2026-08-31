import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Diagnostic, JsonReport } from "../types.js";

const safeName = (value: string): string =>
  value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "diagnostics";

const groupByRule = (diagnostics: Diagnostic[]): Map<string, Diagnostic[]> => {
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const list = grouped.get(diagnostic.rule) ?? [];
    list.push(diagnostic);
    grouped.set(diagnostic.rule, list);
  }
  return grouped;
};

const renderRuleDiagnostics = (rule: string, diagnostics: Diagnostic[]): string => {
  const lines = [`# vue-doctor/${rule}`, ""];
  for (const diagnostic of diagnostics) {
    lines.push(
      `- ${diagnostic.severity.toUpperCase()} ${diagnostic.relativePath}:${diagnostic.line}:${diagnostic.column}`,
      `  - ${diagnostic.message}`,
      `  - ${diagnostic.help}`,
      "",
    );
  }
  return lines.join("\n");
};

export const writeDiagnosticsDirectory = (report: JsonReport): string => {
  const outputDirectory = path.join(tmpdir(), `vue-doctor-diagnostics-${randomUUID()}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "diagnostics.json"), `${JSON.stringify(report, null, 2)}\n`);

  const summary = [
    "# Vue Doctor Diagnostics",
    "",
    `Score: ${report.summary.score} / 100 (${report.summary.scoreLabel})`,
    `Diagnostics: ${report.summary.totalDiagnosticCount}`,
    `Errors: ${report.summary.errorCount}`,
    `Warnings: ${report.summary.warningCount}`,
    `Affected files: ${report.summary.affectedFileCount}`,
    "",
  ];
  fs.writeFileSync(path.join(outputDirectory, "summary.md"), summary.join("\n"));

  const rulesDirectory = path.join(outputDirectory, "rules");
  fs.mkdirSync(rulesDirectory, { recursive: true });
  for (const [rule, diagnostics] of groupByRule(report.diagnostics)) {
    fs.writeFileSync(
      path.join(rulesDirectory, `${safeName(rule)}.md`),
      renderRuleDiagnostics(rule, diagnostics),
    );
  }

  return outputDirectory;
};
