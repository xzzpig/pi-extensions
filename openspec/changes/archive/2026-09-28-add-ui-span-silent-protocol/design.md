# Design: 静默标记协议

## Context

见 proposal.md - Why。通用 UI 等待适配器（pi-notify `extensions/index.ts`）把 agent 运行期间的外层 `ui_prompt_start` span 一律转为通知 + Herdr 等待项，而 `ui_prompt_start` payload 只有 `{kind, title?}`，无法区分「agent 等待」与「用户主动打开」。本设计在既有「带标签事件 = span 分类上下文」架构上扩展出第三种分类：静默。

现状关键事实（均已核实）：

- `pi.events` bus 是扩展间通信通道；`pi-notify:publish` 已确立「协议事件 + 接收端防御解析」的先例。
- `extensions/ui-prompts.ts` 的 `createUiPromptContexts` 已持有 ask flow / pending permission 两组分类上下文并统一 `reset()`。
- `extensions/state.ts` 的 `completeUiPrompt(spanId)` 对未登记 spanId 是 no-op（返回 false 且不发事件），因此静默 span 的 `ui_prompt_end` 走现有路径即安全。
- `packages/pi-subagents` 不依赖 `@xzzpig/pi-notify`；`openSubagentsAdmin` 仅被 `slash-commands.ts` 引用（纯用户命令路径）；`openFleetView` 只在 `ctx.hasUI` 时打开 `ctx.ui.custom`。

## Goals / Non-Goals

Goals:

- 让「打开对话框的插件」能声明「这个对话框不是 agent 等待」，pi-notify 据此静默注册该 span（不通知、不 Herdr），同时保持 end 配对清理与 one-shot 语义。
- 保持适配器既有行为完全不变：无标记时一切照旧。

Non-Goals:

- 不改 core payload、不做调用栈/hook core 方案（会话中已论证脆弱：事件经微任务派发栈已展开；hook 需识别 core 内部派发帧）。
- 不接入 pi-ask 的设置面板（外部 npm 包，非本仓库）。
- 不改 7 事件目录、不加配置键、不改 peerDependencies、不碰 pi-goal-x / pi-sandbox 子树。

## Decisions

**D1: 标记状态并入 `createUiPromptContexts`（`ui-prompts.ts`），静默在适配器层短路。**

`uiContexts` 增加 `pendingSilent: boolean` 与 `markSilent()` / `consumeSilent()`（one-shot：消费后即清）；`reset()` 已由 session start/shutdown 调用，自然覆盖「未消费标记清除」。`classify()` 保持不变——静默的控制流（不 `route()`、不 `state.startUiPrompt`，但照常登记 `openSpanId`）与返回 `{eventId, label}` 的分类不同，放适配器层短路更清晰。
替代方案：独立 `silent-markers.ts` 模块（模块更少但分类上下文被拆散，否决）；`classify()` 返回三态（控制流耦合进分类函数，否决）。

**D2: 消费时机 = `ui_prompt_start` 处理链最前（parse 与 duplicate 守卫之后、agent 门控之前）。**

```ts
const silent = uiContexts.consumeSilent();
if (!agentTracker.isActive()) return; // 空闲对话框本就不通知；标记已消费，不泄漏
const spanId = spans.nextSpanId();
openSpanId = spanId;
if (silent) return; // 静默 span：被跟踪、不通知、不登记 Herdr
const classification = uiContexts.classify(prompt.title);
if (herdrEnabled) state.startUiPrompt(spanId, classification.label);
route(classification.eventId, UI_PROMPT_SOURCE);
```

- 标记在 agent 门控**之前**消费：空闲期打开的 span 也消耗标记，避免残留标记静默掉后续 agent 运行期的真实对话框。
- duplicate-start 守卫在前：已有 span 打开时的新 start 不消费标记（标记属于下一个外层 span）。
- `ui_prompt_end` 零改动：静默 span 的 end 调 `state.completeUiPrompt(spanId)` 走 no-op 路径。

**D3: 协议事件常量从 `api.ts` 导出；pi-subagents 用字面量 + observational emit，不引入包依赖。**

`api.ts` 导出 `PI_NOTIFY_UI_SPAN_SILENT_EVENT = "pi-notify:ui_span_silent"` 与 `UiSpanSilentPayload { reason?: string }`；扩展侧 `ui-prompts.ts` 提供 `parseUiSpanSilentPayload`（防御解析：非对象忽略；reason 存在但非字符串或空白 → 整包忽略；`{}` 与 `{reason:"fleet"}` 合法）。
pi-subagents **不得**依赖 `@xzzpig/pi-notify`（会强制所有 pi-subagents 用户安装 pi-notify，破坏可选集成）；用本地常量 + try/catch emit，与 `herdr-agent-state.ts` 消费 `'herdr:blocked'` 字面量的既有做法一致。未安装 pi-notify 时该 emit 是无害 no-op。

**D4: 发送契约由规格强制：同步发出、紧邻 `ctx.ui.*`、中间不得 await。**

emit 与对话框打开之间任何异步间隙都可能让标记被无关 span 消费或残留。契约写入规格（MUST），实现侧 pi-subagents 在 `ctx.ui.custom/select/editor` 调用前一行 emit。
已知窄窗口：若插件在**另一个已打开的对话框内**发出标记（嵌套），core 只发外层 span 事件，标记将残留到下一个外层 span。TUI 对话框栈互斥（用户无法在对话框内执行命令），fleet/admin 实际不可达此路径，记录为已知限制。

**D5: pi-subagents 接入点 = 用户主动类对话框；executor 的 agent 等待 confirm 不接入。**

- `src/tui/fleet.ts` `openFleetView`：`ctx.ui.custom` 前 emit。fleet 面板有两条用户主动打开路径，均须传 `events`：`/subagents-fleet` 命令（`slash-commands.ts`）与默认启用的 fleet 状态 widget（`extension/index.ts` 的 `openInspector` 回调）——后者经提取的 `openSubagentFleetFromStatus` 共用同一接线，并有回归用例覆盖。
- `src/slash/subagents-admin.ts`：`selectFromList` 入口（覆盖 custom 与 select 两条分支）+ 另两处 `select`/`editor`（260/376/414 行附近）前 emit。
- `subagent-executor.ts` 的三处 `ctx.ui.confirm`（worktree 清理、授权确认）是 agent 等待语义，**不接入**。
- emit 用共享小 helper（本地常量 + try/catch observational），task-4 落实具体放置位置与 `pi` 对象传递（`registerCommand` 处已有 `pi`）。

**D6: 优先级 = 静默 > permission > ask > 默认。**

由处理顺序天然实现：`consumeSilent()` 先于 `classify()`；`classify` 内部保持 permission → ask → 默认。

## Risks / Trade-offs

- [挂起标记被无关 span 消费（插件 emit 后对话框未打开，或嵌套窗口残留）] → 发送契约强制同步紧邻；未消费标记在 session 重置时清除；最坏影响是**一次** span 静默，且 TUI 下实际不可达。接受。
- [静默 span 打开期间 agent_settled 先到] → 与既有 span 语义一致：静默 span 未登记 herdr，无解除负担；通知本就由 span 关闭驱动。无影响。
- [第三方插件不知晓协议，fleet 类误报仍存在于未接入插件] → 协议文档化（README + 规格），接入是插件一行成本；本 change 只承诺 pi-subagents 全量接入。
- [api.ts 导出新增公共面] → 仅常量 + 类型，无 helper、无行为变更；`公共 API` 规格要求不冲突（现有要求是导出清单的下限）。

## Migration Plan

纯增量、双向可独立回滚：

1. 先发 pi-notify（协议接收端）：旧插件不发声，行为与现状完全一致。
2. 再发 pi-subagents（接入端）：fleet/admin 误报消失。
   回滚：pi-subagents 去掉 emit 即回到现状；pi-notify 降级即忽略标记。

## Open Questions

无（pi-subagents 内部 emit helper 的具体放置位置属实现细节，task-4 内确定，不改变规格/设计/任务划分）。
