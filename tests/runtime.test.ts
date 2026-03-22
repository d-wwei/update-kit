import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { defineAdapter } from "../src/adapter.js";
import { normalizeManifest } from "../src/manifest.js";
import { createRuntime } from "../src/runtime.js";
import type {
  CommandExecutionRequest,
  CommandExecutionResult,
  ConfirmHandler,
  HookExecutionResult,
  HookRunner,
  ReleaseChannel,
  UpdateManifest,
  UpdateState
} from "../src/types.js";

const execFile = promisify(execFileCallback);

type FixtureOptions = {
  initialVersion?: string;
  latestVersion?: string;
  releaseChannel?: ReleaseChannel;
  trackContextVersion?: boolean;
  manifestOverrides?: Partial<UpdateManifest>;
  confirm?: ConfirmHandler;
  executorImpl?: (
    request: CommandExecutionRequest,
    text: string,
    state: { reportedVersion: string; calls: string[] }
  ) => Promise<CommandExecutionResult>;
  hookRunner?: HookRunner;
  fetchImpl?: typeof fetch;
  writeManifestFile?: boolean;
};

async function createFixture(options: FixtureOptions = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "update-kit-"));
  const stateDir = path.join(cwd, ".update-kit");
  const initialVersion = options.initialVersion ?? "1.0.0";
  const latestVersion = options.latestVersion ?? "1.0.1";
  let reportedVersion = initialVersion;
  const calls: string[] = [];
  const prompts: string[] = [];
  const hookCalls: string[] = [];

  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: initialVersion }, null, 2), "utf8");

  const manifest = normalizeManifest({
    repo: "acme/example",
    releaseChannel: options.releaseChannel ?? "releases",
    currentVersionSource: {
      type: "package.json",
      path: path.join(cwd, "package.json")
    },
    installStrategy: {
      type: "custom_command",
      command: "install {version}"
    },
    switchCommand: "switch {version}",
    rollbackCommand: "rollback {targetVersion}",
    statePath: path.join(stateDir, "state.json"),
    auditLogPath: path.join(stateDir, "audit.log"),
    lockPath: path.join(stateDir, "update.lock"),
    autoUpdatePolicy: "manual",
    allowedUpdateLevels: ["patch", "minor"],
    ...options.manifestOverrides
  } as UpdateManifest, cwd);

  if (options.writeManifestFile) {
    await writeFile(path.join(cwd, "update.config.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  const runtime = await createRuntime({ cwd, manifest });

  const executor = async (request: CommandExecutionRequest): Promise<CommandExecutionResult> => {
    const text = Array.isArray(request.command) ? request.command.join(" ") : request.command;
    calls.push(text);
    const result = options.executorImpl
      ? await options.executorImpl(request, text, { reportedVersion, calls })
      : {
          ok: true,
          code: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 1,
          command: request.command
        };

    if (result.ok && text.startsWith("switch ")) {
      reportedVersion = text.split(" ").at(-1) ?? reportedVersion;
    }
    if (result.ok && text.startsWith("rollback ")) {
      reportedVersion = text.split(" ").at(-1) ?? reportedVersion;
    }

    return result;
  };

  const adapter = defineAdapter({
    name: "fixture",
    getContext() {
      return {
        cwd,
        appName: "fixture",
        componentName: "fixture",
        ...(options.trackContextVersion === false ? {} : { currentVersion: reportedVersion })
      };
    },
    confirm: options.confirm ?? (async (prompt) => {
      prompts.push(prompt.summary);
      return "update_once";
    }),
    executor,
    hookRunner: options.hookRunner
      ? async (context) => {
          hookCalls.push(context.hook.type === "custom" ? context.hook.handler : context.hook.type);
          return options.hookRunner!(context);
        }
      : undefined
  });

  const fetchImpl = options.fetchImpl ?? createMockFetch({
    releaseChannel: manifest.releaseChannel,
    latestVersion
  });

  return {
    cwd,
    manifest,
    runtime,
    adapter,
    fetchImpl,
    calls,
    prompts,
    hookCalls,
    get reportedVersion() {
      return reportedVersion;
    },
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
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}

function createMockFetch(options: { releaseChannel: ReleaseChannel; latestVersion: string }): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/releases")) {
      return new Response(JSON.stringify([
        {
          tag_name: `v${options.latestVersion}`,
          html_url: `https://example.test/releases/${options.latestVersion}`,
          body: "Fix bug\nAdd verification"
        }
      ]), { status: 200 });
    }
    if (url.includes("/tags?")) {
      return new Response(JSON.stringify([
        { name: `v${options.latestVersion}` },
        { name: "v1.0.0" }
      ]), { status: 200 });
    }
    if (url.includes("/compare/")) {
      return new Response(JSON.stringify({
        html_url: "https://example.test/compare",
        commits: [
          { commit: { message: "Refine update handling" } },
          { commit: { message: "Improve validation" } }
        ]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
}

function okResult(request: CommandExecutionRequest, stdout = "ok"): CommandExecutionResult {
  return {
    ok: true,
    code: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    command: request.command
  };
}

function failResult(request: CommandExecutionRequest, stderr: string): CommandExecutionResult {
  return {
    ok: false,
    code: 1,
    stdout: "",
    stderr,
    durationMs: 1,
    command: request.command
  };
}

test("detects upstream release updates", async () => {
  const fixture = await createFixture({ latestVersion: "1.2.0" });
  try {
    const result = await fixture.runtime.check(fixture.adapter, { fetchImpl: fixture.fetchImpl });
    assert.equal(result.currentVersion, "1.0.0");
    assert.equal(result.latestVersion, "1.2.0");
    assert.equal(result.hasUpdate, true);
    assert.equal(result.riskLevel, "minor");
  } finally {
    await fixture.cleanup();
  }
});

test("detects tag updates", async () => {
  const fixture = await createFixture({ releaseChannel: "tags", latestVersion: "1.0.2" });
  try {
    const result = await fixture.runtime.check(fixture.adapter, { fetchImpl: fixture.fetchImpl });
    assert.equal(result.latestVersion, "1.0.2");
    assert.equal(result.hasUpdate, true);
    assert.match(result.highlights[0] ?? "", /Refine update handling/);
  } finally {
    await fixture.cleanup();
  }
});

test("reads current version from local package source", async () => {
  const fixture = await createFixture({ trackContextVersion: false });
  try {
    const result = await fixture.runtime.check(fixture.adapter, { fetchImpl: fixture.fetchImpl });
    assert.equal(result.currentVersion, "1.0.0");
  } finally {
    await fixture.cleanup();
  }
});

test("manual confirmation branch updates after user approval", async () => {
  const fixture = await createFixture({
    confirm: async (prompt) => {
      assert.match(prompt.summary, /1\.0\.0 -> 1\.0\.1/);
      return "update_once";
    }
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, { fetchImpl: fixture.fetchImpl });
    assert.equal(result.status, "succeeded");
    assert.equal(fixture.reportedVersion, "1.0.1");
  } finally {
    await fixture.cleanup();
  }
});

test("auto update policy applies patch without confirmation", async () => {
  const fixture = await createFixture({
    manifestOverrides: { autoUpdatePolicy: "patch" },
    confirm: async () => {
      throw new Error("confirm should not be called");
    }
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, { fetchImpl: fixture.fetchImpl });
    assert.equal(result.decision, "auto_update");
    assert.equal(result.status, "succeeded");
  } finally {
    await fixture.cleanup();
  }
});

test("ignore_this_version persists ignored version and skips execution", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "ignore_this_version"
    });
    assert.equal(result.status, "skipped");
    assert.deepEqual(fixture.calls, []);
    const state = await fixture.readState();
    assert.deepEqual(state.ignoredVersions, ["1.0.1"]);
  } finally {
    await fixture.cleanup();
  }
});

test("always_auto_update persists widened policy", async () => {
  const fixture = await createFixture({
    latestVersion: "1.1.0",
    confirm: async () => "always_auto_update"
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, { fetchImpl: fixture.fetchImpl });
    assert.equal(result.status, "succeeded");
    assert.equal(result.state.autoUpdatePolicy.mode, "minor");
    const state = await fixture.readState();
    assert.equal(state.autoUpdatePolicy.mode, "minor");
  } finally {
    await fixture.cleanup();
  }
});

test("install success path updates state and executes install", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    assert.equal(result.status, "succeeded");
    assert.ok(fixture.calls.some((call) => call.includes("install 1.0.1")));
    const state = await fixture.readState();
    assert.equal(state.currentVersion, "1.0.1");
    assert.equal(state.stableVersion, "1.0.1");
  } finally {
    await fixture.cleanup();
  }
});

test("preflight failure stops before install", async () => {
  const fixture = await createFixture({
    manifestOverrides: {
      preflightHooks: [
        {
          type: "command",
          command: "preflight {version}",
          description: "Run preflight"
        }
      ]
    },
    executorImpl: async (request, text) => text.startsWith("preflight")
      ? failResult(request, "preflight failed")
      : okResult(request)
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    assert.equal(result.status, "failed");
    assert.equal(fixture.calls.some((call) => call.startsWith("install")), false);
  } finally {
    await fixture.cleanup();
  }
});

test("migration failure triggers rollback", async () => {
  const fixture = await createFixture({
    manifestOverrides: {
      migrationHooks: [
        {
          type: "command",
          command: "migrate {version}",
          description: "Run migrations"
        }
      ]
    },
    executorImpl: async (request, text) => text.startsWith("migrate")
      ? failResult(request, "migration failed")
      : okResult(request)
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    assert.equal(result.status, "rolled_back");
    assert.ok(fixture.calls.some((call) => call.startsWith("rollback 1.0.0")));
  } finally {
    await fixture.cleanup();
  }
});

test("verification failure after switch triggers rollback", async () => {
  const fixture = await createFixture({
    manifestOverrides: {
      verificationHooks: [
        {
          type: "command",
          command: "verify {version}",
          description: "Verify update",
          phase: "after_switch"
        }
      ]
    },
    executorImpl: async (request, text) => text.startsWith("verify")
      ? failResult(request, "verification failed")
      : okResult(request)
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    assert.equal(result.status, "rolled_back");
    assert.ok(fixture.calls.some((call) => call.startsWith("rollback 1.0.0")));
  } finally {
    await fixture.cleanup();
  }
});

test("switch failure triggers rollback", async () => {
  const fixture = await createFixture({
    executorImpl: async (request, text) => text.startsWith("switch")
      ? failResult(request, "switch failed")
      : okResult(request)
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    assert.equal(result.status, "rolled_back");
    assert.ok(fixture.calls.some((call) => call.startsWith("rollback 1.0.0")));
  } finally {
    await fixture.cleanup();
  }
});

test("manual rollback succeeds and restores previous stable version", async () => {
  const fixture = await createFixture();
  try {
    await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    const rollback = await fixture.runtime.rollback(fixture.adapter);
    assert.equal(rollback.ok, true);
    const state = await fixture.readState();
    assert.equal(state.currentVersion, "1.0.0");
    assert.equal(fixture.reportedVersion, "1.0.0");
  } finally {
    await fixture.cleanup();
  }
});

test("rollback failure is written to audit", async () => {
  const fixture = await createFixture({
    manifestOverrides: {
      migrationHooks: [
        {
          type: "command",
          command: "migrate {version}",
          description: "Run migrations"
        }
      ]
    },
    executorImpl: async (request, text) => {
      if (text.startsWith("migrate")) return failResult(request, "migration failed");
      if (text.startsWith("rollback")) return failResult(request, "rollback failed");
      return okResult(request);
    }
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    assert.equal(result.status, "failed");
    const audit = await fixture.readAudit();
    assert.ok(audit.some((record) => record.step === "rollback_failed"));
  } finally {
    await fixture.cleanup();
  }
});

test("audit log records critical execution steps", async () => {
  const fixture = await createFixture();
  try {
    await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    const audit = await fixture.readAudit();
    const steps = audit.map((record) => record.step);
    assert.ok(steps.includes("detection_started"));
    assert.ok(steps.includes("decision_recorded"));
    assert.ok(steps.includes("plan_created"));
    assert.ok(steps.includes("install_started"));
    assert.ok(steps.includes("apply_completed"));
  } finally {
    await fixture.cleanup();
  }
});

test("state persistence records last success and failure fields", async () => {
  const fixture = await createFixture();
  try {
    await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    const state = await fixture.readState();
    assert.equal(state.lastSuccessfulVersion, "1.0.1");
    assert.equal(typeof state.lastSuccessfulAt, "string");
    assert.equal(state.lastExecution?.status, "succeeded");
  } finally {
    await fixture.cleanup();
  }
});

test("update lock prevents concurrent apply", async () => {
  let releaseInstall!: () => void;
  let installSeen!: () => void;
  const installStarted = new Promise<void>((resolve) => {
    installSeen = resolve;
  });
  const continueInstall = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });

  const fixture = await createFixture({
    manifestOverrides: { autoUpdatePolicy: "patch" },
    executorImpl: async (request, text) => {
      if (text.startsWith("install")) {
        installSeen();
        await continueInstall;
      }
      return okResult(request);
    }
  });

  try {
    const firstApply = fixture.runtime.apply(fixture.adapter, { fetchImpl: fixture.fetchImpl });
    await installStarted;
    await assert.rejects(
      fixture.runtime.apply(fixture.adapter, { fetchImpl: fixture.fetchImpl }),
      /Could not acquire update lock/
    );
    releaseInstall();
    const first = await firstApply;
    assert.equal(first.status, "succeeded");
  } finally {
    await fixture.cleanup();
  }
});

test("dry-run produces preview without executing commands", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      dryRun: true
    });
    assert.equal(result.status, "dry_run");
    assert.deepEqual(fixture.calls, []);
    await assert.rejects(fixture.readAudit());
  } finally {
    await fixture.cleanup();
  }
});

test("custom executor and hook runner can be injected by host", async () => {
  const fixture = await createFixture({
    manifestOverrides: {
      preflightHooks: [
        {
          type: "custom",
          handler: "health-check",
          description: "Run custom health check"
        }
      ]
    },
    hookRunner: async (context): Promise<HookExecutionResult> => {
      return {
        ok: true,
        hookId: context.hook.type === "custom" ? context.hook.handler : "unknown",
        message: "custom hook passed"
      };
    }
  });
  try {
    const result = await fixture.runtime.apply(fixture.adapter, {
      fetchImpl: fixture.fetchImpl,
      decision: "update_once"
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(fixture.hookCalls, ["health-check"]);
    assert.ok(fixture.calls.some((call) => call.startsWith("install")));
  } finally {
    await fixture.cleanup();
  }
});

test("cli supports --json output", async () => {
  const fixture = await createFixture({ writeManifestFile: true });
  try {
    const packageRoot = process.cwd();
    const { stdout } = await execFile(
      process.execPath,
      [
        path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(packageRoot, "src", "cli.ts"),
        "state",
        "--manifest",
        path.join(fixture.cwd, "update.config.json"),
        "--cwd",
        fixture.cwd,
        "--json"
      ],
      {
        cwd: fixture.cwd
      }
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.componentName, path.basename(fixture.cwd));
    assert.equal(parsed.repo, "acme/example");
  } finally {
    await fixture.cleanup();
  }
});
