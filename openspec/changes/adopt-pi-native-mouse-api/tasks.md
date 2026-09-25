## 1. pi-mouse-events：删除组件派发

- [x] 1.1 删除 `packages/pi-mouse-events/extensions/dispatch.ts`，并确认 `extensions/` 下不再有任何文件 import 它（`grep -rn "dispatch.ts" packages/pi-mouse-events/extensions/` 无结果）
- [x] 1.2 删除 `extensions/geometry.ts` 的 `hasOnMouse` 及其对 `ComponentMouseEvent*` 类型的 import；确认 `layoutBoxAt` / `overlayGeometries` / `hitTestReceiver` 仍被 `api-registry.ts` 或 `patch.ts` 使用（`pnpm --filter @xzzpig/pi-mouse-events run typecheck` 通过）
- [x] 1.3 改写 `extensions/patch.ts` 的 `patchedViewportInput` 为 D3 的三段结构（`parse → handlers → fallthrough`），移除 `dispatchMouseEvent` import 与 `dispatched` 变量；确认文件内不再出现 `dispatch` 字样，且 `Reflect.apply` 回退路径保留（`grep -c "Reflect.apply" extensions/patch.ts` 为 2）
- [x] 1.3b 在 patch 层补「归还核心状态」：跟踪本手势是否消费过 press；release 被消费且 press 未被消费时，调用 `receiver.clearComponentMouseGesture?.()` 并显式还原 `selectionPressActive=false` / `selectionAnchor=undefined` / `selectionFocus=undefined` / `pressedUrl=undefined` / `selectionDragged=false`；确认真机点击后核心状态无残留（`selectionPressActive` / `selectionAnchor` 为干净值）
- [x] 1.4 更新 `extensions/test-support.ts`：移除 `import { dispatchMouseEvent }` 与末尾的 `export { dispatchMouseEvent }`；确认 `runMouseHandlersInPriorityOrder` / `runCopyHandlersInPriorityOrder` 仍导出（`pnpm --filter @xzzpig/pi-starline test` 中的 `test/contract/mouse-api.test.ts` 不因缺失导入而报错）

## 2. pi-mouse-events：契约升 v2

- [x] 2.1 把 `api.ts` 的 `MOUSE_EVENTS_API_KEY` 改为 `Symbol.for("pi-mouse-events.api.v2")`、`MouseEventsApi.version` 改为 `2`；确认 `MOUSE_EVENT_CHANNEL` 值不变（`grep -n "pi-mouse-events.api.v2\|version: 2" api.ts`）
- [x] 2.2 从 `api.ts` 移除 `ComponentMouseEventWithTarget`、`MouseDispatchEvent.dispatched`、`declare module "@earendil-works/pi-tui"` 的 `Component.onMouse` 增强；确认 `MouseTarget` 保留（`hitTest` 仍返回它）（`pnpm --filter @xzzpig/pi-mouse-events run typecheck` 通过）
- [x] 2.3 更新 `api.ts` 顶部文档：删除 `onMouse` 钩子整节，写明组件级鼠标处理已交给 Pi 原生 `handleMouse` / `MouseRegion`；补一句说明事件总线的 `handled` 只反映本扩展的处理器结果，核心的后续决策不在其中（人工复核文档无残留的 `onMouse` 承诺）
- [x] 2.4 更新 `extensions/receiver.ts` 的 `MouseReceiver` 注释与字段说明：移除仅服务组件派发的成员说明（`overlayStack` / `resolveOverlayLayout` / `isOverlayVisible` 仍需保留给 `overlayGeometries`，不得删除）；确认 `pnpm --filter @xzzpig/pi-mouse-events test` 通过

## 3. pi-mouse-events：测试与元数据

- [x] 3.1 删除 `test/dispatch.test.ts`（10 个仅覆盖组件派发的用例）；确认 `test/hit-test.test.ts` 与 `test/handlers.test.ts` 仍通过（`pnpm --filter @xzzpig/pi-mouse-events test` 全绿）
- [x] 3.2 在 `test/contract.test.ts` 中更新标题（去掉 "0.84.x contract"）并确认 `PATCHED_METHODS` / `READ_METHODS` 断言在 pi-tui 0.87.1 上仍通过（该文件是 patch 方式的 canary）
- [x] 3.3 在 `test/helpers.ts` 的 `makeReceiver` 中补 `instance.renderedOverlayLayouts = []`，使 `Object.create(TuiAltScreen.prototype)` 桩件在 pi-tui ≥0.85 上不因该实例字段缺失而抛错；确认 `pnpm --filter @xzzpig/pi-mouse-events test` 由 34/35 变为全部通过
- [x] 3.4 把 `package.json` 的 peer 区间改为 `>=0.86.0 <0.88`（两个包）、devDependencies 改为 `^0.87.1`，版本升到 `0.2.0`；确认 `pnpm --filter @xzzpig/pi-mouse-events run typecheck` 与 `test` 在 0.87.1 依赖下通过
- [x] 3.4b 为「归还核心状态」补用例：消费 release 且未消费 press → 核心选择字段被还原；未消费 release → 核心字段不被触碰（`test/handlers.test.ts` 或新增文件）
- [x] 3.5 在 `CHANGELOG.md` 写入 0.2.0 条目（删除 `onMouse` 组件派发与 `dispatched`、契约升 v2、peer 下限 0.86.0）并更新 `README.md` 中关于 `onMouse` 的段落；确认两处均不再把 `onMouse` 描述为可用能力
- [x] 3.6 跑 `pnpm --filter @xzzpig/pi-mouse-events run build:types`，确认 `dist/public.d.ts` 中不再出现 `ComponentMouseEventWithTarget` / `dispatched` / `onMouse`（`grep` 无结果）

## 4. pi-thinking-collapse：移除点击折叠，保留自动折叠

- [x] 4.1 删除 `src/click.ts`（点击协议）与 `src/ownership.ts`（行解析）；确认 `extensions/` 与 `src/` 下不再 import 它们（`grep -rn "from \"./click\"\|from \"./ownership\"" src/` 无结果）
- [x] 4.1b 从 `src/state.ts` 移除 `toggle()`、`pins` WeakMap、`resolveCollapsed` 的 pin 分支；确认自动折叠状态机（`updateContent` / `setHideThinkingBlock` patch、`globalHidden`、`collapsedLabelFor`、`recordThinkingChildren`）保留且不依赖被删项（`pnpm --filter @xzzpig/pi-thinking-collapse test` 中 `state.test.ts` 更新后全绿）
- [x] 4.1c 从 `src/controller.ts` 移除 `installClickHandling` / `retryClick` / `clickInstalled`；`install()` 只调 `collapse.install()`；确认 `controller.ts` 不再 import `./click.ts`
- [x] 4.2 删除 `test/click.test.ts`（点击协议用例）；更新 `test/state.test.ts` / `test/reload.test.ts` 中依赖 pin/点击的用例；确认 `pnpm --filter @xzzpig/pi-thinking-collapse test` 全绿
- [x] 4.3 解除对 `@xzzpig/pi-mouse-events` 的依赖：从 `dependencies` / `devDependencies` 移除；`README.md` 更新（不再需要 `pi install npm:@xzzpig/pi-mouse-events`，删除点击相关段落，保留自动折叠描述）；确认 `package.json` 无 `pi-mouse-events` 引用
- [x] 4.4 把 `package.json` 的 peer 区间改为 `>=0.86.0 <0.88`、devDependencies 改为 `^0.87.1`，版本升到 `0.2.0`；确认 typecheck 与 test 通过
- [x] 4.5 更新 `CHANGELOG.md` 与 `README.md` 中的 Pi 版本要求（由 0.84.2 起改为 0.86.0 起），CHANGELOG 记录「移除点击折叠（核心 0.85+ 原生支持）、保留自动折叠、解除 mouse-events 依赖」

## 5. pi-starline：上游同步

- [x] 5.1 确认 worktree 干净、`subtrees/pi-starline.json` 的 `ref` 为 `v0.3.5`、`git config --local --get remote.upstream-pi-starline.pi-ref` 为 `v0.3.5`；以 `caa1acd3a6e873f753a4cc737aaf50a7f4e16828` 执行 `git subtree pull --prefix=packages/pi-starline --squash upstream-pi-starline <sha>`（参考 `pi-upstream-subtree` skill，本地 v0.3.x 标签与 pi-btw 冲突，须用 sha 或远端跟踪 ref）
- [x] 5.2 按 D7 解决 3 个 modify/delete 冲突，保留 fork 版本：`extensions/starline/mouse/tool-box.ts`、`test/mouse/tool-box.test.ts`、`test/contract/tool-box-hint.test.ts`（`git status --short` 中不再有 `UD`/`DU` 条目）
- [x] 5.3 解决 `extensions/starline/mouse/index.ts` 冲突，整体取 fork 版本（fork 的 consumer-API 重写与上游的删除取向不可逐段合并）；确认该文件不含冲突标记（`grep -cE '^(<<<<<<<|>>>>>>>)' extensions/starline/mouse/index.ts` 为 0）
- [x] 5.4 解决 `extensions/starline/mouse/capabilities.ts` 冲突，保留 `clickToToggleExpandable` 能力项与其 `requiredCapabilities` 映射（见 6.1 的改名）；确认 `MouseFeature` 联合类型包含新名
- [x] 5.5 解决 `test/mouse/component-graph.ts`、`test/contract/mouse-install.test.ts`、`test/mouse/capabilities.test.ts`、`test/mouse/editor-caret.test.ts` 的冲突，取与新配置名、新让路判据一致的一侧
- [x] 5.6 解决 `package.json` 冲突：保留 fork 名 `@xzzpig/pi-starline`、fork 版本（见 6.4）与 fork 的 peer 区间，其余取上游；注意保持 TAB 缩进（上游与 biome 均用 TAB，用空格会阻塞 `prepublishOnly`）
- [x] 5.7 解决 `package-lock.json` 冲突时保持 npm 原生 TAB 缩进与上游字节，仅改动 name/version 行（该文件受 biome 保护且被根 prettier 忽略）
- [x] 5.8 处理 `CHANGELOG.md` / `README.md` / `docs/configuration.md` 冲突：采用上游的 v0.3.6/v0.3.7 条目，但把「clickToExpandTools 已被 Pi 取代、点击切换不再是 Starline 能力」的表述改写为 fork 立场（保留该能力、已改名、与核心共存）
- [x] 5.9 确认上游新增的 `extensions/starline/mouse/key-text.ts` 与新让路判据下仍被使用的 `keyTextFor` 不重复定义：让 `tool-box.ts` 改从 `./key-text` 导入，或删除其中一份；确认 `grep -rn "export function keyTextFor" extensions/` 只有一处
- [x] 5.10 按 D8 把 `mouse/capabilities.ts` 的 `isCallable` 与 `probeCapabilities` 参数类型收紧为 `<T extends object>`（不得改为 `Record<string, unknown>`，实测会使 typecheck 失败）；确认 `npx tsc -p tsconfig.json --noEmit` 与 `npx biome check extensions/starline/mouse/capabilities.ts` 均 EXIT=0
- [x] 5.11 跑 `pnpm --filter @xzzpig/pi-starline run typecheck` 与 `npm run verify`（biome + typecheck + test）全绿，确认同步本身未引入行为回归

## 6. pi-starline：配置改名与让路判据

- [x] 6.1 把 `config.ts` 的 `MouseConfig` 字段 `clickToExpandTools` 改名为 `clickToToggleExpandable`（默认 `true`），并同步 `FIXED_EDITOR_KEY_MAP`、`defaultConfig.mouse`、`normalizeMouseConfig`、`saveMousePatch` 四处引用；确认 `grep -c "clickToExpandTools" extensions/starline/config.ts` 为 0
- [x] 6.2 按 D5 补 `mouse.clickToExpandTools` → `clickToToggleExpandable` 的迁移：读取时若新键缺失而旧键存在则沿用旧键值，新键优先；确认新增测试覆盖「旧键被沿用」与「新键优先」两种情况
- [x] 6.3 在 `settings-command.ts` 中把开关项改为新名与新的显示文案（覆盖范围是任意可折叠组件，而非仅工具盒）；确认 `/starline` 设置界面可切换该项并落盘为新键
- [x] 6.4 按 D1 删除 `tool-box.ts` 的 `handlesMouse()` 与 `expandTargetAt` 中的让路循环；确认 `onMouse` 在 `extensions/starline/mouse/` 下不再出现（`grep -rn "onMouse" extensions/starline/mouse/` 无结果）；新增测试断言「解析到 `setExpanded` 组件时切换、解析不到时不消费」两个方向
- [x] 6.5 在 `mouse/index.ts` 中把 `featureOn("clickToExpandTools")` 改为新键；确认 `grep -rn "clickToExpandTools" extensions/ test/ docs/ README.md` 无结果（全部改名完成）
- [x] 6.6 把 `package.json` 的 peer 区间改为 `>=0.86.0 <0.88`（含 `@earendil-works/pi-ai` 如适用）、devDependencies 改为 `^0.87.1`、版本升到 `0.5.0`；确认 typecheck 与 test 通过
- [x] 6.7 与核心原生切换的共存验证：用真实布局树（`ToolExecutionComponent` 作为 `Box` 祖先暴露 `setExpanded`）断言「解析到目标时恰好切换一次」；补充思考行断言（无 `setExpanded` → 不消费，思考行点击由核心处理）；确认该用例在 `pnpm --filter @xzzpig/pi-starline test` 中通过

## 7. pi 0.87.1 真机 e2e 验证

- [x] 7.1 用 **pi 0.87.1** 跑真实 TUI e2e（参考 `pi-plugin-e2e-test` skill + `pi-tmux-tmp-server` skill）：环境用 nix store 的 pi 0.87.1 二进制（`/nix/store/flz04wcfr1zml1sqymd1fdgca20cmhzf-pi-coding-agent-0.87.1/bin/pi`）、`TMUX_TMPDIR=/tmp` 的 tmux 会话、真实 SGR 点击（`\x1b[<0;x;yM` 按下 / `m` 释放）驱动全屏 TUI；确认三包（`pi-mouse-events` / `pi-thinking-collapse` / `pi-starline`）在 0.87.1 上加载无报错、无扩展加载警告
- [x] 7.2 工具盒点击断言：内容行 17–27（`ToolExecutionComponent` 区域）上左键点击，`setExpanded` 恰好调用 1 次（有/无 starline 两种配置均断言）；连续三次点击 `false→true→false` 是真 toggle；点击后核心 `selectionPressActive=false` / `selectionAnchor=undefined`（无残留）；无 starline 时核心自身也恰好切换一次
- [x] 7.3 思考块点击断言：思考块行（`AssistantMessageComponent` 内）左键点击由**核心原生**切换且恰好一次；`pi-starline` 解析器在思考行返回未命中（不消费）；移除 `pi-thinking-collapse` 点击后无第三方介入
- [x] 7.4 `pi-thinking-collapse` 自动折叠断言：消息结束后思考块自动折叠、流式输出保持展开（移除点击后状态机仍工作）；`ctrl+t` 全局切换仍优先
- [x] 7.5 回归断言：滚轮滚动、文本拖选、链接点击行为与安装扩展前一致；无核心手势状态泄漏到下一次输入

## 8. 二开分歧纪律审计与仓库级验证

- [x] 8.1 按 `pi-upstream-subtree` skill 的「Fork divergence discipline」对同步后的 `packages/pi-starline` 逐条审计：上游文件字节稳定（无重格式化——TAB / 引号 / import 序 / 行宽 / 尾部换行与上游一致，`git diff --numstat` vs `git diff -w --numstat` 对比，纯空白变更的文件用 `git show <upstreamCommit>:<path>` 还原为字节一致）；无手改 `package-lock.json`（取上游字节或机械生成）；无零引用复活文件；分歧仅在 fork-only 文件或最小 seam 内
- [x] 8.2 确认所有 fork 分歧在 `subtrees/pi-starline.json` 的 `notes` 中记录（保留 `tool-box.ts` / `component-tree.ts` 的持续 modify/delete 冲突、配置项改名与迁移、删除让路谓词、`key-text.ts` 重复 `keyTextFor` 的处理、`capabilities.ts` 类型收紧、`package-lock.json` TAB 缩进约定、上游 v0.3.6/v0.3.7 内容）；`direnv reload` 的 schema 与 ref 校验通过
- [x] 8.3 同步 `versions.json` 中 `pi-mouse-events` / `pi-thinking-collapse` / `pi-starline` 三项，使其与各自 `package.json` 的版本一致；确认 `pnpm install --frozen-lockfile` 通过且 `pnpm-lock.yaml` 含 pi-tui / pi-coding-agent 0.87.1 条目
- [x] 8.4 跑 `pnpm --filter pi-permission-system run typecheck` 与 `test`，确认本次改动未波及其他包（按 `AGENTS.md` 的验证命令）
- [x] 8.5 跑 `pnpm exec prettier --check .` 通过（`pi-starline` 已被 `.prettierignore` 排除，其格式由 biome 负责）；`pi-thinking-collapse` 移除点击后不再依赖 `pi-mouse-events`，确认其 `package.json` 无残留引用
