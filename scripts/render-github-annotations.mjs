import fs from "node:fs";

const [reportPath] = process.argv.slice(2);
if (!reportPath || !fs.existsSync(reportPath)) process.exit(0);

const encode = (value) =>
  String(value ?? "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(",", "%2C");

const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
for (const diagnostic of report.diagnostics ?? []) {
  const level = diagnostic.severity === "error" ? "error" : "warning";
  const file = encode(diagnostic.relativePath ?? diagnostic.filePath ?? "unknown");
  const line = Number.isInteger(diagnostic.line) ? diagnostic.line : 1;
  const column = Number.isInteger(diagnostic.column) ? diagnostic.column : 1;
  const title = encode(`${diagnostic.plugin ?? "vue-doctor"}/${diagnostic.rule ?? "unknown-rule"}`);
  const message = encode(diagnostic.message ?? "");
  console.log(`::${level} file=${file},line=${line},col=${column},title=${title}::${message}`);
}
