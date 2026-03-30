import type { SnoozeState } from "./types.js";

const DEFAULT_SNOOZE_DURATIONS_MS = [86_400_000, 172_800_000, 604_800_000];

export function computeSnoozeExpiry(snooze: SnoozeState, durations?: number[]): Date {
  const d = durations ?? DEFAULT_SNOOZE_DURATIONS_MS;
  const index = Math.min(snooze.level, d.length - 1);
  const durationMs = d[index] ?? d[d.length - 1] ?? 604_800_000;
  return new Date(new Date(snooze.snoozedAt).getTime() + durationMs);
}

export function isSnoozeActive(snooze: SnoozeState, durations?: number[]): boolean {
  return computeSnoozeExpiry(snooze, durations).getTime() > Date.now();
}

export function advanceSnooze(current: SnoozeState | undefined, candidateVersion: string): SnoozeState {
  if (!current || current.version !== candidateVersion) {
    return { version: candidateVersion, level: 0, snoozedAt: new Date().toISOString() };
  }
  return { version: candidateVersion, level: current.level + 1, snoozedAt: new Date().toISOString() };
}
