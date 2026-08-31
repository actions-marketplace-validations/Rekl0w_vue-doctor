import fs from "node:fs";

const marker = "<!-- vue-doctor:summary -->";
const [reportPath, outputPath] = process.argv.slice(2);

const escapeMarkdown = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const tableText = (value) => escapeMarkdown(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

const inlineCode = (value) => {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  const longestTickRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestTickRun + 1);
  return `${fence}${text}${fence}`;
};

const setOutput = (name, value) => {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

if (!reportPath || !fs.existsSync(reportPath)) {
  if (outputPath) fs.writeFileSync(outputPath, "");
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
const summary = report.summary ?? {};
const diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
const baseline = report.baseline && typeof report.baseline === "object" ? report.baseline : null;

setOutput("score", summary.score ?? "");
setOutput("total-issues", summary.totalDiagnosticCount ?? diagnostics.length);
setOutput("fixed-issues", baseline?.fixedCount ?? 0);
setOutput("error-count", summary.errorCount ?? 0);
setOutput("warning-count", summary.warningCount ?? 0);
setOutput("affected-files", summary.affectedFileCount ?? 0);

const status = diagnostics.length === 0 ? "No diagnostics" : "Diagnostics found";
const sourceFileCount = report.project?.sourceFileCount ?? "?";
const lines = [
  marker,
  "## Vue Doctor",
  "",
  `**Score:** ${inlineCode(`${summary.score ?? "?"}`)} / 100${summary.scoreLabel ? ` (${escapeMarkdown(summary.scoreLabel)})` : ""}`,
  "",
  "| Status | Files | Diagnostics | Errors | Warnings |",
  "| --- | ---: | ---: | ---: | ---: |",
  `| ${tableText(status)} | ${summary.affectedFileCount ?? 0} / ${sourceFileCount} | ${summary.totalDiagnosticCount ?? diagnostics.length} | ${summary.errorCount ?? 0} | ${summary.warningCount ?? 0} |`,
  "",
];

if (baseline) {
  lines.push(
    `Compared with ${inlineCode(baseline.baseRef ?? "base")}: ${inlineCode(baseline.newCount ?? diagnostics.length)} new, ${inlineCode(baseline.fixedCount ?? 0)} fixed, ${inlineCode(baseline.baseTotalCount ?? 0)} at base.`,
    "",
  );
}

if (diagnostics.length === 0) {
  lines.push("No Vue Doctor diagnostics found.");
} else {
  const groups = new Map();
  for (const diagnostic of diagnostics.slice(0, 100)) {
    const category = diagnostic.category ?? "Other";
    const items = groups.get(category) ?? [];
    items.push(diagnostic);
    groups.set(category, items);
  }

  if (diagnostics.length > 100) {
    lines.push(`Showing 100 of ${diagnostics.length} diagnostics. Use the workflow logs or JSON report for the full output.`, "");
  }

  let index = 0;
  for (const [category, items] of groups) {
    lines.push(`<details${index === 0 ? " open" : ""}>`);
    lines.push(`<summary>${escapeMarkdown(category)} (${items.length})</summary>`, "");
    for (const diagnostic of items) {
      const location = `${diagnostic.relativePath ?? diagnostic.filePath ?? "unknown"}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1}`;
      const ruleName = `${diagnostic.plugin ?? "vue-doctor"}/${diagnostic.rule ?? "unknown-rule"}`;
      lines.push(
        `- **${escapeMarkdown(diagnostic.severity ?? "warning")}** ${inlineCode(ruleName)} at ${inlineCode(location)}`,
        `  ${escapeMarkdown(diagnostic.message ?? "")}`,
      );
      if (diagnostic.help) lines.push(`  ${escapeMarkdown(diagnostic.help)}`);
    }
    lines.push("", "</details>", "");
    index += 1;
  }
}

if (outputPath) fs.writeFileSync(outputPath, `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`);
