import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import type {
  CommandExecutionResult,
  ExecutionOperation,
  ResolvedAdapterContext,
  UpdateCandidate,
  UpdateManifest
} from "./types.js";
import { redactText, renderCommandTemplate, renderTemplate, runWithRetry } from "./utils.js";

export function buildTemplateVariables(
  host: Pick<ResolvedAdapterContext, "cwd" | "appName" | "componentName">,
  manifest: UpdateManifest,
  currentVersion: string,
  targetVersion?: string,
  candidate?: UpdateCandidate
): Record<string, string | undefined> {
  return {
    cwd: host.cwd,
    appName: host.appName,
    componentName: host.componentName ?? host.appName,
    repo: manifest.repo,
    currentVersion,
    fromVersion: currentVersion,
    targetVersion,
    toVersion: targetVersion,
    version: targetVersion,
    candidateVersion: targetVersion,
    ref: candidate?.ref ?? targetVersion
  };
}

export async function executeOperations(params: {
  operations: ExecutionOperation[];
  host: ResolvedAdapterContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion?: string;
  candidate?: UpdateCandidate;
}): Promise<CommandExecutionResult[]> {
  const outputs: CommandExecutionResult[] = [];
  const variables = buildTemplateVariables(params.host, params.manifest, params.currentVersion, params.targetVersion, params.candidate);

  for (const operation of params.operations) {
    if (operation.kind === "note") continue;
    if (operation.kind === "download") {
      const url = renderTemplate(operation.url, variables);
      const destination = renderTemplate(operation.destination, variables);
      const response = await params.host.fetchImpl(url);
      if (!response.ok) {
        throw new Error(`Download failed for ${url}: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, buffer);
      continue;
    }

    const command = renderCommandTemplate(operation.command, variables);
    const result = await runWithRetry(async () => {
      const executed = await params.host.executor({
        command,
        cwd: operation.cwd,
        env: operation.env,
        timeoutMs: operation.timeoutMs,
        shell: operation.shell,
        description: operation.description,
        dangerous: operation.dangerous
      });
      if (!executed.ok) {
        throw new Error([
          `${operation.description} failed with exit code ${executed.code}.`,
          redactText(executed.stderr || executed.stdout, params.manifest.privacyRules)
        ].filter(Boolean).join("\n"));
      }
      return executed;
    }, params.manifest.retryPolicy);
    outputs.push({
      ...result,
      stdout: redactText(result.stdout, params.manifest.privacyRules),
      stderr: redactText(result.stderr, params.manifest.privacyRules)
    });
  }

  return outputs;
}
