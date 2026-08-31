import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { SOURCE_EXTENSIONS } from "../constants.js";
import type { ChangedLineRanges, DiffInfo } from "../types.js";

const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "develop", "dev"];

const runGit = (cwd: string, args: string[]): string | null => {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.toString().trim();
};

const runGitNullSeparated = (cwd: string, args: string[]): string[] | null => {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout
    .toString()
    .split("\0")
    .filter((entry) => entry.length > 0);
};

const getCurrentBranch = (directory: string): string | null => {
  const branch = runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return null;
  return branch;
};

const getRepoPrefix = (directory: string): string =>
  runGit(directory, ["rev-parse", "--show-prefix"]) ?? "";

const detectDefaultBranch = (directory: string): string | null => {
  const remoteHead = runGit(directory, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead.replace("refs/remotes/origin/", "");

  const refs = DEFAULT_BRANCH_CANDIDATES.flatMap((candidate) => [
    `refs/heads/${candidate}`,
    `refs/remotes/origin/${candidate}`,
  ]);
  const output = runGit(directory, ["for-each-ref", "--format=%(refname:short)", ...refs]);
  return output?.split("\n")[0]?.trim() || null;
};

const refExists = (directory: string, reference: string): boolean => {
  const result = spawnSync("git", ["rev-parse", "--verify", reference], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status === 0;
};

export const getMergeBase = (directory: string, baseRef: string): string | null =>
  runGit(directory, ["merge-base", baseRef, "HEAD"]);

const getChangedFilesSinceRef = (directory: string, baseRef: string): { baseRef: string; changedFiles: string[] } | null => {
  const mergeBase = runGit(directory, ["merge-base", baseRef, "HEAD"]);
  if (!mergeBase) return null;
  const changedFiles = runGitNullSeparated(directory, [
    "diff",
    "-z",
    "--name-only",
    "--diff-filter=ACMR",
    "--relative",
    mergeBase,
  ]);
  return changedFiles ? { baseRef: mergeBase, changedFiles } : null;
};

const getUncommittedChangedFiles = (directory: string): string[] =>
  runGitNullSeparated(directory, [
    "diff",
    "-z",
    "--name-only",
    "--diff-filter=ACMR",
    "--relative",
    "HEAD",
  ]) ?? [];

export const getStagedSourceFiles = (directory: string): string[] =>
  filterSourceFiles(
    runGitNullSeparated(directory, [
      "diff",
      "--cached",
      "-z",
      "--name-only",
      "--diff-filter=ACMR",
      "--relative",
    ]) ?? [],
  );

export const getDiffInfo = (directory: string, explicitBaseRef?: string): DiffInfo | null => {
  if (explicitBaseRef !== undefined && explicitBaseRef.trim().length === 0) {
    throw new Error("Diff base cannot be empty.");
  }

  const currentBranch = getCurrentBranch(directory);
  const baseBranch = explicitBaseRef ?? detectDefaultBranch(directory);
  if (!baseBranch) return null;

  if (explicitBaseRef && !refExists(directory, explicitBaseRef)) {
    throw new Error(`Diff base "${explicitBaseRef}" does not exist. Run git fetch before scanning.`);
  }

  if (!currentBranch) {
    const selection = getChangedFilesSinceRef(directory, baseBranch);
    if (!selection) return null;
    return {
      currentBranch: "HEAD",
      baseBranch,
      baseRef: selection.baseRef,
      changedFiles: selection.changedFiles,
    };
  }

  if (currentBranch === baseBranch || currentBranch === baseBranch.replace(/^origin\//, "")) {
    const changedFiles = getUncommittedChangedFiles(directory);
    if (changedFiles.length === 0) return null;
    return { currentBranch, baseBranch, baseRef: "HEAD", changedFiles, isCurrentChanges: true };
  }

  const selection = getChangedFilesSinceRef(directory, baseBranch);
  if (!selection) return null;
  return { currentBranch, baseBranch, baseRef: selection.baseRef, changedFiles: selection.changedFiles };
};

export const filterSourceFiles = (filePaths: string[]): string[] =>
  filePaths.filter((filePath) => SOURCE_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf("."))));

const changedFileFromObject = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["filename", "path", "file", "relativePath"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
};

const parseChangedFiles = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => (typeof entry === "string" ? entry.trim() : changedFileFromObject(entry)))
        .filter((entry): entry is string => Boolean(entry));
    }
  }

  return raw
    .split(/\0|\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export const readChangedFilesFromFile = (filePath: string): string[] => {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseChangedFiles(raw);
};

const normalizeGitPath = (filePath: string): string =>
  filePath.replaceAll("\\", "/").replace(/^\.\//, "");

const addRange = (
  rangesByFile: Map<string, Array<readonly [number, number]>>,
  filePath: string,
  start: number,
  count: number,
): void => {
  if (count <= 0) return;
  const ranges = rangesByFile.get(filePath) ?? [];
  ranges.push([start, start + count - 1]);
  rangesByFile.set(filePath, ranges);
};

const parseChangedLineRanges = (rawDiff: string): ChangedLineRanges[] => {
  const rangesByFile = new Map<string, Array<readonly [number, number]>>();
  let currentFile: string | null = null;

  for (const line of rawDiff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentFile = target === "/dev/null" ? null : normalizeGitPath(target.replace(/^b\//, ""));
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !currentFile) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (Number.isInteger(start) && Number.isInteger(count)) {
      addRange(rangesByFile, currentFile, start, count);
    }
  }

  return [...rangesByFile.entries()].map(([file, ranges]) => ({ file, ranges }));
};

export const getChangedLineRanges = (
  directory: string,
  input: { baseRef?: string | undefined; cached?: boolean | undefined; files?: string[] | undefined } = {},
): ChangedLineRanges[] | null => {
  const args = ["diff", "--unified=0", "--diff-filter=ACMR", "--relative"];
  if (input.cached) {
    args.push("--cached");
  } else if (input.baseRef) {
    args.push(input.baseRef);
  }
  args.push("--");
  if (input.files && input.files.length > 0) args.push(...input.files);

  const result = spawnSync("git", args, {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) return null;
  return parseChangedLineRanges(result.stdout.toString());
};

export const readGitFileAtRef = (
  directory: string,
  ref: string,
  relativePath: string,
): string | null => {
  const repoPath = normalizeGitPath(`${getRepoPrefix(directory)}${normalizeGitPath(relativePath)}`);
  const result = spawnSync("git", ["show", `${ref}:${repoPath}`], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.toString();
};
