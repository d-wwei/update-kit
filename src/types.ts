export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export type ReleaseChannel = "releases" | "tags";
export type VersionSourceType = "package.json" | "pyproject.toml" | "file" | "literal";
export type InstallStrategyKind =
  | "npm_package"
  | "pnpm_package"
  | "yarn_package"
  | "pip_package"
  | "git_pull"
  | "archive_download"
  | "custom_command";
export type UpdatePolicyMode = "manual" | "patch" | "minor" | "all";
export type UpdateRiskLevel = "none" | "patch" | "minor" | "major" | "prerelease" | "unknown";
export type HostPreset = "node-npm" | "node-pnpm" | "node-yarn" | "python-pip" | "git-repo" | "custom";
export type ManifestSource = "manifest" | "autodetect" | "merged";
export type UpdateDecision =
  | "update_once"
  | "always_auto_update"
  | "skip_this_time"
  | "ignore_this_version"
  | "auto_update"
  | "no_update_required"
  | "ignored_by_policy";
export type UpdateOutcomeStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "rolled_back"
  | "dry_run";
export type AuditStep =
  | "detection_started"
  | "detection_completed"
  | "decision_recorded"
  | "plan_created"
  | "preflight_passed"
  | "preflight_failed"
  | "install_started"
  | "install_completed"
  | "install_failed"
  | "migration_started"
  | "migration_completed"
  | "migration_failed"
  | "compatibility_started"
  | "compatibility_completed"
  | "compatibility_failed"
  | "verification_started"
  | "verification_completed"
  | "verification_failed"
  | "switch_started"
  | "switch_completed"
  | "switch_failed"
  | "rollback_started"
  | "rollback_completed"
  | "rollback_failed"
  | "apply_completed"
  | "apply_failed";
export type AuditStatus = "started" | "completed" | "failed" | "skipped";
export type VerificationPhase = "before_switch" | "after_switch";
export type HookStage =
  | "preflight"
  | "migration"
  | "compatibility"
  | "verification_before_switch"
  | "verification_after_switch";
export type ExecutionStage =
  | "preflight"
  | "install"
  | "migration"
  | "compatibility"
  | "verification_before_switch"
  | "switch"
  | "verification_after_switch"
  | "rollback";

export type VersionSource = {
  type: VersionSourceType;
  path?: string;
  key?: string;
  value?: string;
  regex?: string;
};

export type RetryPolicy = {
  retries?: number;
  backoffMs?: number;
  factor?: number;
};

export type TimeoutConfig = {
  confirmMs?: number;
  detectionMs?: number;
  installMs?: number;
  hookMs?: number;
  switchMs?: number;
  rollbackMs?: number;
};

export type PrivacyRules = {
  redactPatterns?: string[];
  redactValues?: string[];
  replacement?: string;
};

export type BaseHookDefinition = {
  id?: string;
  description?: string;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  allowFailure?: boolean;
  dangerous?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  phase?: VerificationPhase;
};

export type CommandHookDefinition = BaseHookDefinition & {
  type: "command";
  command: string | string[];
  shell?: boolean;
};

export type CustomHookDefinition = BaseHookDefinition & {
  type: "custom";
  handler: string;
  input?: Record<string, JsonValue>;
};

export type BuiltinHookDefinition = BaseHookDefinition & {
  type: "builtin";
  builtin: "path_exists" | "file_exists" | "command_exists" | "file_contains";
  value: string;
  contains?: string;
};

export type HookDefinition =
  | CommandHookDefinition
  | CustomHookDefinition
  | BuiltinHookDefinition;

export type BaseInstallStrategy = {
  type: InstallStrategyKind;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
};

export type NpmPackageInstallStrategy = BaseInstallStrategy & {
  type: "npm_package";
  packageName: string;
  installArgs?: string[];
};

export type PnpmPackageInstallStrategy = BaseInstallStrategy & {
  type: "pnpm_package";
  packageName: string;
  installArgs?: string[];
};

export type YarnPackageInstallStrategy = BaseInstallStrategy & {
  type: "yarn_package";
  packageName: string;
  installArgs?: string[];
};

export type PipPackageInstallStrategy = BaseInstallStrategy & {
  type: "pip_package";
  packageName: string;
  pythonExecutable?: string;
  installArgs?: string[];
};

export type GitPullInstallStrategy = BaseInstallStrategy & {
  type: "git_pull";
  remote?: string;
  refTemplate?: string;
  fetchArgs?: string[];
};

export type ArchiveDownloadInstallStrategy = BaseInstallStrategy & {
  type: "archive_download";
  urlTemplate: string;
  destinationPath: string;
  archiveFileNameTemplate?: string;
  archiveType?: "zip" | "tar" | "tar.gz" | "tgz";
  checksumSha256?: string;
  allowInsecureArchive?: boolean;
  extract?: boolean;
  extractCommand?: string | string[];
  expectedExtractedPaths?: string[];
};

export type CustomCommandInstallStrategy = BaseInstallStrategy & {
  type: "custom_command";
  command: string | string[];
  shell?: boolean;
};

export type InstallStrategy =
  | NpmPackageInstallStrategy
  | PnpmPackageInstallStrategy
  | YarnPackageInstallStrategy
  | PipPackageInstallStrategy
  | GitPullInstallStrategy
  | ArchiveDownloadInstallStrategy
  | CustomCommandInstallStrategy;

export type UpdatePolicy = {
  mode: UpdatePolicyMode;
  allowedUpdateLevels?: Array<"patch" | "minor" | "major">;
};

export type UpdateInstructions = {
  summary?: string;
  docsUrl?: string;
  installHint?: string;
};

export type UpdateManifest = {
  $schemaVersion?: number;
  componentName?: string;
  repo: string;
  releaseChannel: ReleaseChannel;
  currentVersionSource: VersionSource;
  candidateVersionSource?: VersionSource;
  installStrategy: InstallStrategy;
  installCommand?: string | string[];
  switchCommand?: string | string[];
  rollbackCommand?: string | string[];
  statePath: string;
  auditLogPath: string;
  lockPath: string;
  autoUpdatePolicy?: UpdatePolicy | UpdatePolicyMode;
  allowedUpdateLevels?: Array<"patch" | "minor" | "major">;
  ignoredVersions?: string[];
  preflightHooks?: HookDefinition[];
  migrationHooks?: HookDefinition[];
  compatibilityHooks?: HookDefinition[];
  verificationHooks?: HookDefinition[];
  updateInstructions?: UpdateInstructions;
  privacyRules?: PrivacyRules;
  timeouts?: TimeoutConfig;
  retryPolicy?: RetryPolicy;
  github?: {
    apiBaseUrl?: string;
    token?: string;
    tokenEnv?: string;
    includePrerelease?: boolean;
    perPage?: number;
    maxPages?: number;
    rateLimitRetries?: number;
    maxRateLimitWaitMs?: number;
  };
};

export type UpdateManifestOverrides = Partial<UpdateManifest>;

export type BootstrapManifestOptions = {
  cwd: string;
  preset?: HostPreset;
  overrides?: UpdateManifestOverrides;
};

export type ResolvedManifestInfo = {
  source: ManifestSource;
  preset?: HostPreset;
  signals?: string[];
};

export type UpdateCandidate = {
  version: string;
  ref: string;
  source: ReleaseChannel;
  releaseUrl?: string;
  compareUrl?: string;
  publishedAt?: string;
  riskLevel: UpdateRiskLevel;
  summary: UpdateSummary;
};

export type UpdateSummary = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  ignored: boolean;
  checkedAt: string;
  releaseUrl?: string;
  compareUrl?: string;
  highlights: string[];
  message: string;
  riskLevel: UpdateRiskLevel;
};

export type PolicyEvaluation = {
  effectivePolicy: UpdatePolicy;
  autoApply: boolean;
  requiresConfirmation: boolean;
  ignored: boolean;
  reason: string;
};

export type UpdateCheckResult = UpdateSummary & {
  candidate?: UpdateCandidate;
  policy: PolicyEvaluation;
  state: UpdateState;
  localCandidateVersion?: string;
};

export type CommandExecutionRequest = {
  command: string | string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  shell?: boolean;
  description?: string;
  dangerous?: boolean;
};

export type CommandExecutionResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string | string[];
};

export type UpdateConfirmationPrompt = {
  kind: "update";
  title: string;
  summary: string;
  currentVersion: string;
  candidateVersion: string;
  riskLevel: UpdateRiskLevel;
  repo: string;
  options: Array<"update_once" | "always_auto_update" | "skip_this_time" | "ignore_this_version">;
  highlights: string[];
  releaseUrl?: string;
};

export type CommandExecutor = (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
export type ConfirmHandler = (prompt: UpdateConfirmationPrompt) => Promise<
  "update_once" | "always_auto_update" | "skip_this_time" | "ignore_this_version"
>;

export type HookExecutionContext = {
  hook: HookDefinition;
  stage: HookStage;
  host: UpdateHostContext;
  manifest: UpdateManifest;
  currentVersion: string;
  targetVersion?: string;
  candidate?: UpdateCandidate;
  executor?: CommandExecutor;
  dryRun: boolean;
};

export type HookExecutionResult = {
  ok: boolean;
  hookId: string;
  message: string;
  output?: string;
  metadata?: Record<string, JsonValue>;
};

export type HookRunner = (context: HookExecutionContext) => Promise<HookExecutionResult>;

export type ExecutionOperation =
  | {
      kind: "command";
      description: string;
      command: string | string[];
      cwd: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      shell?: boolean;
      dangerous?: boolean;
    }
  | {
      kind: "download";
      description: string;
      url: string;
      destination: string;
      dangerous?: boolean;
    }
  | {
      kind: "note";
      description: string;
    };

export type ExecutionStep = {
  name: ExecutionStage;
  description: string;
  operations: ExecutionOperation[];
};

export type UpdatePlan = {
  componentName: string;
  repo: string;
  currentVersion: string;
  targetVersion?: string;
  decision: UpdateDecision;
  dryRun: boolean;
  riskLevel: UpdateRiskLevel;
  requiresConfirmation: boolean;
  steps: ExecutionStep[];
  rollbackPreview: ExecutionOperation[];
  reason: string;
};

export type PreflightResult = {
  ok: boolean;
  stage: "preflight";
  results: HookExecutionResult[];
  message: string;
};

export type VerificationResult = {
  ok: boolean;
  phase: VerificationPhase;
  results: HookExecutionResult[];
  message: string;
};

export type SwitchResult = {
  ok: boolean;
  operations: ExecutionOperation[];
  outputs: CommandExecutionResult[];
  message: string;
};

export type RollbackResult = {
  ok: boolean;
  targetVersion?: string;
  operations: ExecutionOperation[];
  outputs: CommandExecutionResult[];
  message: string;
  error?: {
    message: string;
    stack?: string;
  };
};

export type ApplyResult = {
  ok: boolean;
  status: UpdateOutcomeStatus;
  executionId: string;
  decision: UpdateDecision;
  dryRun: boolean;
  currentVersion: string;
  targetVersion?: string;
  plan?: UpdatePlan;
  preflight?: PreflightResult;
  migration?: HookExecutionResult[];
  compatibility?: HookExecutionResult[];
  verificationBeforeSwitch?: VerificationResult;
  verificationAfterSwitch?: VerificationResult;
  switchResult?: SwitchResult;
  rollback?: RollbackResult;
  state: UpdateState;
  message: string;
};

export type AuditRecord = {
  id: string;
  timestamp: string;
  componentName: string;
  repo: string;
  fromVersion?: string;
  toVersion?: string;
  decision?: UpdateDecision;
  step: AuditStep;
  status: AuditStatus;
  message: string;
  metadata?: Record<string, JsonValue>;
};

export type UpdateState = {
  componentName: string;
  repo: string;
  currentVersion?: string;
  stableVersion?: string;
  previousStableVersion?: string;
  candidateVersion?: string;
  localCandidateVersion?: string;
  lastCandidateVersion?: string;
  autoUpdatePolicy: UpdatePolicy;
  ignoredVersions: string[];
  lastCheckedAt?: string;
  lastExecution?: {
    id: string;
    status: "idle" | "running" | "succeeded" | "failed" | "rolled_back" | "skipped" | "dry_run";
    startedAt?: string;
    completedAt?: string;
    decision?: UpdateDecision;
    fromVersion?: string;
    toVersion?: string;
    failureReason?: string;
  };
  lastSuccessfulVersion?: string;
  lastSuccessfulAt?: string;
  lastFailedAt?: string;
  lastFailureReason?: string;
  updatedAt: string;
};

export type UpdateStateStore = {
  read(): Promise<UpdateState | undefined>;
  write(state: UpdateState): Promise<void>;
};

export type AuditWriter = {
  append(record: AuditRecord): Promise<void>;
  list(options?: { limit?: number }): Promise<AuditRecord[]>;
};

export type UpdateLockHandle = {
  release(): Promise<void>;
};

export type UpdateLockManager = {
  acquire(metadata?: Record<string, JsonValue>): Promise<UpdateLockHandle>;
};

export type UpdateHostContext = {
  cwd: string;
  appName: string;
  componentName?: string;
  currentVersion?: string;
  metadata?: Record<string, JsonValue>;
};

export type AdapterContextOverrides = Partial<UpdateHostContext> & {
  confirm?: ConfirmHandler;
  executor?: CommandExecutor;
  stateStore?: UpdateStateStore;
  auditWriter?: AuditWriter;
  lockManager?: UpdateLockManager;
  hookRunner?: HookRunner;
  fetchImpl?: typeof fetch;
};

export type UpdateAdapter = {
  name: string;
  getContext: (overrides?: Partial<UpdateHostContext>) => Promise<UpdateHostContext> | UpdateHostContext;
  confirm?: ConfirmHandler;
  executor?: CommandExecutor;
  stateStore?: UpdateStateStore;
  auditWriter?: AuditWriter;
  lockManager?: UpdateLockManager;
  hookRunner?: HookRunner;
  fetchImpl?: typeof fetch;
};

export type ResolvedAdapterContext = UpdateHostContext & {
  confirm?: ConfirmHandler;
  executor: CommandExecutor;
  stateStore: UpdateStateStore;
  auditWriter: AuditWriter;
  lockManager: UpdateLockManager;
  hookRunner?: HookRunner;
  fetchImpl: typeof fetch;
};

export type RuntimeOptions = {
  cwd: string;
  manifestFile?: string;
  manifest?: UpdateManifest;
  manifestOverrides?: UpdateManifestOverrides;
  autodetect?: boolean;
  preset?: HostPreset;
};

export type CheckOptions = AdapterContextOverrides & {
  persist?: boolean;
};

export type PlanOptions = AdapterContextOverrides & {
  dryRun?: boolean;
  decision?: UpdateDecision;
};

export type ApplyOptions = AdapterContextOverrides & {
  dryRun?: boolean;
  decision?: "update_once" | "always_auto_update" | "skip_this_time" | "ignore_this_version";
};

export type RollbackOptions = AdapterContextOverrides & {
  dryRun?: boolean;
  version?: string;
  reason?: string;
};

export type GetAuditOptions = AdapterContextOverrides & {
  limit?: number;
};
