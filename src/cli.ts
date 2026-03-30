#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { bootstrapManifest } from "./autodetect.js";
import { defineAdapter } from "./adapter.js";
import { createRuntime } from "./runtime.js";
import type {
  ApplyResult,
  AuditRecord,
  ConfirmHandler,
  QuickCheckResult,
  ResolvedManifestInfo,
  RollbackResult,
  UpdateCheckResult,
  UpdateConfirmationPrompt,
  UpdateDecision,
  UpdateManifest,
  UpdatePlan,
  UpdatePolicy,
  UpdatePolicyMode,
  UpdateState
} from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const flags = parseFlags(args.slice(1));
  const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd();
  const runtime = await createRuntime({
    cwd,
    manifestFile: typeof flags.manifest === "string" ? flags.manifest : "update.config.json",
    autodetect: flags.autodetect !== false
  });

  const adapter = defineAdapter({
    name: "update-kit-cli",
    getContext() {
      return {
        cwd,
        appName: path.basename(cwd),
        componentName: path.basename(cwd)
      };
    },
    confirm: createCliConfirm()
  });

  const json = Boolean(flags.json);
  const dryRun = Boolean(flags["dry-run"]);

  try {
    if (command === "check") {
      if (flags.force) {
        const { createUpdateCheckCache } = await import("./cache.js");
        const cache = createUpdateCheckCache(runtime.manifest, cwd);
        await cache.invalidate();
      }
      const result = await runtime.check(adapter);
      print(result, json, renderCheck);
      return;
    }

    if (command === "quick-check") {
      const result = await runtime.quickCheck(adapter, {
        force: Boolean(flags.force),
        softFail: flags.soft !== false
      });
      print(result, json, renderQuickCheck);
      return;
    }

    if (command === "snooze") {
      const version = typeof flags.version === "string" ? flags.version : undefined;
      const result = await runtime.snooze(adapter, { version });
      print(result, json, renderState);
      return;
    }

    if (command === "bootstrap") {
      const result = await bootstrapManifest({
        cwd,
        overrides: undefined,
        preset: typeof flags.preset === "string" ? flags.preset as never : undefined
      });
      print(result, json, renderBootstrap);
      return;
    }

    if (command === "plan") {
      const result = await runtime.plan(adapter, { dryRun });
      print(result, json, renderPlan);
      return;
    }

    if (command === "apply") {
      const result = await runtime.apply(adapter, {
        dryRun,
        decision: parseDecision(flags.decision)
      });
      print(result, json, renderApply);
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (command === "rollback") {
      const result = await runtime.rollback(adapter, {
        dryRun,
        version: typeof flags.version === "string" ? flags.version : undefined
      });
      print(result, json, renderRollback);
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (command === "state") {
      const result = await runtime.getState(adapter);
      print(result, json, renderState);
      return;
    }

    if (command === "audit") {
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;
      const result = await runtime.getAudit(adapter, { limit });
      print(result, json, renderAudit);
      return;
    }

    if (command === "policy") {
      const result = await runtime.getPolicy(adapter);
      print(result, json, renderPolicy);
      return;
    }

    if (command === "ignore") {
      const version = requiredStringFlag(flags.version, "--version");
      const result = await runtime.ignoreVersion(adapter, version);
      print(result, json, renderState);
      return;
    }

    if (command === "unignore") {
      const version = requiredStringFlag(flags.version, "--version");
      const result = await runtime.unignoreVersion(adapter, version);
      print(result, json, renderState);
      return;
    }

    if (command === "set-policy") {
      const mode = requiredPolicyMode(flags.mode);
      const result = await runtime.setPolicy(adapter, mode);
      print(result, json, renderState);
      return;
    }

    printUsage();
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      output[key] = true;
      continue;
    }
    output[key] = next;
    i += 1;
  }
  return output;
}

function print<T>(value: T, asJson: boolean, render: (value: T) => string): void {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(render(value));
}

function renderCheck(result: UpdateCheckResult): string {
  return [
    `Component: ${result.state.componentName}`,
    `Repo: ${result.state.repo}`,
    `Current: ${result.currentVersion}`,
    `Latest: ${result.latestVersion}`,
    `Has update: ${result.hasUpdate ? "yes" : "no"}`,
    `Risk: ${result.riskLevel}`,
    `Policy: ${result.policy.effectivePolicy.mode}`,
    `Action: ${result.policy.autoApply ? "auto-apply" : result.policy.ignored ? "ignored" : "prompt"}`,
    result.highlights.length ? `Highlights:\n${result.highlights.map((item) => `- ${item}`).join("\n")}` : "Highlights: none"
  ].join("\n");
}

function renderPlan(plan: UpdatePlan): string {
  return [
    `Plan for ${plan.componentName}`,
    `${plan.currentVersion} -> ${plan.targetVersion ?? "no-op"}`,
    `Decision: ${plan.decision}`,
    `Reason: ${plan.reason}`,
    `Dry-run: ${plan.dryRun ? "yes" : "no"}`,
    "Steps:",
    ...plan.steps.map((step) => `- ${step.name}: ${step.operations.map((operation) => operation.description).join(" | ")}`)
  ].join("\n");
}

function renderApply(result: ApplyResult): string {
  return [
    `Status: ${result.status}`,
    `Decision: ${result.decision}`,
    `From: ${result.currentVersion}`,
    `To: ${result.targetVersion ?? "n/a"}`,
    `Message: ${result.message}`,
    result.rollback ? `Rollback: ${result.rollback.ok ? "completed" : "failed"}` : "Rollback: not needed"
  ].join("\n");
}

function renderRollback(result: RollbackResult): string {
  return [
    `Rollback ok: ${result.ok ? "yes" : "no"}`,
    `Target: ${result.targetVersion ?? "unknown"}`,
    `Message: ${result.message}`
  ].join("\n");
}

function renderState(state: UpdateState): string {
  return [
    `Component: ${state.componentName}`,
    `Current: ${state.currentVersion ?? "unknown"}`,
    `Stable: ${state.stableVersion ?? "unknown"}`,
    `Candidate: ${state.candidateVersion ?? "none"}`,
    `Policy: ${state.autoUpdatePolicy.mode}`,
    `Ignored: ${state.ignoredVersions.join(", ") || "none"}`
  ].join("\n");
}

function renderAudit(records: AuditRecord[]): string {
  if (!records.length) return "No audit records.";
  return records
    .map((record) => `${record.timestamp} ${record.step} ${record.status} ${record.message}`)
    .join("\n");
}

function renderPolicy(policy: UpdatePolicy): string {
  return [
    `Mode: ${policy.mode}`,
    `Allowed levels: ${policy.allowedUpdateLevels?.join(", ") || "default"}`
  ].join("\n");
}

function renderQuickCheck(result: QuickCheckResult): string {
  const lines = [`Status: ${result.status}`];
  if (result.currentVersion) lines.push(`Current: ${result.currentVersion}`);
  if (result.candidateVersion) lines.push(`Candidate: ${result.candidateVersion}`);
  if (result.previousVersion) lines.push(`Upgraded from: ${result.previousVersion}`);
  if (result.snoozeLevel !== undefined) lines.push(`Snooze level: ${result.snoozeLevel}`);
  if (result.snoozeExpiresAt) lines.push(`Snooze expires: ${result.snoozeExpiresAt}`);
  if (result.cachedAt) lines.push(`Cached at: ${result.cachedAt}`);
  lines.push(`Message: ${result.message}`);
  return lines.join("\n");
}

function renderBootstrap(result: { manifest: UpdateManifest; info: ResolvedManifestInfo }): string {
  return [
    `Source: ${result.info.source}`,
    `Preset: ${result.info.preset ?? "unknown"}`,
    `Repo: ${result.manifest.repo}`,
    `Install strategy: ${result.manifest.installStrategy.type}`,
    `Signals: ${(result.info.signals ?? []).join(", ") || "none"}`
  ].join("\n");
}

function requiredStringFlag(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredPolicyMode(value: string | boolean | undefined): UpdatePolicyMode {
  const mode = requiredStringFlag(value, "--mode");
  if (!["manual", "patch", "minor", "all"].includes(mode)) {
    throw new Error(`Invalid policy mode "${mode}".`);
  }
  return mode as UpdatePolicyMode;
}

function parseDecision(value: string | boolean | undefined): "update_once" | "always_auto_update" | "skip_this_time" | "ignore_this_version" | undefined {
  if (typeof value !== "string") return undefined;
  if (["update_once", "always_auto_update", "skip_this_time", "ignore_this_version"].includes(value)) {
    return value as "update_once" | "always_auto_update" | "skip_this_time" | "ignore_this_version";
  }
  throw new Error(`Invalid decision "${value}".`);
}

function createCliConfirm(): ConfirmHandler {
  return async (prompt: UpdateConfirmationPrompt) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Interactive confirmation is required but no TTY is available. Pass --decision to apply non-interactively.");
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      const answer = await rl.question([
        prompt.title,
        `Repo: ${prompt.repo}`,
        `Change: ${prompt.currentVersion} -> ${prompt.candidateVersion}`,
        `Risk: ${prompt.riskLevel}`,
        prompt.highlights.length ? `Highlights:\n${prompt.highlights.map((item) => `- ${item}`).join("\n")}` : "",
        "Choose: [u]pdate once, [a]lways auto update, [s]kip, [i]gnore this version"
      ].filter(Boolean).join("\n") + "\n> ");
      const normalized = answer.trim().toLowerCase();
      if (normalized === "u" || normalized === "update_once") return "update_once";
      if (normalized === "a" || normalized === "always_auto_update") return "always_auto_update";
      if (normalized === "s" || normalized === "skip_this_time") return "skip_this_time";
      if (normalized === "i" || normalized === "ignore_this_version") return "ignore_this_version";
      throw new Error("Unrecognized confirmation choice.");
    } finally {
      rl.close();
    }
  };
}

function printUsage(): void {
  console.error([
    "Usage:",
    "  update-kit check [--force] [--json]",
    "  update-kit quick-check [--force] [--json]",
    "  update-kit bootstrap --cwd . [--json]",
    "  update-kit plan [--dry-run] [--json]",
    "  update-kit apply [--dry-run] [--decision update_once] [--json]",
    "  update-kit rollback [--version 1.2.3] [--json]",
    "  update-kit snooze [--version 1.2.3] [--json]",
    "  update-kit state [--json]",
    "  update-kit audit [--limit 20] [--json]",
    "  update-kit policy [--json]",
    "  update-kit ignore --version 1.2.3 [--json]",
    "  update-kit unignore --version 1.2.3 [--json]",
    "  update-kit set-policy --mode manual|patch|minor|all [--json]"
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
