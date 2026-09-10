# 静默标记协议：消除监控/管理类对话框的误报

## Why

通用 UI 等待适配器上线后，agent 运行期间任何阻塞式 `ctx.ui.*` 对话框都会被当作「agent 等待输入」而触发 `input-required` 通知并登记 `herdr:blocked`。但用户主动打开的监控/管理类面板——`/subagents-fleet` 实时面板、`/subagents` admin 管理对话框——并非 agent 在等待输入，当前会产生一条多余通知，且 herdr 会错误显示 pi 处于等待态直到面板关闭。核心 `ui_prompt_start` payload 只有 `{kind, title?}`，无法区分对话框是 agent 发起的还是用户发起的，必须由打开对话框的插件声明。

## What Changes

- **pi-notify 新增静默标记协议**：`pi-notify:ui_span_silent`（pi.events bus 事件，非通知事件，7 事件目录不变）。payload 仅 `{reason?: string}`。
- **通用 UI 等待适配器消费标记**：`ui_prompt_start` 打开 span 时，若存在挂起静默标记则优先消费，该 span **静默注册**——不产生通知、不登记 Herdr 等待项，但仍跟踪 `openSpanId` 以配对 `ui_prompt_end` 并清理。分类优先级：**静默标记 > 待确认 permission > 活动 ask flow > 默认**。
- **one-shot 消费与清理**：标记被下一个打开的 span 消费；session start/shutdown 重置时清除未消费标记。
- **发送方契约**：插件须在打开对话框**前同步**发出标记（中间不得 await），发出时用 observational try/catch；**MUST NOT 硬依赖 pi-notify 包**（可用字面量事件名，未安装 pi-notify 时该 emit 是无害 no-op）。
- **pi-subagents 接入**：fleet 面板（`openFleetView`）与 admin 管理对话框（`selectFromList`/`select`/`editor`）在 `ctx.ui.*` 前发出标记；executor 的 agent 等待 confirm（worktree 清理、授权确认）**不接入**。
- **公共 API**：从 `@xzzpig/pi-notify/api` 导出事件名常量与 payload 类型，供已依赖 pi-notify 的插件类型化引用。

## Capabilities

- **New Capabilities**: 无
- **Modified Capabilities**: `notification-event-routing` —— 在既有「通用 UI 等待适配器」要求上增加静默 span 分支（MODIFIED），并新增「静默标记协议」要求（ADDED）。

## Impact

- `packages/pi-notify/extensions/`：静默标记模块（事件常量、payload 防御解析、挂起标记状态、one-shot 消费）+ `index.ts` 适配器接线（静默分支、优先级、end 配对、session 重置清理）。
- `packages/pi-notify/api.ts`：导出 `PI_NOTIFY_UI_SPAN_SILENT_EVENT` 常量与 `UiSpanSilentPayload` 类型。
- `packages/pi-notify/test/`：协议模块单元测试 + 适配器集成测试（监控面板静默、静默后真实对话框仍通知、标记未消费清理、优先级、非法 payload 忽略）。
- `packages/pi-subagents/src/tui/fleet.ts` 与 `packages/pi-subagents/src/slash/subagents-admin.ts`：对话框打开前发出标记；对应单测。
- **明确不变**：`packages/pi-goal-x/`、`packages/pi-sandbox/` 零改动（无子树分叉）；无新配置键；7 事件目录封闭；`herdr:blocked` 契约不变；peerDependencies 不变（仍 >=0.84.4）；pi core 无改动。
