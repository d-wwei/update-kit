# Agent Integration Guide

UpdateKit's `quickCheck()` is designed for agent preambles and high-frequency invocations. It returns instantly from cache most of the time, never throws on network failures, and supports progressive snooze to avoid nagging users.

## The Problem

Update checking involves network I/O (GitHub API). Agents that invoke skills on every user message cannot afford to block the main workflow for 200-500ms each time. Traditional `check()` hits the network every call.

## The Solution: `quickCheck()`

```
First call:    ~200ms (network fetch, writes cache)
Cached calls:  <5ms   (file read only, no network)
Network fail:  <1ms   (returns "up_to_date", never blocks)
```

### Status Flow

```
quickCheck() entry
  |
  ├─ updateCheckEnabled === false? ──► "disabled"
  |
  ├─ justUpgradedFrom marker? ──► "just_upgraded" (one-time, auto-cleared)
  |
  ├─ snooze active? ──► "snoozed" (with level + expiry)
  |
  ├─ cache fresh? ──► "up_to_date" or "upgrade_available" (from cache)
  |
  └─ cache stale/missing ──► full network check ──► write cache ──► return result
```

## Pattern 1: Bash Preamble (Like gstack)

Recommended for skill-based systems where each invocation runs a preamble:

```bash
# Non-blocking update check — runs in <5ms from cache
_UPD=$(update-kit quick-check --cwd "$SKILL_DIR" --json 2>/dev/null || echo '{"status":"up_to_date"}')
_STATUS=$(echo "$_UPD" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).status" 2>/dev/null || echo "up_to_date")

case "$_STATUS" in
  upgrade_available)
    _NEW=$(echo "$_UPD" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).candidateVersion" 2>/dev/null)
    echo "Update available: $_NEW. Run: update-kit apply --cwd $SKILL_DIR"
    ;;
  just_upgraded)
    _PREV=$(echo "$_UPD" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).previousVersion" 2>/dev/null)
    echo "Successfully upgraded from $_PREV!"
    ;;
  snoozed|disabled|up_to_date)
    ;; # Silent — don't bother the user
esac
```

## Pattern 2: TypeScript SDK (Subagent Dispatch)

Recommended for agent frameworks where the main agent can dispatch subagents:

```typescript
import { createRuntime } from "update-kit/runtime";
import { defineAdapter } from "update-kit/adapter";

const runtime = await createRuntime({ cwd: skillDir });
const adapter = defineAdapter({
  name: "my-skill",
  getContext: () => ({ cwd: skillDir, appName: "my-skill", componentName: "my-skill" })
});

// Main agent dispatches this as a background task
const result = await runtime.quickCheck(adapter);

switch (result.status) {
  case "upgrade_available":
    // Append notice to agent output — don't block
    console.log(`Update available: ${result.candidateVersion}`);
    break;
  case "just_upgraded":
    console.log(`Upgraded from ${result.previousVersion}!`);
    break;
  // "up_to_date", "snoozed", "disabled" — no action needed
}
```

### Subagent Pattern (Non-Blocking)

```typescript
// Main agent: fire and forget
const updatePromise = runtime.quickCheck(adapter);

// ... continue with primary task ...

// Read result when convenient (already resolved from cache most of the time)
const updateResult = await updatePromise;
if (updateResult.status === "upgrade_available") {
  // Show notice at end of response
}
```

## Pattern 3: Claude Code Skill Preamble

For Claude Code skills, use the preamble bash block pattern:

```markdown
## Preamble (run first)

\`\`\`bash
_UPD=$(~/.claude/skills/my-skill/node_modules/.bin/update-kit quick-check --cwd ~/.claude/skills/my-skill --json 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
\`\`\`

If output shows `"status":"upgrade_available"`: ask user "Version {candidateVersion} available. Upgrade now?"
If output shows `"status":"just_upgraded"`: tell user "Running latest version (upgraded from {previousVersion})!"
```

## Handling User Decisions

When user declines an update, use `snooze()` for progressive backoff:

```typescript
// User says "not now"
await runtime.snooze(adapter, { version: candidateVersion });
// Snooze durations: 24h → 48h → 7d (configurable)
```

When user says "never ask again":

```json
// In update.config.json:
{ "updateCheckEnabled": false }
```

## Cache TTL Tuning

| Use Case | `upToDateTtlMs` | `upgradeAvailableTtlMs` | Rationale |
|---|---|---|---|
| Agent preamble (default) | 3,600,000 (1h) | 43,200,000 (12h) | Fast discovery, low nag |
| CI/CD pipeline | 300,000 (5m) | 300,000 (5m) | Always fresh |
| Background daemon | 86,400,000 (24h) | 86,400,000 (24h) | Minimal network |
| Interactive CLI | 3,600,000 (1h) | 43,200,000 (12h) | Same as default |

Configure in manifest:

```json
{
  "cache": {
    "upToDateTtlMs": 3600000,
    "upgradeAvailableTtlMs": 43200000
  }
}
```

## Snooze Duration Tuning

Default: `[86400000, 172800000, 604800000]` (24h, 48h, 7d)

For aggressive reminders: `[3600000, 86400000, 604800000]` (1h, 24h, 7d)
For relaxed reminders: `[604800000, 1209600000, 2592000000]` (7d, 14d, 30d)

```json
{
  "snoozeDurations": [86400000, 172800000, 604800000]
}
```

## Design Principles

These principles are borrowed from gstack's battle-tested update check:

1. **Never fail** — `softFail: true` (default) means network errors return `"up_to_date"` instead of throwing. Update checking is a secondary concern; it must never break the primary workflow.

2. **Never block** — Cache hits return in <5ms. The first call after TTL expires does a network check, but subsequent calls are instant.

3. **Progressive backoff** — Don't nag. Level 0 snooze = 24h, Level 1 = 48h, Level 2+ = 7d. New versions reset the snooze.

4. **One-time feedback** — After a successful `apply()`, the next `quickCheck()` returns `"just_upgraded"` exactly once, then clears the marker. This lets preambles show a "just updated!" message without persistent state tracking.

5. **Kill switch** — `updateCheckEnabled: false` disables everything instantly. No network, no cache, no state.
