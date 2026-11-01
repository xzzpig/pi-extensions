# 变更提案

## Why

`pi-mcp-adapter` 通过 `setStatus("mcp", ...)` 发布的状态已经能显示为 Starline pill，但目前无法点击打开 MCP 管理面板。用户已选择并自行配置 adapter 的 `compact` 模式，本变更补齐 Starline fork 内的点击入口，让简短的 `MCP 已连接数/已启用数` 状态直接通向原生管理操作。

## What Changes

- 在 Starline fork 内为第三方状态 key `mcp` 增加可选适配，复用现有 pill action 注册与命中机制，不新增独立插件。
- 点击 MCP pill 或执行 `/starline mcp` 时，检查扩展命令 `mcp-adapter` 是否存在，再通过 Pi 的命令分发打开 adapter 原有面板；不使用容易冲突的 `/mcp`。
- 保留 adapter 发布的简短计数、连接中、信任阻止和任务提示，不解析计数、不复制 MCP 状态、不改写 adapter 配置。
- 关闭已有 Starline 气泡后再打开面板，处理同次鼠标手势的重复事件、短时间重复触发、可见浮层和会话清理。
- 未安装 adapter、命令消失、非交互模式时安全降级，绝不把未知斜杠命令发送给模型。
- 增加 fork 专属测试、使用说明与真实 TUI 验证任务。无破坏性公共 API 变更。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `pill-rendering`：新增 MCP 第三方 status pill 的显示职责边界、原面板命令路由、安全降级与生命周期要求；保持已有颜色和几何要求不变。

## Impact

- 主要实现区域：`packages/pi-starline/extensions/starline/fork-mcp-pill.ts`（拟新增）、Starline 入口的最小生命周期接缝，以及 fork 专属测试和文档。
- 复用 `pill-api.ts` 的外部 action 注册表、`pill-bubble.ts` 的关闭能力与 Pi 的 `getCommands()` / `sendUserMessage()`。
- 不新增对 `pi-mcp-adapter` 的运行时依赖，不导入其私有状态或面板实现，不修改本仓库之外的 Nix / 用户配置。
- 用户配置 `settings.mcpFooterStatus = "compact"` 是既有外部前提，不是本变更的实施任务；其他 Starline 显示配置继续生效。
- 涉及上游文件的接缝按 fork-divergence 纪律记录在 `subtrees/pi-starline.json`；不发布、不提交，也不更新版本，除非另有授权。
