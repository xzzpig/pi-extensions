## Context

见 `proposal.md` — Why。此处只记录塑造方案的关键约束。

**已验证的运行时事实**（pi-tui / pi-coding-agent 0.87.1，nix store 副本实测，`pi-plugin-e2e-test` 真机 TUI + SGR 点击）：

0. **真机点击实测**（pi 0.87.1，真实 fullscreen TUI，`\x1b[<0;x;yM/m` SGR 点击工具盒提示行）：

   ```text
   有 starline 时： BUS up handled=true  setExpanded 调用 1 次 → expanded false→true
   无 starline 时： BUS up handled=false setExpanded 调用 1 次 → expanded false→true
   连续三次：     false→true→false（真 toggle，每次恰好一次）
   有 starline 时点击后： selectionPressActive=true  selectionAnchor=SET  ← 残留
   无 starline 时点击后： selectionPressActive=false selectionAnchor=undefined ← 干净
   ```

   **核心结论**：有/无 starline 都恰好切换一次（patch 层 `if (handled) return {consume:true}` 在调用 original 之前返回，核心的 release 路径根本没跑，不存在双重切换）；但 starline 消费 release 后核心的 `handleSelectionMouseEvent` release 分支——唯一还原 `selectionPressActive`/`selectionAnchor` 的地方——被跳过，留下选择状态残留。

1. `TuiAltScreen` 在构造函数的最后一行注册自己的 input listener（`this.addInputListener((data) => this.handleViewportInput(data))`），而 `TuiBase.handleTerminalInput` 按插入序迭代 `inputListeners` 并在 `result.consume` 时立即 `return`。因此**扩展的 `tui.addInputListener` 永远收不到鼠标序列**。`ctx.ui.onTerminalInput` 的实现就是 `ui.addInputListener`，同样收不到。实测：SGR press / wheel / hover 均被 alt screen 以 `consume:true` 拦下；只有 legacy X10 与普通按键能穿过。

1. `TuiAltScreen` 在构造函数的最后一行注册自己的 input listener（`this.addInputListener((data) => this.handleViewportInput(data))`），而 `TuiBase.handleTerminalInput` 按插入序迭代 `inputListeners` 并在 `result.consume` 时立即 `return`。因此**扩展的 `tui.addInputListener` 永远收不到鼠标序列**。`ctx.ui.onTerminalInput` 的实现就是 `ui.addInputListener`，同样收不到。实测：SGR press / wheel / hover 均被 alt screen 以 `consume:true` 拦下；只有 legacy X10 与普通按键能穿过。

1. `MouseRegion` 是一个**具体类**（`dist/components/mouse-region.d.ts`，`export declare class MouseRegion implements Component`），从 `dist/index.d.ts:11` 公开导出。实例自有属性恰为 `child` 与 `onMouse`，**没有 `children`**。真机图遍历确认工具盒 `contentBox` 的子节点是两个 `MouseRegion`（`childish=true`）。

1. **真机行遍历**（真实工具盒，内容行 17–27）：`LINEWALK rowsContainingMouseRegion=0`——`MouseRegion` 只有 `child`，`childrenOf()` 读 `component.children` 得到 `[]`，**行路径上永远没有 `MouseRegion`**。真实行路径是：

   ```text
   row 21: [Container > Container > ToolExecutionComponent > Box]
   ```

   `ToolExecutionComponent` 作为 `Box` 的**祖先**在路径上，且暴露 `setExpanded`（`expandableRows=18`），所以 fork 解析得到它并切换——不是靠让路，而是靠解析能力。`instanceof MouseRegion` 判据在真机上对工具行为 `false`（路径上没有 `MouseRegion`），对普通消息行同样 `false`，**对任何真实行都从未生效**。

1. 核心的五个 `MouseRegion` 实例只在 `event.type === "click" && event.button === "left"` 时返回 `handled`，press 返回 `undefined`。因此核心的 click 合成走的是 `handleSelectionMouseEvent` 的 `isClick` 分支，而非 `mousePressTarget` 分支（后者需要 press 就返回 `target`）。

1. 核心 0.86.0 的边界是实测的：`new MouseRegion(` 在 0.85.1 有 2 处，在 0.86.1 有 5 处，与 CHANGELOG 0.86.0 的 "Added click toggling for branch summaries, compaction summaries, and skill invocation entries" 一致。

1. 扩展加载器把 `@earendil-works/pi-tui` **别名到 Pi 自己的那份**（`getAliases()` → `piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui")`；`loadExtensionModule` 以 `{alias: getAliases()}` 创建 jiti；内嵌/单文件运行时走 `virtualModules` 指向同一份内联副本）。即扩展与核心拿到的是**同一个模块实例**。

## Goals / Non-Goals

**Goals:**

- 三个鼠标包能安装在 Pi 0.86.0+ 上，并声明一致的兼容区间。
- `pi-mouse-events` 只保留 Pi 原生无法提供的能力，删除与 `handleMouse` 重复的组件派发。
- `pi-starline` 的「点击任意可折叠组件切换」在与核心原生切换共存时恰好触发一次。
- `pi-thinking-collapse` 移除与核心重复的点击折叠，保留自动折叠状态机。
- 用 **pi 0.87.1 真机 e2e** 验证全部鼠标行为断言（不是仅靠单测）。
- 同步 `pi-starline` 上游 v0.3.6/v0.3.7 时守住**二开分歧纪律**（fork-divergence discipline），使分歧可审计、冲突面可预期。

**Non-Goals:**

- 不用 `MouseRegion` 重写 fork 的组件（三个包内没有任何自建组件需要它）。
- 不移除 prototype patch 层（`copyActiveSelectionToClipboard`、`handleSelectionMouseEvent`、`routeWheel`、选择几何都是 `handleMouse` 契约触不可及的）。
- 不修改与鼠标无关的包的 peer 区间，也不动根 catalog。
- 不修正与本次改动无关的上游文件格式问题（二开分歧纪律禁止重格式化上游文件）；`capabilities.ts` 的类型收紧属于 fork 自有代码（见 D8），不在该禁令范围内。
- 不把 `pi-thinking-collapse` 的自动折叠状态机一并删除（那是核心没有的另一半能力）。

## Decisions

### D1：删除 `handlesMouse()` 让路谓词，让路由解析能力决定

**决策**：删除 `tool-box.ts` 的 `handlesMouse()`（`onMouse` 鸭子类型）及 `expandTargetAt` 中的整条让路循环。不再有任何"检测别人处理鼠标"的谓词。

**理由**：真机证明该谓词在所有真实行上从未生效——`MouseRegion` 只有 `child` 没有 `children`，行路径上永远没有 `MouseRegion`，`onMouse` 检查永远为 `false`。它是死代码，且与 `pi-mouse-events` 删除 `onMouse` 钩子的决定自相矛盾（同一个 change 里一边删契约一边检查契约）。

**删除后行为不变**：fork 在能解析到 `setExpanded` 组件时接管（工具盒 / skill/branch/compaction 摘要 / 自定义条目），解析不到时返回 `undefined` 自然回落（思考块→`pi-thinking-collapse` / 核心）。真机验证有/无 starline 都恰好一次切换，无双重切换。

**备选（已否决）**：改为认 `handleMouse`——朴素谓词误伤 `Box`（有自有 `handleMouse`），让路粒度是"路径上任一命中即放弃整条 click"，等于静默关闭整个功能；`instanceof MouseRegion` 在真机路径上永远为假，同样无效。

### D2：点击归属由解析能力决定，无双重切换是 patch 层的结构性保证

**决策**：把 spec 中「组件自带处理时让路」重写为「点击归属由解析能力决定」：fork 只在解析到 `setExpanded` 组件时接管，否则不消费、回落。不再设计任何"检测核心是否处理"的机制。

**理由**：真机证明防双重切换不需要让路判据——patch 层 `if (handled) return {consume:true}` 在调用 original `handleViewportInput` 之前返回，核心的 release 路径（`handleSelectionMouseEvent` 的 `isClick` 分支合成 clickEvent 并派发到 `MouseRegion`）在 fork 消费时根本不会跑。有/无 starline 都恰好一次切换（实测）。

**分工表（真机 + 静态验证）**：

| 行类型                                                     | fork 能否解析到 `setExpanded`                                                          | 谁切换                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 工具盒（call/result）                                      | ✅ `ToolExecutionComponent` 在路径上                                                   | starline                                                                              |
| skill/branch/compaction 摘要                               | ✅ 有 `setExpanded`                                                                    | starline                                                                              |
| 自定义 entry/message、`ExpandableText`、`AuthCommandError` | ✅ 有 `setExpanded`/`_expanded`                                                        | starline（核心不包裹，保留价值）                                                      |
| 思考块                                                     | ❌ 无 `setExpanded`（可见 `Markdown` / 隐藏 `Text`，`AssistantMessageComponent` 亦无） | **核心原生**（0.85.0+ MouseRegion；`pi-thinking-collapse` 不再注册点击处理器，见 D9） |

### D3：`patch.ts` 缩短为 `parse → handlers → fallthrough`，并归还核心选择状态

**真机发现（新增）**：fork 消费 release 后，核心的 `selectionPressActive` / `selectionAnchor` 残留（见事实 0）。`pi-thinking-collapse` 的 `dispatchClick` 同样只 `requestRender` 不清核心状态，是同一类问题的第二个消费者。归还逻辑放 patch 层（而非各 fork 内），一次修复两个消费者。

**决策**：删除 `dispatchMouseEvent` 调用与 `dispatched` 变量，保留结构：

```ts
const event = parseMouseEventWith(receiver, data);
if (!event) return Reflect.apply(originalViewportInput, this, [data, ...rest]);
if (runMouseHandlersInPriorityOrder(core.mouseHandlers, event, receiver)) {
  emit({ ...event, handled: true });
  return { consume: true };
}
emit({ ...event, handled: false });
return Reflect.apply(originalViewportInput, this, [data, ...rest]);
```

**理由**：删除组件派发后，未消费的事件**必然**回落到核心，而核心的 `handleMouseEvent` 会自行完成 `dispatchMouseToLayout` → `MouseRegion.onMouse` → 切换。行为不变，代码变少。`geometry.ts` 保留（`hitTest` 依赖 `layoutBoxAt` / `overlayGeometries`）。

**权衡**：核心的处理发生在 wrapper 之后，所以跨扩展的事件总线广播早于核心决策，`handled` 只反映 fork 侧结果。需在 `api.ts` 文档中写明，避免消费者误读。

### D4：契约升 v2，键与版本号同时推进

**决策**：`MOUSE_EVENTS_API_KEY` 改为 `Symbol.for("pi-mouse-events.api.v2")`，`MouseEventsApi.version` 改为 `2`。

**理由**：本次删除了 `MouseDispatchEvent.dispatched`，而 `api.ts` 明文承诺"同一 major 内不移除、不重塑字段"。只改 version 不改键会让"键钉住契约名、版本钉住形状"的设计意图失效。消费者（`pi-starline/extensions/starline/mouse/api-consumer.ts:34`、pi-thinking-collapse）已按 `version !== 1 → undefined` 优雅降级，因此不匹配时鼠标功能整体关闭，而不是带着残缺形状运行。

### D5：配置项改名 `clickToExpandTools` → `clickToToggleExpandable`，按改名先例迁移

**决策**：新键默认 `true`；旧键的值被沿用（新键存在时新键优先），采用上游 `fixedEditor` → `mouse` 的一次性写回 + 告知机制。

**理由**：上游有两条相反先例——**删除**（`clickToExpandTools`，因功能被核心取代 → 运行时忽略）与**改名**（`fixedEditor` → `mouse`，键值保留 → 自动迁移）。本次是**在 `mouse` 命名空间内改名且功能保留**，属改名先例，不是删除先例。旧名只描述工具盒，且不含"切换"（展开/折叠）语义，与现在覆盖 thinking / 摘要 / skill / 自定义条目的事实不符。

### D6：`geometry.ts` 的 `hasOnMouse` 删除，`hitTest` 保持不变

**决策**：删除 `hasOnMouse`；`hitTestReceiver` 继续返回"最深的 layout box"，不加任何鼠标方法过滤。

**理由**：`hitTest` 回答的是"指针下是什么组件"，它从来就**不带** `onMouse` 过滤（与 dispatch 不同）。删除 `hasOnMouse` 只影响 dispatch，`hitTest` 语义与实现均不变。

## Risks / Trade-offs

- **[删除让路谓词后，核心包裹的行与 fork 解析到的行重叠]** → 不会双重切换：patch 层 `{consume:true}` 在核心前返回（真机验证有/无 starline 都恰好一次）。重叠行（工具盒）由 fork 切换、核心的 `MouseRegion` 不跑——`setExpanded` 目标同一，结果等价。
- **[消费 release 留下核心选择状态残留]** → 修复在 patch 层：手势内消费 release 且未消费 press 时归还（`clearComponentMouseGesture` + 选择字段还原），真机验证后 `selectionPressActive=false` / `selectionAnchor=undefined`。
- **[思考块与 `pi-thinking-collapse` 的边界]** → 思考行无 `setExpanded`（`AssistantMessageComponent` 类体仅 `hasToolCalls` / `thinkingVisibilityOverrides` 两个顶层字段），starline 解析器返回未命中；`pi-thinking-collapse` 移除自身点击处理器后思考行只剩核心原生一个消费者，三条线彻底解耦。需要真机断言验证思考行点击由核心切换且恰好一次（见 Open Questions 与任务 7.3）。
- **[删除 `dispatched` 会让未同步升级的消费者失去该字段]** → 契约升 v2 且键同时推进，旧消费者读到 `undefined` 后按既有约定整体关闭鼠标功能，不会带着残缺形状运行。
- **[peer 下限抬到 0.86.0 会使 Pi 0.84.x / 0.85.x 用户无法安装]** → 这是有意的：0.84.x–0.85.x 上核心只覆盖 thinking 与工具结果，摘要与 skill 无点击切换，且 fork 的让路/共存机制按 0.86+ 设计。与其在旧版上部分失效，不如明确拒绝。
- **[核心的 `MouseRegion` 不直接出现在行路径上]** → 真机确认（`rowsContainingMouseRegion=0`），所以不存在"提示行归 fork、结果区归核心"的按行分工；真实分工是"能解析到 `setExpanded` 就归 fork，否则回落"（D2 分工表）。若核心未来把可展开组件改为不暴露 `setExpanded`，fork 的解析会自然让出，不需要改判据。
- **[subtree 同步在 12 个文件上有冲突，含 3 个 modify/delete]** → 按 `subtrees/pi-starline.json` 的 notes 逐条重放 fork 分歧；上游删除的文件按 D7 保留。
- **[二开分歧纪律（审查目标）]** → 同步与 fork 改动必须通过 `pi-upstream-subtree` skill 的分歧审计：上游文件字节稳定（禁止重格式化、禁止手改 `package-lock.json`、禁止零引用复活文件）、分歧收敛在 fork-only 文件或最小 seam、每条分歧记录在 `subtrees/pi-starline.json` 的 `notes`。任务 8.1/8.2 落地该审计，未通过不得提交。
- **[真机 e2e 是验收门槛]** → 单测只验证单元行为，鼠标归属 / 状态残留 / 共存断言必须以 pi 0.87.1 真实 TUI 的 SGR 点击为准（任务 7 整节）。真机环境细节（nix store 0.87.1 路径、`TMUX_TMPDIR`、点击协议）已在任务 7.1 记录，避免实施阶段重新考古。

### D9：思考块点击归核心原生，`pi-thinking-collapse` 只保留自动折叠状态机

**决策**：`pi-thinking-collapse` 移除自身的点击折叠功能（`dispatchClick` / `installClickHandling` / `pins` 状态机 / `ownership.ts` 行解析），思考块行的点击完全由核心原生处理；`pi-thinking-collapse` 只保留核心没有的**自动折叠状态机**（消息结束后自动折叠、流式输出时保持展开、per-message 展开记忆、自定义折叠标签）。

**理由（真机 + 静态验证）**：pi 0.87.1 的 `AssistantMessageComponent` 已把 `thinkingComponent` 包在 `MouseRegion` 里，左键单击切换 `thinkingVisibilityOverrides.set(runIndex, !hidden)` 并刷新——思考块点击是核心原生能力（0.85.0 起就有，0.87.1 的 5 处 MouseRegion 之一）。`pi-thinking-collapse` 的点击协议（modeled on starline's click-on-shell）在核心原生支持后成为重复劳动，且其消费 release 还会触发核心选择状态残留（真机实测的同一问题）；移除后思考行点击走核心路径，patch 层的状态归还不受影响（思考行点击不再被 fork 消费）。

**剩余价值**：核心的 `hideThinkingBlock` 是全局标志（`ctrl+t` / settings 翻转），没有 per-message 的自动折叠——这正是 `pi-thinking-collapse` 的存活理由（README："Auto-collapsed on completion"）。点击移除后该状态机保留不变，且不再依赖 `@xzzpig/pi-mouse-events`。

**注册顺序无关（旧结论仍适用但不再需要）**：移除后思考行上只有一个点击消费者（核心），starline 解析器仍返回未命中（`AssistantMessageComponent` 无 `setExpanded`），三条线彻底解耦。

### D7：上游删除的文件按 fork 意图保留

**决策**：保留 `mouse/tool-box.ts`、`mouse/component-tree.ts` 及其测试；接受未来每次 pull 的 modify/delete 冲突。

**理由**：上游删除的理由是"核心已原生支持"。真机实测表明 fork 的点击能力与核心**不等价**：核心只在 `MouseRegion` 包裹的区域内切换且工具运行中（`this.result` 未定义）不响应，而 fork 解析 `setExpanded` 组件（工具盒 / 摘要 / 自定义条目），工具运行中也能通过 `expanded` 字段切换。删除会丢失 fork 独有的覆盖范围。代价是持续的冲突面，记录在 subtree 元数据里。

### D8：`capabilities.ts` 的类型收紧按 fork 自有代码处理

**决策**：把 `isCallable` 与 `probeCapabilities` 的参数类型由裸 `object` 收紧为 `<T extends object>`。

**理由**：这两处是 **fork 自有代码**（上游 v0.3.5 没有 `isCallable`，且 `probeCapabilities` 已被 fork 改写为以 receiver 而非 prototype 为参数），不属 fork-divergence 纪律保护的"上游行"。收紧后仍接受类实例与 `ctx.ui` 代对象，类型与运行时行为均不变（typecheck / biome / 12 个用例均通过）。

**备选**：改成 `Record<string, unknown>` —— **不可行**，实测会让 `test/mouse/capabilities.test.ts` 的 `object` 实参无法传入（`TS2345`，缺字符串索引签名），typecheck 失败。

## Migration Plan

1. 先做 `pi-mouse-events`（无 subtree 约束）：改 `api.ts` / `patch.ts` / `geometry.ts` / `test-support.ts`，删 `dispatch.ts` 与 `dispatch.test.ts`，升 peer 与版本，重跑测试；patch 层补「消费 release 且未消费 press 时归还核心状态」逻辑与用例。
2. 再做 `pi-thinking-collapse`：移除点击折叠功能（`click.ts` / `ownership.ts` / `state.ts` 的 `toggle`+`pins` / `controller.ts` 的 `installClickHandling`+`retryClick`），保留自动折叠状态机；解除对 `@xzzpig/pi-mouse-events` 的依赖；适配 v2 契约（如仍引用），升 peer 与版本。
3. 最后做 `pi-starline`（需干净 worktree）：先 `git subtree pull` 并解析冲突，再删 `handlesMouse()` 让路谓词、改配置项，升 peer 与版本，推进 `subtrees/pi-starline.json`。
4. 同步 `versions.json` 与 `pnpm-lock.yaml`；`direnv reload` 通过元数据校验；跑三个包的 typecheck / test 与根 prettier。
5. 真机验证（`pi-plugin-e2e-test`）：三包在 pi 0.87.1 加载无报错；工具盒行点击恰好一次；思考行点击归 `pi-thinking-collapse` 且恰好一次；点击后核心选择状态无残留；滚轮与选择行为不变。

**回滚**：三个包相互独立，逐个 revert 即可；`pi-starline` 的 subtree 同步可用 `git revert` 撤销 squash commit，并把 `subtrees/pi-starline.json` 的 `ref` 退回 v0.3.5。

## Open Questions

- **思考行归属的真机断言**：思考行点击是否确实由核心切换且恰好一次、starline 是否在思考行返回未命中、`pi-thinking-collapse` 移除点击后自动折叠状态机是否仍工作——静态分析与真机工具行测试已支持结论，但思考行本身未直接实测，任务 7.3/7.4 落地该断言（pi 0.87.1 真机 e2e）。
- **遗留工作树改动**：`packages/pi-starline/extensions/starline/mouse/capabilities.ts` 的 `<T extends object>` 收紧（D8 的实现）已在工作树中，早于本 change 且处于 explore 模式未提交——实施时确认其归属（作为 D8 的一部分保留并验证，或回退由实施阶段重做）。
- **`pi-thinking-collapse` 点击移除的版本影响**：点击折叠功能对使用方是用户可见行为，移除后依赖它的用户需要在新版本里改用核心原生点击（0.85+ 原生可用）；由于本 change 同时把 peer 下限抬到 0.86.0，用户必然在支持原生点击的版本上运行，行为衔接无缝。
- **二开分歧纪律审计未完成前不得提交**：`pi-starline` 同步后必须先过任务 8.1/8.2 的字节稳定性与 notes 记录审计，任何格式化漂移、lockfile 手改、零引用文件都会放大未来 pull 的冲突面。
