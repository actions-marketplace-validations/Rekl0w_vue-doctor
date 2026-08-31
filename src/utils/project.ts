import fs from "node:fs";
import path from "node:path";
import type { ProjectInfo, VueFramework } from "../types.js";
import { discoverSourceFiles } from "./source-files.js";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const readPackageJson = (rootDirectory: string): PackageJson | null => {
  const packageJsonPath = path.join(rootDirectory, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageJson;
  } catch {
    return null;
  }
};

const collectDependencies = (packageJson: PackageJson | null): Record<string, string> => ({
  ...packageJson?.peerDependencies,
  ...packageJson?.dependencies,
  ...packageJson?.devDependencies,
});

const detectFramework = (dependencies: Record<string, string>, rootDirectory: string): VueFramework => {
  if (dependencies.nuxt || fs.existsSync(path.join(rootDirectory, "nuxt.config.ts"))) return "nuxt";
  if (dependencies.quasar || fs.existsSync(path.join(rootDirectory, "quasar.config.js"))) return "quasar";
  if (dependencies.vitepress) return "vitepress";
  if (dependencies.vuepress || dependencies["vuepress-vite"]) return "vuepress";
  if (dependencies["@vue/cli-service"]) return "vue-cli";
  if (dependencies.vite || fs.existsSync(path.join(rootDirectory, "vite.config.ts"))) return "vite";
  return "unknown";
};

const hasVueFrameworkDependency = (dependencies: Record<string, string>): boolean =>
  Boolean(
    dependencies.vue ||
      dependencies.nuxt ||
      dependencies.quasar ||
      dependencies.vitepress ||
      dependencies.vuepress ||
      dependencies["vuepress-vite"] ||
      dependencies["@vue/cli-service"],
  );

export const discoverProject = (rootDirectory: string): ProjectInfo => {
  const packageJson = readPackageJson(rootDirectory);
  const dependencies = collectDependencies(packageJson);
  const sourceFiles = discoverSourceFiles(rootDirectory, [], {
    ignoreConfigFiles: true,
  });
  const framework = detectFramework(dependencies, rootDirectory);
  const hasVueSourceFiles = sourceFiles.some((filePath) => path.extname(filePath) === ".vue");

  return {
    rootDirectory,
    projectName: packageJson?.name ?? path.basename(rootDirectory),
    hasVue: hasVueFrameworkDependency(dependencies) || hasVueSourceFiles,
    vueVersion: dependencies.vue ?? null,
    framework,
    hasTypeScript:
      Boolean(dependencies.typescript) ||
      fs.existsSync(path.join(rootDirectory, "tsconfig.json")),
    hasPinia: Boolean(dependencies.pinia),
    hasVueRouter: Boolean(dependencies["vue-router"]),
    sourceFileCount: sourceFiles.length,
  };
};
