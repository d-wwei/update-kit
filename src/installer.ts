import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { executeOperations } from "./execution.js";
import { inferArchiveType } from "./manifest.js";
import type {
  ArchiveDownloadInstallStrategy,
  CommandExecutionResult,
  ExecutionOperation,
  ResolvedAdapterContext,
  UpdateCandidate,
  UpdateManifest
} from "./types.js";
import { renderCommandTemplate } from "./utils.js";

export function buildInstallOperations(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion: string;
  candidate?: UpdateCandidate;
}): ExecutionOperation[] {
  const { host, manifest, targetVersion, candidate } = params;
  const strategy = manifest.installStrategy;
  const cwd = strategy.cwd ?? host.cwd;

  if (manifest.installCommand) {
    return [{
      kind: "command",
      description: `Install ${targetVersion}`,
      command: manifest.installCommand,
      cwd,
      timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
      shell: typeof manifest.installCommand === "string",
      dangerous: true
    }];
  }

  if (strategy.type === "npm_package") {
    return [{
      kind: "command",
      description: `Install npm package ${strategy.packageName}@${targetVersion}`,
      command: ["npm", "install", `${strategy.packageName}@${targetVersion}`, ...(strategy.installArgs ?? [])],
      cwd,
      env: strategy.env,
      timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
      dangerous: true
    }];
  }

  if (strategy.type === "pnpm_package") {
    return [{
      kind: "command",
      description: `Install pnpm package ${strategy.packageName}@${targetVersion}`,
      command: ["pnpm", "add", `${strategy.packageName}@${targetVersion}`, ...(strategy.installArgs ?? [])],
      cwd,
      env: strategy.env,
      timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
      dangerous: true
    }];
  }

  if (strategy.type === "yarn_package") {
    return [{
      kind: "command",
      description: `Install yarn package ${strategy.packageName}@${targetVersion}`,
      command: ["yarn", "add", `${strategy.packageName}@${targetVersion}`, ...(strategy.installArgs ?? [])],
      cwd,
      env: strategy.env,
      timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
      dangerous: true
    }];
  }

  if (strategy.type === "pip_package") {
    return [{
      kind: "command",
      description: `Install pip package ${strategy.packageName}==${targetVersion}`,
      command: [
        strategy.pythonExecutable ?? "python",
        "-m",
        "pip",
        "install",
        `${strategy.packageName}==${targetVersion}`,
        ...(strategy.installArgs ?? [])
      ],
      cwd,
      env: strategy.env,
      timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
      dangerous: true
    }];
  }

  if (strategy.type === "git_pull") {
    const ref = strategy.refTemplate
      ? renderCommandTemplate(strategy.refTemplate, {
          version: targetVersion,
          targetVersion,
          ref: candidate?.ref ?? targetVersion
        })
      : candidate?.ref ?? targetVersion;

    const refValue = Array.isArray(ref) ? ref.join(" ") : ref;
    return [
      {
        kind: "command",
        description: `Fetch git refs for ${refValue}`,
        command: ["git", "fetch", strategy.remote ?? "origin", ...(strategy.fetchArgs ?? ["--tags", "--force"])],
        cwd,
        env: strategy.env,
        timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
        dangerous: true
      },
      {
        kind: "command",
        description: `Checkout ${refValue}`,
        command: ["git", "checkout", refValue],
        cwd,
        env: strategy.env,
        timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
        dangerous: true
      }
    ];
  }

  if (strategy.type === "archive_download") {
    const archiveType = inferArchiveType(strategy);
    const archiveName = strategy.archiveFileNameTemplate
      ? renderCommandTemplate(strategy.archiveFileNameTemplate, { version: targetVersion, targetVersion })
      : `${targetVersion}.${archiveType ?? "archive"}`;
    const archiveFile = path.join(strategy.destinationPath, Array.isArray(archiveName) ? archiveName.join("-") : archiveName);
    const operations: ExecutionOperation[] = [{
      kind: "download",
      description: `Download archive for ${targetVersion}`,
      url: strategy.urlTemplate,
      destination: archiveFile,
      dangerous: true
    }];

    if (strategy.extract) {
      const extractCommand = strategy.extractCommand ?? inferExtractCommand(archiveType, archiveFile, strategy.destinationPath);
      if (extractCommand) {
        operations.push({
          kind: "command",
          description: `Extract archive ${archiveFile}`,
          command: extractCommand,
          cwd,
          env: strategy.env,
          timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
          shell: typeof extractCommand === "string",
          dangerous: true
        });
      } else {
        operations.push({
          kind: "note",
          description: `Archive downloaded to ${archiveFile}; configure extractCommand to unpack it.`
        });
      }
    }
    return operations;
  }

  return [{
    kind: "command",
    description: `Run custom install command for ${targetVersion}`,
    command: strategy.command,
    cwd,
    env: strategy.env,
    timeoutMs: strategy.timeoutMs ?? manifest.timeouts?.installMs,
    shell: strategy.shell ?? typeof strategy.command === "string",
    dangerous: true
  }];
}

export async function executeInstall(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion: string;
  candidate?: UpdateCandidate;
}): Promise<{ operations: ExecutionOperation[]; outputs: CommandExecutionResult[] }> {
  if (params.manifest.installStrategy.type === "archive_download") {
    return executeArchiveInstall({
      host: params.host,
      manifest: params.manifest,
      currentVersion: params.currentVersion,
      targetVersion: params.targetVersion,
      candidate: params.candidate
    });
  }
  const operations = buildInstallOperations(params);
  const outputs = await executeOperations({
    operations,
    host: params.host,
    manifest: params.manifest,
    currentVersion: params.currentVersion,
    targetVersion: params.targetVersion,
    candidate: params.candidate
  });
  return { operations, outputs };
}

function inferExtractCommand(archiveType: string | undefined, archiveFile: string, destinationPath: string): string[] | undefined {
  if (archiveType === "zip" || archiveFile.endsWith(".zip")) return ["unzip", "-o", archiveFile, "-d", destinationPath];
  if (archiveType === "tar.gz" || archiveType === "tgz" || archiveFile.endsWith(".tar.gz") || archiveFile.endsWith(".tgz")) {
    return ["tar", "-xzf", archiveFile, "-C", destinationPath];
  }
  if (archiveType === "tar" || archiveFile.endsWith(".tar")) return ["tar", "-xf", archiveFile, "-C", destinationPath];
  return undefined;
}

async function executeArchiveInstall(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion: string;
  candidate?: UpdateCandidate;
}): Promise<{ operations: ExecutionOperation[]; outputs: CommandExecutionResult[] }> {
  const strategy = params.manifest.installStrategy as ArchiveDownloadInstallStrategy;
  const operations = buildInstallOperations(params);
  const archiveDownload = operations.find((operation) => operation.kind === "download");
  if (!archiveDownload || archiveDownload.kind !== "download") {
    throw new Error("Archive install requires a download operation.");
  }

  const archiveType = inferArchiveType(strategy);
  const archiveFile = renderArchiveDestination(params.targetVersion, strategy, archiveType);
  const downloadUrl = renderArchiveUrl(params.targetVersion, strategy);
  const outputs: CommandExecutionResult[] = [];

  const response = await params.host.fetchImpl(downloadUrl);
  if (!response.ok) {
    throw new Error(`Download failed for ${downloadUrl}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error(`Downloaded archive for ${params.targetVersion} is empty.`);
  }
  if (strategy.checksumSha256) {
    const checksum = createHash("sha256").update(buffer).digest("hex");
    if (checksum !== strategy.checksumSha256.toLowerCase()) {
      throw new Error(`Archive checksum mismatch for ${params.targetVersion}.`);
    }
  }

  await mkdir(path.dirname(archiveFile), { recursive: true });
  await writeFile(archiveFile, buffer);

  if (strategy.extract) {
    const extractCommand = strategy.extractCommand ?? inferExtractCommand(archiveType, archiveFile, strategy.destinationPath);
    if (!extractCommand) {
      throw new Error("Could not infer archive extraction command. Configure extractCommand.");
    }
    const result = await params.host.executor({
      command: extractCommand,
      cwd: strategy.cwd ?? params.host.cwd,
      env: strategy.env,
      timeoutMs: strategy.timeoutMs ?? params.manifest.timeouts?.installMs,
      shell: typeof extractCommand === "string",
      description: `Extract archive ${archiveFile}`,
      dangerous: true
    });
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || `Archive extraction failed for ${archiveFile}.`);
    }
    outputs.push(result);
    await verifyExtractedPaths(strategy);
  }

  return { operations, outputs };
}

function renderArchiveDestination(targetVersion: string, strategy: ArchiveDownloadInstallStrategy, archiveType: string | undefined): string {
  const archiveName = strategy.archiveFileNameTemplate
    ? renderCommandTemplate(strategy.archiveFileNameTemplate, { version: targetVersion, targetVersion })
    : `${targetVersion}.${archiveType ?? "archive"}`;
  return path.join(strategy.destinationPath, Array.isArray(archiveName) ? archiveName.join("-") : archiveName);
}

function renderArchiveUrl(targetVersion: string, strategy: ArchiveDownloadInstallStrategy): string {
  const rendered = renderCommandTemplate(strategy.urlTemplate, { version: targetVersion, targetVersion });
  return Array.isArray(rendered) ? rendered.join("") : rendered;
}

async function verifyExtractedPaths(strategy: ArchiveDownloadInstallStrategy): Promise<void> {
  for (const relativePath of strategy.expectedExtractedPaths ?? []) {
    const absolutePath = path.join(strategy.destinationPath, relativePath);
    await access(absolutePath).catch(() => {
      throw new Error(`Expected extracted path is missing: ${absolutePath}`);
    });
  }
}
