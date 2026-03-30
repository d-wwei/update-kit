// Issue #15: Rollback isolation tests
// Tests rollback edge cases: undefined previousStableVersion, explicit version override, dry-run.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

import { defineAdapter } from "../src/adapter.js";
import { normalizeManifest } from "../src/manifest.js";
import { createRuntime } from "../src/runtime.js";
import type {
  CommandExecutionRequest,
  CommandExecutionResult,
  ReleaseChannel,
  UpdateManifest,
  UpdateState
} from "../src/types.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(options: {
  initialVersion?: string;
  latestVersion?: string;
  manifestOverrides?: Partial<UpdateManifest>;
} = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "uk-rollback-"));
  const stateDir = path.join(cwd, ".update-kit");
  const initialVersion = options.initialVersion ?? "1.0.0";
  const latestVersion = options.latestVersion ?? "1.0.1";

  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", version: initialVersion }, null, 2),
    "utf8"
  );

  const manifest = normalizeManifest({
    repo: "acme/example",
    releaseChannel: "releases" as ReleaseChannel,
    currentVersionSource: { type: "package.json", path: path.join(cwd, "package.json") },
    installStrategy: { type: "custom_command", command: "install {version}" },
    switchCommand: "switch {version}",
    rollbackCommand: "rollback {targetVersion}",
    statePath: path.join(stateDir, "state.json"),
    auditLogPath: path.join(stateDir, "audit.log"),
    lockPath: path.join(stateDir, "update.lock"),
    autoUpdatePolicy: "manual",
    allowedUpdateLevels: ["patch", "minor"],
    ...options.manifestOverrides
  } as UpdateManifest, cwd);

  const runtime = await createRuntime({ cwd, manifest });

  let reportedVersion = initialVersion;
  const calls: string[] = [];

  const executor = async (request: CommandExecutionRequest): Promise<CommandExecutionResult> => {
    const text = Array.isArray(request.command) ? request.command.join(" ") : request.command;
    calls.push(text);
    if (text.startsWith("switch ")) reportedVersion = text.split(" ").at(-1) ?? reportedVersion;
    if (text.startsWith("rollback ")) reportedVersion = text.split(" ").at(-1) ?? reportedVersion;
    return { ok: true, code: 0, stdout: "ok", stderr: "", durationMs: 1, command: request.command };
  };

  const adapter = defineAdapter({
    name: "fixture",
    getContext() {
      return { cwd, appName: "fixture", componentName: "fixture", currentVersion: reportedVersion };
    },
    confirm: async () => "update_once",
    executor
  });

  const fetchImpl = createMockFetch(latestVersion);

  return {
    cwd, manifest, runtime, adapter, fetchImpl, calls,
    get reportedVersion() { return reportedVersion; },
    async readState() {
      return JSON.parse(await readFile(manifest.statePath, "utf8")) as UpdateState;
    },
    async readAudit() {
      return (await readFile(manifest.auditLogPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    async cleanup() { await rm(cwd, { recursive: true, force: true }); }
  };
}

function createMockFetch(latestVersion: string): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/releases")) {
      return new Response(JSON.stringify([{
        tag_name: `v${latestVersion}`,
        html_url: `https://example.test/releases/${latestVersion}`,
        body: "Fix bug"
      }]), { status: 200 });
    }
    if (url.includes("/compare/")) {
      return new Response(JSON.stringify({
        html_url: "https://example.test/compare",
        commits: [{ commit: { message: "Improve validation" } }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
}

describe("rollback isolation", () => {
  const fixtures: Fixture[] = [];
  after(async () => { for (const f of fixtures) await f.cleanup(); });

  async function setup(opts?: Parameters<typeof createFixture>[0]) {
    const f = await createFixture(opts);
    fixtures.push(f);
    return f;
  }

  it("rollback when previousStableVersion is undefined returns gracefully", async () => {
    const f = await setup();
    // Do NOT apply first, so there's no previousStableVersion in state.
    // First we need to create a state by doing a check so state file exists.
    await f.runtime.check(f.adapter, { fetchImpl: f.fetchImpl });

    // Now rollback without any previous upgrade having happened.
    // The runtime.rollback reads state.previousStableVersion ?? state.stableVersion.
    // stableVersion should be set to current version (1.0.0) after check writes state.
    const result = await f.runtime.rollback(f.adapter);

    // The rollback target should be the stableVersion (current), since there is
    // no previousStableVersion. This effectively rolls back to itself.
    assert.equal(result.ok, true);
    assert.equal(result.targetVersion, "1.0.0");
  });

  it("rollback with explicit version override uses provided version", async () => {
    const f = await setup({ latestVersion: "1.0.1" });

    // Apply an update first so state has previousStableVersion = 1.0.0
    const applyResult = await f.runtime.apply(f.adapter, {
      fetchImpl: f.fetchImpl,
      decision: "update_once"
    });
    assert.equal(applyResult.status, "succeeded");

    // Now rollback with explicit version override (not the previousStableVersion)
    const rollbackResult = await f.runtime.rollback(f.adapter, { version: "0.9.0" });
    assert.equal(rollbackResult.ok, true);
    assert.equal(rollbackResult.targetVersion, "0.9.0");
    assert.ok(f.calls.some((call) => call.includes("rollback 0.9.0")));

    // Verify state reflects the overridden version
    const state = await f.readState();
    assert.equal(state.currentVersion, "0.9.0");
  });

  it("rollback dry-run does not execute any commands", async () => {
    const f = await setup({ latestVersion: "1.0.1" });

    // Apply first to get a previousStableVersion
    await f.runtime.apply(f.adapter, {
      fetchImpl: f.fetchImpl,
      decision: "update_once"
    });
    const callsBeforeRollback = f.calls.length;

    // Dry-run rollback
    const result = await f.runtime.rollback(f.adapter, { dryRun: true });
    assert.equal(result.ok, true);
    assert.match(result.message, /Dry-run/);

    // No new commands should have been executed
    assert.equal(f.calls.length, callsBeforeRollback);

    // State should still reflect the applied version (not rolled back)
    const state = await f.readState();
    assert.equal(state.currentVersion, "1.0.1");
  });

  it("rollback after apply restores previousStableVersion by default", async () => {
    const f = await setup({ latestVersion: "1.0.1" });

    await f.runtime.apply(f.adapter, {
      fetchImpl: f.fetchImpl,
      decision: "update_once"
    });

    const stateAfterApply = await f.readState();
    assert.equal(stateAfterApply.previousStableVersion, "1.0.0");
    assert.equal(stateAfterApply.stableVersion, "1.0.1");

    const result = await f.runtime.rollback(f.adapter);
    assert.equal(result.ok, true);
    assert.equal(result.targetVersion, "1.0.0");

    const stateAfterRollback = await f.readState();
    assert.equal(stateAfterRollback.currentVersion, "1.0.0");
    assert.equal(stateAfterRollback.stableVersion, "1.0.0");
  });

  it("rollback writes audit records", async () => {
    const f = await setup({ latestVersion: "1.0.1" });

    await f.runtime.apply(f.adapter, {
      fetchImpl: f.fetchImpl,
      decision: "update_once"
    });

    await f.runtime.rollback(f.adapter);

    const audit = await f.readAudit();
    const steps = audit.map((r) => r.step);
    assert.ok(steps.includes("rollback_started"));
    assert.ok(steps.includes("rollback_completed"));
  });
});
