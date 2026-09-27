## Why

本仓库的鼠标三件套（`pi-mouse-events` / `pi-thinking-collapse` / `pi-starline`）把 Pi 的鼠标支持钉在 `>=0.84.2 <0.85`，而 Pi 0.85.0 起已经原生提供组件级鼠标 API（`Component.handleMouse` + `MouseRegion`），0.86.0 起核心用它实现了 thinking、工具结果、branch/compaction 摘要与 skill 调用五处的点击展开——正好覆盖了 `pi-starline` 上游 v0.3.7 删除 `clickToExpandTools` 所依据的能力。继续钉在 0.84.x 意味着三件套无法与任何一个现代 Pi 版本共存，且 `pi-mouse-events` 自带的 `onMouse` 组件派发机制已经与原生 API 重复。

同时，上游 `pi-starline` 已经发布了 v0.3.6 与 v0.3.7 两个版本（fork 记录仍停在 v0.3.5），其中 v0.3.7 的"删除 `clickToExpandTools`"与本 fork 的既有能力直接冲突，需要一次明确的上游同步来重新划定 fork 的边界。

## What Changes

- **上游同步**：以 `git subtree pull` 把 `pi-starline` 从 v0.3.5 同步到 v0.3.7（含 v0.3.6 的 markdown transformer 修复），并把 `subtrees/pi-starline.json` 的 `ref` / `upstreamCommit` / `lastSyncedAt` 推进到 v0.3.7。
- **保留 fork 能力**：上游 v0.3.7 删除了 `clickToExpandTools`（理由是"Pi 0.86.0 已原生支持"），本 fork **拒绝整体删除**，改为保留「点击任意可折叠组件切换展开」并让其与核心原生 toggle 共存——由扩展按"能否解析到 `setExpanded` 组件"决定是否接管，解析不到时回落给后续处理器与核心。
- **配置项改名**：`mouse.clickToExpandTools` 改为 `mouse.clickToToggleExpandable`，默认开启。旧名只描述了工具盒，且不表达「切换」（展开与折叠）这一实际语义；按上游 `fixedEditor` → `mouse` 改名先例（沿用键值 + 一次性写回并告知）迁移，而非按删除先例静默忽略。
- **升级 Pi 基线**：三个鼠标包的 `@earendil-works/pi-tui` 与 `@earendil-works/pi-coding-agent` peer 区间从 `>=0.84.2 <0.85` 提到 `>=0.86.0 <0.88`，devDependencies 提到 `^0.87.1`。**BREAKING**：不再支持 Pi 0.84.x / 0.85.x。
- **删除 `pi-mouse-events` 的组件派发**：移除 `extensions/dispatch.ts`（96 行）与 `geometry.ts` 的 `hasOnMouse`、`api.ts` 的 `Component` 模块增强与 `MouseDispatchEvent.dispatched` 字段。组件级鼠标处理交给原生 `handleMouse` / `MouseRegion`。**BREAKING**：`onMouse` 钩子与 `dispatched` 字段不再存在。
- **保留 `pi-mouse-events` 的不可替代面**：`addMouseHandler` / `addCopyHandler` 优先级槽、`MOUSE_EVENT_CHANNEL` 事件总线、`hitTest` / `parseMouseEvent` / `isMouseSequence` 工具。这些是 Pi 原生 API 无法提供的（`ctx.ui.onTerminalInput` 拿不到鼠标，因为 `TuiAltScreen` 把自己的 input listener 注册在所有扩展之前并 consume 掉全部 SGR 鼠标序列）。
- **契约版本推进**：`MouseEventsApi.version` 由 `1` 提到 `2`，`Symbol.for` 键相应改为 `pi-mouse-events.api.v2`，使旧消费者读取失败时按既有约定优雅降级（鼠标功能关闭）而不是读到被削减的形状。键与版本号同时推进，符合 `api.ts` 自己写下的「同一 major 内不移除、不重塑字段」承诺。
- **删除让路谓词（真机修正）**：`pi-starline` 的 `handlesMouse()`（只认 `onMouse`）在所有真实行上从未生效——`MouseRegion` 只有 `child` 没有 `children`，行路径上永远没有 `MouseRegion`（真机 `rowsContainingMouseRegion=0`）。删除该谓词与整条让路循环，不与 `pi-mouse-events` 删除 `onMouse` 钩子的决定自相矛盾。无双重切换由 patch 层 `{consume:true}` 在核心前返回的结构性保证提供（真机验证有/无 starline 都恰好一次切换）。
- **归还核心选择状态（真机发现）**：fork 消费 release 后核心的 `selectionPressActive` / `selectionAnchor` 残留（真机实测）。`pi-thinking-collapse` 的 `dispatchClick` 是同一问题的第二个消费者。修复在 `pi-mouse-events` patch 层：本手势消费了 release 且未消费 press 时归还核心手势与选择状态，两个消费者一次修复。
- **思考块分工（真机修正）**：思考块行无 `setExpanded`（`AssistantMessageComponent` 类体仅 `hasToolCalls` / `thinkingVisibilityOverrides` 两个顶层字段），starline 解析器返回未命中；思考块点击由**核心原生**处理（0.85.0+ MouseRegion，左键单击切换 `thinkingVisibilityOverrides`）。`pi-thinking-collapse` **移除自身点击折叠功能**，只保留自动折叠状态机（消息结束后自动折叠、流式保持展开、自定义标签），并解除对 `@xzzpig/pi-mouse-events` 的依赖。
- **测试与文档**：删除 `dispatch.test.ts`（10 例）等仅覆盖组件派发的用例；为让路与共存规则补测试；重写 `contract.test.ts` 中宣称 "0.84.x contract" 的标题与断言说明；同步三个包的 README / CHANGELOG；`versions.json` 版本推进。
- **pi 0.87.1 真机 e2e 验证**：以真实 TUI + SGR 点击验证全部鼠标行为断言（加载无报错、工具盒/思考块点击恰好一次、无双重切换、无核心状态残留、滚轮与选择不变、自动折叠不受影响）。真机是本 change 的验收门槛，不是可选补充。
- **二开分歧纪律审计**：`pi-starline` 同步后按 `pi-upstream-subtree` skill 的分歧纪律逐条审计（上游文件字节稳定、无手改 lockfile、无零引用复活文件、分歧仅收敛在 fork-only 文件或最小 seam、全部记录在 `subtrees/pi-starline.json` 的 `notes`）。审查目标：同步不引入不可审计的分歧、不产生未来 pull 的意外冲突面。

## Capabilities

### New Capabilities

- `mouse-event-slots`: 全局鼠标/复制处理器槽与事件总线——`addMouseHandler` / `addCopyHandler` 的优先级语义、首个 `{handled:true}` 消费、抛错跳过、未消费时回落给 Pi 内建处理；`MOUSE_EVENT_CHANNEL` 观察通道（只读，不影响派发）；`hitTest` / `parseMouseEvent` / `isMouseSequence` 查询工具；以及"不消费即让核心照常运行"的回落契约。
- `component-mouse-deference`: 组件级鼠标处理的归属规则——扩展只在能解析到 `setExpanded` 组件时接管点击，解析不到时回落给后续处理器与 Pi 核心；`pi-starline` 保留「点击任意可折叠组件切换展开」；思考块点击归核心原生（`pi-thinking-collapse` 只保留自动折叠、不注册点击处理器）；消费 release 后核心选择状态由 patch 层归还，不发生双重切换。
- `mouse-peer-baseline`: 三个鼠标包的 Pi 原生鼠标 API 基线与降级——peer 区间 `>=0.86.0 <0.88`；`pi-mouse-events` 未安装或契约版本不匹配时的关闭行为；三包版本与发布约定。

### Modified Capabilities

（无——本仓库现有 spec 均与鼠标无关，本次改动不修改任何既有 capability 的需求。）

## Impact

- **`packages/pi-mouse-events`**：删除 `extensions/dispatch.ts`；`geometry.ts` 去掉 `hasOnMouse`；`api.ts` 去掉 `Component` 增强、`ComponentMouseEventWithTarget`、`dispatched`，`version` 改 `2`；`patch.ts` 改为 `parse → handlers → fallthrough`；`extensions/test-support.ts` 去掉 `dispatchMouseEvent` 导出。删除 `test/dispatch.test.ts`。版本 `0.1.3` → `0.2.0`。
- **`packages/pi-thinking-collapse`**：移除点击折叠功能（`click.ts` / `ownership.ts` / `state.ts` 的 `toggle`+`pins` / `controller.ts` 的 `installClickHandling`+`retryClick`），保留自动折叠状态机；解除对 `@xzzpig/pi-mouse-events` 的依赖（dependencies / devDependencies / README）；peer/devDependency 提升。版本 `0.1.0` → `0.2.0`。
- **`packages/pi-starline`**：上游 subtree 同步（含 12 个文件的 fork 与上游交集、3 个 modify/delete 冲突）；删除 `handlesMouse()` 让路谓词；`mouse/capabilities.ts` 保留 `clickToExpandTools` 能力项；`package.json` 保留 fork 名与版本、推进 peer；`subtrees/pi-starline.json` 推进到 v0.3.7。版本 `0.4.1` → `0.5.0`。
- **`pi-mouse-events` patch 层新增**：消费 release 且未消费 press 时归还核心手势与选择状态（`pi-starline` 一个消费者受益——`pi-thinking-collapse` 移除点击后不再消费 release，但逻辑保留覆盖未来消费者）。
- **仓库级**：`versions.json` 三个条目更新；`pnpm-lock.yaml` 新增 pi-tui / pi-coding-agent 0.87.1 条目（当前 lockfile 只到 0.85.1，需联网下载）。
- **依赖契约**：三包 peer 下限提高会让 Pi 0.84.x / 0.85.x 用户无法安装，属用户可见的破坏性变更；`pi-mouse-events` 契约升 v2 会让未同步升级的消费者优雅降级而非报错。
- **不在本次范围**：`pi-agent-role` / `pi-tool-display` / `pi-vibeguard` / `pi-sandbox` / 根 catalog 的 peer 区间（与鼠标无关）。
- **顺带修正**：`mouse/capabilities.ts` 的 `isCallable` 与 `probeCapabilities` 参数类型由裸 `object` 收紧为 `<T extends object>`。该处是 fork 自有代码（上游 v0.3.5 无 `isCallable`，`probeCapabilities` 亦已被 fork 改写），收紧后仍接受类实例与 `ctx.ui` 代理，行为不变（typecheck / biome / 12 个用例均通过）。
