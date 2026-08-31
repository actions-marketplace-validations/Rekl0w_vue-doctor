const fs = require("node:fs");

const REVIEW_MARKER = "<!-- vue-doctor:review -->";

const readReport = (reportPath) => {
  if (!reportPath || !fs.existsSync(reportPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
};

const getDirectoryPrefix = (directory) =>
  String(directory || ".").replace(/^\.\/?/, "").replace(/\/$/, "");

const getCommentableLinesByFile = (files) => {
  const commentableLinesByFile = new Map();
  for (const file of files || []) {
    if (!file.patch) continue;
    const lines = new Set();
    let newLine = 0;
    for (const patchLine of String(file.patch).split("\n")) {
      const hunk = patchLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (patchLine.startsWith("+") || patchLine.startsWith(" ")) {
        lines.add(newLine);
        newLine += 1;
      }
    }
    commentableLinesByFile.set(file.filename, lines);
  }
  return commentableLinesByFile;
};

const toRepoPath = (filePath, directoryPrefix, commentableLinesByFile) => {
  const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (commentableLinesByFile.has(normalized)) return normalized;
  const prefixed = directoryPrefix ? `${directoryPrefix}/${normalized}` : normalized;
  if (commentableLinesByFile.has(prefixed)) return prefixed;
  const suffixMatches = [...commentableLinesByFile.keys()].filter((name) => name.endsWith(`/${normalized}`));
  return suffixMatches.length === 1 ? suffixMatches[0] : null;
};

const buildReviewComments = (report, files, inputDirectory = ".") => {
  if (!report || report.ok === false) return [];
  const diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  const directoryPrefix = getDirectoryPrefix(inputDirectory);
  const commentableLinesByFile = getCommentableLinesByFile(files);
  const seen = new Set();
  const comments = [];

  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic.line !== "number" || diagnostic.line <= 0) continue;
    const repoPath = toRepoPath(diagnostic.relativePath || diagnostic.filePath, directoryPrefix, commentableLinesByFile);
    if (!repoPath) continue;
    const commentableLines = commentableLinesByFile.get(repoPath);
    if (!commentableLines || !commentableLines.has(diagnostic.line)) continue;
    const ruleKey = `${diagnostic.plugin || "vue-doctor"}/${diagnostic.rule || "unknown-rule"}`;
    const dedupeKey = `${repoPath}:${diagnostic.line}:${ruleKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const severity = diagnostic.severity === "error" ? "error" : "warning";
    const fixLine = diagnostic.help ? `\n\n**Fix** -> ${diagnostic.help}` : "";
    comments.push({
      path: repoPath,
      line: diagnostic.line,
      side: "RIGHT",
      body: `${REVIEW_MARKER}\n**Vue Doctor** - \`${ruleKey}\` _(${severity})_\n\n${diagnostic.message || ""}${fixLine}`,
    });
  }

  return comments;
};

const isVueDoctorReviewComment = (comment) =>
  Boolean(comment && typeof comment.body === "string" && comment.body.startsWith(REVIEW_MARKER));

const getPriorReviewCommentIds = (comments) =>
  (comments || []).filter(isVueDoctorReviewComment).map((comment) => comment.id).filter((id) => id !== undefined);

const buildCommitStatus = ({ report, scanStatus, eventName, runUrl }) => {
  const summary = report?.summary || {};
  const score = summary.score;
  const errors = Number(summary.errorCount || 0);
  const warnings = Number(summary.warningCount || 0);
  const scanFailed = String(scanStatus) !== "0";
  const description = score !== undefined && score !== null
    ? `Score: ${score}/100 - ${errors} errors - ${warnings} warnings`
    : scanFailed
      ? "Scan could not complete"
      : `${errors} errors - ${warnings} warnings`;
  return {
    state: eventName === "pull_request" && scanFailed ? "failure" : "success",
    description: description.slice(0, 140),
    target_url: runUrl,
  };
};

module.exports = {
  REVIEW_MARKER,
  buildCommitStatus,
  buildReviewComments,
  getPriorReviewCommentIds,
  readReport,
};
