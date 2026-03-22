import { readFile } from "node:fs/promises";
import path from "node:path";

import { bootstrapManifest } from "./autodetect.js";
import type { ResolvedManifestInfo, RuntimeOptions, UpdateManifest } from "./types.js";
import { isMissingFileError, normalizeGithubRepo, pathExists, resolveFromCwd } from "./utils.js";

export async function loadManifest(cwd: string, fileName = "update.config.json"): Promise<UpdateManifest> {
  const filePath = resolveFromCwd(cwd, fileName);
  if (!filePath) throw new Error("Could not resolve manifest path.");
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as UpdateManifest;
  return normalizeManifest(parsed, cwd);
}

export async function resolveManifest(options: RuntimeOptions): Promise<{ manifest: UpdateManifest; info: ResolvedManifestInfo }> {
  if (options.manifest) {
    return {
      manifest: normalizeManifest(options.manifest, options.cwd),
      info: { source: options.manifestOverrides ? "merged" : "manifest" }
    };
  }

  const fileName = options.manifestFile ?? "update.config.json";
  const filePath = resolveFromCwd(options.cwd, fileName);
  const manifestExists = filePath ? await pathExists(filePath) : false;

  if (manifestExists) {
    const manifest = await loadManifest(options.cwd, fileName);
    if (!options.manifestOverrides) {
      return { manifest, info: { source: "manifest" } };
    }
    return {
      manifest: normalizeManifest({
        ...manifest,
        ...options.manifestOverrides
      }, options.cwd),
      info: { source: "merged" }
    };
  }

  if (options.autodetect !== false) {
    return bootstrapManifest({
      cwd: options.cwd,
      overrides: options.manifestOverrides,
      preset: options.preset
    });
  }

  throw new Error(`Could not find manifest ${fileName}.`);
}

export function normalizeManifest(manifest: UpdateManifest, cwd: string): UpdateManifest {
  validateManifest(manifest);
  return {
    ...manifest,
    currentVersionSource: {
      ...manifest.currentVersionSource,
      path: resolveFromCwd(cwd, manifest.currentVersionSource.path)
    },
    candidateVersionSource: manifest.candidateVersionSource
      ? {
          ...manifest.candidateVersionSource,
          path: resolveFromCwd(cwd, manifest.candidateVersionSource.path)
        }
      : undefined,
    statePath: resolveFromCwd(cwd, manifest.statePath) ?? manifest.statePath,
    auditLogPath: resolveFromCwd(cwd, manifest.auditLogPath) ?? manifest.auditLogPath,
    lockPath: resolveFromCwd(cwd, manifest.lockPath) ?? manifest.lockPath,
    installStrategy: normalizeInstallStrategy(manifest.installStrategy, cwd),
    preflightHooks: normalizeHooks(manifest.preflightHooks, cwd),
    migrationHooks: normalizeHooks(manifest.migrationHooks, cwd),
    compatibilityHooks: normalizeHooks(manifest.compatibilityHooks, cwd),
    verificationHooks: normalizeHooks(manifest.verificationHooks, cwd)
  };
}

function normalizeInstallStrategy(manifestInstallStrategy: UpdateManifest["installStrategy"], cwd: string) {
  if (manifestInstallStrategy.type === "archive_download") {
    return {
      ...manifestInstallStrategy,
      cwd: resolveFromCwd(cwd, manifestInstallStrategy.cwd),
      destinationPath: resolveFromCwd(cwd, manifestInstallStrategy.destinationPath) ?? manifestInstallStrategy.destinationPath
    };
  }

  return {
    ...manifestInstallStrategy,
    cwd: resolveFromCwd(cwd, manifestInstallStrategy.cwd)
  };
}

function normalizeHooks(hooks: UpdateManifest["preflightHooks"], cwd: string) {
  return hooks?.map((hook) => ({
    ...hook,
    cwd: resolveFromCwd(cwd, hook.cwd)
  }));
}

function validateManifest(manifest: UpdateManifest): void {
  if (!manifest.repo) throw new Error("Manifest requires repo.");
  if (!manifest.releaseChannel) throw new Error("Manifest requires releaseChannel.");
  if (!manifest.currentVersionSource?.type) {
    throw new Error("Manifest requires currentVersionSource.type.");
  }
  if (!manifest.installStrategy?.type) {
    throw new Error("Manifest requires installStrategy.type.");
  }
  if (!manifest.statePath) throw new Error("Manifest requires statePath.");
  if (!manifest.auditLogPath) throw new Error("Manifest requires auditLogPath.");
  if (!manifest.lockPath) throw new Error("Manifest requires lockPath.");
  if (manifest.installStrategy.type.endsWith("_package") && !("packageName" in manifest.installStrategy)) {
    throw new Error(`${manifest.installStrategy.type} requires packageName.`);
  }
  if (manifest.installStrategy.type === "archive_download" && !manifest.installStrategy.urlTemplate) {
    throw new Error("archive_download requires urlTemplate.");
  }
  if (!normalizeGithubRepo(`https://github.com/${manifest.repo}`)) {
    throw new Error(`Manifest repo must be a GitHub repo in owner/name form, got "${manifest.repo}".`);
  }
  validateArchiveStrategy(manifest);
}

function validateArchiveStrategy(manifest: UpdateManifest): void {
  if (manifest.installStrategy.type !== "archive_download") return;
  const strategy = manifest.installStrategy;
  if (!/^https?:\/\//i.test(strategy.urlTemplate)) {
    throw new Error("archive_download urlTemplate must use http or https.");
  }
  if (!strategy.checksumSha256 && !strategy.allowInsecureArchive) {
    throw new Error("archive_download requires checksumSha256 unless allowInsecureArchive is explicitly true.");
  }
  if (path.parse(strategy.destinationPath).root === strategy.destinationPath) {
    throw new Error("archive_download destinationPath cannot be a filesystem root.");
  }
  if (strategy.extract && !strategy.extractCommand && !inferArchiveType(strategy)) {
    throw new Error("archive_download with extract=true requires archiveType or extractCommand.");
  }
  if (strategy.extract && strategy.expectedExtractedPaths?.some((entry) => entry.startsWith(".."))) {
    throw new Error("archive_download expectedExtractedPaths cannot escape the destination directory.");
  }
}

export function inferArchiveType(strategy: Extract<UpdateManifest["installStrategy"], { type: "archive_download" }>): string | undefined {
  if (strategy.archiveType) return strategy.archiveType;
  const source = strategy.archiveFileNameTemplate ?? strategy.urlTemplate;
  if (source.endsWith(".tar.gz")) return "tar.gz";
  if (source.endsWith(".tgz")) return "tgz";
  if (source.endsWith(".tar")) return "tar";
  if (source.endsWith(".zip")) return "zip";
  return undefined;
}
