## Why

pi-goal-x 的提问/提案确认与 pi-sandbox 的沙箱权限确认都是阻塞等待用户的对话框，但它们只通过 `ctx.ui.*` 展示 UI、不发任何 pi-notify 可感知的事件，因此既不产生跨设备通知，也不改变 herdr 阻塞状态。pi core 0.84.4 起在所有 `ctx.ui.select/confirm/input/editor/custom` 外层发出 `ui_prompt_start`/`ui_prompt_end` 生命周期事件，这使既有 pi-ask / permission-system 专用适配器在现代 pi 上完全冗余：与其让两套机制并存再用抑制计数去消解双发，不如让通用适配器成为唯一的通知与 herdr 来源，带标签事件降级为分类上下文。

## What Changes

- pi-notify 新增通用 UI 等待适配器：监听 pi core 的 `ui_prompt_start`/`ui_prompt_end`（`pi.on()` 处理器），把 agent 运行期间的阻塞对话框映射为通知事件并纳入 herdr blocked 状态机；**span 是唯一的通知方与 herdr 记账方**。
- 仅在 agent run 活跃（`agent_start` 到 `agent_settled` 之间）时路由通用对话框；用户自行敲命令打开的设置/配置对话框不产生通知也不标记 herdr。
- **带标签事件降级为分类上下文**：pi-ask `started/completed` 与 permission-system `ui_prompt`/decision 系事件不再直接产生通知或 herdr 等待项，只用于给当前 span 分类和提供 herdr 标签——存在待确认 permission 请求时 span 归类为 `permission-required`（转发场景标签含请求方代理名），存在活动 ask flow 时归类为 `input-required` 并以净化后的问题标题作 herdr 标签，其余为 `input-required` 默认文案。
- **BREAKING**（对旧版 pi）：移除 pi-ask 输入等待适配器与 permission-system 权限等待适配器的独立通知路径。`peerDependencies` 下限提升为 `@earendil-works/pi-coding-agent >= 0.84.4`；pi < 0.84.4 时问答与权限不再有任何通知。
- **BREAKING**（行为收窄）：headless / 无 UI 模式下的 pi-ask 流程（只有 started/completed 事件、不打开对话框）不再产生通知。
- herdr 独立状态机简化：从"ask + permission"两类等待项收敛为单一 UI 等待项（span）；`herdr:blocked` event 名与 payload 不变，blocked 解除不再依赖 permission decision 匹配。
- 不修改 pi-goal-x、pi-sandbox 或任何其它插件；`api.ts` 公共契约与 `pi-notify:publish` 协议不变（`permission-required` 事件 ID 保留，外部发布者仍可使用）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `notification-event-routing`: 新增"通用 UI 等待适配器"需求（span 映射、agent 活跃门控、基于带标签上下文的分类与标签）；移除"输入等待适配器"与"权限等待适配器"需求（其通知职责由通用适配器承接）；"Herdr 独立状态机"需求收敛为单一 UI 等待项。

## Impact

- `packages/pi-notify/extensions/`：新增通用适配器模块（核心事件解析 + ask flow / 待确认 permission 两组分类上下文 + span 跟踪）；`index.ts` 移除 pi-ask/permission 的通知与 herdr 接线、保留事件监听用于分类、注册两个 `pi.on` 处理器；`state.ts` 收敛为 span 单类等待项；`agent-events.ts` 的 AgentRunTracker 暴露 `isActive()`；`interaction-events.ts` 的 ask/permission 路由去重随之移除。
- 不改动 `packages/pi-goal-x/`、`packages/pi-sandbox/`（均为上游 subtree，零 divergence）。
- 不新增配置项：通用适配器沿用顶层 `enabled` 与 `herdr.enabled` 两个既有开关。
- `package.json`：`peerDependencies["@earendil-works/pi-coding-agent"]` 从 `*` 改为 `>=0.84.4`；README 说明行为收窄点。
- 测试：pi-notify 现有 ask/permission 适配器用例重写为分类上下文用例；新增 agent 门控、嵌套合并、双发消失（started → span 仅一次通知）、session 清理等用例。
