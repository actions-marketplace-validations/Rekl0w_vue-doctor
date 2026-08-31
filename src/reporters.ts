import { VERSION } from "./constants.js";
import { rules } from "./rules/index.js";
import type { Diagnostic, JsonReport } from "./types.js";

const escapeMarkdown = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const inlineCode = (value: string): string => {
  const longestTickRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestTickRun + 1);
  return `${fence}${value}${fence}`;
};

const groupDiagnosticsByCategory = (diagnostics: Diagnostic[]): Map<string, Diagnostic[]> => {
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const list = grouped.get(diagnostic.category) ?? [];
    list.push(diagnostic);
    grouped.set(diagnostic.category, list);
  }
  return grouped;
};

export const toMarkdownReport = (report: JsonReport): string => {
  const lines = [
    "# Vue Doctor Report",
    "",
    `**Score:** ${report.summary.score} / 100 (${report.summary.scoreLabel})`,
    "",
    "| Files | Diagnostics | Errors | Warnings |",
    "| ---: | ---: | ---: | ---: |",
    `| ${report.summary.affectedFileCount} / ${report.project.sourceFileCount} | ${report.summary.totalDiagnosticCount} | ${report.summary.errorCount} | ${report.summary.warningCount} |`,
    "",
  ];

  if (report.diagnostics.length === 0) {
    lines.push("No Vue Doctor diagnostics found.");
    return `${lines.join("\n")}\n`;
  }

  for (const [category, diagnostics] of groupDiagnosticsByCategory(report.diagnostics)) {
    lines.push(`## ${category}`, "");
    lines.push("| Severity | Rule | Location | Message |");
    lines.push("| --- | --- | --- | --- |");
    for (const diagnostic of diagnostics) {
      const location = `${diagnostic.relativePath}:${diagnostic.line}:${diagnostic.column}`;
      lines.push(
        `| ${diagnostic.severity} | ${inlineCode(`vue-doctor/${diagnostic.rule}`)} | ${inlineCode(location)} | ${escapeMarkdown(diagnostic.message)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

export const toSarifReport = (report: JsonReport): unknown => ({
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "Vue Doctor",
          informationUri: "https://github.com/Rekl0w/vue-doctor",
          semanticVersion: VERSION,
          rules: rules.map((rule) => ({
            id: `vue-doctor/${rule.name}`,
            name: rule.name,
            shortDescription: {
              text: rule.description,
            },
            properties: {
              category: rule.category,
              defaultSeverity: rule.defaultSeverity,
            },
          })),
        },
      },
      results: report.diagnostics.map((diagnostic) => ({
        ruleId: `vue-doctor/${diagnostic.rule}`,
        level: diagnostic.severity === "error" ? "error" : "warning",
        message: {
          text: diagnostic.message,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: diagnostic.relativePath.replaceAll("\\", "/"),
              },
              region: {
                startLine: diagnostic.line,
                startColumn: diagnostic.column,
              },
            },
          },
        ],
        properties: {
          category: diagnostic.category,
          help: diagnostic.help,
        },
      })),
    },
  ],
});
