import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const feedback = require(path.resolve(import.meta.dirname, "..", "scripts", "github-action-feedback.cjs")) as {
  buildCommitStatus: (input: {
    report: unknown;
    scanStatus: string | undefined;
    eventName: string;
    runUrl?: string;
  }) => { state: string; description: string; target_url?: string };
  buildReviewComments: (
    report: unknown,
    files: Array<{ filename: string; patch?: string }>,
    inputDirectory?: string,
  ) => Array<{ path: string; line: number; body: string }>;
  getPriorReviewCommentIds: (comments: Array<{ id?: number; body?: string }>) => number[];
};

describe("GitHub Action feedback helpers", () => {
  it("builds inline comments only for diagnostics on commentable changed lines", () => {
    const comments = feedback.buildReviewComments(
      {
        diagnostics: [
          {
            plugin: "vue-doctor",
            rule: "no-v-html",
            severity: "error",
            relativePath: "src/App.vue",
            line: 2,
            message: "Avoid raw HTML.",
            help: "Sanitize first.",
          },
          {
            plugin: "vue-doctor",
            rule: "require-img-alt",
            severity: "warning",
            relativePath: "src/App.vue",
            line: 9,
            message: "Missing alt.",
          },
        ],
      },
      [
        {
          filename: "apps/web/src/App.vue",
          patch: [
            "@@ -1,2 +1,4 @@",
            " <template>",
            "+  <p v-html=\"html\"></p>",
            "+  <p>ok</p>",
            " </template>",
          ].join("\n"),
        },
      ],
      "apps/web",
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]?.path).toBe("apps/web/src/App.vue");
    expect(comments[0]?.line).toBe(2);
    expect(comments[0]?.body).toContain("vue-doctor/no-v-html");
  });

  it("identifies prior Vue Doctor review comments even when the new run has no inline comments", () => {
    expect(
      feedback.getPriorReviewCommentIds([
        { id: 1, body: "<!-- vue-doctor:review -->\nold" },
        { id: 2, body: "human comment" },
      ]),
    ).toEqual([1]);

    const comments = feedback.buildReviewComments(
      {
        diagnostics: [
          {
            plugin: "vue-doctor",
            rule: "require-img-alt",
            severity: "warning",
            relativePath: "src/App.vue",
            line: 99,
            message: "Missing alt.",
          },
        ],
      },
      [{ filename: "src/App.vue", patch: "@@ -1,1 +1,1 @@\n <template></template>" }],
    );
    expect(comments).toEqual([]);
  });

  it("reports pull request commit status failures only when the scan failed", () => {
    expect(
      feedback.buildCommitStatus({
        report: { summary: { score: 72, errorCount: 1, warningCount: 2 } },
        scanStatus: "1",
        eventName: "pull_request",
        runUrl: "https://example.test/run",
      }),
    ).toEqual({
      state: "failure",
      description: "Score: 72/100 - 1 errors - 2 warnings",
      target_url: "https://example.test/run",
    });

    expect(
      feedback.buildCommitStatus({
        report: { summary: { score: 72, errorCount: 1, warningCount: 2 } },
        scanStatus: "1",
        eventName: "push",
      }).state,
    ).toBe("success");
  });
});
