import type { UpdateManifest, UpdatePolicy, UpdateState, UpdateStateStore, UpdateHostContext } from "./types.js";
import { readJsonFileIfExists, toPolicy, writeJsonFile } from "./utils.js";

export class FileStateStore implements UpdateStateStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<UpdateState | undefined> {
    return readJsonFileIfExists<UpdateState>(this.filePath);
  }

  async write(state: UpdateState): Promise<void> {
    await writeJsonFile(this.filePath, state);
  }
}

export function createFileStateStore(filePath: string): UpdateStateStore {
  return new FileStateStore(filePath);
}

export function buildInitialState(
  manifest: UpdateManifest,
  host: Pick<UpdateHostContext, "appName" | "componentName">
): UpdateState {
  return {
    componentName: host.componentName ?? manifest.componentName ?? host.appName,
    repo: manifest.repo,
    autoUpdatePolicy: toPolicy(manifest.autoUpdatePolicy, manifest.allowedUpdateLevels),
    ignoredVersions: [...(manifest.ignoredVersions ?? [])],
    updatedAt: new Date().toISOString()
  };
}

export async function ensureState(
  store: UpdateStateStore,
  manifest: UpdateManifest,
  host: Pick<UpdateHostContext, "appName" | "componentName">
): Promise<UpdateState> {
  const existing = await store.read();
  if (existing) {
    return {
      ...existing,
      componentName: existing.componentName || host.componentName || manifest.componentName || host.appName,
      repo: existing.repo || manifest.repo,
      autoUpdatePolicy: mergePolicy(existing.autoUpdatePolicy, manifest)
    };
  }
  const state = buildInitialState(manifest, host);
  await store.write(state);
  return state;
}

export function mergePolicy(existing: UpdatePolicy | undefined, manifest: UpdateManifest): UpdatePolicy {
  const manifestPolicy = toPolicy(manifest.autoUpdatePolicy, manifest.allowedUpdateLevels);
  if (!existing) return manifestPolicy;
  return {
    mode: existing.mode ?? manifestPolicy.mode,
    allowedUpdateLevels: existing.allowedUpdateLevels ?? manifestPolicy.allowedUpdateLevels
  };
}

export function touchState(state: UpdateState, patch: Partial<UpdateState>): UpdateState {
  return {
    ...state,
    ...patch,
    autoUpdatePolicy: patch.autoUpdatePolicy ?? state.autoUpdatePolicy,
    ignoredVersions: patch.ignoredVersions ?? state.ignoredVersions,
    updatedAt: new Date().toISOString()
  };
}
