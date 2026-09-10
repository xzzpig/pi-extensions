## Context

pi-notify 目前只适配两个带标签事件源（pi-ask `started/completed`、permission-system `ui_prompt` + decision 系事件），均为 `pi.events` 总线事件，各自独立产生通知与 herdr 等待项。pi core **0.84.4** 起（CHANGELOG #8355，已验证 0.85.1 的 `dist/core/extensions/runner.js`）在扩展 UI 上下文外层包装全部 `ctx.ui.select/confirm/input/editor/custom`，外层 span 打开/关闭时经 `queueMicrotask` 异步分发 `ui_prompt_start`/`ui_prompt_end` 到 `pi.on()` 处理器（不进总线）；嵌套 span 合并为最外层一对事件。pi-ask 主对话框（`ui/controller.ts`）与 permission-system 对话框本身也走 `ctx.ui.custom`，因此核心事件与带标签事件描述同一批对话框。pi-notify 已有 agent run tracker（`agent_start`→`agent_settled` 可见运行判定）与 herdr blocked 状态机（`state.ts`）。pi 未向扩展暴露版本号 API。

## Goals / Non-Goals

### Goals

- 一个通用适配器覆盖所有插件经 `ctx.ui.*` 的 agent 阻塞对话框（含 pi-goal-x 问卷/提案、pi-sandbox 权限确认及未来插件），产生通知与 herdr blocked 状态。
- 单一通知/herdr 来源：带标签事件只提供分类与标签，从结构上消除双发，不引入抑制计数或版本门控。
- 保持 pi-notify 的既有失败隔离原则：适配器任何路径不得阻塞或抛出到 Pi。

### Non-Goals

- 不修改 pi-goal-x / pi-sandbox 或其它插件（上游 subtree 零 divergence）。
- 不新增配置项、不改 `api.ts` 公共契约、不扩展 `pi-notify:publish` 协议（publish 依旧不触达 herdr 状态）。
- 不为通用 span 引入新的语义事件 ID（目录保持封闭七个，`permission-required` 由 span 分类产生）。
- 不支持 pi < 0.84.4（不保留 legacy 适配器路径，不做版本探测）；不支持 headless 无 UI 的 pi-ask 纯远程问答流通知（两者均为已确认接受的行为收窄）。
- 不覆盖非 `ctx.ui.*` 的阻塞点（如插件自绘 overlay、纯 `pi-tui` 组件）——当前已知等待点均走 `ctx.ui.*`。

## Decisions

**D1. 适配器放在 pi-notify，监听核心事件而非让插件发事件。**
pi-goal-x（约 25 处 `ctx.ui.*` 调用点）与 pi-sandbox 均为 git subtree 导入的上游仓库，就地插桩会产生每次 upstream sync 都要重放的本地 divergence；核心事件已覆盖其全部对话框。

**D2. span 是唯一通知方与 herdr 记账方；带标签事件降级为分类上下文。**
双发的根源是两套系统对同一对话框各自记账。pi-ask/permission 的总线事件不再触发 `route()` 与 `state.startAsk/startPermission`，只维护两组轻量上下文：活动 ask flow（flowId → 净化标题）与待确认 permission 请求（requestId 集合，含转发来源）。span 打开时按"待确认 permission 优先 → 活动 ask flow 次之 → 默认"归类。替代方案（保留双系统 + 抑制计数 latch）被否决：计数器、claim/expire 与 completed/decision 兜底清理是持续的概念负担，且 spec 需要额外的抑制场景；版本门控方案（pi ≥ 0.84.4 走通用、旧版走 legacy）被否决：pi 无版本 API 需解析 package.json，且双代码路径永久维护、现代 pi 上权限语义仍降级。

**D3. 语义映射：`permission-required` 仅当存在待确认 permission 请求，其余一律 `input-required`。**
核心事件对 `custom` 类 span 不携带标题，无法直接区分对话框来源；但 permission-system 的 `ui_prompt` 总线事件先于对话框到达（同步 emit），其 requestId 在 decision 系事件到达前保持"待确认"，恰好构成可靠的分类信号。pi-sandbox 权限确认无此信号，归 `input-required`（"Pi needs your input" 语义仍准确）。事件目录不变。

**D4. agent 活跃门控复用既有 AgentRunTracker。**
工具调用引发的对话框必然落在 `agent_start`→`agent_settled` 之间；用户敲命令打开的对话框（/goal-settings、pi-ask /answer 提取界面、各配置 modal）都在空闲期。Tracker 增加只读 `isActive()`。仅在活跃时路由通知并登记 herdr 等待项。

**D5. herdr 状态机收敛为单一 span 类等待项。**
`state.ts` 移除 ask/permission 两类等待项，仅保留 `startUiPrompt(spanId, label)`/`completeUiPrompt(spanId)`；`herdr:blocked` event 名与 payload 不变，解除路径只剩 span 关闭与 session shutdown，decision 匹配清理逻辑整体删除。spanId 由适配器生成的单调序号，生命周期由核心事件的配对性保证。

**D6. 事件解析遵循既有模块模式。**
新增 `extensions/ui-prompts.ts`（核心事件常量、payload 解析、span 序号、ask flow / 待确认 permission 两组分类上下文）；`permissions.ts` 的 prompt tracker 收敛为分类上下文的维护者（decision/forwarded_decision 仅清上下文，不再触达 herdr）；`interaction-events.ts` 的 ask/permission 路由去重移除。`index.ts` 注册 `pi.on("ui_prompt_start"/"ui_prompt_end")`，handler 内部全 try/catch，失败仅本地告警。

**D7. herdr 标签策略。**
`select/confirm/input/editor` 类 span 用核心事件自带的净化标题；ask 对话框用活动 flow 的问题标题；转发 permission 用"Permission required by X"；`custom` 类无上下文时用默认文案。通知正文继续走固定文案，不含任何标题——沿用既有正文纪律。

**D8. 版本支持策略：peer 下限声明，不做运行时探测。**
`peerDependencies["@earendil-works/pi-coding-agent"]` 置为 `>=0.84.4`；README 注明旧版 pi 上问答/权限通知消失。不采用运行时版本探测（无 API、需解析包文件）也不保留 legacy 路径（维护成本高于收益，用户环境 pi 始终保持最新）。

## Risks / Trade-offs

- [headless / 无 UI 的 pi-ask 纯远程问答流不再通知] → 已确认接受；TUI 与带 UI rpc 会话（含 herdr pane、远程应答驱动已打开对话框）全部覆盖。文档明示该收窄。
- [pi < 0.84.4 上问答/权限通知整体消失] → 已确认接受；peer 下限 + README 声明，扩展加载不报错，仅 agent 生命周期通知照常。
- [分类的环境性歧义：ask flow 活动期间打开的无关对话框会误用其标题] → 仅影响 herdr 标签（通知事件仍为 input-required），且 ask flow 的对话框与 flow 注册同 tick 打开、completed 即刻清上下文，实际窗口极窄；不影响通知发送与 blocked 计数。
- [核心事件为 notification-only、fire-and-forget（`queueMicrotask` + 不等待 handler）] → 适配器只做本地簿记与路由，天然容忍异步滞后；`ui_prompt_end` 晚到仅延迟解除 blocked，不丢状态（配对性由核心保证）。
- [rpc/headless 模式下 `ctx.ui.custom` 行为差异] → 无 UI 上下文时核心不包装、不发事件，适配器自然静默。

## Migration Plan

纯增量 + 行为收窄：合入后随 pi-notify 常规发布（建议 minor→major 语义评估，因旧版 pi 与 headless ask 行为变化，按仓库惯例记录于 CHANGELOG）。无配置迁移、无数据迁移。回滚即回退该扩展版本。

## Open Questions

无——单机制 + 分类上下文的方案、headless 收窄与旧版放弃均已由用户确认。
