import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { VERSION } from "../constants.js";
import { runInstallSkill } from "./install-skill.js";
import { canPrompt, printBrandHeader, promptConfirm, runProductStep } from "./terminal.js";

export interface InstallOnboardingOptions {
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
  cwd?: string | undefined;
  agentHooks?: boolean | undefined;
  gitHook?: boolean | undefined;
  githubAction?: boolean | undefined;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface InstallStep {
  label: string;
  detail: string;
  run: () => void | Promise<void>;
  prompts?: boolean | undefined;
}

interface InstallSelection {
  packageScript: boolean;
  devDependency: boolean;
  agentSkill: boolean;
  gitHook: boolean;
  githubAction: boolean;
  agentHooks: boolean;
}

const PACKAGE_NAME = "@rekl0w/vue-doctor";
const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;
const SCRIPT_COMMAND = "vue-doctor";
const HOOK_COMMAND = "npx vue-doctor --staged --blocking warning";
const MARKER_START = "# vue-doctor start";
const MARKER_END = "# vue-doctor end";

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const writeJsonFile = (filePath: string, value: unknown): void => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const findPackageRoot = (cwd: string): string => {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
};

const detectPackageManager = (root: string): PackageManager => {
  const packageJson = readJsonFile(path.join(root, "package.json"));
  const packageManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager.startsWith("pnpm@")) return "pnpm";
  if (packageManager.startsWith("yarn@")) return "yarn";
  if (packageManager.startsWith("bun@")) return "bun";
  if (packageManager.startsWith("npm@")) return "npm";
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  return "npm";
};

const installCommandFor = (manager: PackageManager): { command: string; args: string[] } => {
  if (manager === "pnpm") return { command: "pnpm", args: ["add", "-D", PACKAGE_SPEC] };
  if (manager === "yarn") return { command: "yarn", args: ["add", "-D", PACKAGE_SPEC] };
  if (manager === "bun") return { command: "bun", args: ["add", "-d", PACKAGE_SPEC] };
  return { command: "npm", args: ["install", "--save-dev", PACKAGE_SPEC] };
};

const runPackageManagerInstall = (root: string, manager: PackageManager): void => {
  const { command, args } = installCommandFor(manager);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to install ${PACKAGE_SPEC}. Run ${command} ${args.join(" ")} manually.`);
  }
};

const addPackageScript = (root: string): string => {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJsonFile(packageJsonPath);
  if (!packageJson) throw new Error(`Could not read ${packageJsonPath}.`);

  const scripts = typeof packageJson.scripts === "object" && packageJson.scripts !== null
    ? { ...(packageJson.scripts as Record<string, unknown>) }
    : {};
  const scriptName = typeof scripts.doctor === "string" && scripts.doctor !== SCRIPT_COMMAND
    ? "vue-doctor"
    : "doctor";
  scripts[scriptName] = SCRIPT_COMMAND;
  packageJson.scripts = scripts;
  writeJsonFile(packageJsonPath, packageJson);
  return scriptName;
};

const hasPackageDependency = (root: string): boolean => {
  const packageJson = readJsonFile(path.join(root, "package.json"));
  const dependencies = typeof packageJson?.dependencies === "object" && packageJson.dependencies !== null
    ? packageJson.dependencies as Record<string, unknown>
    : {};
  const devDependencies = typeof packageJson?.devDependencies === "object" && packageJson.devDependencies !== null
    ? packageJson.devDependencies as Record<string, unknown>
    : {};
  return PACKAGE_NAME in dependencies || PACKAGE_NAME in devDependencies;
};

const writeWorkflow = (root: string): string => {
  const workflowPath = path.join(root, ".github", "workflows", "vue-doctor.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  const content = `name: Vue Doctor

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]

permissions:
  contents: read
  issues: write
  pull-requests: write
  statuses: write

concurrency:
  group: vue-doctor-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  vue-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Rekl0w/vue-doctor@v${VERSION}
        with:
          directory: .
          scope: changed
          blocking: warning
          annotations: true
          comment: true
          review-comments: true
          commit-status: true
`;
  fs.writeFileSync(workflowPath, content);
  return workflowPath;
};

const appendManagedBlock = (filePath: string, command: string): void => {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const block = `${MARKER_START}\n${command}\n${MARKER_END}`;
  const next = existing.includes(MARKER_START)
    ? existing.replace(new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`), block)
    : `${existing.trimEnd()}${existing.trim().length > 0 ? "\n\n" : ""}${block}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
};

const installDirectGitHook = (root: string): string | null => {
  const gitDirectory = path.join(root, ".git");
  if (!fs.existsSync(gitDirectory)) return null;
  const hookPath = path.join(gitDirectory, "hooks", "pre-commit");
  appendManagedBlock(hookPath, HOOK_COMMAND);
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {}
  return hookPath;
};

const installHuskyHook = (root: string): string | null => {
  const huskyDirectory = path.join(root, ".husky");
  if (!fs.existsSync(huskyDirectory)) return null;
  const hookPath = path.join(huskyDirectory, "pre-commit");
  appendManagedBlock(hookPath, HOOK_COMMAND);
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {}
  return hookPath;
};

const installSimpleGitHooks = (root: string): string | null => {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJsonFile(packageJsonPath);
  if (!packageJson) return null;
  const hasSimpleGitHooks =
    typeof packageJson["simple-git-hooks"] === "object" ||
    Boolean((packageJson.devDependencies as Record<string, unknown> | undefined)?.["simple-git-hooks"]);
  if (!hasSimpleGitHooks) return null;
  packageJson["simple-git-hooks"] = {
    ...((packageJson["simple-git-hooks"] as Record<string, unknown> | undefined) ?? {}),
    "pre-commit": HOOK_COMMAND,
  };
  writeJsonFile(packageJsonPath, packageJson);
  return "package.json simple-git-hooks.pre-commit";
};

const installLefthook = (root: string): string | null => {
  const candidates = ["lefthook.yml", "lefthook.yaml"].map((filename) => path.join(root, filename));
  const hookPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!hookPath) return null;
  const existing = fs.readFileSync(hookPath, "utf-8");
  if (existing.includes("vue-doctor")) return hookPath;
  fs.appendFileSync(
    hookPath,
    `\n# vue-doctor\npre-commit:\n  commands:\n    vue-doctor:\n      run: ${HOOK_COMMAND}\n`,
  );
  return hookPath;
};

const installGitHook = (root: string): string => {
  const installed =
    installHuskyHook(root) ??
    installSimpleGitHooks(root) ??
    installLefthook(root) ??
    installDirectGitHook(root);
  if (!installed) throw new Error("No Git repository or supported hook manager found for Git hook install.");
  return installed;
};

const hookScript = (): string => `#!/bin/sh
set -eu

if command -v vue-doctor >/dev/null 2>&1; then
  vue-doctor --staged --blocking none
elif command -v npx >/dev/null 2>&1; then
  npx vue-doctor --staged --blocking none
fi
`;

const writeAgentHooks = (root: string): string[] => {
  const written: string[] = [];
  const claudeDirectory = path.join(root, ".claude");
  if (fs.existsSync(claudeDirectory)) {
    const hookPath = path.join(claudeDirectory, "hooks", "vue-doctor.sh");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, hookScript());
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {}
    const settingsPath = path.join(claudeDirectory, "settings.json");
    const settings = readJsonFile(settingsPath) ?? {};
    const hooks = typeof settings.hooks === "object" && settings.hooks !== null
      ? settings.hooks as Record<string, unknown>
      : {};
    hooks.PostToolUse = [
      {
        matcher: "Write|Edit|MultiEdit",
        hooks: [{ type: "command", command: `sh "${hookPath.replaceAll("\\", "/")}"` }],
      },
    ];
    settings.hooks = hooks;
    writeJsonFile(settingsPath, settings);
    written.push(hookPath);
  }

  const cursorDirectory = path.join(root, ".cursor");
  if (fs.existsSync(cursorDirectory)) {
    const hookPath = path.join(cursorDirectory, "hooks", "vue-doctor.sh");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, hookScript());
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {}
    const hooksPath = path.join(cursorDirectory, "hooks.json");
    const hooks = readJsonFile(hooksPath) ?? {};
    hooks.hooks = [
      {
        matcher: "Write|Edit|MultiEdit|ApplyPatch",
        command: `sh "${hookPath.replaceAll("\\", "/")}"`,
      },
    ];
    writeJsonFile(hooksPath, hooks);
    written.push(hookPath);
  }

  return written;
};

const resolveInstallSelection = async (
  root: string,
  options: InstallOnboardingOptions,
): Promise<InstallSelection> => {
  const defaults: InstallSelection = {
    packageScript: true,
    devDependency: !hasPackageDependency(root),
    agentSkill: true,
    gitHook: options.gitHook !== false,
    githubAction: options.githubAction !== false,
    agentHooks: Boolean(options.agentHooks),
  };

  if (options.dryRun || options.yes || !canPrompt()) return defaults;

  console.log(pc.bold("Vue Doctor install wizard"));
  console.log(pc.dim("Choose the repo setup pieces you want. Press Enter to accept each recommendation."));
  console.log("");

  return {
    packageScript: await promptConfirm("Add a package script (`doctor` -> `vue-doctor`)?", defaults.packageScript),
    devDependency: defaults.devDependency
      ? await promptConfirm(`Install ${PACKAGE_SPEC} as a dev dependency?`, true)
      : false,
    agentSkill: await promptConfirm("Install the bundled coding-agent skill?", defaults.agentSkill),
    gitHook: await promptConfirm("Install a pre-commit hook for staged Vue files?", defaults.gitHook),
    githubAction: await promptConfirm("Write .github/workflows/vue-doctor.yml?", defaults.githubAction),
    agentHooks: await promptConfirm("Install native Claude/Cursor edit hooks when project folders exist?", defaults.agentHooks),
  };
};

const buildSteps = (
  root: string,
  options: InstallOnboardingOptions,
  selection: InstallSelection,
): InstallStep[] => {
  const manager = detectPackageManager(root);
  const steps: InstallStep[] = [];

  if (selection.packageScript) {
    steps.push({
      label: "package script",
      detail: "Add npm script for vue-doctor",
      run: () => {
        const scriptName = addPackageScript(root);
        console.log(pc.green(`Added package script: ${scriptName}`));
      },
    });
  }

  if (selection.devDependency && !hasPackageDependency(root)) {
    steps.push({
      label: "dev dependency",
      detail: `${installCommandFor(manager).command} ${installCommandFor(manager).args.join(" ")}`,
      run: () => runPackageManagerInstall(root, manager),
    });
  }

  if (selection.agentSkill) {
    steps.push({
      label: "agent skill",
      detail: "Install bundled Vue Doctor skill into detected coding agents",
      prompts: true,
      run: async () => {
        try {
          await runInstallSkill({ yes: options.yes, dryRun: false, cwd: root });
        } catch (error) {
          console.log(pc.yellow(error instanceof Error ? error.message : String(error)));
        }
      },
    });
  }

  if (selection.gitHook) {
    steps.push({
      label: "git hook",
      detail: "Install pre-commit vue-doctor --staged hook",
      run: () => {
        const target = installGitHook(root);
        console.log(pc.green(`Installed Git hook: ${target}`));
      },
    });
  }

  if (selection.githubAction) {
    steps.push({
      label: "GitHub Action",
      detail: "Write .github/workflows/vue-doctor.yml",
      run: () => {
        const target = writeWorkflow(root);
        console.log(pc.green(`Wrote workflow: ${target}`));
      },
    });
  }

  if (selection.agentHooks) {
    steps.push({
      label: "native agent hooks",
      detail: "Wire Claude/Cursor edit hooks when their project folders exist",
      run: () => {
        const written = writeAgentHooks(root);
        if (written.length === 0) {
          console.log(pc.dim("No .claude or .cursor directory found; skipped native agent hooks."));
          return;
        }
        for (const target of written) console.log(pc.green(`Wrote agent hook: ${target}`));
      },
    });
  }

  return steps;
};

export const runInstallOnboarding = async (options: InstallOnboardingOptions = {}): Promise<void> => {
  const root = findPackageRoot(options.cwd ?? process.cwd());
  const selection = await resolveInstallSelection(root, options);
  const steps = buildSteps(root, options, selection);

  printBrandHeader(VERSION, [
    ["Project", root],
    ["Mode", options.dryRun ? "dry run" : "install"],
    ["Steps", steps.length],
  ]);

  if (options.dryRun) {
    console.log(`Dry run - would configure Vue Doctor in ${root}:`);
    for (const step of steps) console.log(pc.dim(`  - ${step.label}: ${step.detail}`));
    return;
  }

  for (const step of steps) {
    if (step.prompts && canPrompt() && !options.yes) {
      console.log(`- ${step.label}`);
      try {
        await step.run();
        console.log(`${pc.green("OK")} ${step.label}${pc.dim(` - ${step.detail}`)}`);
      } catch (error) {
        console.log(`${pc.red("x")} ${step.label}`);
        throw error;
      }
      continue;
    }

    await runProductStep(step.label, async () => {
      await step.run();
      return step;
    }, () => step.detail);
  }
};
