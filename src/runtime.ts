import { resolveAdapterContext } from "./adapter.js";
import { createUpdateCheckCache } from "./cache.js";
import { detectCurrentVersion, detectLocalCandidateVersion, detectUpdateCandidate } from "./detector.js";
import { filterVerificationHooks, runHooks } from "./hooks.js";
import { executeInstall } from "./installer.js";
import { resolveManifest } from "./manifest.js";
import { createUpdatePlan } from "./planner.js";
import {
  decisionFromPolicy,
  evaluatePolicy,
  getEffectivePolicy,
  mergeIgnoredVersions,
  widenPolicyMode
} from "./policy.js";
import { executeRollback } from "./rollback.js";
import { advanceSnooze, computeSnoozeExpiry, isSnoozeActive } from "./snooze.js";
import { ensureState, touchState } from "./state.js";
import { executeSwitch } from "./switcher.js";
import type {
  AdapterContextOverrides,
  ApplyOptions,
  ApplyResult,
  AuditRecord,
  AuditStep,
  AuditStatus,
  CheckOptions,
  GetAuditOptions,
  PlanOptions,
  PreflightResult,
  QuickCheckOptions,
  QuickCheckResult,
  ResolvedAdapterContext,
  RollbackOptions,
  RollbackResult,
  RuntimeOptions,
  ResolvedManifestInfo,
  SnoozeOptions,
  UpdateAdapter,
  UpdateCandidate,
  UpdateCheckResult,
  UpdateConfirmationPrompt,
  UpdateDecision,
  UpdateManifest,
  UpdatePlan,
  UpdateState,
  VerificationResult
} from "./types.js";
import { createId, serializeError, toJsonRecord } from "./utils.js";

type PreparedSession = {
  resolved: ResolvedAdapterContext;
  state: UpdateState;
  currentVersion: string;
  localCandidateVersion?: string;
  candidate?: UpdateCandidate;
  checkResult: UpdateCheckResult;
};

export class UpdateRuntime {
  readonly cwd: string;
  readonly manifest: UpdateManifest;
  readonly manifestInfo: ResolvedManifestInfo;

  constructor(options: { cwd: string; manifest: UpdateManifest; manifestInfo: ResolvedManifestInfo }) {
    this.cwd = options.cwd;
    this.manifest = options.manifest;
    this.manifestInfo = options.manifestInfo;
  }

  async check(adapter: UpdateAdapter, options: CheckOptions = {}): Promise<UpdateCheckResult> {
    const prepared = await this.prepare(adapter, options);
    if (options.persist !== false) {
      await this.writeAudit(prepared.resolved, "detection_started", "started", "Starting update detection.", {
        currentVersion: prepared.currentVersion
      });
      const nextState = this.buildDetectionState(prepared);
      await prepared.resolved.stateStore.write(nextState);
      await this.writeAudit(prepared.resolved, "detection_completed", "completed", "Update detection completed.", {
        currentVersion: prepared.currentVersion,
        candidateVersion: prepared.candidate?.version,
        hasUpdate: prepared.checkResult.hasUpdate,
        ignored: prepared.checkResult.policy.ignored
      });
      prepared.checkResult.state = nextState;
    }
    return prepared.checkResult;
  }

  async quickCheck(adapter: UpdateAdapter, options: QuickCheckOptions = {}): Promise<QuickCheckResult> {
    if (this.manifest.updateCheckEnabled === false) {
      return { status: "disabled", message: "Update checking is disabled." };
    }

    const softFail = options.softFail ?? true;

    try {
      const resolved = await resolveAdapterContext(adapter, this.manifest, options);
      const state = await ensureState(resolved.stateStore, this.manifest, resolved);
      const currentVersion = await detectCurrentVersion(resolved, this.manifest);

      if (state.justUpgradedFrom) {
        const previousVersion = state.justUpgradedFrom;
        const nextState = touchState(state, { justUpgradedFrom: undefined });
        await resolved.stateStore.write(nextState);
        return {
          status: "just_upgraded",
          currentVersion,
          previousVersion,
          message: `Just upgraded from ${previousVersion} to ${currentVersion}.`
        };
      }

      if (state.snooze && isSnoozeActive(state.snooze, this.manifest.snoozeDurations)) {
        return {
          status: "snoozed",
          currentVersion,
          candidateVersion: state.snooze.version,
          snoozeLevel: state.snooze.level,
          snoozeExpiresAt: computeSnoozeExpiry(state.snooze, this.manifest.snoozeDurations).toISOString(),
          message: `Version ${state.snooze.version} is snoozed (level ${state.snooze.level}).`
        };
      }

      const cache = createUpdateCheckCache(this.manifest, this.cwd);
      if (!options.force) {
        const cached = await cache.read();
        if (cached && cache.isFresh(cached, currentVersion, this.manifest.cache)) {
          return {
            status: cached.status,
            currentVersion: cached.currentVersion,
            candidateVersion: cached.candidateVersion,
            cachedAt: cached.cachedAt,
            message: cached.status === "up_to_date"
              ? `Up to date at ${cached.currentVersion} (cached).`
              : `Update available: ${cached.candidateVersion} (cached).`
          };
        }
      } else {
        await cache.invalidate();
      }

      const detection = await detectUpdateCandidate(resolved, this.manifest, resolved.fetchImpl);

      let updatedState = touchState(state, {
        candidateVersion: detection.candidate?.version,
        lastCheckedAt: new Date().toISOString()
      });

      if (state.snooze && detection.candidate && state.snooze.version !== detection.candidate.version) {
        updatedState = touchState(updatedState, { snooze: undefined });
      }

      await resolved.stateStore.write(updatedState);

      await cache.write({
        status: detection.summary.hasUpdate ? "upgrade_available" : "up_to_date",
        currentVersion: detection.summary.currentVersion,
        candidateVersion: detection.candidate?.version,
        cachedAt: new Date().toISOString(),
        localVersionAtCache: currentVersion
      });

      return {
        status: detection.summary.hasUpdate ? "upgrade_available" : "up_to_date",
        currentVersion: detection.summary.currentVersion,
        candidateVersion: detection.candidate?.version,
        message: detection.summary.message
      };
    } catch (error) {
      if (softFail) {
        return {
          status: "error",
          message: `Check failed (soft): ${error instanceof Error ? error.message : String(error)}`
        };
      }
      throw error;
    }
  }

  async snooze(adapter: UpdateAdapter, options: SnoozeOptions = {}): Promise<UpdateState> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    const targetVersion = options.version ?? state.candidateVersion;
    if (!targetVersion) {
      throw new Error("No version to snooze. Provide a version or run check first.");
    }
    const nextSnooze = advanceSnooze(state.snooze, targetVersion);
    const nextState = touchState(state, { snooze: nextSnooze });
    await resolved.stateStore.write(nextState);
    return nextState;
  }

  async plan(adapter: UpdateAdapter, options: PlanOptions = {}): Promise<UpdatePlan> {
    const prepared = await this.prepare(adapter, options);
    const decision = options.decision ?? decisionFromPolicy(
      prepared.checkResult.hasUpdate,
      prepared.candidate,
      prepared.checkResult.policy
    );
    return createUpdatePlan({
      host: prepared.resolved,
      manifest: this.manifest,
      currentVersion: prepared.currentVersion,
      candidate: prepared.candidate,
      decision,
      dryRun: options.dryRun ?? false,
      requiresConfirmation: prepared.checkResult.policy.requiresConfirmation,
      reason: prepared.checkResult.policy.reason,
      rollbackVersion: prepared.state.stableVersion ?? prepared.currentVersion
    });
  }

  async apply(adapter: UpdateAdapter, options: ApplyOptions = {}): Promise<ApplyResult> {
    const prepared = options.preChecked
      ? await this.prepareFromCheckResult(adapter, options, options.preChecked)
      : await this.prepare(adapter, options);
    const executionId = createId("apply");
    let state = this.buildDetectionState(prepared);
    const dryRun = options.dryRun ?? false;

    if (!dryRun) {
      await this.writeAudit(prepared.resolved, "detection_started", "started", "Starting update detection.", {
        executionId,
        currentVersion: prepared.currentVersion
      });
      await this.writeAudit(prepared.resolved, "detection_completed", "completed", "Update detection completed.", {
        executionId,
        currentVersion: prepared.currentVersion,
        candidateVersion: prepared.candidate?.version,
        hasUpdate: prepared.checkResult.hasUpdate
      });
    }

    const decision = await this.resolveDecision(prepared, options);
    const effectiveDecision: UpdateDecision = decision ?? decisionFromPolicy(
      prepared.checkResult.hasUpdate,
      prepared.candidate,
      prepared.checkResult.policy
    );

    if (effectiveDecision === "no_update_required" || effectiveDecision === "ignored_by_policy") {
      const message = effectiveDecision === "ignored_by_policy"
        ? `Version ${prepared.candidate?.version} is ignored.`
        : `No update available for ${prepared.currentVersion}.`;
      if (!dryRun) {
        state = touchState(state, {
          lastExecution: {
            id: executionId,
            status: "skipped",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            decision: effectiveDecision,
            fromVersion: prepared.currentVersion
          }
        });
        await prepared.resolved.stateStore.write(state);
        await this.writeAudit(prepared.resolved, "decision_recorded", "completed", message, {
          executionId,
          decision: effectiveDecision
        }, effectiveDecision, prepared.currentVersion, prepared.candidate?.version);
      }
      return {
        ok: true,
        status: "skipped",
        executionId,
        decision: effectiveDecision,
        dryRun,
        currentVersion: prepared.currentVersion,
        targetVersion: prepared.candidate?.version,
        state,
        message
      };
    }

    if (effectiveDecision === "ignore_this_version" && prepared.candidate) {
      state = touchState(state, {
        ignoredVersions: mergeIgnoredVersions(this.manifest, state).concat(prepared.candidate.version)
      });
      if (!dryRun) {
        await prepared.resolved.stateStore.write(state);
        await this.writeAudit(
          prepared.resolved,
          "decision_recorded",
          "completed",
          `Ignoring version ${prepared.candidate.version}.`,
          { executionId, decision: effectiveDecision },
          effectiveDecision,
          prepared.currentVersion,
          prepared.candidate.version
        );
      }
      return {
        ok: true,
        status: dryRun ? "dry_run" : "skipped",
        executionId,
        decision: effectiveDecision,
        dryRun,
        currentVersion: prepared.currentVersion,
        targetVersion: prepared.candidate.version,
        state,
        message: `Ignored version ${prepared.candidate.version}.`
      };
    }

    if (effectiveDecision === "skip_this_time") {
      if (!dryRun) {
        await this.writeAudit(
          prepared.resolved,
          "decision_recorded",
          "completed",
          "Update skipped for this run.",
          { executionId, decision: effectiveDecision },
          effectiveDecision,
          prepared.currentVersion,
          prepared.candidate?.version
        );
      }
      return {
        ok: true,
        status: dryRun ? "dry_run" : "skipped",
        executionId,
        decision: effectiveDecision,
        dryRun,
        currentVersion: prepared.currentVersion,
        targetVersion: prepared.candidate?.version,
        state,
        message: "Update skipped for this run."
      };
    }

    if (effectiveDecision === "always_auto_update") {
      state = touchState(state, {
        autoUpdatePolicy: {
          ...getEffectivePolicy(this.manifest, state),
          mode: widenPolicyMode(state.autoUpdatePolicy.mode, prepared.candidate?.riskLevel ?? "major")
        }
      });
    }

    const normalizedDecision: UpdateDecision =
      effectiveDecision === "always_auto_update" || effectiveDecision === "update_once"
        ? effectiveDecision
        : effectiveDecision === "auto_update"
          ? "auto_update"
          : "update_once";

    const plan = createUpdatePlan({
      host: prepared.resolved,
      manifest: this.manifest,
      currentVersion: prepared.currentVersion,
      candidate: prepared.candidate,
      decision: normalizedDecision,
      dryRun,
      requiresConfirmation: prepared.checkResult.policy.requiresConfirmation,
      reason: prepared.checkResult.policy.reason,
      rollbackVersion: state.stableVersion ?? prepared.currentVersion
    });

    if (dryRun) {
      return {
        ok: true,
        status: "dry_run",
        executionId,
        decision: normalizedDecision,
        dryRun: true,
        currentVersion: prepared.currentVersion,
        targetVersion: prepared.candidate?.version,
        plan,
        state,
        message: "Dry-run completed. No update actions were executed."
      };
    }

    await prepared.resolved.stateStore.write(state);
    await this.writeAudit(
      prepared.resolved,
      "decision_recorded",
      "completed",
      `Decision recorded: ${normalizedDecision}.`,
      { executionId, decision: normalizedDecision },
      normalizedDecision,
      prepared.currentVersion,
      prepared.candidate?.version
    );
    await this.writeAudit(
      prepared.resolved,
      "plan_created",
      "completed",
      "Update plan created.",
      { executionId, steps: plan.steps.length },
      normalizedDecision,
      prepared.currentVersion,
      prepared.candidate?.version
    );

    const lock = await prepared.resolved.lockManager.acquire({
      executionId,
      repo: this.manifest.repo,
      componentName: prepared.resolved.componentName ?? prepared.resolved.appName
    });

    try {
      state = touchState(state, {
        lastExecution: {
          id: executionId,
          status: "running",
          startedAt: new Date().toISOString(),
          decision: normalizedDecision,
          fromVersion: prepared.currentVersion,
          toVersion: prepared.candidate?.version
        }
      });
      await prepared.resolved.stateStore.write(state);

      const preflight = await this.runPreflight(prepared, executionId, normalizedDecision);
      if (!preflight.ok) {
        return await this.finalizeFailure({
          prepared,
          state,
          executionId,
          decision: normalizedDecision,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version,
          plan,
          message: preflight.message,
          preflight
        });
      }

      await this.writeAudit(
        prepared.resolved,
        "install_started",
        "started",
        `Installing ${prepared.candidate?.version}.`,
        { executionId },
        normalizedDecision,
        prepared.currentVersion,
        prepared.candidate?.version
      );
      try {
        await executeInstall({
          host: prepared.resolved,
          manifest: this.manifest,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version ?? prepared.currentVersion,
          candidate: prepared.candidate
        });
      } catch (error) {
        await this.writeAudit(
          prepared.resolved,
          "install_failed",
          "failed",
          `Install failed: ${serializeError(error).message}`,
          { executionId },
          normalizedDecision,
          prepared.currentVersion,
          prepared.candidate?.version
        );
        return await this.finalizeFailure({
          prepared,
          state,
          executionId,
          decision: normalizedDecision,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version,
          plan,
          message: serializeError(error).message,
          preflight,
          shouldRollback: true
        });
      }
      await this.writeAudit(
        prepared.resolved,
        "install_completed",
        "completed",
        `Installed ${prepared.candidate?.version}.`,
        { executionId },
        normalizedDecision,
        prepared.currentVersion,
        prepared.candidate?.version
      );

      const migration = await this.runHookStage("migration", prepared, executionId, normalizedDecision);
      if (!migration.ok) {
        return await this.finalizeFailure({
          prepared,
          state,
          executionId,
          decision: normalizedDecision,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version,
          plan,
          message: "Migration failed.",
          preflight,
          migration: migration.results,
          shouldRollback: true
        });
      }

      const compatibility = await this.runHookStage("compatibility", prepared, executionId, normalizedDecision);
      if (!compatibility.ok) {
        return await this.finalizeFailure({
          prepared,
          state,
          executionId,
          decision: normalizedDecision,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version,
          plan,
          message: "Compatibility checks failed.",
          preflight,
          migration: migration.results,
          compatibility: compatibility.results,
          shouldRollback: true
        });
      }

      const verificationBeforeSwitch = await this.runVerification("before_switch", prepared, executionId, normalizedDecision);
      if (!verificationBeforeSwitch.ok) {
        return await this.finalizeFailure({
          prepared,
          state,
          executionId,
          decision: normalizedDecision,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version,
          plan,
          message: verificationBeforeSwitch.message,
          preflight,
          migration: migration.results,
          compatibility: compatibility.results,
          verificationBeforeSwitch,
          shouldRollback: true
        });
      }

      await this.writeAudit(
        prepared.resolved,
        "switch_started",
        "started",
        `Switching host to ${prepared.candidate?.version}.`,
        { executionId },
        normalizedDecision,
        prepared.currentVersion,
        prepared.candidate?.version
      );
      let switchResult;
      try {
        switchResult = await executeSwitch({
          host: prepared.resolved,
          manifest: this.manifest,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version ?? prepared.currentVersion,
          candidate: prepared.candidate
        });
      } catch (error) {
        await this.writeAudit(
          prepared.resolved,
          "switch_failed",
          "failed",
          `Switch failed: ${serializeError(error).message}`,
          { executionId },
          normalizedDecision,
          prepared.currentVersion,
          prepared.candidate?.version
        );
        return await this.finalizeFailure({
          prepared,
          state,
          executionId,
          decision: normalizedDecision,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version,
          plan,
          message: serializeError(error).message,
          preflight,
          migration: migration.results,
          compatibility: compatibility.results,
          verificationBeforeSwitch,
          shouldRollback: true
        });
      }
      await this.writeAudit(
        prepared.resolved,
        "switch_completed",
        "completed",
        `Switch completed for ${prepared.candidate?.version}.`,
        { executionId },
        normalizedDecision,
        prepared.currentVersion,
        prepared.candidate?.version
      );

      const verificationAfterSwitch = await this.runVerification("after_switch", prepared, executionId, normalizedDecision);
      if (!verificationAfterSwitch.ok) {
        return await this.finalizeFailure({
          prepared,
          state,
          executionId,
          decision: normalizedDecision,
          currentVersion: prepared.currentVersion,
          targetVersion: prepared.candidate?.version,
          plan,
          message: verificationAfterSwitch.message,
          preflight,
          migration: migration.results,
          compatibility: compatibility.results,
          verificationBeforeSwitch,
          verificationAfterSwitch,
          switchResult,
          shouldRollback: true
        });
      }

      state = touchState(state, {
        currentVersion: prepared.candidate?.version,
        stableVersion: prepared.candidate?.version,
        previousStableVersion: prepared.currentVersion,
        candidateVersion: undefined,
        lastSuccessfulVersion: prepared.candidate?.version,
        lastSuccessfulAt: new Date().toISOString(),
        lastFailureReason: undefined,
        justUpgradedFrom: prepared.currentVersion,
        snooze: undefined,
        lastExecution: {
          id: executionId,
          status: "succeeded",
          startedAt: state.lastExecution?.startedAt,
          completedAt: new Date().toISOString(),
          decision: normalizedDecision,
          fromVersion: prepared.currentVersion,
          toVersion: prepared.candidate?.version
        }
      });
      await prepared.resolved.stateStore.write(state);
      await this.writeAudit(
        prepared.resolved,
        "apply_completed",
        "completed",
        `Applied update ${prepared.currentVersion} -> ${prepared.candidate?.version}.`,
        { executionId },
        normalizedDecision,
        prepared.currentVersion,
        prepared.candidate?.version
      );

      return {
        ok: true,
        status: "succeeded",
        executionId,
        decision: normalizedDecision,
        dryRun: false,
        currentVersion: prepared.currentVersion,
        targetVersion: prepared.candidate?.version,
        plan,
        preflight,
        migration: migration.results,
        compatibility: compatibility.results,
        verificationBeforeSwitch,
        verificationAfterSwitch,
        switchResult,
        state,
        message: `Applied update ${prepared.currentVersion} -> ${prepared.candidate?.version}.`
      };
    } finally {
      await lock.release();
    }
  }

  async rollback(adapter: UpdateAdapter, options: RollbackOptions = {}): Promise<RollbackResult> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    const currentVersion = await detectCurrentVersion(resolved, this.manifest);
    const targetVersion = options.version ?? state.previousStableVersion ?? state.stableVersion;

    if (options.dryRun) {
      return {
        ok: true,
        targetVersion,
        operations: [],
        outputs: [],
        message: targetVersion
          ? `Dry-run: rollback would target ${targetVersion}.`
          : "Dry-run: rollback target could not be determined."
      };
    }

    const lock = await resolved.lockManager.acquire({
      executionId: createId("rollback"),
      repo: this.manifest.repo
    });
    try {
      await this.writeAudit(resolved, "rollback_started", "started", "Starting manual rollback.", {
        targetVersion
      });
      const result = await executeRollback({
        host: resolved,
        manifest: this.manifest,
        currentVersion,
        targetVersion
      });
      if (result.ok) {
        const nextState = touchState(state, {
          currentVersion: targetVersion,
          stableVersion: targetVersion,
          lastSuccessfulVersion: targetVersion,
          lastSuccessfulAt: new Date().toISOString(),
          lastExecution: {
            id: createId("rollback_state"),
            status: "rolled_back",
            completedAt: new Date().toISOString(),
            fromVersion: currentVersion,
            toVersion: targetVersion
          }
        });
        await resolved.stateStore.write(nextState);
        await this.writeAudit(resolved, "rollback_completed", "completed", result.message, {
          targetVersion
        });
      } else {
        await this.writeAudit(resolved, "rollback_failed", "failed", result.message, {
          targetVersion
        });
      }
      return result;
    } finally {
      await lock.release();
    }
  }

  async getState(adapter: UpdateAdapter, options: AdapterContextOverrides = {}): Promise<UpdateState> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    const currentVersion = await detectCurrentVersion(resolved, this.manifest).catch(() => state.currentVersion);
    const localCandidateVersion = await detectLocalCandidateVersion(resolved, this.manifest).catch(() => state.localCandidateVersion);
    const nextState = touchState(state, {
      currentVersion,
      stableVersion: state.stableVersion ?? currentVersion,
      localCandidateVersion,
      autoUpdatePolicy: getEffectivePolicy(this.manifest, state),
      ignoredVersions: mergeIgnoredVersions(this.manifest, state)
    });
    await resolved.stateStore.write(nextState);
    return nextState;
  }

  async getAudit(adapter: UpdateAdapter, options: GetAuditOptions = {}): Promise<AuditRecord[]> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    return resolved.auditWriter.list({ limit: options.limit });
  }

  async getPolicy(adapter: UpdateAdapter, options: AdapterContextOverrides = {}): Promise<UpdateState["autoUpdatePolicy"]> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    return getEffectivePolicy(this.manifest, state);
  }

  async setPolicy(
    adapter: UpdateAdapter,
    mode: UpdateState["autoUpdatePolicy"]["mode"],
    options: AdapterContextOverrides = {}
  ): Promise<UpdateState> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    const nextState = touchState(state, {
      autoUpdatePolicy: {
        ...getEffectivePolicy(this.manifest, state),
        mode
      }
    });
    await resolved.stateStore.write(nextState);
    return nextState;
  }

  async ignoreVersion(adapter: UpdateAdapter, version: string, options: AdapterContextOverrides = {}): Promise<UpdateState> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    const nextState = touchState(state, {
      ignoredVersions: Array.from(new Set([...mergeIgnoredVersions(this.manifest, state), version]))
    });
    await resolved.stateStore.write(nextState);
    return nextState;
  }

  async unignoreVersion(adapter: UpdateAdapter, version: string, options: AdapterContextOverrides = {}): Promise<UpdateState> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    const nextState = touchState(state, {
      ignoredVersions: mergeIgnoredVersions(this.manifest, state).filter((entry) => entry !== version)
    });
    await resolved.stateStore.write(nextState);
    return nextState;
  }

  private async prepareFromCheckResult(
    adapter: UpdateAdapter,
    options: AdapterContextOverrides,
    checkResult: UpdateCheckResult
  ): Promise<PreparedSession> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    return {
      resolved,
      state,
      currentVersion: checkResult.currentVersion,
      localCandidateVersion: checkResult.localCandidateVersion,
      candidate: checkResult.candidate,
      checkResult
    };
  }

  private async prepare(
    adapter: UpdateAdapter,
    options: AdapterContextOverrides = {}
  ): Promise<PreparedSession> {
    const resolved = await resolveAdapterContext(adapter, this.manifest, options);
    const state = await ensureState(resolved.stateStore, this.manifest, resolved);
    const currentVersion = await detectCurrentVersion(resolved, this.manifest);
    const localCandidateVersion = await detectLocalCandidateVersion(resolved, this.manifest);
    const detection = await detectUpdateCandidate(resolved, this.manifest, resolved.fetchImpl);
    const policy = evaluatePolicy(this.manifest, state, detection.candidate, currentVersion);

    return {
      resolved,
      state,
      currentVersion,
      localCandidateVersion,
      candidate: detection.candidate,
      checkResult: {
        ...detection.summary,
        ignored: policy.ignored,
        message: policy.ignored
          ? `Version ${detection.candidate?.version} is ignored.`
          : detection.summary.message,
        candidate: detection.candidate,
        policy,
        state,
        localCandidateVersion
      }
    };
  }

  private buildDetectionState(prepared: PreparedSession): UpdateState {
    return touchState(prepared.state, {
      currentVersion: prepared.currentVersion,
      stableVersion: prepared.state.stableVersion ?? prepared.currentVersion,
      candidateVersion: prepared.candidate?.version,
      lastCandidateVersion: prepared.candidate?.version ?? prepared.state.lastCandidateVersion,
      localCandidateVersion: prepared.localCandidateVersion,
      lastCheckedAt: prepared.checkResult.checkedAt,
      autoUpdatePolicy: getEffectivePolicy(this.manifest, prepared.state),
      ignoredVersions: mergeIgnoredVersions(this.manifest, prepared.state)
    });
  }

  private async resolveDecision(
    prepared: PreparedSession,
    options: ApplyOptions
  ): Promise<UpdateDecision | undefined> {
    if (!prepared.checkResult.hasUpdate) return "no_update_required";
    if (prepared.checkResult.policy.ignored) return "ignored_by_policy";
    if (options.decision) return options.decision;
    if (prepared.checkResult.policy.autoApply) return "auto_update";
    if (options.dryRun) return "update_once";
    if (!prepared.resolved.confirm) {
      throw new Error("Update confirmation is required but adapter.confirm was not provided.");
    }
    return prepared.resolved.confirm(this.createPrompt(prepared));
  }

  private createPrompt(prepared: PreparedSession): UpdateConfirmationPrompt {
    return {
      kind: "update",
      title: `Apply update for ${prepared.resolved.componentName ?? prepared.resolved.appName}?`,
      summary: `${prepared.currentVersion} -> ${prepared.candidate?.version} (${prepared.candidate?.riskLevel ?? "unknown"})`,
      currentVersion: prepared.currentVersion,
      candidateVersion: prepared.candidate?.version ?? prepared.currentVersion,
      riskLevel: prepared.candidate?.riskLevel ?? "unknown",
      repo: this.manifest.repo,
      options: ["update_once", "always_auto_update", "skip_this_time", "ignore_this_version"],
      highlights: prepared.checkResult.highlights,
      releaseUrl: prepared.checkResult.releaseUrl
    };
  }

  private async runPreflight(
    prepared: PreparedSession,
    executionId: string,
    decision: UpdateDecision
  ): Promise<PreflightResult> {
    const definitions = this.manifest.preflightHooks ?? [];
    const result = await runHooks({
      stage: "preflight",
      definitions,
      host: prepared.resolved,
      manifest: this.manifest,
      currentVersion: prepared.currentVersion,
      targetVersion: prepared.candidate?.version,
      candidate: prepared.candidate
    });
    await this.writeAudit(
      prepared.resolved,
      result.ok ? "preflight_passed" : "preflight_failed",
      result.ok ? "completed" : "failed",
      result.ok ? "Preflight checks passed." : "Preflight checks failed.",
      { executionId, hooks: definitions.length },
      decision,
      prepared.currentVersion,
      prepared.candidate?.version
    );
    return {
      ok: result.ok,
      stage: "preflight",
      results: result.results,
      message: result.ok ? "Preflight checks passed." : "Preflight checks failed."
    };
  }

  private async runHookStage(
    stage: "migration" | "compatibility",
    prepared: PreparedSession,
    executionId: string,
    decision: UpdateDecision
  ): Promise<{ ok: boolean; results: VerificationResult["results"] }> {
    const definitions = stage === "migration"
      ? this.manifest.migrationHooks ?? []
      : this.manifest.compatibilityHooks ?? [];
    const startedStep = stage === "migration" ? "migration_started" : "compatibility_started";
    const completedStep = stage === "migration" ? "migration_completed" : "compatibility_completed";
    const failedStep = stage === "migration" ? "migration_failed" : "compatibility_failed";
    await this.writeAudit(prepared.resolved, startedStep, "started", `${capitalize(stage)} started.`, {
      executionId,
      hooks: definitions.length
    }, decision, prepared.currentVersion, prepared.candidate?.version);
    const result = await runHooks({
      stage,
      definitions,
      host: prepared.resolved,
      manifest: this.manifest,
      currentVersion: prepared.currentVersion,
      targetVersion: prepared.candidate?.version,
      candidate: prepared.candidate
    });
    await this.writeAudit(
      prepared.resolved,
      result.ok ? completedStep : failedStep,
      result.ok ? "completed" : "failed",
      result.ok ? `${capitalize(stage)} completed.` : `${capitalize(stage)} failed.`,
      { executionId, hooks: definitions.length },
      decision,
      prepared.currentVersion,
      prepared.candidate?.version
    );
    return result;
  }

  private async runVerification(
    phase: "before_switch" | "after_switch",
    prepared: PreparedSession,
    executionId: string,
    decision: UpdateDecision
  ): Promise<VerificationResult> {
    const definitions = filterVerificationHooks(this.manifest.verificationHooks, phase);
    await this.writeAudit(prepared.resolved, "verification_started", "started", `Verification ${phase} started.`, {
      executionId,
      phase,
      hooks: definitions.length
    }, decision, prepared.currentVersion, prepared.candidate?.version);
    const result = await runHooks({
      stage: phase === "before_switch" ? "verification_before_switch" : "verification_after_switch",
      definitions,
      host: prepared.resolved,
      manifest: this.manifest,
      currentVersion: prepared.currentVersion,
      targetVersion: prepared.candidate?.version,
      candidate: prepared.candidate
    });
    await this.writeAudit(
      prepared.resolved,
      result.ok ? "verification_completed" : "verification_failed",
      result.ok ? "completed" : "failed",
      result.ok ? `Verification ${phase} completed.` : `Verification ${phase} failed.`,
      { executionId, phase, hooks: definitions.length },
      decision,
      prepared.currentVersion,
      prepared.candidate?.version
    );
    return {
      ok: result.ok,
      phase,
      results: result.results,
      message: result.ok ? `Verification ${phase} completed.` : `Verification ${phase} failed.`
    };
  }

  private async finalizeFailure(params: {
    prepared: PreparedSession;
    state: UpdateState;
    executionId: string;
    decision: UpdateDecision;
    currentVersion: string;
    targetVersion?: string;
    plan: UpdatePlan;
    message: string;
    preflight?: PreflightResult;
    migration?: VerificationResult["results"];
    compatibility?: VerificationResult["results"];
    verificationBeforeSwitch?: VerificationResult;
    verificationAfterSwitch?: VerificationResult;
    switchResult?: ApplyResult["switchResult"];
    shouldRollback?: boolean;
  }): Promise<ApplyResult> {
    let rollback: RollbackResult | undefined;
    let state = params.state;

    if (params.shouldRollback) {
      await this.writeAudit(
        params.prepared.resolved,
        "rollback_started",
        "started",
        "Starting rollback.",
        { executionId: params.executionId },
        params.decision,
        params.targetVersion,
        params.currentVersion
      );
      rollback = await executeRollback({
        host: params.prepared.resolved,
        manifest: this.manifest,
        currentVersion: params.targetVersion ?? params.currentVersion,
        targetVersion: params.state.stableVersion ?? params.currentVersion
      });
      await this.writeAudit(
        params.prepared.resolved,
        rollback.ok ? "rollback_completed" : "rollback_failed",
        rollback.ok ? "completed" : "failed",
        rollback.message,
        { executionId: params.executionId },
        params.decision,
        params.targetVersion,
        rollback.targetVersion
      );
    }

    state = touchState(state, {
      currentVersion: rollback?.ok ? rollback.targetVersion : params.state.currentVersion,
      stableVersion: rollback?.ok ? rollback.targetVersion : params.state.stableVersion,
      lastFailedAt: new Date().toISOString(),
      lastFailureReason: params.message,
      lastExecution: {
        id: params.executionId,
        status: rollback?.ok ? "rolled_back" : "failed",
        startedAt: state.lastExecution?.startedAt,
        completedAt: new Date().toISOString(),
        decision: params.decision,
        fromVersion: params.currentVersion,
        toVersion: params.targetVersion,
        failureReason: params.message
      }
    });
    await params.prepared.resolved.stateStore.write(state);
    await this.writeAudit(
      params.prepared.resolved,
      "apply_failed",
      "failed",
      params.message,
      { executionId: params.executionId },
      params.decision,
      params.currentVersion,
      params.targetVersion
    );

    return {
      ok: false,
      status: rollback?.ok ? "rolled_back" : "failed",
      executionId: params.executionId,
      decision: params.decision,
      dryRun: false,
      currentVersion: params.currentVersion,
      targetVersion: params.targetVersion,
      plan: params.plan,
      preflight: params.preflight,
      migration: params.migration,
      compatibility: params.compatibility,
      verificationBeforeSwitch: params.verificationBeforeSwitch,
      verificationAfterSwitch: params.verificationAfterSwitch,
      switchResult: params.switchResult,
      rollback,
      state,
      message: params.message
    };
  }

  private async writeAudit(
    resolved: ResolvedAdapterContext,
    step: AuditStep,
    status: AuditStatus,
    message: string,
    metadata: Record<string, string | number | boolean | undefined> = {},
    decision?: UpdateDecision,
    fromVersion?: string,
    toVersion?: string
  ): Promise<void> {
    await resolved.auditWriter.append({
      id: createId("audit"),
      timestamp: new Date().toISOString(),
      componentName: resolved.componentName ?? resolved.appName,
      repo: this.manifest.repo,
      fromVersion,
      toVersion,
      decision,
      step,
      status,
      message,
      metadata: toJsonRecord(metadata)
    });
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<UpdateRuntime> {
  const resolved = await resolveManifest(options);
  return new UpdateRuntime({
    cwd: options.cwd,
    manifest: resolved.manifest,
    manifestInfo: resolved.info
  });
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
