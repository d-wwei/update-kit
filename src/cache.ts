import path from "node:path";
import type { CacheConfig, UpdateManifest } from "./types.js";
import { readJsonFileIfExists, writeJsonFile } from "./utils.js";
import { rm } from "node:fs/promises";

export type CacheEntry = {
  status: "up_to_date" | "upgrade_available";
  currentVersion: string;
  candidateVersion?: string;
  cachedAt: string;
  localVersionAtCache: string;
};

const DEFAULT_UP_TO_DATE_TTL_MS = 3_600_000;
const DEFAULT_UPGRADE_AVAILABLE_TTL_MS = 43_200_000;

export class UpdateCheckCache {
  readonly filePath: string;

  constructor(manifest: UpdateManifest, cwd: string) {
    this.filePath = resolveCachePath(manifest, cwd);
  }

  async read(): Promise<CacheEntry | undefined> {
    try {
      return await readJsonFileIfExists<CacheEntry>(this.filePath);
    } catch {
      return undefined;
    }
  }

  async write(entry: CacheEntry): Promise<void> {
    try {
      await writeJsonFile(this.filePath, entry);
    } catch {
      // Cache write failure is non-fatal — next check will simply miss the cache.
    }
  }

  async invalidate(): Promise<void> {
    try {
      await rm(this.filePath, { force: true });
    } catch {
      // Ignore removal failures.
    }
  }

  isFresh(entry: CacheEntry, currentVersion: string, config?: CacheConfig): boolean {
    if (entry.localVersionAtCache !== currentVersion) return false;

    const now = Date.now();
    const cachedTime = new Date(entry.cachedAt).getTime();
    if (Number.isNaN(cachedTime)) return false;

    const ttl =
      entry.status === "up_to_date"
        ? (config?.upToDateTtlMs ?? DEFAULT_UP_TO_DATE_TTL_MS)
        : (config?.upgradeAvailableTtlMs ?? DEFAULT_UPGRADE_AVAILABLE_TTL_MS);

    return now - cachedTime < ttl;
  }
}

function resolveCachePath(manifest: UpdateManifest, cwd: string): string {
  if (manifest.cache?.cachePath) {
    return path.isAbsolute(manifest.cache.cachePath)
      ? manifest.cache.cachePath
      : path.join(cwd, manifest.cache.cachePath);
  }
  return path.join(path.dirname(manifest.statePath), "check-cache.json");
}

export function createUpdateCheckCache(manifest: UpdateManifest, cwd: string): UpdateCheckCache {
  return new UpdateCheckCache(manifest, cwd);
}
