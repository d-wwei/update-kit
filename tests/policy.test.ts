// Issue #16: setPolicy / ignoreVersion / unignoreVersion tests
// Tests runtime methods for managing update policy and ignored versions.

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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "uk-policy-"));
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

describe("setPolicy", () => {
  const fixtures: Fixture[] = [];
  after(async () => { for (const f of fixtures) await f.cleanup(); });

  async function setup(opts?: Parameters<typeof createFixture>[0]) {
    const f = await createFixture(opts);
    fixtures.push(f);
    return f;
  }

  it("setPolicy changes mode to patch", async () => {
    const f = await setup();
    const state = await f.runtime.setPolicy(f.adapter, "patch");
    assert.equal(state.autoUpdatePolicy.mode, "patch");

    // Verify persistence
    const persisted = await f.readState();
    assert.equal(persisted.autoUpdatePolicy.mode, "patch");
  });

  it("setPolicy changes mode to minor", async () => {
    const f = await setup();
    const state = await f.runtime.setPolicy(f.adapter, "minor");
    assert.equal(state.autoUpdatePolicy.mode, "minor");
  });

  it("setPolicy changes mode to all", async () => {
    const f = await setup();
    const state = await f.runtime.setPolicy(f.adapter, "all");
    assert.equal(state.autoUpdatePolicy.mode, "all");
  });

  it("setPolicy changes mode back to manual", async () => {
    const f = await setup();
    await f.runtime.setPolicy(f.adapter, "patch");
    const state = await f.runtime.setPolicy(f.adapter, "manual");
    assert.equal(state.autoUpdatePolicy.mode, "manual");
  });
});

describe("ignoreVersion / unignoreVersion", () => {
  const fixtures: Fixture[] = [];
  after(async () => { for (const f of fixtures) await f.cleanup(); });

  async function setup(opts?: Parameters<typeof createFixture>[0]) {
    const f = await createFixture(opts);
    fixtures.push(f);
    return f;
  }

  it("ignoreVersion adds version to the ignored list", async () => {
    const f = await setup();
    const state = await f.runtime.ignoreVersion(f.adapter, "1.2.0");
    assert.ok(state.ignoredVersions.includes("1.2.0"));

    // Verify persistence
    const persisted = await f.readState();
    assert.ok(persisted.ignoredVersions.includes("1.2.0"));
  });

  it("unignoreVersion removes version from the ignored list", async () => {
    const f = await setup();
    await f.runtime.ignoreVersion(f.adapter, "1.2.0");
    const state = await f.runtime.unignoreVersion(f.adapter, "1.2.0");
    assert.ok(!state.ignoredVersions.includes("1.2.0"));

    // Verify persistence
    const persisted = await f.readState();
    assert.ok(!persisted.ignoredVersions.includes("1.2.0"));
  });

  it("ignore then unignore same version round-trip returns to original state", async () => {
    const f = await setup();
    // Get initial state
    const initial = await f.runtime.getState(f.adapter);
    const originalIgnored = [...initial.ignoredVersions];

    // Ignore and then unignore
    await f.runtime.ignoreVersion(f.adapter, "2.0.0");
    const state = await f.runtime.unignoreVersion(f.adapter, "2.0.0");

    assert.deepEqual(state.ignoredVersions, originalIgnored);
  });

  it("ignore duplicate version appears only once", async () => {
    const f = await setup();
    await f.runtime.ignoreVersion(f.adapter, "1.2.0");
    const state = await f.runtime.ignoreVersion(f.adapter, "1.2.0");

    const count = state.ignoredVersions.filter((v) => v === "1.2.0").length;
    assert.equal(count, 1, "version 1.2.0 should appear exactly once in ignoredVersions");
  });

  it("ignoreVersion adds multiple different versions", async () => {
    const f = await setup();
    await f.runtime.ignoreVersion(f.adapter, "1.2.0");
    const state = await f.runtime.ignoreVersion(f.adapter, "1.3.0");

    assert.ok(state.ignoredVersions.includes("1.2.0"));
    assert.ok(state.ignoredVersions.includes("1.3.0"));
  });

  it("unignoreVersion on non-existent version is a no-op", async () => {
    const f = await setup();
    const before = await f.runtime.getState(f.adapter);
    const after = await f.runtime.unignoreVersion(f.adapter, "9.9.9");

    assert.deepEqual(
      after.ignoredVersions.filter((v) => v !== "9.9.9"),
      before.ignoredVersions.filter((v) => v !== "9.9.9")
    );
  });
});
