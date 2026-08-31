import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { runInstallOnboarding } from "./install-onboarding.js";
import { canPrompt, promptChoice } from "./terminal.js";

const STATE_PATH = process.env.VUE_DOCTOR_SETUP_HINT_STORE
  ? path.resolve(process.env.VUE_DOCTOR_SETUP_HINT_STORE)
  : path.join(os.homedir(), ".vue-doctor", "setup-hints.json");
const PACKAGE_NAME = "@rekl0w/vue-doctor";

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const projectKey = (rootDirectory: string): string =>
  createHash("sha256").update(path.resolve(rootDirectory).toLowerCase()).digest("hex").slice(0, 16);

interface SetupStatus {
  hasPackageScript: boolean;
  hasDependency: boolean;
  hasWorkflow: boolean;
}

const getSetupStatus = (rootDirectory: string): SetupStatus => {
  const packageJson = readJsonFile(path.join(rootDirectory, "package.json"));
  const scripts = typeof packageJson?.scripts === "object" && packageJson.scripts !== null
    ? packageJson.scripts as Record<string, unknown>
    : {};
  const dependencies = typeof packageJson?.dependencies === "object" && packageJson.dependencies !== null
    ? packageJson.dependencies as Record<string, unknown>
    : {};
  const devDependencies = typeof packageJson?.devDependencies === "object" && packageJson.devDependencies !== null
    ? packageJson.devDependencies as Record<string, unknown>
    : {};
  const workflowPath = path.join(rootDirectory, ".github", "workflows", "vue-doctor.yml");

  return {
    hasPackageScript: Object.values(scripts).some((value) => typeof value === "string" && value.includes("vue-doctor")),
    hasDependency: PACKAGE_NAME in dependencies || PACKAGE_NAME in devDependencies,
    hasWorkflow: fs.existsSync(workflowPath),
  };
};

const hasVueDoctorSetup = (rootDirectory: string): boolean => {
  const status = getSetupStatus(rootDirectory);
  return status.hasPackageScript && status.hasDependency && status.hasWorkflow;
};

const isCodingAgentEnvironment = (): boolean => {
  const names = Object.keys(process.env).join(" ");
  return /\b(CODEX|CLAUDE|CURSOR|CLINE|GITHUB_COPILOT|AIDER|OPENAI)\b/i.test(names);
};

const readState = (): Record<string, true> => {
  const state = readJsonFile(STATE_PATH);
  return state ? Object.fromEntries(Object.keys(state).map((key) => [key, true])) : {};
};

const writeState = (state: Record<string, true>): void => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
};

const markSeen = (rootDirectory: string): void => {
  const state = readState();
  const key = projectKey(rootDirectory);
  state[key] = true;
  writeState(state);
};

export const maybeOfferProjectSetup = async (rootDirectory: string): Promise<void> => {
  if (hasVueDoctorSetup(rootDirectory)) return;

  const state = readState();
  const key = projectKey(rootDirectory);
  if (state[key]) return;

  if (!canPrompt()) {
    if (!isCodingAgentEnvironment()) return;
    console.log("");
    console.log(pc.bold("Vue Doctor is not installed in this project."));
    console.log("Ask the user if they would like to set it up, then run:");
    console.log("");
    console.log("  npx @rekl0w/vue-doctor@latest install");
    console.log("");
    console.log(
      pc.dim(
        "This can add a `doctor` package script, the dev dependency, GitHub Actions, Git hooks, and the bundled agent skill.",
      ),
    );
    markSeen(rootDirectory);
    return;
  }

  console.log("");
  console.log(pc.bold("Keep Vue Doctor watching this repo?"));
  console.log(
    pc.dim(
      "The scan is local. The setup wizard can add a doctor script, dev dependency, PR review workflow, Git hook, and agent skill.",
    ),
  );
  console.log("");

  const selected = await promptChoice(
    "Add Vue Doctor setup now?",
    [
      { value: "setup", label: "Run setup wizard", hint: "choose script, dependency, GitHub Action, hooks, and agent skill" },
      { value: "command", label: "Show command", hint: "print the installer command and leave files untouched" },
      { value: "skip", label: "Skip", hint: "do not ask again for this project" },
    ],
    "setup",
  );

  markSeen(rootDirectory);

  if (selected === "setup") {
    await runInstallOnboarding({ cwd: rootDirectory });
    return;
  }

  if (selected === "command") {
    console.log("");
    console.log("Run this when you are ready:");
    console.log("");
    console.log("  npx @rekl0w/vue-doctor@latest install");
  }
};

export const maybePrintSetupHint = (rootDirectory: string): void => {
  void maybeOfferProjectSetup(rootDirectory);
};
