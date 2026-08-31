import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnose, toJsonReportFromScans } from "../src/index.js";
import { filterSourceFiles, getDiffInfo } from "../src/utils/git.js";
import { selectProjectDirectories } from "../src/utils/workspaces.js";

const tempRoots: string[] = [];

const makeTempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-doctor-cli-"));
  tempRoots.push(root);
  return root;
};

const writeFile = (root: string, relativePath: string, content: string): void => {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGit = (root: string, args: string[]): void => {
  const result = spawnSync("git", args, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CLI feature helpers", () => {
  it("resolves workspace project names", () => {
    const root = makeTempRoot();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ private: true, workspaces: ["apps/*"] }, null, 2),
    );
    writeFile(
      root,
      "apps/web/package.json",
      JSON.stringify({ name: "web", dependencies: { vue: "^3.5.0", vite: "^7.0.0" } }, null, 2),
    );
    writeFile(
      root,
      "apps/admin/package.json",
      JSON.stringify({ name: "admin", dependencies: { vue: "^3.5.0", vite: "^7.0.0" } }, null, 2),
    );

    expect(selectProjectDirectories(root, "web,admin", false)).toEqual([
      path.join(root, "apps", "web"),
      path.join(root, "apps", "admin"),
    ]);
  });

  it("uses git diff files as include paths", async () => {
    const root = makeTempRoot();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ dependencies: { vue: "^3.5.0", vite: "^7.0.0" } }, null, 2),
    );
    writeFile(root, "src/Clean.vue", "<template><img src=\"/logo.png\"></template>\n");
    writeFile(root, "src/Changed.vue", "<template><p>ok</p></template>\n");

    runGit(root, ["init", "-b", "main"]);
    runGit(root, ["add", "."]);
    runGit(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"]);
    runGit(root, ["checkout", "-b", "feature"]);
    writeFile(root, "src/Changed.vue", "<template><p v-html=\"html\"></p></template>\n");

    const diffInfo = getDiffInfo(root, "main");
    expect(diffInfo?.changedFiles).toEqual(["src/Changed.vue"]);

    const result = await diagnose(root, {
      includePaths: filterSourceFiles(diffInfo?.changedFiles ?? []),
    });
    const rules = result.diagnostics.map((diagnostic) => diagnostic.rule);

    expect(rules).toContain("no-v-html");
    expect(rules).not.toContain("require-img-alt");
  });

  it("builds aggregate JSON reports for multiple projects", async () => {
    const root = makeTempRoot();
    writeFile(root, "apps/web/package.json", JSON.stringify({ dependencies: { vue: "^3.5.0" } }));
    writeFile(root, "apps/web/src/App.vue", "<template><img src=\"/logo.png\"></template>\n");
    writeFile(root, "apps/admin/package.json", JSON.stringify({ dependencies: { vue: "^3.5.0" } }));
    writeFile(root, "apps/admin/src/App.vue", "<template><p>ok</p></template>\n");

    const webDirectory = path.join(root, "apps", "web");
    const adminDirectory = path.join(root, "apps", "admin");
    const report = toJsonReportFromScans(root, [
      { directory: webDirectory, result: await diagnose(webDirectory) },
      { directory: adminDirectory, result: await diagnose(adminDirectory) },
    ]);

    expect(report.projects).toHaveLength(2);
    expect(report.summary.totalDiagnosticCount).toBe(1);
    expect(report.project.sourceFileCount).toBe(2);
  });
});
