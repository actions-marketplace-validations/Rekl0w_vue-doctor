import { describe, expect, it } from "vitest";
import plugin, { RECOMMENDED_RULES } from "../packages/oxlint-plugin-vue-doctor/src/index.js";

describe("oxlint-plugin-vue-doctor", () => {
  it("exports a vue-doctor oxlint plugin with recommended rule ids", () => {
    expect(plugin.meta.name).toBe("vue-doctor");
    expect(Object.keys(plugin.rules)).toContain("no-eval");
    expect(RECOMMENDED_RULES).toContain("vue-doctor/no-public-env-secret");
  });

  it("reports script-level Vue Doctor findings through oxlint visitors", () => {
    const reports: Array<{ message: string }> = [];
    const noEval = plugin.rules["no-eval"]!;
    const noPublicEnvSecret = plugin.rules["no-public-env-secret"]!;
    const noEvalVisitors = noEval.create({ report: (descriptor) => reports.push({ message: descriptor.message }) });
    const noPublicEnvSecretVisitors = noPublicEnvSecret.create({
      report: (descriptor) => reports.push({ message: descriptor.message }),
    });

    noEvalVisitors.CallExpression!({
      type: "CallExpression",
      callee: { type: "Identifier", name: "eval" },
      arguments: [],
    });
    noPublicEnvSecretVisitors.MemberExpression!({
      type: "MemberExpression",
      object: {
        type: "MemberExpression",
        object: {
          type: "MetaProperty",
          meta: { type: "Identifier", name: "import" },
          property: { type: "Identifier", name: "meta" },
        },
        property: { type: "Identifier", name: "env" },
      },
      property: { type: "Identifier", name: "VITE_API_TOKEN" },
    });

    expect(reports.map((report) => report.message).join("\n")).toContain("eval()");
    expect(reports.map((report) => report.message).join("\n")).toContain("VITE_API_TOKEN");
  });
});
