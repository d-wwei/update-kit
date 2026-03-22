import { spawn } from "node:child_process";

import { createFileAuditWriter } from "./audit.js";
import { createFileLockManager } from "./lock.js";
import { createFileStateStore } from "./state.js";
import type {
  AdapterContextOverrides,
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandExecutor,
  ResolvedAdapterContext,
  UpdateAdapter,
  UpdateHostContext,
  UpdateManifest
} from "./types.js";

export function defineAdapter(adapter: UpdateAdapter): UpdateAdapter {
  return adapter;
}

export async function resolveAdapterContext(
  adapter: UpdateAdapter,
  manifest: UpdateManifest,
  overrides: AdapterContextOverrides = {}
): Promise<ResolvedAdapterContext> {
  const base = await adapter.getContext(overrides);
  const host = mergeHostContext(base, overrides, manifest);
  return {
    ...host,
    confirm: overrides.confirm ?? adapter.confirm,
    executor: overrides.executor ?? adapter.executor ?? createDefaultCommandExecutor(),
    stateStore: overrides.stateStore ?? adapter.stateStore ?? createFileStateStore(manifest.statePath),
    auditWriter: overrides.auditWriter ?? adapter.auditWriter ?? createFileAuditWriter(manifest.auditLogPath, manifest.privacyRules),
    lockManager: overrides.lockManager ?? adapter.lockManager ?? createFileLockManager(manifest.lockPath),
    hookRunner: overrides.hookRunner ?? adapter.hookRunner,
    fetchImpl: overrides.fetchImpl ?? adapter.fetchImpl ?? fetch
  };
}

export function mergeHostContext(
  base: UpdateHostContext,
  overrides: Partial<UpdateHostContext>,
  manifest: UpdateManifest
): UpdateHostContext {
  return {
    ...base,
    ...overrides,
    componentName: overrides.componentName ?? base.componentName ?? manifest.componentName ?? base.appName
  };
}

export function createDefaultCommandExecutor(): CommandExecutor {
  return async (request: CommandExecutionRequest): Promise<CommandExecutionResult> => {
    const startedAt = Date.now();

    return await new Promise((resolve, reject) => {
      const child = typeof request.command === "string"
        ? spawn(request.command, {
            cwd: request.cwd,
            env: request.env ? { ...process.env, ...request.env } : process.env,
            shell: request.shell ?? true
          })
        : spawn(request.command[0] ?? "", request.command.slice(1), {
            cwd: request.cwd,
            env: request.env ? { ...process.env, ...request.env } : process.env,
            shell: request.shell ?? false
          });

      let stdout = "";
      let stderr = "";
      let finished = false;
      let timeout: NodeJS.Timeout | undefined;

      if (request.timeoutMs && request.timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (finished) return;
          finished = true;
          child.kill("SIGTERM");
          reject(new Error(`Command timed out after ${request.timeoutMs}ms.`));
        }, request.timeoutMs);
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        resolve({
          ok: code === 0,
          code: code ?? 1,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          command: request.command
        });
      });
    });
  };
}
