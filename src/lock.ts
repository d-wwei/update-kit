import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { JsonValue, UpdateLockHandle, UpdateLockManager } from "./types.js";

export class FileUpdateLockManager implements UpdateLockManager {
  constructor(private readonly filePath: string) {}

  async acquire(metadata: Record<string, JsonValue> = {}): Promise<UpdateLockHandle> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const tryOpen = async (): Promise<UpdateLockHandle> => {
      let file;
      try {
        file = await open(this.filePath, "wx");
        await file.writeFile(JSON.stringify({
          createdAt: new Date().toISOString(),
          pid: process.pid,
          ...metadata
        }, null, 2), "utf8");
      } finally {
        await file?.close();
      }

      return {
        release: async () => {
          await rm(this.filePath, { force: true });
        }
      };
    };

    try {
      return await tryOpen();
    } catch (error) {
      // If the file already exists, check for stale lock
      if (isFileExistsError(error) && await this.removeStaleLock()) {
        try {
          return await tryOpen();
        } catch (retryError) {
          const message = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`Could not acquire update lock at ${this.filePath}: ${message}`);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not acquire update lock at ${this.filePath}: ${message}`);
    }
  }

  private async removeStaleLock(): Promise<boolean> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as { pid?: number };
      if (typeof data.pid !== "number") return false;

      try {
        process.kill(data.pid, 0);
        // Process is still alive — lock is not stale
        return false;
      } catch {
        // Process is dead — lock is stale, remove it
        await rm(this.filePath, { force: true });
        return true;
      }
    } catch {
      return false;
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

export function createFileLockManager(filePath: string): UpdateLockManager {
  return new FileUpdateLockManager(filePath);
}
