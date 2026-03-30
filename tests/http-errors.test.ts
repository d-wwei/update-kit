// Issue #17: HTTP backend error path tests
// Tests error handling for HttpStateStore, HttpAuditWriter, and HttpLockManager.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHttpStateStore,
  createHttpAuditWriter,
  createHttpLockManager
} from "../src/remote.js";

describe("HttpStateStore error paths", () => {
  it("read with network failure throws", async () => {
    const stateStore = createHttpStateStore({
      readUrl: "https://state.example/state",
      writeUrl: "https://state.example/state",
      fetchImpl: async () => { throw new Error("Network failure"); }
    });

    await assert.rejects(
      () => stateStore.read(),
      /Network failure/
    );
  });

  it("read with 500 response throws with status", async () => {
    const stateStore = createHttpStateStore({
      readUrl: "https://state.example/state",
      writeUrl: "https://state.example/state",
      fetchImpl: async () => new Response("Internal Server Error", { status: 500 })
    });

    await assert.rejects(
      () => stateStore.read(),
      /Remote state read failed: 500/
    );
  });

  it("read with 404 response returns undefined", async () => {
    const stateStore = createHttpStateStore({
      readUrl: "https://state.example/state",
      writeUrl: "https://state.example/state",
      fetchImpl: async () => new Response("Not Found", { status: 404 })
    });

    const result = await stateStore.read();
    assert.equal(result, undefined);
  });

  it("write with 500 response throws", async () => {
    const stateStore = createHttpStateStore({
      readUrl: "https://state.example/state",
      writeUrl: "https://state.example/state",
      fetchImpl: async () => new Response("Internal Server Error", { status: 500 })
    });

    await assert.rejects(
      () => stateStore.write({
        componentName: "demo",
        repo: "acme/example",
        autoUpdatePolicy: { mode: "manual" },
        ignoredVersions: [],
        updatedAt: new Date().toISOString()
      }),
      /Remote state write failed: 500/
    );
  });

  it("write with network failure throws", async () => {
    const stateStore = createHttpStateStore({
      readUrl: "https://state.example/state",
      writeUrl: "https://state.example/state",
      fetchImpl: async () => { throw new Error("Connection refused"); }
    });

    await assert.rejects(
      () => stateStore.write({
        componentName: "demo",
        repo: "acme/example",
        autoUpdatePolicy: { mode: "manual" },
        ignoredVersions: [],
        updatedAt: new Date().toISOString()
      }),
      /Connection refused/
    );
  });
});

describe("HttpAuditWriter error paths", () => {
  it("append with network failure throws", async () => {
    const auditWriter = createHttpAuditWriter({
      appendUrl: "https://state.example/audit",
      listUrl: "https://state.example/audit",
      fetchImpl: async () => { throw new Error("Network failure"); }
    });

    await assert.rejects(
      () => auditWriter.append({
        id: "1",
        timestamp: new Date().toISOString(),
        componentName: "demo",
        repo: "acme/example",
        step: "detection_started",
        status: "started",
        message: "ok"
      }),
      /Network failure/
    );
  });

  it("append with 500 response throws", async () => {
    const auditWriter = createHttpAuditWriter({
      appendUrl: "https://state.example/audit",
      listUrl: "https://state.example/audit",
      fetchImpl: async () => new Response("Server Error", { status: 500 })
    });

    await assert.rejects(
      () => auditWriter.append({
        id: "1",
        timestamp: new Date().toISOString(),
        componentName: "demo",
        repo: "acme/example",
        step: "detection_started",
        status: "started",
        message: "ok"
      }),
      /Remote audit append failed: 500/
    );
  });

  it("list with 500 response throws", async () => {
    const auditWriter = createHttpAuditWriter({
      appendUrl: "https://state.example/audit",
      listUrl: "https://state.example/audit",
      fetchImpl: async () => new Response("Server Error", { status: 500 })
    });

    await assert.rejects(
      () => auditWriter.list(),
      /Remote audit list failed: 500/
    );
  });

  it("list with 404 response returns empty array", async () => {
    const auditWriter = createHttpAuditWriter({
      appendUrl: "https://state.example/audit",
      listUrl: "https://state.example/audit",
      fetchImpl: async () => new Response("Not Found", { status: 404 })
    });

    const records = await auditWriter.list();
    assert.deepEqual(records, []);
  });
});

describe("HttpLockManager error paths", () => {
  it("acquire with 500 response throws", async () => {
    const lockManager = createHttpLockManager({
      acquireUrl: "https://state.example/lock",
      releaseUrlTemplate: "https://state.example/lock/{leaseId}",
      fetchImpl: async () => new Response("Server Error", { status: 500 })
    });

    await assert.rejects(
      () => lockManager.acquire({ componentName: "demo" }),
      /Could not acquire remote update lock.*500/
    );
  });

  it("acquire with 409 conflict throws", async () => {
    const lockManager = createHttpLockManager({
      acquireUrl: "https://state.example/lock",
      releaseUrlTemplate: "https://state.example/lock/{leaseId}",
      fetchImpl: async () => new Response("Conflict", { status: 409 })
    });

    await assert.rejects(
      () => lockManager.acquire({ componentName: "demo" }),
      /Could not acquire remote update lock.*conflict/
    );
  });

  it("acquire with network failure throws", async () => {
    const lockManager = createHttpLockManager({
      acquireUrl: "https://state.example/lock",
      releaseUrlTemplate: "https://state.example/lock/{leaseId}",
      fetchImpl: async () => { throw new Error("DNS resolution failed"); }
    });

    await assert.rejects(
      () => lockManager.acquire({ componentName: "demo" }),
      /DNS resolution failed/
    );
  });

  it("release with 500 response throws", async () => {
    let callCount = 0;
    const lockManager = createHttpLockManager({
      acquireUrl: "https://state.example/lock",
      releaseUrlTemplate: "https://state.example/lock/{leaseId}",
      fetchImpl: async () => {
        callCount++;
        if (callCount === 1) {
          // acquire succeeds
          return new Response(JSON.stringify({ leaseId: "lease-42" }), { status: 200 });
        }
        // release fails
        return new Response("Server Error", { status: 500 });
      }
    });

    const lock = await lockManager.acquire({ componentName: "demo" });
    await assert.rejects(
      () => lock.release(),
      /Could not release remote update lock/
    );
  });
});
