import { readFile } from "node:fs/promises";

import type { AuditRecord, AuditWriter, PrivacyRules } from "./types.js";
import { appendTextFile, isMissingFileError, redactText } from "./utils.js";

export class FileAuditWriter implements AuditWriter {
  constructor(
    private readonly filePath: string,
    private readonly privacyRules?: PrivacyRules
  ) {}

  async append(record: AuditRecord): Promise<void> {
    const serialized = JSON.stringify({
      ...record,
      message: redactText(record.message, this.privacyRules)
    });
    await appendTextFile(this.filePath, `${serialized}\n`);
  }

  async list(options: { limit?: number } = {}): Promise<AuditRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const records = lines.map((line) => JSON.parse(line) as AuditRecord);
      if (!options.limit || options.limit <= 0) return records;
      return records.slice(-options.limit);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }
}

export function createFileAuditWriter(filePath: string, privacyRules?: PrivacyRules): AuditWriter {
  return new FileAuditWriter(filePath, privacyRules);
}
