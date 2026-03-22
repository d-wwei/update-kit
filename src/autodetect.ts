import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  BootstrapManifestOptions,
  HostPreset,
  InstallStrategy,
  ResolvedManifestInfo,
  UpdateManifest,
  UpdateManifestOverrides,
  VersionSource
} from "./types.js";
import { normalizeManifest } from "./manifest.js";
import { normalizeGithubRepo, pathExists } from "./utils.js";

const execFile = promisify(execFileCallback);

type Detection = {
  preset: HostPreset;
  signals: string[];
  componentName: string;
  repo?: string;
  currentVersionSource: VersionSource;
  installStrategy: InstallStrategy;
};

export async function bootstrapManifest(
  options: BootstrapManifestOptions
): Promise<{ manifest: UpdateManifest; info: ResolvedManifestInfo }> {
  const detected = await detectHost(options.cwd, options.preset);
  if (!detected.repo && !options.overrides?.repo) {
    throw new Error(
      "Could not autodetect a GitHub repo from package metadata or git remote. Pass manifestOverrides.repo or provide update.config.json."
    );
  }

  const baseManifest: UpdateManifest = {
    $schemaVersion: 1,
    componentName: detected.componentName,
    repo: detected.repo ?? options.overrides?.repo ?? "",
    releaseChannel: "releases",
    currentVersionSource: detected.currentVersionSource,
    installStrategy: detected.installStrategy,
    statePath: path.join(options.cwd, ".update-kit", "state.json"),
    auditLogPath: path.join(options.cwd, ".update-kit", "audit.log"),
    lockPath: path.join(options.cwd, ".update-kit", "update.lock"),
    autoUpdatePolicy: "manual",
    allowedUpdateLevels: ["patch", "minor"],
    updateInstructions: {
      summary: "Autodetected UpdateKit manifest."
    }
  };

  const merged = applyManifestOverrides(baseManifest, options.overrides);
  return {
    manifest: normalizeManifest(merged, options.cwd),
    info: {
      source: options.overrides ? "merged" : "autodetect",
      preset: detected.preset,
      signals: detected.signals
    }
  };
}

export async function detectHost(cwd: string, preferredPreset?: HostPreset): Promise<Detection> {
  if (preferredPreset) {
    return detectForPreset(cwd, preferredPreset);
  }

  if (await pathExists(path.join(cwd, "package.json"))) {
    const packageJson = await readPackageJson(cwd);
    if (packageJson) {
      const preset = await detectNodePreset(cwd, packageJson);
      return detectForPreset(cwd, preset, packageJson);
    }
  }

  if (await pathExists(path.join(cwd, "pyproject.toml"))) {
    return detectForPreset(cwd, "python-pip");
  }

  if (await pathExists(path.join(cwd, ".git", "config"))) {
    return detectForPreset(cwd, "git-repo");
  }

  throw new Error(
    "Could not autodetect host type. Supported defaults are Node package managers, pyproject-based Python projects, or git repositories."
  );
}

async function detectForPreset(
  cwd: string,
  preset: HostPreset,
  packageJson?: PackageJson
): Promise<Detection> {
  if (preset === "node-npm" || preset === "node-pnpm" || preset === "node-yarn") {
    const parsed = packageJson ?? await readPackageJson(cwd);
    if (!parsed?.name || !parsed.version) {
      throw new Error("Autodetected Node host requires package.json with name and version.");
    }
    return {
      preset,
      signals: [`package.json`, `${preset}`],
      componentName: parsed.name,
      repo: detectRepoFromPackageJson(parsed) ?? await detectRepoFromGit(cwd),
      currentVersionSource: {
        type: "package.json",
        path: path.join(cwd, "package.json")
      },
      installStrategy: {
        type: preset === "node-pnpm" ? "pnpm_package" : preset === "node-yarn" ? "yarn_package" : "npm_package",
        packageName: parsed.name,
        cwd
      }
    };
  }

  if (preset === "python-pip") {
    const pyproject = await readFile(path.join(cwd, "pyproject.toml"), "utf8");
    const name = extractTomlValue(pyproject, "name") ?? path.basename(cwd);
    return {
      preset,
      signals: ["pyproject.toml", "python-pip"],
      componentName: name,
      repo: detectRepoFromPyproject(pyproject) ?? await detectRepoFromGit(cwd),
      currentVersionSource: {
        type: "pyproject.toml",
        path: path.join(cwd, "pyproject.toml")
      },
      installStrategy: {
        type: "pip_package",
        packageName: name,
        cwd
      }
    };
  }

  if (preset === "git-repo") {
    const repo = await detectRepoFromGit(cwd);
    const version = await detectGitTagVersion(cwd);
    return {
      preset,
      signals: [".git/config", "git origin"],
      componentName: path.basename(cwd),
      repo,
      currentVersionSource: {
        type: "literal",
        value: version ?? "0.0.0"
      },
      installStrategy: {
        type: "git_pull",
        remote: "origin",
        cwd
      }
    };
  }

  throw new Error(`Unsupported preset ${preset}.`);
}

async function readPackageJson(cwd: string): Promise<PackageJson | undefined> {
  const filePath = path.join(cwd, "package.json");
  if (!await pathExists(filePath)) return undefined;
  return JSON.parse(await readFile(filePath, "utf8")) as PackageJson;
}

async function detectNodePreset(cwd: string, packageJson: PackageJson): Promise<HostPreset> {
  const packageManager = packageJson.packageManager?.toLowerCase();
  if (packageManager?.startsWith("pnpm@")) return "node-pnpm";
  if (packageManager?.startsWith("yarn@")) return "node-yarn";
  if (packageManager?.startsWith("npm@")) return "node-npm";

  if (await pathExists(path.join(cwd, "pnpm-lock.yaml"))) return "node-pnpm";
  if (await pathExists(path.join(cwd, "yarn.lock"))) return "node-yarn";
  return "node-npm";
}

function detectRepoFromPackageJson(packageJson: PackageJson): string | undefined {
  const repository = packageJson.repository;
  if (typeof repository === "string") return normalizeGithubRepo(repository);
  if (repository && typeof repository === "object" && typeof repository.url === "string") {
    return normalizeGithubRepo(repository.url);
  }
  return undefined;
}

function detectRepoFromPyproject(pyproject: string): string | undefined {
  const patterns = [
    /repository\s*=\s*["']([^"']+)["']/m,
    /Homepage\s*=\s*["']([^"']+)["']/m,
    /Source\s*=\s*["']([^"']+)["']/m
  ];
  for (const pattern of patterns) {
    const match = pyproject.match(pattern);
    if (match?.[1]) {
      const repo = normalizeGithubRepo(match[1]);
      if (repo) return repo;
    }
  }
  return undefined;
}

async function detectRepoFromGit(cwd: string): Promise<string | undefined> {
  const gitConfigPath = path.join(cwd, ".git", "config");
  if (await pathExists(gitConfigPath)) {
    const raw = await readFile(gitConfigPath, "utf8");
    const section = raw.match(/\[remote\s+"origin"\][^\[]+/m)?.[0];
    const url = section?.match(/url\s*=\s*(.+)/)?.[1]?.trim();
    if (url) return normalizeGithubRepo(url);
  }
  try {
    const { stdout } = await execFile("git", ["config", "--get", "remote.origin.url"], { cwd });
    return normalizeGithubRepo(stdout.trim());
  } catch {
    return undefined;
  }
}

async function detectGitTagVersion(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["describe", "--tags", "--abbrev=0"], { cwd });
    return stdout.trim().replace(/^v/i, "");
  } catch {
    return undefined;
  }
}

export function applyManifestOverrides(
  baseManifest: UpdateManifest,
  overrides: UpdateManifestOverrides | undefined
): UpdateManifest {
  if (!overrides) return baseManifest;
  return {
    ...baseManifest,
    ...overrides,
    currentVersionSource: overrides.currentVersionSource ?? baseManifest.currentVersionSource,
    candidateVersionSource: overrides.candidateVersionSource ?? baseManifest.candidateVersionSource,
    installStrategy: overrides.installStrategy ?? baseManifest.installStrategy,
    updateInstructions: {
      ...baseManifest.updateInstructions,
      ...overrides.updateInstructions
    },
    privacyRules: {
      ...baseManifest.privacyRules,
      ...overrides.privacyRules
    },
    timeouts: {
      ...baseManifest.timeouts,
      ...overrides.timeouts
    },
    retryPolicy: {
      ...baseManifest.retryPolicy,
      ...overrides.retryPolicy
    },
    github: {
      ...baseManifest.github,
      ...overrides.github
    }
  };
}

type PackageJson = {
  name?: string;
  version?: string;
  packageManager?: string;
  repository?: string | { type?: string; url?: string };
};

function extractTomlValue(raw: string, key: string): string | undefined {
  return raw.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];
}

export function defaultDistributedNamespace(componentName: string): string {
  return path.join(os.userInfo().username, componentName).replace(/[\\/]+/g, "-");
}
