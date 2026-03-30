// Issue #18: hookRunner error tests
// Tests what happens when the custom hookRunner throws or returns failure.

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
  HookExecutionResult,
  HookRunner,
  ReleaseChannel,
  UpdateManifest,
  UpdateState
} from "../src/types.js";

type FixtureOptions = {
  initialVersion?: string;
  latestVersion?: string;
  manifestOverrides?: Partial<UpdateManifest>;
  hookRunner?: HookRunner;
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(options: FixtureOptions = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "uk-hook-err-"));
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
  const hookCalls: string[] = [];

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
    executor,
    hookRunner: options.hookRunner
      ? async (context) => {
          hookCalls.push(context.hook.type === "custom" ? context.hook.handler : context.hook.type);
          return options.hookRunner!(context);
        }
      : undefined
  });

  const fetchImpl = createMockFetch(latestVersion);

  return {
    cwd, manifest, runtime, adapter, fetchImpl, calls, hookCalls,
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

describe("hookRunner errors", () => {
  const fixtures: Fixture[] = [];
  after(async () => { for (const f of fixtures) await f.cleanup(); });

  async function setup(opts: FixtureOptions) {
    const f = await createFixture(opts);
    fixtures.push(f);
    return f;
  }

  it("hookRunner throws during preflight propagates as unhandled error from apply", async () => {
    // When a hookRunner throws (as opposed to returning { ok: false }), the error
    // propagates through apply() as an unhandled exception. This documents that
    // apply() does not catch hookRunner throws during preflight -- callers must
    // handle the thrown error themselves, or hookRunners should return { ok: false }.
    const f = await setup({
      manifestOverrides: {
        preflightHooks: [
          {
            type: "custom",
            handler: "exploding-check",
            description: "A hook that throws"
          }
        ]
      },
      hookRunner: async () => {
        throw new Error("hookRunner exploded");
      }
    });

    await assert.rejects(
      () => f.runtime.apply(f.adapter, {
        fetchImpl: f.fetchImpl,
        decision: "update_once"
      }),
      /hookRunner exploded/
    );

    // No install commands should have been executed
    assert.ok(!f.calls.some((call) => call.startsWith("install")));
  });

  it("hookRunner returns { ok: false } during preflight propagates failure", async () => {
    const f = await setup({
      manifestOverrides: {
        preflightHooks: [
          {
            type: "custom",
            handler: "failing-check",
            description: "A hook that returns failure"
          }
        ]
      },
      hookRunner: async (context): Promise<HookExecutionResult> => {
        return {
          ok: false,
          hookId: context.hook.type === "custom" ? context.hook.handler : "unknown",
          message: "custom check failed gracefully"
        };
      }
    });

    const result = await f.runtime.apply(f.adapter, {
      fetchImpl: f.fetchImpl,
      decision: "update_once"
    });

    assert.equal(result.status, "failed");
    assert.ok(result.preflight);
    assert.equal(result.preflight.ok, false);
    assert.equal(result.preflight.results.length, 1);
    assert.equal(result.preflight.results[0]!.ok, false);
    assert.match(result.preflight.results[0]!.message, /custom check failed gracefully/);

    // No install commands should have been executed
    assert.ok(!f.calls.some((call) => call.startsWith("install")));
  });

  it("hookRunner throws during migration propagates as unhandled error from apply", async () => {
    // Similar to the preflight case: when a hookRunner throws during the migration
    // stage, the error propagates uncaught from apply(). The rollback is NOT triggered
    // because the error escapes the hook stage handler. This documents the current
    // behavior -- hookRunners should return { ok: false } for graceful failure handling.
    const f = await setup({
      manifestOverrides: {
        migrationHooks: [
          {
            type: "custom",
            handler: "migration-boom",
            description: "A migration hook that throws"
          }
        ]
      },
      hookRunner: async () => {
        throw new Error("migration hook exploded");
      }
    });

    await assert.rejects(
      () => f.runtime.apply(f.adapter, {
        fetchImpl: f.fetchImpl,
        decision: "update_once"
      }),
      /migration hook exploded/
    );
  });

  it("hookRunner returns { ok: false } during verification_after_switch triggers rollback", async () => {
    const f = await setup({
      manifestOverrides: {
        verificationHooks: [
          {
            type: "custom",
            handler: "post-switch-verify",
            description: "A verification hook that fails after switch",
            phase: "after_switch"
          }
        ]
      },
      hookRunner: async (context): Promise<HookExecutionResult> => {
        return {
          ok: false,
          hookId: context.hook.type === "custom" ? context.hook.handler : "unknown",
          message: "verification failed after switch"
        };
      }
    });

    const result = await f.runtime.apply(f.adapter, {
      fetchImpl: f.fetchImpl,
      decision: "update_once"
    });

    assert.equal(result.status, "rolled_back");
    assert.ok(f.calls.some((call) => call.startsWith("rollback")));
  });
});
