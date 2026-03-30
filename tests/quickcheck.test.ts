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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "uk-qc-"));
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

function failingFetch(): typeof fetch {
  return async () => { throw new Error("Network unreachable"); };
}

describe("quickCheck", () => {
  const fixtures: Fixture[] = [];
  after(async () => { for (const f of fixtures) await f.cleanup(); });

  async function setup(opts?: Parameters<typeof createFixture>[0]) {
    const f = await createFixture(opts);
    fixtures.push(f);
    return f;
  }

  it("returns up_to_date when no update available", async () => {
    const f = await setup({ latestVersion: "1.0.0" });
    const result = await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    assert.equal(result.status, "up_to_date");
    assert.equal(result.currentVersion, "1.0.0");
  });

  it("returns upgrade_available when update exists", async () => {
    const f = await setup({ latestVersion: "1.1.0" });
    const result = await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    assert.equal(result.status, "upgrade_available");
    assert.equal(result.candidateVersion, "1.1.0");
  });

  it("returns cached result on second call within TTL", async () => {
    const f = await setup({ latestVersion: "1.1.0" });
    let fetchCount = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      fetchCount++;
      return f.fetchImpl(input, init);
    };

    const r1 = await f.runtime.quickCheck(f.adapter, { fetchImpl: countingFetch });
    assert.equal(r1.status, "upgrade_available");
    const firstFetchCount = fetchCount;

    const r2 = await f.runtime.quickCheck(f.adapter, { fetchImpl: countingFetch });
    assert.equal(r2.status, "upgrade_available");
    assert.ok(r2.cachedAt, "second call should have cachedAt");
    assert.equal(fetchCount, firstFetchCount, "no additional network calls on cached path");
  });

  it("force bypasses cache", async () => {
    const f = await setup({ latestVersion: "1.1.0" });
    let fetchCount = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      fetchCount++;
      return f.fetchImpl(input, init);
    };

    await f.runtime.quickCheck(f.adapter, { fetchImpl: countingFetch });
    const firstCount = fetchCount;

    await f.runtime.quickCheck(f.adapter, { fetchImpl: countingFetch, force: true });
    assert.ok(fetchCount > firstCount, "force should trigger network call");
  });

  it("returns disabled when updateCheckEnabled is false", async () => {
    const f = await setup({ manifestOverrides: { updateCheckEnabled: false } });
    const result = await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    assert.equal(result.status, "disabled");
  });

  it("soft-fail returns error status on network error", async () => {
    const f = await setup();
    const result = await f.runtime.quickCheck(f.adapter, { fetchImpl: failingFetch(), softFail: true });
    assert.equal(result.status, "error");
    assert.ok(result.message.includes("Check failed (soft)"));
  });

  it("throws on network error with softFail=false", async () => {
    const f = await setup();
    await assert.rejects(
      () => f.runtime.quickCheck(f.adapter, { fetchImpl: failingFetch(), softFail: false }),
      /Network unreachable/
    );
  });

  it("returns just_upgraded after successful apply and clears marker", async () => {
    const f = await setup({ latestVersion: "1.0.1" });

    await f.runtime.apply(f.adapter, { fetchImpl: f.fetchImpl });

    const r1 = await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    assert.equal(r1.status, "just_upgraded");
    assert.equal(r1.previousVersion, "1.0.0");
    assert.equal(r1.currentVersion, "1.0.1");

    const r2 = await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    assert.notEqual(r2.status, "just_upgraded", "marker should be consumed on first read");
  });

  it("snooze makes quickCheck return snoozed", async () => {
    const f = await setup({ latestVersion: "1.1.0" });

    await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    await f.runtime.snooze(f.adapter, { version: "1.1.0" });

    const result = await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    assert.equal(result.status, "snoozed");
    assert.equal(result.candidateVersion, "1.1.0");
    assert.equal(result.snoozeLevel, 0);
    assert.ok(result.snoozeExpiresAt);
  });

  it("snooze advances level on repeated calls", async () => {
    const f = await setup({ latestVersion: "1.1.0" });

    await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    await f.runtime.snooze(f.adapter, { version: "1.1.0" });
    await f.runtime.snooze(f.adapter, { version: "1.1.0" });

    const state = await f.readState();
    assert.equal(state.snooze?.level, 1);
  });

  it("apply clears snooze state", async () => {
    const f = await setup({ latestVersion: "1.0.1" });

    await f.runtime.quickCheck(f.adapter, { fetchImpl: f.fetchImpl });
    await f.runtime.snooze(f.adapter, { version: "1.0.1" });

    const stateBeforeApply = await f.readState();
    assert.ok(stateBeforeApply.snooze, "snooze should be set before apply");

    await f.runtime.apply(f.adapter, { fetchImpl: f.fetchImpl });

    const stateAfterApply = await f.readState();
    assert.equal(stateAfterApply.snooze, undefined, "apply should clear snooze");
  });

  it("snooze throws if no version to snooze", async () => {
    const f = await setup();
    await assert.rejects(
      () => f.runtime.snooze(f.adapter),
      /No version to snooze/
    );
  });

  it("cache invalidated when local version changes", async () => {
    const f = await setup({ latestVersion: "2.0.0" });
    let fetchCount = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      fetchCount++;
      return f.fetchImpl(input, init);
    };

    // First call populates cache
    await f.runtime.quickCheck(f.adapter, { fetchImpl: countingFetch });
    const countAfterFirst = fetchCount;

    // Simulate version change by rewriting package.json
    await writeFile(
      path.join(f.cwd, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.5.0" }, null, 2),
      "utf8"
    );

    // Second call should re-fetch because local version changed
    await f.runtime.quickCheck(f.adapter, { fetchImpl: countingFetch, currentVersion: "1.5.0" });
    assert.ok(fetchCount > countAfterFirst, "cache should be invalidated when version changes");
  });
});

describe("quickCheck CLI", () => {
  const fixtures: Fixture[] = [];
  after(async () => { for (const f of fixtures) await f.cleanup(); });

  it("cli quick-check --json outputs correct format", async () => {
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFile = promisify(execFileCb);

    const f = await createFixture({ latestVersion: "1.0.0", manifestOverrides: { updateCheckEnabled: false } });
    fixtures.push(f);

    await writeFile(
      path.join(f.cwd, "update.config.json"),
      JSON.stringify(f.manifest, null, 2),
      "utf8"
    );

    const packageRoot = process.cwd();
    const { stdout } = await execFile(process.execPath, [
      path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(packageRoot, "src", "cli.ts"),
      "quick-check",
      "--manifest", path.join(f.cwd, "update.config.json"),
      "--cwd", f.cwd,
      "--json"
    ], { cwd: f.cwd });
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.status, "disabled");
  });
});
