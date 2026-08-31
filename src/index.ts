import type { VueDoctorConfig } from "./types.js";

export { diagnose, summarizeDiagnostics, toJsonReport, toJsonReportFromScans } from "./scanner.js";
export { toMarkdownReport, toSarifReport } from "./reporters.js";
export { rules } from "./rules/index.js";

export const defineConfig = (config: VueDoctorConfig): VueDoctorConfig => config;

export type {
  Diagnostic,
  ChangedLineRanges,
  DiffInfo,
  DiagnoseOptions,
  DiagnoseResult,
  FailOnLevel,
  JsonReport,
  JsonReportMode,
  ProjectInfo,
  RuleDefinition,
  RuleLevel,
  ScanScope,
  ScoreResult,
  Severity,
  VueDoctorConfig,
  VueDoctorDeadCodeConfig,
  VueDoctorPreset,
  VueDoctorSupplyChainConfig,
} from "./types.js";
