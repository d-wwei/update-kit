# UpdateKit Integration Guide

`UpdateKit` 的目标不是替宿主“顺手拉个最新版本”，而是把更新执行变成一个可控、可审计、可回滚的运行时能力。

## 0. 默认接入方式

现在推荐先尝试“默认自动发现”，而不是先写完整 manifest：

```ts
import { createRuntime } from "update-kit/runtime";

const runtime = await createRuntime({
  cwd: process.cwd()
});
```

它会优先推断：

- GitHub repo
- 当前版本来源
- 包管理器与默认安装策略
- 默认状态 / 审计 / 锁路径

只有在自动发现不够安全或不够准确的地方，再补 `manifestOverrides` 或显式 `update.config.json`。

## 1. 宿主需要提供什么

宿主最少只要接两样东西：

- 一个稳定的 `adapter`
- 一份稳定的 `update.config.json`

`adapter` 负责暴露宿主上下文和可替换能力。
`manifest` 负责定义更新来源、安装策略、hook、状态路径、审计路径和默认策略。

如果没有 manifest，`UpdateKit` 会尝试自动生成一份等价配置。

## 2. 薄 Adapter 模式

推荐让宿主把自己特有的逻辑都收敛在 adapter 里：

- `confirm`
  宿主 UI / CLI 的确认入口，返回 `update_once | always_auto_update | skip_this_time | ignore_this_version`
- `executor`
  宿主自己的命令执行器；如果不提供，UpdateKit 会使用默认的子进程执行器
- `hookRunner`
  只有当你使用 `custom` hook 时才需要提供
- `stateStore / auditWriter / lockManager`
  如果宿主有自己的数据库、事件总线或锁服务，可以在这里替换默认文件实现

## 3. Node / TypeScript 最小接入

```ts
import { defineAdapter } from "update-kit/adapter";
import { createRuntime } from "update-kit/runtime";

const runtime = await createRuntime({
  cwd: process.cwd()
});

const adapter = defineAdapter({
  name: "my-skill",
  getContext() {
    return {
      cwd: process.cwd(),
      appName: "my-skill",
      componentName: "my-skill"
    };
  },
  confirm: async (prompt) => {
    console.log(prompt.title);
    return "update_once";
  }
});

const summary = await runtime.check(adapter);
if (summary.hasUpdate) {
  await runtime.apply(adapter);
}
```

## 4. 非 Node 宿主

如果宿主不是 Node 项目，可以只使用 CLI：

```bash
update-kit check --manifest ./update.config.json
update-kit plan --manifest ./update.config.json --dry-run
update-kit apply --manifest ./update.config.json
update-kit rollback --manifest ./update.config.json
```

## 5. 自定义执行器

如果宿主不希望框架直接调用系统命令，可以注入自己的执行器：

```ts
const adapter = defineAdapter({
  name: "hosted-app",
  getContext() {
    return { cwd: process.cwd(), appName: "hosted-app" };
  },
  executor: async (request) => {
    return mySandbox.run(request);
  }
});
```

## 6. 分布式状态 / 审计 / 锁

如果宿主运行在多进程、多机或远端 agent 环境，建议不要继续用本地文件后端，而是注入远端后端：

```ts
import {
  createHttpAuditWriter,
  createHttpLockManager,
  createHttpStateStore,
  defineAdapter
} from "update-kit";

const adapter = defineAdapter({
  name: "hosted-app",
  getContext() {
    return { cwd: process.cwd(), appName: "hosted-app" };
  },
  stateStore: createHttpStateStore({
    readUrl: "https://control-plane.internal/state/hosted-app",
    writeUrl: "https://control-plane.internal/state/hosted-app"
  }),
  auditWriter: createHttpAuditWriter({
    appendUrl: "https://control-plane.internal/audit/hosted-app",
    listUrl: "https://control-plane.internal/audit/hosted-app"
  }),
  lockManager: createHttpLockManager({
    acquireUrl: "https://control-plane.internal/locks/hosted-app",
    releaseUrlTemplate: "https://control-plane.internal/locks/hosted-app/{leaseId}"
  })
});
```

## 7. 自定义 Hook Runner

当 manifest 中使用 `custom` hook 时，宿主必须提供 `hookRunner`：

```json
{
  "preflightHooks": [
    {
      "type": "custom",
      "handler": "health-check"
    }
  ]
}
```

```ts
const adapter = defineAdapter({
  name: "hosted-app",
  getContext() {
    return { cwd: process.cwd(), appName: "hosted-app" };
  },
  hookRunner: async (context) => {
    if (context.hook.type !== "custom") {
      throw new Error("Unexpected hook type");
    }
    return {
      ok: true,
      hookId: context.hook.handler,
      message: "health-check passed"
    };
  }
});
```

## 8. 与 UDD Kit 组合

推荐组合方式是：

1. `UDD Kit` 做发现、提示、变更摘要和用户面交互
2. 用户同意后，把决策交给 `UpdateKit`
3. `UpdateKit` 执行 `plan -> preflight -> install -> migrate -> verify -> switch -> rollback`
4. 结果再回传给 `UDD Kit` 或宿主自己的通知层

## 9. 集成建议

- 宿主只依赖 `update-kit/adapter` 和 `update-kit/runtime`
- 不直接调用内部模块文件
- 尽量把平台差异放进 adapter，而不是写死到 manifest 之外
- major 自动更新默认不要开，除非宿主明确接受风险
- 如果宿主已经有数据库和审计系统，优先替换默认 `stateStore / auditWriter`
- 如果使用 `archive_download`，优先提供 `checksumSha256` 和 `expectedExtractedPaths`
