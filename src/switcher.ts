import { executeOperations } from "./execution.js";
import type {
  CommandExecutionResult,
  ExecutionOperation,
  ResolvedAdapterContext,
  SwitchResult,
  UpdateCandidate,
  UpdateManifest
} from "./types.js";

export function buildSwitchOperations(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  targetVersion: string;
}): ExecutionOperation[] {
  if (!params.manifest.switchCommand) {
    return [{
      kind: "note",
      description: "No switchCommand configured; install strategy is assumed to switch in place."
    }];
  }

  return [{
    kind: "command",
    description: `Switch host to ${params.targetVersion}`,
    command: params.manifest.switchCommand,
    cwd: params.host.cwd,
    timeoutMs: params.manifest.timeouts?.switchMs,
    shell: typeof params.manifest.switchCommand === "string",
    dangerous: true
  }];
}

export async function executeSwitch(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion: string;
  candidate?: UpdateCandidate;
}): Promise<SwitchResult> {
  const operations = buildSwitchOperations(params);
  const outputs = await executeOperations({
    operations,
    host: params.host,
    manifest: params.manifest,
    currentVersion: params.currentVersion,
    targetVersion: params.targetVersion,
    candidate: params.candidate
  });

  return {
    ok: true,
    operations,
    outputs,
    message: `Switched host to ${params.targetVersion}.`
  };
}
