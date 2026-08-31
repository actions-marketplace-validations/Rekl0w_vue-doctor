import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { VERSION } from "../constants.js";
import type { Diagnostic, JsonReport } from "../types.js";
import { writeDiagnosticsDirectory } from "./diagnostics-directory.js";
import { promptChoice, type Choice } from "./terminal.js";

export type HandoffMode = "prompt" | "copy" | "print" | "codex" | "claude" | "cursor" | "skip";

interface AgentCommand {
  mode: Extract<HandoffMode, "codex" | "claude" | "cursor">;
  label: string;
  binary: string;
  args: (prompt: string) => string[];
}

const AGENT_COMMANDS: AgentCommand[] = [
  {
    mode: "codex",
    label: "Codex",
    binary: "codex",
    args: (prompt) => ["--yolo", prompt],
  },
  {
    mode: "claude",
    label: "Claude Code",
    binary: "claude",
    args: (prompt) => ["--dangerously-skip-permissions", prompt],
  },
  {
    mode: "cursor",
    label: "Cursor Agent",
    binary: "cursor-agent",
    args: (prompt) => ["--force", prompt],
  },
];

const commandCandidates = (command: string): string[] => {
  if (process.platform !== "win32") return [command];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.toLowerCase())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
};

const isCommandAvailable = (command: string): boolean => {
  for (const candidate of commandCandidates(command)) {
    const result =
      process.platform === "win32"
        ? spawnSync("where", [candidate], { stdio: "ignore" })
        : spawnSync("sh", ["-c", `command -v ${JSON.stringify(candidate)} >/dev/null 2>&1`], {
            stdio: "ignore",
          });
    if (!result.error && result.status === 0) return true;
  }
  return false;
};

const availableAgents = (): AgentCommand[] =>
  AGENT_COMMANDS.filter((agent) => isCommandAvailable(agent.binary));

const groupByRule = (diagnostics: Diagnostic[]): Array<[string, Diagnostic[]]> => {
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const list = grouped.get(diagnostic.rule) ?? [];
    list.push(diagnostic);
    grouped.set(diagnostic.rule, list);
  }
  return [...grouped.entries()].sort(([, left], [, right]) => right.length - left.length);
};

const renderTopIssues = (diagnostics: Diagnostic[]): string => {
  const lines: string[] = [];
  for (const [rule, items] of groupByRule(diagnostics).slice(0, 8)) {
    const first = items[0]!;
    lines.push(
      `- vue-doctor/${rule} (${items.length}): ${first.relativePath}:${first.line}:${first.column}`,
      `  ${first.message}`,
    );
  }
  return lines.join("\n");
};

export const buildHandoffPrompt = (report: JsonReport, diagnosticsDirectory: string): string => `You are fixing Vue Doctor diagnostics in this repository.

Vue Doctor version: ${VERSION}
Score: ${report.summary.score} / 100 (${report.summary.scoreLabel})
Diagnostics: ${report.summary.totalDiagnosticCount}
Errors: ${report.summary.errorCount}
Warnings: ${report.summary.warningCount}

Top issue groups:
${renderTopIssues(report.diagnostics)}

Full diagnostic files are in:
${diagnosticsDirectory}

Use diagnostics.json as the source of truth. Fix root causes instead of suppressing rules. Keep changes scoped to the reported Vue issues. After editing, run:

npx @rekl0w/vue-doctor@latest --verbose --blocking none

Then summarize what changed in plain language.`;

export const copyToClipboard = (text: string): boolean => {
  const attempts =
    process.platform === "win32"
      ? [["clip", []] as const]
      : process.platform === "darwin"
        ? [["pbcopy", []] as const]
        : ([
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ] as const);

  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, {
      input: text,
      encoding: "utf-8",
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (!result.error && result.status === 0) return true;
  }
  return false;
};

const launchAgent = (mode: HandoffMode, prompt: string, cwd: string): boolean => {
  const agent = AGENT_COMMANDS.find((candidate) => candidate.mode === mode);
  if (!agent) return false;
  const result = spawnSync(agent.binary, agent.args(prompt), {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return !result.error && result.status === 0;
};

const promptForMode = async (): Promise<HandoffMode> => {
  const agents = availableAgents();
  const choices: Array<Choice<HandoffMode>> = [
    ...agents.map((agent) => ({ value: agent.mode, label: `Launch ${agent.label}` })),
    { value: "copy", label: "Copy prompt to clipboard" },
    { value: "print", label: "Print prompt" },
    { value: "skip", label: "Skip" },
  ];

  return promptChoice("Hand these Vue Doctor diagnostics to an agent?", choices, "skip");
};

export const runAgentHandoff = async (
  report: JsonReport,
  options: {
    cwd: string;
    mode?: HandoffMode | undefined;
  },
): Promise<void> => {
  if (report.diagnostics.length === 0) return;

  const mode = options.mode === "prompt" || !options.mode
    ? process.stdin.isTTY && process.stdout.isTTY
      ? await promptForMode()
      : "skip"
    : options.mode;
  if (mode === "skip") return;

  const diagnosticsDirectory = writeDiagnosticsDirectory(report);
  const prompt = buildHandoffPrompt(report, diagnosticsDirectory);

  if (mode === "copy") {
    const copied = copyToClipboard(prompt);
    console.log(copied ? pc.green("Vue Doctor handoff prompt copied to clipboard.") : pc.yellow("Could not copy to clipboard. Printing prompt instead."));
    if (!copied) console.log(prompt);
    console.log(pc.dim(`Full diagnostics written to ${diagnosticsDirectory}`));
    return;
  }

  if (mode === "print") {
    console.log("");
    console.log(prompt);
    console.log(pc.dim(`Full diagnostics written to ${diagnosticsDirectory}`));
    return;
  }

  const launched = launchAgent(mode, prompt, options.cwd);
  if (!launched) {
    console.log(pc.yellow(`Could not launch ${mode}. Handoff prompt copied to diagnostics directory.`));
    console.log(pc.dim(`Full diagnostics written to ${diagnosticsDirectory}`));
  }
};
