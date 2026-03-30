// Issue #19: Corrupt JSONL audit test
// Tests FileAuditWriter.list() behavior when the audit log contains malformed JSON lines.
//
// The compiled implementation (dist/src/audit.js) wraps each JSON.parse in a try/catch
// and silently skips corrupt lines. This test verifies that behavior.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

import { FileAuditWriter, createFileAuditWriter } from "../src/audit.js";

describe("FileAuditWriter corrupt JSONL handling", () => {
  const tmpDirs: string[] = [];
  after(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  async function makeTmpDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uk-audit-corrupt-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("list() works correctly with all valid JSONL lines", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "audit.log");

    const record1 = {
      id: "1",
      timestamp: new Date().toISOString(),
      componentName: "demo",
      repo: "acme/example",
      step: "detection_started",
      status: "started",
      message: "First record"
    };
    const record2 = {
      id: "2",
      timestamp: new Date().toISOString(),
      componentName: "demo",
      repo: "acme/example",
      step: "detection_completed",
      status: "completed",
      message: "Second record"
    };

    await writeFile(filePath, JSON.stringify(record1) + "\n" + JSON.stringify(record2) + "\n", "utf8");

    const writer = createFileAuditWriter(filePath);
    const records = await writer.list();
    assert.equal(records.length, 2);
    assert.equal(records[0]!.message, "First record");
    assert.equal(records[1]!.message, "Second record");
  });

  it("list() skips corrupt JSON lines and returns only valid records", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "audit.log");

    const validRecord1 = {
      id: "1",
      timestamp: new Date().toISOString(),
      componentName: "demo",
      repo: "acme/example",
      step: "detection_started",
      status: "started",
      message: "First valid record"
    };
    const validRecord3 = {
      id: "3",
      timestamp: new Date().toISOString(),
      componentName: "demo",
      repo: "acme/example",
      step: "detection_completed",
      status: "completed",
      message: "Third valid record"
    };

    // Write valid line, then corrupt line, then another valid line
    const content = [
      JSON.stringify(validRecord1),
      "not json at all {{{",
      JSON.stringify(validRecord3)
    ].join("\n") + "\n";

    await writeFile(filePath, content, "utf8");

    const writer = createFileAuditWriter(filePath);

    // The implementation wraps each JSON.parse in a per-line try/catch,
    // silently skipping corrupt lines. Only valid records are returned.
    const records = await writer.list();
    assert.equal(records.length, 2);
    assert.equal(records[0]!.message, "First valid record");
    assert.equal(records[1]!.message, "Third valid record");
  });

  it("list() returns empty array for missing file", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "nonexistent-audit.log");

    const writer = createFileAuditWriter(filePath);
    const records = await writer.list();
    assert.deepEqual(records, []);
  });

  it("list() returns empty array for empty file", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "empty-audit.log");
    await writeFile(filePath, "", "utf8");

    const writer = createFileAuditWriter(filePath);
    const records = await writer.list();
    assert.deepEqual(records, []);
  });

  it("list() handles file with only whitespace lines", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "whitespace-audit.log");
    await writeFile(filePath, "\n  \n\n", "utf8");

    const writer = createFileAuditWriter(filePath);
    // Current behavior: whitespace-only lines are filtered out by .filter(Boolean)
    // but "  " (spaces) is truthy, so it will be passed to JSON.parse and throw.
    // Let's verify:
    await assert.rejects(
      () => writer.list(),
      (error: unknown) => {
        // A trimmed "  " becomes "" which is falsy and should be filtered.
        // Wait, the code does .map(line => line.trim()).filter(Boolean), so "  " -> "" -> filtered.
        // So this should actually work fine.
        return false; // Signal we don't expect rejection
      }
    ).catch(() => {
      // If it didn't reject, that's the expected behavior. Verify it returns empty.
    });

    // Re-create writer and verify the non-rejecting case
    const writer2 = createFileAuditWriter(filePath);
    const records = await writer2.list();
    assert.deepEqual(records, []);
  });

  it("append creates valid JSONL format", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "append-audit.log");

    const writer = createFileAuditWriter(filePath);
    await writer.append({
      id: "1",
      timestamp: new Date().toISOString(),
      componentName: "demo",
      repo: "acme/example",
      step: "detection_started",
      status: "started",
      message: "Record one"
    });
    await writer.append({
      id: "2",
      timestamp: new Date().toISOString(),
      componentName: "demo",
      repo: "acme/example",
      step: "detection_completed",
      status: "completed",
      message: "Record two"
    });

    // Verify the file content is valid JSONL
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);

    // Each line should parse independently
    const parsed1 = JSON.parse(lines[0]!);
    const parsed2 = JSON.parse(lines[1]!);
    assert.equal(parsed1.message, "Record one");
    assert.equal(parsed2.message, "Record two");
  });

  it("list() with limit returns only the last N records", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "limited-audit.log");

    const writer = createFileAuditWriter(filePath);
    for (let i = 1; i <= 5; i++) {
      await writer.append({
        id: String(i),
        timestamp: new Date().toISOString(),
        componentName: "demo",
        repo: "acme/example",
        step: "detection_started",
        status: "started",
        message: `Record ${i}`
      });
    }

    const records = await writer.list({ limit: 2 });
    assert.equal(records.length, 2);
    assert.equal(records[0]!.message, "Record 4");
    assert.equal(records[1]!.message, "Record 5");
  });
});
