import { access, readFile } from "node:fs/promises";

import type {
  BuiltinHookDefinition,
  HookDefinition,
  HookExecutionContext,
  HookExecutionResult,
  HookStage,
  ResolvedAdapterContext,
  UpdateCandidate,
  UpdateManifest,
  UpdateHostContext,
  VerificationPhase
} from "./types.js";
import { buildTemplateVariables } from "./execution.js";
import { renderCommandTemplate, renderTemplate, runWithRetry } from "./utils.js";

export async function runHooks(params: {
  stage: HookStage;
  definitions: HookDefinition[];
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion?: string;
  candidate?: UpdateCandidate;
}): Promise<{ ok: boolean; results: HookExecutionResult[] }> {
  const results: HookExecutionResult[] = [];

  for (const definition of params.definitions) {
    const result = await runHook({
      hook: definition,
      stage: params.stage,
      host: params.host,
      manifest: params.manifest,
      currentVersion: params.currentVersion,
      targetVersion: params.targetVersion,
      candidate: params.candidate,
      executor: params.host.executor,
      dryRun: false
    }, params.host.hookRunner);
    results.push(result);
    if (!result.ok && !definition.allowFailure) {
      return { ok: false, results };
    }
  }

  return { ok: true, results };
}

export function filterVerificationHooks(
  hooks: HookDefinition[] | undefined,
  phase: VerificationPhase
): HookDefinition[] {
  return (hooks ?? []).filter((hook) => (hook.phase ?? "after_switch") === phase);
}

export async function runHook(
  context: HookExecutionContext,
  customRunner?: ResolvedAdapterContext["hookRunner"]
): Promise<HookExecutionResult> {
  const hookId = context.hook.id ?? hookLabel(context.stage, context.hook);
  const variables = buildTemplateVariables(
    {
      cwd: context.host.cwd,
      appName: context.host.appName,
      componentName: context.host.componentName
    } as ResolvedAdapterContext,
    context.manifest,
    context.currentVersion,
    context.targetVersion,
    context.candidate
  );

  const execute = async (): Promise<HookExecutionResult> => {
    if (context.hook.type === "builtin") {
      return await runBuiltinHook(hookId, context.hook, context, variables);
    }

    if (context.hook.type === "command") {
      const result = await context.executor?.({
        command: renderCommandTemplate(context.hook.command, variables),
        cwd: context.hook.cwd ?? context.host.cwd,
        env: context.hook.env,
        timeoutMs: context.hook.timeoutMs ?? context.manifest.timeouts?.hookMs,
        shell: context.hook.shell,
        description: context.hook.description,
        dangerous: context.hook.dangerous
      });
      if (!result) throw new Error(`No executor available for hook ${hookId}.`);
      return {
        ok: result.ok,
        hookId,
        message: result.ok
          ? `${hookId} passed`
          : `${hookId} failed with exit code ${result.code}`,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n")
      };
    }

    if (!customRunner) {
      throw new Error(`Custom hook ${hookId} requires adapter.hookRunner.`);
    }
    return customRunner(context);
  };

  return await runWithRetry(execute, context.hook.retryPolicy ?? context.manifest.retryPolicy);
}

async function runBuiltinHook(
  hookId: string,
  hook: BuiltinHookDefinition,
  context: HookExecutionContext,
  variables: Record<string, string | undefined>
): Promise<HookExecutionResult> {
  const value = renderTemplate(hook.value, variables);

  if (hook.builtin === "path_exists" || hook.builtin === "file_exists") {
    try {
      await access(value);
      return { ok: true, hookId, message: `${hookId} passed` };
    } catch {
      return { ok: false, hookId, message: `${hookId} missing path ${value}` };
    }
  }

  if (hook.builtin === "command_exists") {
    const result = await context.executor?.({
      command: `command -v ${value}`,
      cwd: context.host.cwd,
      shell: true,
      timeoutMs: hook.timeoutMs ?? context.manifest.timeouts?.hookMs,
      description: hook.description
    });
    if (!result) throw new Error(`No executor available for hook ${hookId}.`);
    return {
      ok: result.ok,
      hookId,
      message: result.ok ? `${hookId} passed` : `${hookId} could not find command ${value}`,
      output: result.stdout || result.stderr
    };
  }

  if (hook.builtin === "file_contains") {
    const raw = await readFile(value, "utf8").catch(() => undefined);
    const ok = raw?.includes(hook.contains ?? "") ?? false;
    return {
      ok,
      hookId,
      message: ok
        ? `${hookId} passed`
        : `${hookId} expected ${hook.contains ?? ""} in ${value}`
    };
  }

  return { ok: false, hookId, message: `${hookId} is not supported.` };
}

function hookLabel(stage: HookStage, hook: HookDefinition): string {
  return `${stage}_${hook.type}`;
}
