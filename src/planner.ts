import { buildInstallOperations } from "./installer.js";
import { buildRollbackOperations } from "./rollback.js";
import { buildSwitchOperations } from "./switcher.js";
import type {
  ExecutionOperation,
  HookDefinition,
  ResolvedAdapterContext,
  UpdateCandidate,
  UpdateDecision,
  UpdateManifest,
  UpdatePlan
} from "./types.js";

export function createUpdatePlan(params: {
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  candidate?: UpdateCandidate;
  decision: UpdateDecision;
  dryRun: boolean;
  requiresConfirmation: boolean;
  reason: string;
  rollbackVersion?: string;
}): UpdatePlan {
  const targetVersion = params.candidate?.version;
  return {
    componentName: params.host.componentName ?? params.host.appName,
    repo: params.manifest.repo,
    currentVersion: params.currentVersion,
    targetVersion,
    decision: params.decision,
    dryRun: params.dryRun,
    riskLevel: params.candidate?.riskLevel ?? "none",
    requiresConfirmation: params.requiresConfirmation,
    steps: [
      buildHookStep("preflight", "Run preflight checks", params.manifest.preflightHooks),
      {
        name: "install",
        description: "Install or fetch the candidate version",
        operations: targetVersion
          ? buildInstallOperations({
              host: params.host,
              manifest: params.manifest,
              currentVersion: params.currentVersion,
              targetVersion,
              candidate: params.candidate
            })
          : [{ kind: "note", description: "No candidate available." }]
      },
      buildHookStep("migration", "Run migration hooks", params.manifest.migrationHooks),
      buildHookStep("compatibility", "Run compatibility hooks", params.manifest.compatibilityHooks),
      buildHookStep(
        "verification_before_switch",
        "Run pre-switch verification hooks",
        (params.manifest.verificationHooks ?? []).filter((hook) => (hook.phase ?? "after_switch") === "before_switch")
      ),
      {
        name: "switch",
        description: "Switch host to the candidate version",
        operations: targetVersion
          ? buildSwitchOperations({
              host: params.host,
              manifest: params.manifest,
              targetVersion
            })
          : [{ kind: "note", description: "No candidate available." }]
      },
      buildHookStep(
        "verification_after_switch",
        "Run post-switch verification hooks",
        (params.manifest.verificationHooks ?? []).filter((hook) => (hook.phase ?? "after_switch") === "after_switch")
      )
    ],
    rollbackPreview: buildRollbackOperations({
      host: params.host,
      manifest: params.manifest,
      currentVersion: targetVersion ?? params.currentVersion,
      targetVersion: params.rollbackVersion
    }),
    reason: params.reason
  };
}

function buildHookStep(
  name: UpdatePlan["steps"][number]["name"],
  description: string,
  hooks: HookDefinition[] | undefined
): UpdatePlan["steps"][number] {
  const operations: ExecutionOperation[] = (hooks ?? []).map((hook, index) => ({
    kind: "note",
    description: hook.description ?? hook.id ?? `${name}_hook_${index + 1}`
  }));
  return {
    name,
    description,
    operations: operations.length ? operations : [{ kind: "note", description: "No hooks configured." }]
  };
}
