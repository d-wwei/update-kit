import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

import type { JsonValue, UpdateLockHandle, UpdateLockManager } from "./types.js";

export class FileUpdateLockManager implements UpdateLockManager {
  constructor(private readonly filePath: string) {}

  async acquire(metadata: Record<string, JsonValue> = {}): Promise<UpdateLockHandle> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let file;
    try {
      file = await open(this.filePath, "wx");
      await file.writeFile(JSON.stringify({
        createdAt: new Date().toISOString(),
        pid: process.pid,
        ...metadata
      }, null, 2), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not acquire update lock at ${this.filePath}: ${message}`);
    } finally {
      await file?.close();
    }

    return {
      release: async () => {
        await rm(this.filePath, { force: true });
      }
    };
  }
}

export function createFileLockManager(filePath: string): UpdateLockManager {
  return new FileUpdateLockManager(filePath);
}
