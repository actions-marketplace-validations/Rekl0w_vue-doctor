import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import {
  getSkillAgentConfig,
  installSkillsFromSource,
  SKILL_MANIFEST_FILE,
  type SkillAgentType,
} from "agent-install";
import { detectAvailableAgents } from "./detect-agents.js";
import { promptMultiChoice } from "./terminal.js";

interface InstallSkillOptions {
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
  cwd?: string | undefined;
  sourceDir?: string | undefined;
  detectedAgents?: SkillAgentType[] | undefined;
}

const SKILL_NAME = "vue-doctor";

const getSkillSourceDirectory = (): string => {
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(distDirectory, "..", "skills", SKILL_NAME);
};

const formatAgent = (agent: SkillAgentType): string => getSkillAgentConfig(agent).displayName;

const selectAgents = async (
  detectedAgents: SkillAgentType[],
  yes: boolean | undefined,
): Promise<SkillAgentType[]> => {
  if (yes) return detectedAgents;

  return promptMultiChoice(
    "Install Vue Doctor skill for:",
    detectedAgents.map((agent) => ({
      value: agent,
      label: formatAgent(agent),
    })),
    detectedAgents,
  );
};

export const runInstallSkill = async (options: InstallSkillOptions = {}): Promise<void> => {
  const projectRoot = options.cwd ?? process.cwd();
  const sourceDir = options.sourceDir ?? getSkillSourceDirectory();

  if (!existsSync(path.join(sourceDir, SKILL_MANIFEST_FILE))) {
    throw new Error(`Could not locate the bundled ${SKILL_NAME} skill at ${sourceDir}.`);
  }

  const detectedAgents = options.detectedAgents ?? (await detectAvailableAgents());
  if (detectedAgents.length === 0) {
    throw new Error(
      "No supported coding agents detected. Run with an agent installed, or install the skill manually from the package's skills/vue-doctor folder.",
    );
  }

  const selectedAgents = await selectAgents(detectedAgents, options.yes);
  if (selectedAgents.length === 0) {
    console.log(pc.dim("No agents selected."));
    return;
  }

  if (options.dryRun) {
    console.log(`Dry run - would install ${SKILL_NAME} for:`);
    for (const agent of selectedAgents) {
      console.log(pc.dim(`  - ${formatAgent(agent)}`));
    }
    console.log(pc.dim(`Source: ${sourceDir}`));
    return;
  }

  const result = await installSkillsFromSource({
    source: sourceDir,
    agents: selectedAgents,
    cwd: projectRoot,
    mode: "copy",
  });

  if (result.skills.length === 0) {
    throw new Error(`Could not parse ${SKILL_MANIFEST_FILE} for ${SKILL_NAME}.`);
  }

  if (result.failed.length > 0) {
    throw new Error(
      result.failed
        .map((failure) => `${formatAgent(failure.agent)}: ${failure.error}`)
        .join("\n"),
    );
  }

  console.log(
    pc.green(
      `${SKILL_NAME} skill installed for ${selectedAgents.map((agent) => formatAgent(agent)).join(", ")}.`,
    ),
  );
};
