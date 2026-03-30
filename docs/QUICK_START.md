# Quick Start: 将 UpdateKit 接入一个 Skill 或产品

本文档是 **agent 可直接执行的逐步指南**。复制对应章节即可完成接入。

---

## Step 1: 安装

在 skill 或产品目录下：

```bash
npm install update-kit
```

无运行时依赖，安装后 `node_modules/update-kit` 约 250KB。

---

## Step 2: 初始化配置

### 方式 A：自动发现（推荐）

如果目录下有 `package.json` 且 `repository` 字段指向 GitHub，不需要配置文件。UpdateKit 会自动推断版本来源、安装策略和状态路径。

验证自动发现是否工作：

```bash
npx update-kit bootstrap --cwd . --json
```

如果输出包含 `"source": "autodetect"` 和正确的 `repo`，跳到 Step 3。

### 方式 B：手动配置

创建 `update.config.json`：

```json
{
  "repo": "your-org/your-skill",
  "releaseChannel": "releases",
  "currentVersionSource": {
    "type": "package.json",
    "path": "./package.json"
  },
  "installStrategy": {
    "type": "npm_package",
    "packageName": "your-skill"
  },
  "statePath": "./.update-kit/state.json",
  "auditLogPath": "./.update-kit/audit.log",
  "lockPath": "./.update-kit/update.lock"
}
```

将 `.update-kit/` 加入 `.gitignore`。

---

## Step 3: 验证

```bash
npx update-kit check --cwd . --json
npx update-kit quick-check --cwd . --json
```

`check` 做完整网络检查；`quick-check` 走缓存优先。

---

## Step 4: 接入 Preamble

### Claude Code Skill

在 `SKILL.md` 中加入以下内容。**这是完整的接入代码，直接复制即可。**

````markdown
## Preamble (run first)

```bash
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || echo "$HOME/.claude/skills/YOUR_SKILL_NAME")"
_UPD=$(npx --prefix "$SKILL_DIR" update-kit quick-check --cwd "$SKILL_DIR" --json 2>/dev/null || true)
[ -n "$_UPD" ] && echo "UPDATE_CHECK: $_UPD" || true
```

**Update handling:**
- If UPDATE_CHECK contains `"status":"upgrade_available"`: use AskUserQuestion to ask "Version {candidateVersion} is available. Upgrade now?" with options ["Yes", "Not now", "Never ask again"].
  - "Yes": run `npx --prefix "$SKILL_DIR" update-kit apply --cwd "$SKILL_DIR" --decision update_once` and tell user the result.
  - "Not now": run `npx --prefix "$SKILL_DIR" update-kit snooze --cwd "$SKILL_DIR"` and continue with the skill.
  - "Never ask again": run `npx --prefix "$SKILL_DIR" update-kit snooze --cwd "$SKILL_DIR"` and continue. (User can re-enable in update.config.json.)
- If UPDATE_CHECK contains `"status":"just_upgraded"`: tell user "Just upgraded from {previousVersion}!" and continue.
- Otherwise: continue silently.
````

**上下文成本：~400 字符 preamble bash + ~600 字符处理指令 = ~1KB。**

### 通用 Bash Skill

在 skill 入口脚本中：

```bash
#!/usr/bin/env bash
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
_STATUS=$(npx --prefix "$SKILL_DIR" update-kit quick-check --cwd "$SKILL_DIR" --json 2>/dev/null | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
case "${_STATUS:-up_to_date}" in
  upgrade_available) echo "⚡ Update available. Run: npx --prefix $SKILL_DIR update-kit apply --cwd $SKILL_DIR" ;;
  just_upgraded)     echo "✓ Just upgraded!" ;;
esac
# ... rest of skill ...
```

### TypeScript SDK

```typescript
import { createRuntime } from "update-kit/runtime";
import { defineAdapter } from "update-kit/adapter";

const runtime = await createRuntime({ cwd: __dirname });
const adapter = defineAdapter({
  name: "my-skill",
  getContext: () => ({ cwd: __dirname, appName: "my-skill", componentName: "my-skill" }),
  confirm: async () => "update_once"
});

const result = await runtime.quickCheck(adapter);
if (result.status === "upgrade_available") {
  console.log(`Update: ${result.candidateVersion}`);
}
```

---

## Step 5（可选）: 调参

在 `update.config.json` 中添加：

```json
{
  "updateCheckEnabled": true,
  "autoUpdatePolicy": "patch",
  "cache": {
    "upToDateTtlMs": 3600000,
    "upgradeAvailableTtlMs": 43200000
  },
  "snoozeDurations": [86400000, 172800000, 604800000]
}
```

- `autoUpdatePolicy: "patch"` — patch 版本自动更新，不询问
- `cache` — 调 TTL 控制检查频率
- `snoozeDurations` — 调退避时长

---

## Subagent Dispatch Prompt

当 agent 框架（如 Claude Code）支持派生 subagent 时，主 agent 可以用以下 prompt 派一个后台 subagent 执行更新检查，**不阻塞主流程**：

### 推荐 Prompt（直接复制）

```
You are an update-check subagent. Your ONLY job is to check for updates and return the result. Do NOT do anything else.

Run this command and return the JSON output:

```bash
npx --prefix "{SKILL_DIR}" update-kit quick-check --cwd "{SKILL_DIR}" --json 2>/dev/null || echo '{"status":"up_to_date","message":"check failed"}'
```

Return the raw JSON output. Do not interpret it, do not take action on it, do not ask questions.
```

### 主 Agent 用法

```
1. Dispatch the subagent with the prompt above (run_in_background: true)
2. Continue with the user's primary task immediately
3. When subagent completes, read its result:
   - "upgrade_available": mention at the end of your response that an update is available
   - "just_upgraded": mention that the skill was just upgraded
   - Any other status: say nothing about updates
```

### Claude Code 具体示例

主 agent 在处理 skill 调用时：

```
Agent tool call:
  description: "check skill updates"
  prompt: |
    Run this command and return the output exactly:
    ```bash
    npx --prefix ~/.claude/skills/my-skill update-kit quick-check --cwd ~/.claude/skills/my-skill --json 2>/dev/null || echo '{"status":"up_to_date"}'
    ```
    Return ONLY the JSON output, nothing else.
  run_in_background: true
```

主 agent 不等结果，继续处理用户任务。Subagent 完成后，主 agent 在回复末尾检查结果并附带更新提示（如果有的话）。

---

## 接入 Checklist

- [ ] `npm install update-kit`
- [ ] `npx update-kit bootstrap --cwd . --json` 验证自动发现（或创建 `update.config.json`）
- [ ] `.update-kit/` 加入 `.gitignore`
- [ ] SKILL.md preamble 中加入 quick-check bash block
- [ ] SKILL.md 中加入 update handling 指令
- [ ] （可选）配置 `autoUpdatePolicy`、`cache`、`snoozeDurations`
- [ ] 测试：`npx update-kit quick-check --cwd . --json` 返回合理结果

完成以上步骤后，skill 的每次调用都会自动检查更新（<5ms 从缓存），用户决策后自动 snooze，升级后自动反馈。
