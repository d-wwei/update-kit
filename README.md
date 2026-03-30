# UpdateKit

[中文说明](./README.zh-CN.md)

`UpdateKit` is a production-grade, embeddable update orchestration framework. It is the execution plane for safely integrating upstream updates into host environments with policy, confirmation, verification, switching, rollback, locking, and structured auditability.

> UpdateKit safely turns “an update exists” into “the host was updated, verified, and can be rolled back.”

## Why It Exists

Many tools can detect a new version. Very few can safely apply it in a real host environment.

`UpdateKit` focuses on the execution path:

`detect -> policy -> prompt -> plan -> preflight -> install -> migrate -> compatibility -> verify -> switch -> record -> rollback`

It is designed for skills, agents, protocols, modules, CLIs, and full products that need controlled update execution rather than just notifications.

## Relationship To UDD Kit

Use `UDD Kit` when you need discovery, prompting, issue/contribution/PR drafts, and feedback loops.

Use `UpdateKit` when you need to actually execute an update with:

- policy
- host confirmation
- preflight checks
- installation
- migration hooks
- compatibility checks
- verification hooks
- switch and rollback
- state persistence
- audit logs

Recommended composition:

1. `UDD Kit` detects and explains the update.
2. The host or user makes a decision.
3. `UpdateKit.apply(...)` executes the update safely.
4. Results flow back into the host UI or `UDD Kit`.

## What It Supports

- GitHub releases and tags detection
- local current-version detection
- stable version and candidate version state
- explicit user decisions:
  `update_once`, `always_auto_update`, `skip_this_time`, `ignore_this_version`
- persisted auto-update policy:
  `manual`, `patch`, `minor`, `all`
- built-in install strategies:
  `npm_package`, `pnpm_package`, `yarn_package`, `pip_package`, `git_pull`, `archive_download`, `custom_command`
- preflight, migration, compatibility, and verification hooks
- dry-run / preview
- switch and automatic rollback
- structured JSONL audit logs
- persistent state
- update locking
- SDK and CLI

## Zero-Config Adoption

`UpdateKit` now defaults to autodetection first, and explicit overrides only when needed.

This works for common hosts without a manifest:

- `node-npm`
- `node-pnpm`
- `node-yarn`
- `python-pip`
- `git-repo`

Minimal usage:

```ts
import { createRuntime } from "update-kit/runtime";

const runtime = await createRuntime({
  cwd: process.cwd()
});
```

Autodetection attempts to infer:

- GitHub repo
- current version source
- package manager / install strategy
- default state, audit, and lock paths
- default safe policy

If that is not enough, use `manifestOverrides`:

```ts
const runtime = await createRuntime({
  cwd: process.cwd(),
  manifestOverrides: {
    autoUpdatePolicy: "patch"
  }
});
```

## Install

```bash
npm install update-kit
```

## Public API

- `createRuntime(options)`
- `bootstrapManifest({ cwd, overrides?, preset? })`
- `runtime.check(adapter, overrides?)`
- `runtime.plan(adapter, options?)`
- `runtime.apply(adapter, options?)`
- `runtime.rollback(adapter, options?)`
- `runtime.getState(adapter, options?)`
- `runtime.getAudit(adapter, options?)`
- `runtime.getPolicy(adapter, options?)`
- `runtime.setPolicy(adapter, mode, options?)`
- `runtime.ignoreVersion(adapter, version, options?)`
- `runtime.unignoreVersion(adapter, version, options?)`
- `runtime.quickCheck(adapter, options?)`
- `runtime.snooze(adapter, options?)`
- `defineAdapter(...)`

## Minimal Node/TS Example

```ts
import { defineAdapter } from "update-kit/adapter";
import { createRuntime } from "update-kit/runtime";

const runtime = await createRuntime({
  cwd: process.cwd()
});

const adapter = defineAdapter({
  name: "my-host",
  getContext() {
    return {
      cwd: process.cwd(),
      appName: "my-host",
      componentName: "my-host"
    };
  },
  confirm: async () => "update_once"
});

const summary = await runtime.check(adapter);
if (summary.hasUpdate) {
  const result = await runtime.apply(adapter);
  console.log(result.message);
}
```

See [examples/node-ts/index.ts](./examples/node-ts/index.ts).

## CLI

```bash
update-kit bootstrap --cwd . --json
update-kit check --cwd . [--force]
update-kit quick-check --cwd . [--force]
update-kit plan --cwd . --dry-run
update-kit apply --cwd .
update-kit rollback --cwd .
update-kit state --cwd .
update-kit audit --cwd .
update-kit policy --cwd .
update-kit ignore --cwd . --version 1.2.3
update-kit unignore --cwd . --version 1.2.3
update-kit snooze --cwd . [--version 1.2.3]
update-kit set-policy --cwd . --mode manual
```

CLI behavior:

- human-readable output by default
- `--json` for structured output
- `--manifest` to force a manifest file
- `--cwd` to choose the host root
- autodetect when a manifest is missing
- `--dry-run` for execution preview
- non-zero exit code on failure
- `--force` to bypass cache on check/quick-check

## Quick Check (Agent-Friendly)

`quickCheck()` is a cache-first, lightweight update check designed for agent preambles and high-frequency invocations:

- Returns from cache within TTL (no network, <5ms)
- Two-level TTL: up_to_date 60min, upgrade_available 12h
- Progressive snooze: 24h -> 48h -> 7d
- Just-upgraded marker after successful updates
- Soft-fail: network errors return "up_to_date" instead of throwing
- Kill switch via `updateCheckEnabled: false`

```ts
const result = await runtime.quickCheck(adapter);
// result.status: "up_to_date" | "upgrade_available" | "just_upgraded" | "snoozed" | "disabled"
```

See [Agent Integration Guide](./docs/AGENT_INTEGRATION.md) for patterns.

## Manifest

Default filename:

- `update.config.json`

Example:

- [update.config.example.json](./update.config.example.json)

You only need a full manifest when your host behavior cannot be safely inferred.

## Distributed Backends

The default implementation uses local files:

- `FileStateStore`
- `FileAuditWriter`
- `FileUpdateLockManager`

For multi-process or distributed environments, `UpdateKit` also ships with HTTP-based backends:

- `HttpStateStore`
- `HttpAuditWriter`
- `HttpLockManager`

This lets the host keep state, audit, and locking in a shared control plane.

## GitHub Resilience

GitHub detection now includes:

- pagination for releases and tags
- retry handling for `429` and rate-limit responses
- tunable controls through `manifest.github`

Relevant fields:

- `perPage`
- `maxPages`
- `rateLimitRetries`
- `maxRateLimitWaitMs`

## Archive Strategy Hardening

`archive_download` is stricter now:

- `checksumSha256` is required by default
- if no checksum is provided, `allowInsecureArchive: true` must be explicit
- `extract=true` requires either `archiveType` or `extractCommand`
- destination root paths are rejected
- `expectedExtractedPaths` can be used to verify extraction results

Recommended shape:

```json
{
  "installStrategy": {
    "type": "archive_download",
    "urlTemplate": "https://example.com/releases/{version}.tar.gz",
    "destinationPath": "./releases/current",
    "archiveType": "tar.gz",
    "checksumSha256": "expected_sha256_here",
    "extract": true,
    "expectedExtractedPaths": ["bin/app"]
  }
}
```

## Docs

- [Quick Start](./docs/QUICK_START.md) — step-by-step integration guide agents can execute directly
- [Agent Integration Guide](./docs/AGENT_INTEGRATION.md) — quickCheck design and tuning
- [Integration guide](./docs/INTEGRATION.md) — full SDK integration and advanced config
- [Chinese README](./README.zh-CN.md)

## Test Coverage

The current test suite covers:

- release detection
- tag detection
- local current version loading
- manual confirmation flow
- auto-update policy flow
- ignore decision persistence
- `always_auto_update` persistence
- install success
- preflight failure
- migration failure
- verification-triggered rollback
- switch-triggered rollback
- manual rollback
- rollback failure audit
- audit log persistence
- state persistence
- update lock concurrency protection
- CLI `--json`
- dry-run behavior
- custom executor / hook-runner injection
- host autodetection
- GitHub pagination and rate-limit retries
- HTTP distributed backends
- archive checksum and extraction validation
- quickCheck cache TTL and two-level expiry
- progressive snooze advancement and expiry
- just-upgraded marker lifecycle
- kill switch (updateCheckEnabled)
- soft-fail on network error
- cache invalidation on version change
- quickCheck --force cache bypass
- CLI quick-check / snooze commands

## Development

```bash
npm install
npm run build
npm test
```
