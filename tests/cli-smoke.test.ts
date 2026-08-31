import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "..");
const packageVersion = (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as { version: string }).version;
const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

const makeProject = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-doctor-cli-smoke-"));
  tempRoots.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { vue: "^3.5.0", vite: "^7.0.0" } }),
  );
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "App.vue"), "<template><img src=\"/logo.png\"></template>\n");
  return root;
};

const runCli = (args: string[]): string => {
  const result = spawnSync(process.execPath, ["bin/vue-doctor.js", ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `vue-doctor ${args.join(" ")} failed`);
  }
  return stripAnsi(result.stdout);
};

const runGit = (root: string, args: string[]): void => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
};

const makeChangedGitProject = (): string => {
  const root = makeProject();
  fs.writeFileSync(
    path.join(root, "src", "App.vue"),
    [
      "<template>",
      "  <section>",
      "    <img src=\"/logo.png\">",
      "    <p>safe</p>",
      "  </section>",
      "</template>",
      "",
    ].join("\n"),
  );
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"]);
  runGit(root, ["checkout", "-b", "feature"]);
  fs.writeFileSync(
    path.join(root, "src", "App.vue"),
    [
      "<template>",
      "  <section>",
      "    <img src=\"/logo.png\">",
      "    <p v-html=\"html\"></p>",
      "  </section>",
      "</template>",
      "",
    ].join("\n"),
  );
  return root;
};

const makeDeadCodeProject = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-doctor-dead-code-"));
  tempRoots.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { vue: "^3.5.0", vite: "^7.0.0", "unused-runtime": "^1.0.0" } }),
  );
  fs.writeFileSync(path.join(root, "index.html"), "<script type=\"module\" src=\"/src/main.js\"></script>\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.js"), "console.log('ok')\n");
  fs.writeFileSync(path.join(root, "src", "dead.js"), "export const dead = true\n");
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CLI smoke", () => {
  it("prints detailed version information", () => {
    const output = runCli(["version"]);
    expect(output).toContain(`vue-doctor ${packageVersion}`);
    expect(output).toContain("node ");
  });

  it("emits JSON, Markdown, and SARIF reports", () => {
    const root = makeProject();

    const json = JSON.parse(runCli([root, "--json", "--fail-on", "none"])) as {
      summary: { totalDiagnosticCount: number };
    };
    expect(json.summary.totalDiagnosticCount).toBe(1);

    const markdown = runCli([root, "--markdown", "--fail-on", "none"]);
    expect(markdown).toContain("# Vue Doctor Report");
    expect(markdown).toContain("vue-doctor/require-img-alt");

    const sarif = JSON.parse(runCli([root, "--sarif", "--json-compact", "--fail-on", "none"])) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.results[0]?.ruleId).toBe("vue-doctor/require-img-alt");
  });

  it("honors blocking config when no CLI gate flag is passed", () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, "vue-doctor.config.json"), JSON.stringify({ blocking: "none" }));

    const json = JSON.parse(runCli([root, "--json"])) as {
      summary: { totalDiagnosticCount: number };
    };

    expect(json.summary.totalDiagnosticCount).toBe(1);
  });

  it("can hide warnings from CLI reports", () => {
    const root = makeProject();

    const json = JSON.parse(runCli([root, "--json", "--no-warnings"])) as {
      summary: { totalDiagnosticCount: number; score: number };
    };

    expect(json.summary.totalDiagnosticCount).toBe(0);
    expect(json.summary.score).toBe(100);
  });

  it("can disable dead-code analysis from the CLI", () => {
    const root = makeDeadCodeProject();

    const withDeadCode = JSON.parse(runCli([root, "--json", "--blocking", "none"])) as {
      diagnostics: Array<{ rule: string }>;
    };
    const withoutDeadCode = JSON.parse(runCli([root, "--json", "--blocking", "none", "--no-dead-code"])) as {
      diagnostics: Array<{ rule: string }>;
    };

    expect(withDeadCode.diagnostics.map((diagnostic) => diagnostic.rule)).toContain("no-unused-file");
    expect(withoutDeadCode.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain("no-unused-file");
    expect(withoutDeadCode.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain("no-unused-dependency");
  });

  it("accepts the supply-chain CLI toggle", () => {
    const root = makeProject();

    const json = JSON.parse(runCli([root, "--json", "--blocking", "none", "--no-supply-chain"])) as {
      diagnostics: Array<{ rule: string }>;
    };

    expect(json.diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain("low-supply-chain-score");
  });

  it("loads TypeScript config files", () => {
    const root = makeProject();
    fs.writeFileSync(
      path.join(root, "vue-doctor.config.ts"),
      "export default { rules: { 'vue-doctor/require-img-alt': 'off' } }\n",
    );

    const json = JSON.parse(runCli([root, "--json", "--blocking", "none"])) as {
      summary: { totalDiagnosticCount: number };
    };

    expect(json.summary.totalDiagnosticCount).toBe(0);
  });

  it("prints a lean human report with verbose source frames", () => {
    const root = makeProject();
    const output = runCli([root, "--verbose", "--fail-on", "none", "--handoff", "skip"]);

    expect(output).toContain(`vue-doctor v${packageVersion}`);
    expect(output).toContain("Full project - 1 workspace - single-threaded");
    expect(output).toContain("Analyzing Vue source...");
    expect(output).toContain("require-img-alt");
    expect(output).toContain("| <template><img src=\"/logo.png\"></template>");
  });

  it("prints a clear non-Vue project diagnostic", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-doctor-non-vue-"));
    tempRoots.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "react-app", dependencies: { react: "^18.2.0" } }),
    );
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "App.jsx"), "export const App = () => null\n");

    const output = runCli([root, "--fail-on", "none", "--handoff", "skip"]);

    expect(output).toContain("Vue project was not detected");
    expect(output).toContain("Correctness -> 1 error");
    expect(output).not.toContain("100 / 100");
  });

  it("can write and apply a diagnostics baseline", () => {
    const root = makeProject();
    const baselinePath = path.join(root, "vue-doctor-baseline.json");

    const raw = JSON.parse(runCli([root, "--json", "--fail-on", "none", "--update-baseline", baselinePath])) as {
      summary: { totalDiagnosticCount: number };
    };
    expect(raw.summary.totalDiagnosticCount).toBe(1);
    expect(fs.existsSync(baselinePath)).toBe(true);

    const filtered = JSON.parse(runCli([root, "--json", "--fail-on", "none", "--baseline", baselinePath])) as {
      summary: { totalDiagnosticCount: number; score: number };
    };
    expect(filtered.summary.totalDiagnosticCount).toBe(0);
    expect(filtered.summary.score).toBe(100);
  });

  it("can scan a changed-files list without relying on local git diff state", () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, "src", "App.vue"), "<template><p>ok</p></template>\n");
    fs.writeFileSync(path.join(root, "src", "Changed.vue"), "<template><p v-html=\"html\"></p></template>\n");
    const changedFilesPath = path.join(root, "changed-files.txt");
    fs.writeFileSync(changedFilesPath, "src/Changed.vue\n");

    const json = JSON.parse(
      runCli([root, "--json", "--fail-on", "none", "--changed-files-from", changedFilesPath]),
    ) as {
      mode: string;
      diagnostics: Array<{ relativePath: string; rule: string }>;
      summary: { totalDiagnosticCount: number };
    };

    expect(json.mode).toBe("changed-files");
    expect(json.summary.totalDiagnosticCount).toBe(1);
    expect(json.diagnostics[0]?.relativePath).toBe("src/Changed.vue");
    expect(json.diagnostics[0]?.rule).toBe("no-v-html");
  });

  it("can scan with experimental worker-thread parallelism", () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, "src", "Clean.vue"), "<template><p>ok</p></template>\n");

    const json = JSON.parse(
      runCli([root, "--json", "--fail-on", "none", "--experimental-parallel", "2", "--no-dead-code"]),
    ) as {
      diagnostics: Array<{ rule: string }>;
      summary: { totalDiagnosticCount: number };
    };

    expect(json.summary.totalDiagnosticCount).toBe(1);
    expect(json.diagnostics[0]?.rule).toBe("require-img-alt");
  });

  it("supports changed-line scope for pull request style scans", () => {
    const root = makeChangedGitProject();
    const json = JSON.parse(
      runCli([root, "--json", "--scope", "lines", "--base", "main", "--blocking", "none"]),
    ) as {
      mode: string;
      diagnostics: Array<{ rule: string }>;
      summary: { totalDiagnosticCount: number };
    };

    expect(json.mode).toBe("diff");
    expect(json.summary.totalDiagnosticCount).toBe(1);
    expect(json.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual(["no-v-html"]);
  });

  it("supports introduced-issue scope by comparing against the base ref", () => {
    const root = makeChangedGitProject();
    const json = JSON.parse(
      runCli([root, "--json", "--scope", "changed", "--base", "main", "--blocking", "none"]),
    ) as {
      mode: string;
      baseline?: { newCount: number; baseTotalCount: number };
      diagnostics: Array<{ rule: string }>;
      summary: { totalDiagnosticCount: number };
    };

    expect(json.mode).toBe("baseline");
    expect(json.baseline?.newCount).toBe(1);
    expect(json.baseline?.baseTotalCount).toBe(1);
    expect(json.summary.totalDiagnosticCount).toBe(1);
    expect(json.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual(["no-v-html"]);
  });

  it("can list and update rule configuration from the rules command", () => {
    const root = makeProject();
    const list = JSON.parse(runCli(["rules", "list", "--json", "-c", root])) as Array<{ key: string }>;
    expect(list.some((rule) => rule.key === "vue-doctor/require-img-alt")).toBe(true);

    const output = runCli(["rules", "disable", "require-img-alt", "-c", root]);
    expect(output).toContain("vue-doctor/require-img-alt");

    const json = JSON.parse(runCli([root, "--json", "--fail-on", "none"])) as {
      summary: { totalDiagnosticCount: number };
    };
    expect(json.summary.totalDiagnosticCount).toBe(0);
  });

  it("previews the expanded install onboarding flow", () => {
    const root = makeProject();
    const output = runCli(["install", "--dry-run", "--cwd", root, "--agent-hooks"]);

    expect(output).toContain("Dry run");
    expect(output).toContain("package script");
    expect(output).toContain("GitHub Action");
    expect(output).toContain("native agent hooks");
  });
});
