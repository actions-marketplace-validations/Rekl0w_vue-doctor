import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import {
  detectInstalledSkillAgents,
  getSkillAgentTypes,
  type SkillAgentType,
} from "agent-install";

const PATH_BINARIES: Partial<Record<SkillAgentType, readonly string[]>> = {
  "claude-code": ["claude"],
  codex: ["codex"],
  cursor: ["cursor", "agent"],
  droid: ["droid"],
  "gemini-cli": ["gemini"],
  "github-copilot": ["copilot"],
  opencode: ["opencode"],
  pi: ["pi", "omegon"],
};

const commandCandidates = (command: string): string[] => {
  if (process.platform !== "win32") return [command];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.toLowerCase())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
};

const isCommandAvailable = (command: string): boolean => {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const candidate of commandCandidates(command)) {
      const binaryPath = path.join(directory, candidate);
      try {
        if (statSync(binaryPath).isFile()) {
          accessSync(binaryPath, constants.X_OK);
          return true;
        }
      } catch {}
    }
  }
  return false;
};

const detectPathAvailableAgents = (): SkillAgentType[] => {
  const detected: SkillAgentType[] = [];
  for (const [agent, binaries] of Object.entries(PATH_BINARIES) as Array<
    [SkillAgentType, readonly string[]]
  >) {
    if (binaries.some(isCommandAvailable)) detected.push(agent);
  }
  return detected;
};

export const detectAvailableAgents = async (): Promise<SkillAgentType[]> => {
  const detected = new Set<SkillAgentType>([
    ...detectPathAvailableAgents(),
    ...(await detectInstalledSkillAgents()),
  ]);
  return getSkillAgentTypes().filter((agent) => agent !== "universal" && detected.has(agent));
};
