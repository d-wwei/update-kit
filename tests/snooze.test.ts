import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advanceSnooze, computeSnoozeExpiry, isSnoozeActive } from "../src/snooze.js";
import type { SnoozeState } from "../src/types.js";

describe("snooze", () => {
  it("advanceSnooze starts at level 0 for new version", () => {
    const result = advanceSnooze(undefined, "1.1.0");
    assert.equal(result.version, "1.1.0");
    assert.equal(result.level, 0);
  });

  it("advanceSnooze increments level for same version", () => {
    const current: SnoozeState = { version: "1.1.0", level: 0, snoozedAt: new Date().toISOString() };
    const result = advanceSnooze(current, "1.1.0");
    assert.equal(result.level, 1);
    assert.equal(result.version, "1.1.0");
  });

  it("advanceSnooze resets to 0 for different version", () => {
    const current: SnoozeState = { version: "1.1.0", level: 2, snoozedAt: new Date().toISOString() };
    const result = advanceSnooze(current, "1.2.0");
    assert.equal(result.level, 0);
    assert.equal(result.version, "1.2.0");
  });

  it("isSnoozeActive returns true within duration", () => {
    const snooze: SnoozeState = {
      version: "1.1.0",
      level: 0,
      snoozedAt: new Date(Date.now() - 3_600_000).toISOString() // 1h ago
    };
    assert.equal(isSnoozeActive(snooze), true); // level 0 = 24h, 1h < 24h
  });

  it("isSnoozeActive returns false after duration", () => {
    const snooze: SnoozeState = {
      version: "1.1.0",
      level: 0,
      snoozedAt: new Date(Date.now() - 90_000_000).toISOString() // 25h ago
    };
    assert.equal(isSnoozeActive(snooze), false); // level 0 = 24h
  });

  it("computeSnoozeExpiry uses correct duration for each level", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const level0: SnoozeState = { version: "1.0.0", level: 0, snoozedAt: base.toISOString() };
    const level1: SnoozeState = { version: "1.0.0", level: 1, snoozedAt: base.toISOString() };
    const level2: SnoozeState = { version: "1.0.0", level: 2, snoozedAt: base.toISOString() };

    const expiry0 = computeSnoozeExpiry(level0);
    const expiry1 = computeSnoozeExpiry(level1);
    const expiry2 = computeSnoozeExpiry(level2);

    assert.equal(expiry0.getTime() - base.getTime(), 86_400_000, "level 0 = 24h");
    assert.equal(expiry1.getTime() - base.getTime(), 172_800_000, "level 1 = 48h");
    assert.equal(expiry2.getTime() - base.getTime(), 604_800_000, "level 2 = 7d");
  });

  it("computeSnoozeExpiry caps at last duration for high levels", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const level10: SnoozeState = { version: "1.0.0", level: 10, snoozedAt: base.toISOString() };
    const expiry = computeSnoozeExpiry(level10);
    assert.equal(expiry.getTime() - base.getTime(), 604_800_000, "level 10 should cap at 7d");
  });

  it("custom durations override defaults", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const snooze: SnoozeState = { version: "1.0.0", level: 0, snoozedAt: base.toISOString() };
    const customDurations = [60_000, 120_000]; // 1min, 2min
    const expiry = computeSnoozeExpiry(snooze, customDurations);
    assert.equal(expiry.getTime() - base.getTime(), 60_000, "should use custom 1min duration");
  });
});
