import { readFile, writeFile } from "node:fs/promises";

import type { AuditRecord, AuditWriter, PrivacyRules } from "./types.js";
import { appendTextFile, isMissingFileError, redactText } from "./utils.js";

export class FileAuditWriter implements AuditWriter {
  constructor(
    private readonly filePath: string,
    private readonly privacyRules?: PrivacyRules,
    private readonly maxRecords?: number
  ) {}

  async append(record: AuditRecord): Promise<void> {
    const serialized = JSON.stringify({
      ...record,
      message: redactText(record.message, this.privacyRules)
    });
    await appendTextFile(this.filePath, `${serialized}\n`);

    if (this.maxRecords && this.maxRecords > 0) {
      await this.pruneIfNeeded();
    }
  }

  async list(options: { limit?: number } = {}): Promise<AuditRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

      const linesToParse = (options.limit && options.limit > 0)
        ? lines.slice(-options.limit)
        : lines;

      const records: AuditRecord[] = [];
      for (const line of linesToParse) {
        try {
          records.push(JSON.parse(line) as AuditRecord);
        } catch {
          // Skip corrupt JSONL lines
        }
      }
      return records;
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private async pruneIfNeeded(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length > this.maxRecords!) {
        const pruned = lines.slice(-this.maxRecords!);
        await writeFile(this.filePath, pruned.join("\n") + "\n", "utf8");
      }
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
  }
}

export function createFileAuditWriter(filePath: string, privacyRules?: PrivacyRules, maxRecords?: number): AuditWriter {
  return new FileAuditWriter(filePath, privacyRules, maxRecords);
}
