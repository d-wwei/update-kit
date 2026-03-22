import { executeOperations } from "./execution.js";
import { buildInstallOperations } from "./installer.js";
import type {
  CommandExecutionResult,
  ExecutionOperation,
  ResolvedAdapterContext,
  RollbackResult,
  UpdateManifest
} from "./types.js";

export function buildRollbackOperations(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion?: string;
}): ExecutionOperation[] {
  if (params.manifest.rollbackCommand) {
    return [{
      kind: "command",
      description: params.targetVersion
        ? `Rollback host to ${params.targetVersion}`
        : "Rollback host using configured rollbackCommand",
      command: params.manifest.rollbackCommand,
      cwd: params.host.cwd,
      timeoutMs: params.manifest.timeouts?.rollbackMs,
      shell: typeof params.manifest.rollbackCommand === "string",
      dangerous: true
    }];
  }

  if (!params.targetVersion) {
    return [{
      kind: "note",
      description: "No rollback command configured and no target version is known."
    }];
  }

  return buildInstallOperations({
    host: params.host,
    manifest: params.manifest,
    currentVersion: params.currentVersion,
    targetVersion: params.targetVersion
  }).map((operation) => operation.kind === "note"
    ? operation
    : { ...operation, description: `Rollback: ${operation.description}` });
}

export async function executeRollback(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion?: string;
}): Promise<RollbackResult> {
  const operations = buildRollbackOperations(params);
  if (!operations.some((operation) => operation.kind !== "note")) {
    return {
      ok: false,
      targetVersion: params.targetVersion,
      operations,
      outputs: [],
      message: "Rollback could not run because no rollback operation is configured.",
      error: { message: "No rollback operation configured." }
    };
  }

  try {
    const outputs = await executeOperations({
      operations,
      host: params.host,
      manifest: params.manifest,
      currentVersion: params.currentVersion,
      targetVersion: params.targetVersion
    });
    return {
      ok: true,
      targetVersion: params.targetVersion,
      operations,
      outputs,
      message: params.targetVersion
        ? `Rolled back to ${params.targetVersion}.`
        : "Rollback completed."
    };
  } catch (error) {
    return {
      ok: false,
      targetVersion: params.targetVersion,
      operations,
      outputs: [],
      message: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
    };
  }
}
