import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  CommandExecutionRequest,
  JsonValue,
  PrivacyRules,
  RetryPolicy,
  UpdatePolicy,
  UpdatePolicyMode,
  UpdateRiskLevel
} from "./types.js";

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function resolveFromCwd(cwd: string, maybePath?: string): string | undefined {
  if (!maybePath) return undefined;
  return path.isAbsolute(maybePath) ? maybePath : path.join(cwd, maybePath);
}

export async function readJsonFileIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function appendTextFile(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, { encoding: "utf8", flag: "a" });
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function parseVersion(version: string): ParsedSemver | undefined {
  const normalized = normalizeVersion(version);
  const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split(".") : []
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a && b) {
    if (a.major !== b.major) return a.major > b.major ? 1 : -1;
    if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
    if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
    if (!a.prerelease.length && b.prerelease.length) return 1;
    if (a.prerelease.length && !b.prerelease.length) return -1;
    const max = Math.max(a.prerelease.length, b.prerelease.length);
    for (let i = 0; i < max; i += 1) {
      const leftPart = a.prerelease[i];
      const rightPart = b.prerelease[i];
      if (leftPart === rightPart) continue;
      if (leftPart === undefined) return -1;
      if (rightPart === undefined) return 1;
      const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : Number.NaN;
      const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : Number.NaN;
      if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
        return leftNumber > rightNumber ? 1 : -1;
      }
      return leftPart > rightPart ? 1 : -1;
    }
    return 0;
  }

  const leftParts = normalizeVersion(left).split(/[.-]/);
  const rightParts = normalizeVersion(right).split(/[.-]/);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < max; i += 1) {
    const l = leftParts[i] ?? "0";
    const r = rightParts[i] ?? "0";
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? Number(l) : Number.NaN;
    const rn = /^\d+$/.test(r) ? Number(r) : Number.NaN;
    if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln > rn ? 1 : -1;
    return l > r ? 1 : -1;
  }
  return 0;
}

export function getRiskLevel(currentVersion: string, nextVersion: string): UpdateRiskLevel {
  if (compareVersions(nextVersion, currentVersion) <= 0) return "none";
  const current = parseVersion(currentVersion);
  const next = parseVersion(nextVersion);
  if (!current || !next) return "unknown";
  if (next.prerelease.length) return "prerelease";
  if (current.major !== next.major) return "major";
  if (current.minor !== next.minor) return "minor";
  if (current.patch !== next.patch) return "patch";
  return "unknown";
}

export function toPolicy(input?: UpdatePolicy | UpdatePolicyMode, allowedUpdateLevels?: Array<"patch" | "minor" | "major">): UpdatePolicy {
  const base = typeof input === "string"
    ? { mode: input }
    : input ?? { mode: "manual" satisfies UpdatePolicyMode };

  return {
    mode: base.mode,
    allowedUpdateLevels: allowedUpdateLevels ?? base.allowedUpdateLevels
  };
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}

export function renderTemplate(value: string, variables: Record<string, string | undefined>): string {
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => variables[key] ?? "");
}

export function renderCommandTemplate(
  command: string | string[],
  variables: Record<string, string | undefined>
): string | string[] {
  if (typeof command === "string") return renderTemplate(command, variables);
  return command.map((part) => renderTemplate(part, variables));
}

export function formatCommand(request: Pick<CommandExecutionRequest, "command" | "shell">): string {
  const command = request.command;
  if (typeof command === "string") return command;
  return command.map((token) => quoteForShell(token)).join(" ");
}

export function quoteForShell(token: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function takeNonEmptyLines(input: string, limit = 5): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function mergeUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean).map((value) => value.trim()).filter(Boolean)));
}

export function redactText(input: string, rules?: PrivacyRules): string {
  if (!rules) return input;
  const replacement = rules.replacement ?? "[REDACTED]";
  let output = input;
  for (const value of rules.redactValues ?? []) {
    if (!value) continue;
    output = output.split(value).join(replacement);
  }
  for (const pattern of rules.redactPatterns ?? []) {
    if (!pattern) continue;
    output = output.replace(new RegExp(pattern, "g"), replacement);
  }
  return output;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithRetry<T>(
  task: () => Promise<T>,
  policy?: RetryPolicy
): Promise<T> {
  const retries = policy?.retries ?? 0;
  const backoffMs = policy?.backoffMs ?? 0;
  const factor = policy?.factor ?? 1;
  let attempt = 0;
  let currentDelay = backoffMs;

  for (;;) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= retries) throw error;
      attempt += 1;
      if (currentDelay > 0) await sleep(currentDelay);
      currentDelay = currentDelay * factor || currentDelay;
    }
  }
}

export function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo "${repo}". Expected "owner/name".`);
  }
  return { owner, repo: name };
}

export function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

export function toJsonRecord(value: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) output[key] = entry;
  }
  return output;
}

export function mergeDefined<T extends object>(base: T, overrides: Partial<T> | undefined): T {
  if (!overrides) return base;
  const output = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) output[key] = value;
  }
  return output as T;
}

export function normalizeGithubRepo(input: string): string | undefined {
  const trimmed = input.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  return undefined;
}
