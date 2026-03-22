import type {
  UpdateCandidate,
  UpdateCheckResult,
  UpdateDecision,
  UpdateManifest,
  UpdatePolicy,
  UpdatePolicyMode,
  UpdateRiskLevel,
  UpdateState
} from "./types.js";
import { mergeUnique, toPolicy } from "./utils.js";

export function evaluatePolicy(
  manifest: UpdateManifest,
  state: UpdateState,
  candidate: UpdateCandidate | undefined,
  currentVersion: string
): UpdateCheckResult["policy"] {
  const effectivePolicy = getEffectivePolicy(manifest, state);
  if (!candidate) {
    return {
      effectivePolicy,
      autoApply: false,
      requiresConfirmation: false,
      ignored: false,
      reason: `No update available for ${currentVersion}.`
    };
  }

  const ignored = mergeIgnoredVersions(manifest, state).includes(candidate.version);
  if (ignored) {
    return {
      effectivePolicy,
      autoApply: false,
      requiresConfirmation: false,
      ignored: true,
      reason: `Version ${candidate.version} is ignored.`
    };
  }

  const autoApply = allowsRiskLevel(effectivePolicy, candidate.riskLevel);
  return {
    effectivePolicy,
    autoApply,
    requiresConfirmation: !autoApply,
    ignored: false,
    reason: autoApply
      ? `Policy ${effectivePolicy.mode} allows automatic ${candidate.riskLevel} updates.`
      : `Policy ${effectivePolicy.mode} requires confirmation for ${candidate.riskLevel} updates.`
  };
}

export function getEffectivePolicy(manifest: UpdateManifest, state: UpdateState): UpdatePolicy {
  const manifestPolicy = toPolicy(manifest.autoUpdatePolicy, manifest.allowedUpdateLevels);
  return {
    mode: state.autoUpdatePolicy.mode ?? manifestPolicy.mode,
    allowedUpdateLevels: state.autoUpdatePolicy.allowedUpdateLevels ?? manifestPolicy.allowedUpdateLevels
  };
}

export function allowsRiskLevel(policy: UpdatePolicy, riskLevel: UpdateRiskLevel): boolean {
  const allowed = new Set(getAllowedLevels(policy));
  if (riskLevel === "patch") return allowed.has("patch");
  if (riskLevel === "minor") return allowed.has("minor");
  if (riskLevel === "major") return allowed.has("major");
  return false;
}

export function getAllowedLevels(policy: UpdatePolicy): Array<"patch" | "minor" | "major"> {
  const defaultLevels: Array<"patch" | "minor" | "major"> = policy.mode === "manual"
    ? []
    : policy.mode === "patch"
      ? ["patch"]
      : policy.mode === "minor"
        ? ["patch", "minor"]
        : ["patch", "minor", "major"];

  if (!policy.allowedUpdateLevels?.length) return defaultLevels;
  return defaultLevels.filter((level) => policy.allowedUpdateLevels?.includes(level));
}

export function mergeIgnoredVersions(manifest: UpdateManifest, state: UpdateState): string[] {
  return mergeUnique([...(manifest.ignoredVersions ?? []), ...state.ignoredVersions]);
}

export function decisionFromPolicy(
  hasUpdate: boolean,
  candidate: UpdateCandidate | undefined,
  policyResult: ReturnType<typeof evaluatePolicy>
): UpdateDecision {
  if (!hasUpdate || !candidate) return "no_update_required";
  if (policyResult.ignored) return "ignored_by_policy";
  if (policyResult.autoApply) return "auto_update";
  return "update_once";
}

export function widenPolicyMode(currentMode: UpdatePolicyMode, riskLevel: UpdateRiskLevel): UpdatePolicyMode {
  const targetMode = riskLevel === "patch"
    ? "patch"
    : riskLevel === "minor"
      ? "minor"
      : "all";
  return modeOrder(currentMode) >= modeOrder(targetMode) ? currentMode : targetMode;
}

function modeOrder(mode: UpdatePolicyMode): number {
  return mode === "manual" ? 0 : mode === "patch" ? 1 : mode === "minor" ? 2 : 3;
}
