import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "../types.js";

interface BaselineLike {
  diagnostics?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asDiagnostics = (value: unknown): Diagnostic[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Diagnostic =>
    isObject(entry) &&
    typeof entry.relativePath === "string" &&
    typeof entry.rule === "string" &&
    typeof entry.message === "string" &&
    typeof entry.line === "number" &&
    typeof entry.column === "number",
  );
};

export const createDiagnosticKey = (diagnostic: Diagnostic): string =>
  [
    diagnostic.relativePath.replaceAll("\\", "/"),
    diagnostic.rule,
    diagnostic.line,
    diagnostic.column,
    diagnostic.message,
  ].join("\0");

export const readBaselineKeys = (baselinePath: string): Set<string> => {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline file "${baselinePath}" does not exist. Run with --update-baseline first.`);
  }

  const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as BaselineLike;
  return new Set(asDiagnostics(parsed.diagnostics).map(createDiagnosticKey));
};

export const filterDiagnosticsByBaseline = (
  diagnostics: Diagnostic[],
  baselineKeys: Set<string>,
): Diagnostic[] => diagnostics.filter((diagnostic) => !baselineKeys.has(createDiagnosticKey(diagnostic)));

export const writeBaseline = (
  baselinePath: string,
  diagnostics: Diagnostic[],
): void => {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        diagnostics: diagnostics.map((diagnostic) => ({
          relativePath: diagnostic.relativePath,
          rule: diagnostic.rule,
          message: diagnostic.message,
          line: diagnostic.line,
          column: diagnostic.column,
        })),
      },
      null,
      2,
    )}\n`,
  );
};
