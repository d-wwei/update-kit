import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UpdateCheckCache } from "../src/cache.js";
import type { CacheEntry } from "../src/cache.js";
import type { UpdateManifest } from "../src/types.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uk-cache-test-"));
}

function makeManifest(statePath: string, cacheOverride?: { cachePath?: string }): UpdateManifest {
  return {
    repo: "test/test",
    releaseChannel: "releases",
    currentVersionSource: { type: "literal", value: "1.0.0" },
    installStrategy: { type: "custom_command", command: "echo ok" },
    statePath,
    auditLogPath: path.join(path.dirname(statePath), "audit.log"),
    lockPath: path.join(path.dirname(statePath), "update.lock"),
    cache: cacheOverride
  } as UpdateManifest;
}

describe("UpdateCheckCache", () => {
  let dir: string;

  before(() => { dir = tmpDir(); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("read returns undefined for missing file", async () => {
    const cache = new UpdateCheckCache(makeManifest(path.join(dir, "missing", "state.json")), dir);
    const result = await cache.read();
    assert.equal(result, undefined);
  });

  it("write and read round-trips correctly", async () => {
    const subdir = path.join(dir, "roundtrip");
    fs.mkdirSync(subdir, { recursive: true });
    const cache = new UpdateCheckCache(makeManifest(path.join(subdir, "state.json")), dir);
    const entry: CacheEntry = {
      status: "up_to_date",
      currentVersion: "1.0.0",
      cachedAt: new Date().toISOString(),
      localVersionAtCache: "1.0.0"
    };
    await cache.write(entry);
    const read = await cache.read();
    assert.deepEqual(read, entry);
  });

  it("isFresh returns true within TTL", () => {
    const subdir = path.join(dir, "fresh");
    fs.mkdirSync(subdir, { recursive: true });
    const cache = new UpdateCheckCache(makeManifest(path.join(subdir, "state.json")), dir);
    const entry: CacheEntry = {
      status: "up_to_date",
      currentVersion: "1.0.0",
      cachedAt: new Date().toISOString(),
      localVersionAtCache: "1.0.0"
    };
    assert.equal(cache.isFresh(entry, "1.0.0"), true);
  });

  it("isFresh returns false after TTL", () => {
    const subdir = path.join(dir, "stale");
    fs.mkdirSync(subdir, { recursive: true });
    const cache = new UpdateCheckCache(makeManifest(path.join(subdir, "state.json")), dir);
    const entry: CacheEntry = {
      status: "up_to_date",
      currentVersion: "1.0.0",
      cachedAt: new Date(Date.now() - 4_000_000).toISOString(),
      localVersionAtCache: "1.0.0"
    };
    assert.equal(cache.isFresh(entry, "1.0.0"), false);
  });

  it("isFresh returns false when local version changed", () => {
    const subdir = path.join(dir, "version-change");
    fs.mkdirSync(subdir, { recursive: true });
    const cache = new UpdateCheckCache(makeManifest(path.join(subdir, "state.json")), dir);
    const entry: CacheEntry = {
      status: "up_to_date",
      currentVersion: "1.0.0",
      cachedAt: new Date().toISOString(),
      localVersionAtCache: "1.0.0"
    };
    assert.equal(cache.isFresh(entry, "1.1.0"), false);
  });

  it("two-level TTL: upgrade_available uses longer TTL", () => {
    const subdir = path.join(dir, "two-level");
    fs.mkdirSync(subdir, { recursive: true });
    const cache = new UpdateCheckCache(makeManifest(path.join(subdir, "state.json")), dir);
    const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();

    const upToDate: CacheEntry = {
      status: "up_to_date",
      currentVersion: "1.0.0",
      cachedAt: twoHoursAgo,
      localVersionAtCache: "1.0.0"
    };
    assert.equal(cache.isFresh(upToDate, "1.0.0"), false, "up_to_date should be stale after 2h");

    const upgradeAvail: CacheEntry = {
      status: "upgrade_available",
      currentVersion: "1.0.0",
      candidateVersion: "1.1.0",
      cachedAt: twoHoursAgo,
      localVersionAtCache: "1.0.0"
    };
    assert.equal(cache.isFresh(upgradeAvail, "1.0.0"), true, "upgrade_available should still be fresh after 2h");
  });

  it("invalidate removes cache file", async () => {
    const subdir = path.join(dir, "invalidate");
    fs.mkdirSync(subdir, { recursive: true });
    const cache = new UpdateCheckCache(makeManifest(path.join(subdir, "state.json")), dir);
    await cache.write({
      status: "up_to_date",
      currentVersion: "1.0.0",
      cachedAt: new Date().toISOString(),
      localVersionAtCache: "1.0.0"
    });
    assert.notEqual(await cache.read(), undefined);
    await cache.invalidate();
    assert.equal(await cache.read(), undefined);
  });

  it("uses custom cachePath from manifest", async () => {
    const subdir = path.join(dir, "custom-path");
    fs.mkdirSync(subdir, { recursive: true });
    const customPath = path.join(subdir, "my-cache.json");
    const cache = new UpdateCheckCache(
      makeManifest(path.join(subdir, "state.json"), { cachePath: customPath }),
      dir
    );
    assert.equal(cache.filePath, customPath);
  });

  it("isFresh returns false for invalid cachedAt", () => {
    const subdir = path.join(dir, "invalid-date");
    fs.mkdirSync(subdir, { recursive: true });
    const cache = new UpdateCheckCache(makeManifest(path.join(subdir, "state.json")), dir);
    const entry: CacheEntry = {
      status: "up_to_date",
      currentVersion: "1.0.0",
      cachedAt: "not-a-date",
      localVersionAtCache: "1.0.0"
    };
    assert.equal(cache.isFresh(entry, "1.0.0"), false);
  });
});
