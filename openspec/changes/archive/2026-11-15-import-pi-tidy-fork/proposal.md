# Proposal

## Why

仓库的转录装饰面目前由四个插件各自维护实现，其中「用户消息」与「复制不带框线」两处能力存在**三方争抢**：`pi-starline`、`pi-tool-display` 与上游指定的归属者 `pi-tidy` 都在 patch 同一个 `UserMessageComponent.prototype.render`。

上游 pi-starline v0.13.0 已经把这两项能力交给 pi-tidy，本 fork 为保留旧视觉而冻结了约 590 行上游已删除的代码。这些代码不会再获得任何上游改进，且每次同步都要重新应用（`subtrees/pi-starline.json` 的 `reapplyOnSync` 第 17 条）。

同时，pi-tidy 有 4 项本仓库没有的能力（错误行去重、hex 色块、最终回复框、代码块分节），自行移植需要触碰两个 Pi 私有 API（`InteractiveMode.init`、Markdown 的 `renderToken`），长期维护成本高于直接二开。

## What Changes

- **新增第 11 个 upstream subtree** `packages/pi-tidy`，来源 `Andy8647/pi-tidy`（MIT），以 squash 方式导入并由 `pi-upstream-subtree` 流程记录精确 commit；fork 身份为 `@xzzpig/pi-tidy`。
- **二开：新增 `frameTools` 开关**（fork 默认 `false`）。上游把工具框写在 `patchToolBoxFrames` 里且不提供任何开关，这是唯一必须改上游源码的点。
- **二开：运行时默认值覆盖**。12 项与现有插件重叠的能力由 fork-only 模块在入口处覆盖，**不修改上游 `DEFAULTS`**，因此上游 `loadConfig` 相关测试仍然通过。
- **上游消息框开关耦合**。pi-tidy 用 `frameMessages` 同时控制用户消息 `frame` 与 compaction/branch/skill/custom 消息框；为保留已选定的 `userMessageStyle: "frame"`，fork 默认开启 `frameMessages`，并接受这些一般消息也带框。
- **二开：框关闭时单独安装 hover 跟踪**。上游把 `installHoverTracking()` 藏在 `patchToolBoxFrames` 内部，跳过它会连带失去代码块复制 chip 的悬停高亮与手型光标。
- **保留 pi-tidy 的四项能力**：`dedupeErrors`、`hexSwatches`、`finalReplyStyle`、`codeBlocks`。
- **不补回「一键复制路径」chip**：它长在工具框顶边上，关闭工具框会一并失去；`pi-tool-display` 的调用行已显示路径，拖选即可复制。
- **pi-tidy 接管用户消息与干净复制**：fork 默认开启 `userMessageStyle: "frame"`，但默认关闭 `cleanCopy`；用户可通过 `tidy.cleanCopy: true` 显式开启干净复制，旧配置迁移提示会告知新键。
- **移除 pi-starline 的重复实现**（约 590 行）：`extensions/starline/user-message.ts`（327）、`mouse/transcript-copy.ts`（209）、`mouse/fork-transcript-copy.ts`（54），以及 `index.ts`、`prototype-patch-registry.ts`、`mouse/index.ts` 中的四处接缝。
- **pi-starline 采纳上游的一次性迁移提示** `warnMovedUserMessageKeys`，对已迁移的配置键给出提示而不是静默失效。
- **不修改 `pi-tool-display` 的默认值**：`enableNativeUserMessageBox` 保持上游默认 `true`，避免新增上游分歧；改为在文档中说明需由用户自行设为 `false`，才能让 pi-tidy 独占用户消息面。
- **BREAKING**：`colors.userMessageBorder`、`colors.userMessageText`、`colorSources.userMessages`、`userMessagePaddingY`、`mouse.transcriptCleanCopy` 在 pi-starline 中不再生效；用户消息视觉改由 `tidy.*` 配置控制。
- **BREAKING**：`colorSources.userMessages` 的「主题色 / 终端调色板」二选一语义消失，pi-tidy 只接受主题色名与 `#rrggbb`。

## Capabilities

### New Capabilities

- `transcript-chrome-ownership`: 转录装饰面的单一所有权与共存契约——哪个插件绘制工具框、用户消息、干净复制、组级折叠、代码块与错误行；同一渲染面如何保证只有一个生效者；多个插件 patch 同一组件时如何按 predecessor 链组合。
- `tidy-transcript-rendering`: `@xzzpig/pi-tidy` 二开后的渲染契约——保留的四项能力、fork 运行时默认值、`frameTools` 开关语义，以及私有 Pi API 不可用时的降级行为。

### Modified Capabilities

无。`transcript-group-folding` 与 `pill-rendering` 的行为契约不变：组级折叠仍由 `pi-group-collapse` 独占，pill 与状态栏仍由 `pi-starline` 独占，本次变更只调整谁拥有用户消息与干净复制。

## Impact

### 新增

- `packages/pi-tidy/`（上游源码 + `fork/` 二开模块 + `FORK-CHANGELOG.md`）
- `packages/pi-tidy/test/e2e/`：自动化 e2e 套件（harness + 渲染面归属 / 补丁链 / 配置迁移 / 纯渲染 / 错误去重）与 `test:e2e` script
- `artifacts/pi-tidy/e2e/<date>/`：真机证据包（`.cast` 录像 + `manifest.json` + `report.md` + `analyze-cast.mjs` + `git-fingerprint.txt`），删除前与删除后各一份
- `subtrees/pi-tidy.json`（name / prefix / source / remote / ref / upstreamCommit / reapplyOnSync / knownDebt）
- `versions.json`、`README.md` 包列表

### 修改

- `packages/pi-starline/`：删除 3 个文件、4 处接缝、5 个配置键、2 个测试文件；`subtrees/pi-starline.json` 的 `reapplyOnSync` 由 32 条降为 31 条
- `packages/pi-tidy/README.md`、`packages/pi-starline/README.md`：说明 `enableNativeUserMessageBox` 需由用户关闭，否则两个插件会同时绘制用户消息
- `pnpm-workspace.yaml`：为 `@xzzpig/pi-tidy` 增加 Pi 1.5 overrides（`registerToolRenderer` 需 pi ≥ 1.3.0，而共享 catalog 为 1.1.0）
- `AGENTS.md`：验证段落补充 `test:e2e` 命令

### 依赖与运行时

- 新增运行时依赖：无（pi-tidy 不注册工具，只使用 Pi 公开 API 与两个私有接缝）
- Pi 版本下限：`pi-tidy` 本体需 ≥ 1.1.0；`registerToolRenderer` 相关能力需 ≥ 1.3.0
- 与 `@xzzpig/pi-group-collapse`、`@xzzpig/pi-tool-display`、`@xzzpig/pi-starline`、`@xzzpig/pi-mouse-events` 的共存由自动化 e2e 与真机证据包两轮验证：删除前一轮不加载 `pi-starline`（它没有开关可关掉自绘用户消息），删除后一轮加载全部五个插件并断言 patch 链上只剩 `pi-tidy`
