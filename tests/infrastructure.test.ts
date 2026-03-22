import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectUpdateCandidate } from "../src/detector.js";
import { executeInstall } from "../src/installer.js";
import { normalizeManifest } from "../src/manifest.js";
import {
  createHttpAuditWriter,
  createHttpLockManager,
  createHttpStateStore
} from "../src/remote.js";
import type {
  ArchiveDownloadInstallStrategy,
  CommandExecutionRequest,
  ResolvedAdapterContext,
  UpdateManifest
} from "../src/types.js";

test("GitHub tag detection follows pagination to later pages", async () => {
  const manifest = normalizeManifest({
    repo: "acme/example",
    releaseChannel: "tags",
    currentVersionSource: { type: "literal", value: "1.0.0" },
    installStrategy: { type: "custom_command", command: "noop" },
    statePath: "/tmp/state.json",
    auditLogPath: "/tmp/audit.log",
    lockPath: "/tmp/lock"
  } as UpdateManifest, process.cwd());

  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/tags") && !url.includes("page=2")) {
      return new Response(JSON.stringify([{ name: "v1.0.1" }]), {
        status: 200,
        headers: {
          link: '<https://api.github.com/repos/acme/example/tags?page=2>; rel="next"'
        }
      });
    }
    if (url.includes("page=2")) {
      return new Response(JSON.stringify([{ name: "v1.1.0" }]), { status: 200 });
    }
    if (url.includes("/compare/")) {
      return new Response(JSON.stringify({
        html_url: "https://example.test/compare",
        commits: [{ commit: { message: "Paged release landed" } }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  const result = await detectUpdateCandidate({
    cwd: process.cwd(),
    appName: "demo",
    componentName: "demo",
    currentVersion: "1.0.0"
  }, manifest, fetchImpl);

  assert.equal(result.candidate?.version, "1.1.0");
  assert.ok(calls >= 2);
});

test("GitHub requests retry after rate limiting", async () => {
  const manifest = normalizeManifest({
    repo: "acme/example",
    releaseChannel: "releases",
    currentVersionSource: { type: "literal", value: "1.0.0" },
    installStrategy: { type: "custom_command", command: "noop" },
    statePath: "/tmp/state.json",
    auditLogPath: "/tmp/audit.log",
    lockPath: "/tmp/lock",
    github: {
      rateLimitRetries: 1,
      maxRateLimitWaitMs: 5
    }
  } as UpdateManifest, process.cwd());

  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/releases") && calls === 1) {
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: { "retry-after": "0" }
      });
    }
    if (url.includes("/releases")) {
      return new Response(JSON.stringify([{
        tag_name: "v1.0.1",
        html_url: "https://example.test/releases/1.0.1",
        body: "Retry succeeded"
      }]), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  const result = await detectUpdateCandidate({
    cwd: process.cwd(),
    appName: "demo",
    componentName: "demo",
    currentVersion: "1.0.0"
  }, manifest, fetchImpl);

  assert.equal(result.candidate?.version, "1.0.1");
  assert.equal(calls, 2);
});

test("HTTP distributed backends support state, audit, and lock operations", async () => {
  const writes: string[] = [];
  const releases: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state") && init?.method === "PUT") {
      writes.push(String(init.body));
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/state") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify({
        componentName: "demo",
        repo: "acme/example",
        autoUpdatePolicy: { mode: "manual" },
        ignoredVersions: [],
        updatedAt: new Date().toISOString()
      }), { status: 200 });
    }
    if (url.endsWith("/audit") && init?.method === "POST") {
      return new Response("{}", { status: 200 });
    }
    if (url.includes("/audit") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith("/lock") && init?.method === "POST") {
      return new Response(JSON.stringify({ leaseId: "lease-1" }), { status: 200 });
    }
    if (url.endsWith("/lock/lease-1") && init?.method === "DELETE") {
      releases.push(url);
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };

  const stateStore = createHttpStateStore({
    readUrl: "https://state.example/state",
    writeUrl: "https://state.example/state",
    fetchImpl
  });
  const auditWriter = createHttpAuditWriter({
    appendUrl: "https://state.example/audit",
    listUrl: "https://state.example/audit",
    fetchImpl
  });
  const lockManager = createHttpLockManager({
    acquireUrl: "https://state.example/lock",
    releaseUrlTemplate: "https://state.example/lock/{leaseId}",
    fetchImpl
  });

  await stateStore.write({
    componentName: "demo",
    repo: "acme/example",
    autoUpdatePolicy: { mode: "manual" },
    ignoredVersions: [],
    updatedAt: new Date().toISOString()
  });
  const state = await stateStore.read();
  await auditWriter.append({
    id: "1",
    timestamp: new Date().toISOString(),
    componentName: "demo",
    repo: "acme/example",
    step: "detection_started",
    status: "started",
    message: "ok"
  });
  const records = await auditWriter.list();
  const lock = await lockManager.acquire({ componentName: "demo" });
  await lock.release();

  assert.equal(state?.componentName, "demo");
  assert.equal(records.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(releases.length, 1);
});

test("archive strategy requires checksum unless explicitly marked insecure", () => {
  assert.throws(() => {
    normalizeManifest({
      repo: "acme/example",
      releaseChannel: "releases",
      currentVersionSource: { type: "literal", value: "1.0.0" },
      installStrategy: {
        type: "archive_download",
        urlTemplate: "https://example.test/archive-{version}.tar.gz",
        destinationPath: "/tmp/archive",
        extract: true,
        archiveType: "tar.gz"
      },
      statePath: "/tmp/state.json",
      auditLogPath: "/tmp/audit.log",
      lockPath: "/tmp/lock"
    } as UpdateManifest, process.cwd());
  }, /checksumSha256/);
});

test("archive install validates checksum and extracted paths", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "update-kit-archive-"));
  const destination = path.join(cwd, "release");
  await mkdir(destination, { recursive: true });
  const archiveBuffer = Buffer.from("archive-contents");
  const checksum = createHash("sha256").update(archiveBuffer).digest("hex");

  const manifest = normalizeManifest({
    repo: "acme/example",
    releaseChannel: "releases",
    currentVersionSource: { type: "literal", value: "1.0.0" },
    installStrategy: {
      type: "archive_download",
      urlTemplate: "https://example.test/archive-{version}.tar.gz",
      destinationPath: destination,
      archiveType: "tar.gz",
      checksumSha256: checksum,
      extract: true,
      expectedExtractedPaths: ["bin/app"]
    } as ArchiveDownloadInstallStrategy,
    statePath: path.join(cwd, "state.json"),
    auditLogPath: path.join(cwd, "audit.log"),
    lockPath: path.join(cwd, "lock")
  } as UpdateManifest, cwd);

  const host = {
    cwd,
    appName: "demo",
    componentName: "demo",
    fetchImpl: async () => new Response(archiveBuffer, { status: 200 }),
    executor: async (request: CommandExecutionRequest) => {
      await mkdir(path.join(destination, "bin"), { recursive: true });
      await writeFile(path.join(destination, "bin", "app"), "ok", "utf8");
      return {
        ok: true,
        code: 0,
        stdout: "extracted",
        stderr: "",
        durationMs: 1,
        command: request.command
      };
    },
    stateStore: {
      async read() {
        return undefined;
      },
      async write() {}
    },
    auditWriter: {
      async append() {},
      async list() {
        return [];
      }
    },
    lockManager: {
      async acquire() {
        return {
          async release() {}
        };
      }
    }
  } as unknown as ResolvedAdapterContext;

  try {
    const result = await executeInstall({
      host,
      manifest,
      currentVersion: "1.0.0",
      targetVersion: "1.0.1"
    });
    assert.equal(result.outputs.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
