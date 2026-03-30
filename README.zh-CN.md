# UpdateKit

[English README](./README.md)

`UpdateKit` 是一个生产级、可嵌入的更新执行编排框架。它不是“发现到新版本后提示一下”的工具，而是把更新真正安全地集成进宿主环境的执行层，负责策略、确认、预检、安装、迁移、验证、切换、回滚、锁和审计。

> `UpdateKit` 的目标是把“发现更新”变成“宿主已完成安全更新，并且可验证、可回滚、可追溯”。

## 为什么做它

很多工具会告诉你“有新版本了”，但很少有工具能真正负责：

- 要不要更
- 谁来确认
- 安装前怎么预检
- 安装后怎么迁移
- 切换前后怎么验证
- 失败后怎么回滚
- 最后怎么留审计和状态

`UpdateKit` 专门解决这条执行主链路：

`detect -> policy -> prompt -> plan -> preflight -> install -> migrate -> compatibility -> verify -> switch -> record -> rollback`

## 和 UDD Kit 的关系

两者边界很清楚：

- `UDD Kit`
  更像 control plane / sensor
  负责发现、提示、摘要、issue / contribution / PR 草稿、反馈回传
- `UpdateKit`
  execution plane
  负责真正执行更新并保障安全性

推荐组合方式：

1. `UDD Kit` 检测并提示更新
2. 宿主或用户做决策
3. `UpdateKit.apply(...)` 执行更新
4. 结果再回传给宿主 UI 或 `UDD Kit`

## 已支持能力

- GitHub releases / tags 检测
- 宿主当前本地版本读取
- 稳定版本与候选版本状态
- 用户显式决策：
  `update_once`、`always_auto_update`、`skip_this_time`、`ignore_this_version`
- 持久化自动更新策略：
  `manual`、`patch`、`minor`、`all`
- 多种安装策略：
  `npm_package`、`pnpm_package`、`yarn_package`、`pip_package`、`git_pull`、`archive_download`、`custom_command`
- preflight / migration / compatibility / verification hooks
- dry-run / preview
- switch 与自动 rollback
- 结构化 JSONL 审计
- 状态持久化
- update lock
- **quickCheck**: 缓存优先的轻量检查，适合 agent preamble（<5ms）
- **渐进式 snooze**: 24h → 48h → 7d 递增退避，新版本自动重置
- **just-upgraded marker**: 升级后一次性反馈
- **soft-fail**: 网络失败返回 up_to_date 而非抛错
- **kill switch**: `updateCheckEnabled: false` 一键关闭
- SDK + CLI

## 默认自动发现接入

现在 `UpdateKit` 默认优先自动发现宿主，而不是先要求你写完整 manifest。

支持的常见宿主：

- `node-npm`
- `node-pnpm`
- `node-yarn`
- `python-pip`
- `git-repo`

最小接入：

```ts
import { createRuntime } from "update-kit/runtime";

const runtime = await createRuntime({
  cwd: process.cwd()
});
```

它会尝试自动推断：

- GitHub repo
- 当前版本来源
- 包管理器 / 安装策略
- 默认状态路径、审计路径、锁路径
- 默认安全策略

如果自动发现不够，就只覆盖必要字段：

```ts
const runtime = await createRuntime({
  cwd: process.cwd(),
  manifestOverrides: {
    autoUpdatePolicy: "patch"
  }
});
```

## 安装

```bash
npm install update-kit
```

## 公开 API

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

## 最小 Node/TS 示例

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

示例代码见 [examples/node-ts/index.ts](./examples/node-ts/index.ts)。

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

CLI 特性：

- 默认输出人类可读摘要
- `--json` 输出结构化结果
- `--manifest` 指定 manifest
- `--cwd` 指定宿主目录
- manifest 缺失时默认自动发现
- `--dry-run` 做执行预演
- `--force` 绕过缓存强制检查
- 失败时返回非 0 exit code

## Manifest

默认文件名：

- `update.config.json`

示例文件：

- [update.config.example.json](./update.config.example.json)

只有当宿主行为无法被安全推断时，才需要完整 manifest。

## 分布式后端

默认实现使用本地文件：

- `FileStateStore`
- `FileAuditWriter`
- `FileUpdateLockManager`

如果宿主运行在多进程、多机或远端 agent 环境，`UpdateKit` 也内置了基于 HTTP 的共享后端：

- `HttpStateStore`
- `HttpAuditWriter`
- `HttpLockManager`

宿主可以把状态、审计和锁统一收敛到自己的控制平面。

## GitHub 韧性增强

GitHub 检测层现在支持：

- releases / tags 分页抓取
- `429` 和 rate-limit 响应后的重试
- 通过 `manifest.github` 控制抓取与等待策略

相关字段：

- `perPage`
- `maxPages`
- `rateLimitRetries`
- `maxRateLimitWaitMs`

## Archive 策略加固

`archive_download` 现在更严格了：

- 默认要求 `checksumSha256`
- 如果没有 checksum，必须显式写 `allowInsecureArchive: true`
- `extract=true` 时，必须能推断 `archiveType` 或提供 `extractCommand`
- 禁止把根目录当作 `destinationPath`
- 可通过 `expectedExtractedPaths` 校验解包结果

推荐配置：

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

## Quick Check（Agent 友好）

`quickCheck()` 是为 agent preamble 和高频调用场景设计的轻量检查：

- 缓存命中时无网络请求（<5ms）
- 两级 TTL：up_to_date 60min，upgrade_available 12h
- 渐进式 snooze：24h → 48h → 7d
- 升级后一次性 just-upgraded 反馈
- soft-fail：网络故障返回 up_to_date
- kill switch：`updateCheckEnabled: false`

```ts
const result = await runtime.quickCheck(adapter);
// result.status: "up_to_date" | "upgrade_available" | "just_upgraded" | "snoozed" | "disabled"
```

详见 [Agent 集成指南](./docs/AGENT_INTEGRATION.md)。

## 文档

- [快速接入指南](./docs/QUICK_START.md) — agent 可直接执行的逐步接入指南
- [Agent 集成指南](./docs/AGENT_INTEGRATION.md) — quickCheck 设计原理与调参
- [集成指南](./docs/INTEGRATION.md) — 完整 SDK 接入与高级配置
- [English README](./README.md)

## 当前测试覆盖

当前测试已经覆盖：

- release 检测
- tag 检测
- 本地版本读取
- 手动确认分支
- 自动更新策略分支
- ignore 决策持久化
- `always_auto_update` 持久化
- 安装成功
- preflight 失败
- migration 失败
- verification 触发 rollback
- switch 失败触发 rollback
- 手动 rollback
- rollback 失败审计
- audit log 持久化
- state 持久化
- update lock 并发保护
- CLI `--json`
- dry-run
- 自定义 executor / hook runner 注入
- 宿主自动发现
- GitHub 分页与限流重试
- HTTP 分布式后端
- archive checksum 与解包验证
- quickCheck 缓存 TTL 和两级过期
- 渐进式 snooze 递进和过期
- just-upgraded marker 生命周期
- kill switch（updateCheckEnabled）
- soft-fail 网络错误
- quickCheck 缓存因版本变更失效
- quickCheck --force 绕过缓存
- CLI quick-check / snooze

## 开发

```bash
npm install
npm run build
npm test
```
