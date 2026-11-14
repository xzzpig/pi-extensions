# Design

## Context

动机见 `proposal.md` 的 Why 一节，此处只记录影响方案取舍的现状与约束。

- 仓库已用 git subtree 管理 10 个上游包，配套 `pi-upstream-subtree`、`pi-fork-divergence` 两个技能与 `pnpm run audit:fork-divergence` 门禁，元数据由 `subtrees/*.json` 记录。
- `packages/pi-starline` 当前保留了 590 行上游 v0.13.0 已删除的代码（用户消息渲染器 + 干净复制），依赖 `reapplyOnSync` 第 17 条维持。
- pi-tidy 是单体渲染器：patch `ToolExecutionComponent`、各消息组件与 `InteractiveMode.addChild`，不提供任何协作或所有权机制。
- 现有四个插件各自使用不同的补丁注册方式：`pi-starline` 用 `Symbol.for("pi-starline.prototype-patch-registry")` 带 predecessor 链；`pi-tool-display` 用 `__piUserMessagePatchOwner` 单所有者标记；`pi-group-collapse` 用自己的 `patch-registry.ts` 带 predecessor 链。
- `pnpm-workspace.yaml` 的 catalog 固定 Pi 为 `1.1.0`，而 pi-tidy 的 bash/write 渲染器依赖 `pi.registerToolRenderer`（1.3.0）。仓库已有 per-package `overrides` 先例（`pi-sentinel`、`pi-openspec-x` 提升到 1.5.0）。

## Goals / Non-Goals

### Goals

- 以第 11 个 subtree 导入 pi-tidy，fork 身份 `@xzzpig/pi-tidy`，二开面压到「1 个 fork-only 目录 + 入口 2 行接缝」。
- pi-tidy 只保留错误行去重、hex 色块、最终回复框、代码块分节，并接管用户消息与干净复制。
- 消除用户消息的三方争抢，同时把 pi-starline 的 fork 代码量减少约 590 行。

### Non-Goals

- 不替换 `pi-tool-display`、`pi-group-collapse`、`pi-thinking-collapse` 的既有职责。
- 不接管 pill 与状态栏。
- 不启用 pi-tidy 的工具框、整轮折叠、工具分组、并排 diff、bash 高亮、背景任务行。
- 不补回「一键复制路径」chip：它长在工具框顶边上，`frameTools: false` 会一并失去；pi-tool-display 的调用行已显示路径，拖选即可复制。
- 不在本次向上游 pi-tidy 提交 PR。

## Decisions

### D1：用 git subtree 导入，而不是 npm 依赖

必须修改上游源码（工具框没有开关），npm 依赖无法承载这一点。仓库已有 10 个 subtree 的工作流、元数据 schema 与分歧审计，复用成本最低。

**替代方案**：npm 依赖 + 运行时 monkey-patch（脆弱且不可审计）；fork 成独立仓库（多一个仓库要维护）。

### D2：fork 默认值在入口覆盖，不改上游 `DEFAULTS`

上游 `loadConfig()` 的默认值常量保持原样，fork 在入口处调用 fork-only 的覆盖函数。这样上游 `config` 相关测试继续通过，同步时的冲突面也最小。

**替代方案**：直接改上游 `DEFAULTS`——会与上游测试断言冲突，且每次同步都要重新改一遍。

### D3：`frameTools` 是新增配置键，由 fork-only 模块承载

上游 `ToolFrameOptions` 的完整字段中没有关闭工具框的开关，`proto.render` 只以 `tidyEnabled`（即 `config.enabled`）为出口。因此这是唯一必须改上游源码的点：在入口处按 `frameTools` 决定是否调用 `patchToolBoxFrames`。

**替代方案**：整体剔除上游工具框代码——不可行，`patchToolBoxFrames` 同时安装分组边界与悬停跟踪，剔除会连带破坏其他能力。

### D4：工具框关闭时单独调用 `installHoverTracking()`

上游把 `installHoverTracking()` 写在 `patchToolBoxFrames` 内部。跳过该函数会让代码块复制控件失去悬停高亮与手型光标。fork 在关闭工具框的分支里显式补一次调用。

**风险**：若上游改变该函数的导出或调用位置，同步时需同步调整。

### D5：用户消息与干净复制交给 pi-tidy，而不是保留在 pi-starline

pi-tidy 是上游指定的归属者，能力是超集（`userMessageAlign`、`userMessageMaxWidth`、`userMessageTime`、三种样式），且删除后 fork 与上游的差异收敛，`reapplyOnSync` 由 32 条降为 31 条。

**代价**：`colorSources.userMessages` 的「主题色 / 终端调色板」语义消失，pi-tidy 只接受主题色名与 `#rrggbb`。

**已定**：fork 默认用户消息样式取 `frame`（圆角框贴合文字宽度，带用户图标与时间）；`cleanCopy` 默认关闭，用户可用 `tidy.cleanCopy: true` 显式开启。这样用户消息所有权立即移交，但复制去框线行为不会在未确认时改变。

**替代方案**：保留 pi-starline 实现——继续冻结、继续三方争抢同一 prototype。

### D6：不在代码中修改 `pi-tool-display` 的默认值

用户消息面由 `pi-tidy` 独占，但 `pi-tool-display` 的 `enableNativeUserMessageBox` 默认仍为 `true`。本变更 MUST NOT 修改该包的源码或默认值，以避免新增上游分歧；改为在 `pi-tidy` 的 fork 文档与 pi-starline 的迁移说明中写明前置配置 `"enableNativeUserMessageBox": false`，由用户自行设置。

**替代方案**：改默认值——会让 `pi-tool-display` 与上游产生新的字节差异，每次同步都要重新应用，且属于“为了本仓库的搭配去改另一个上游包的默认体验”，收益不抵成本。

### D7：分阶段执行，删除放在真机验证之后

导入与二开先落地并验证，确认 pi-tidy 的用户消息与干净复制在四个插件共存下正常后，才删除 pi-starline 的 590 行。

**理由**：保证可回滚。若验证不通过，把 `userMessageStyle` 改回 `off` 即可，代码仍在，无功能损失。

### D8：Pi 版本用 per-package `overrides` 提升到 1.5.0

`registerToolRenderer` 需要 Pi ≥ 1.3.0，共享 catalog 为 1.1.0。沿用 `pi-sentinel` / `pi-openspec-x` 的写法，只对 `@xzzpig/pi-tidy` 提升。

**替代方案**：提升共享 catalog——会影响全部 11 个包，风险与收益不成比例。

### D9：e2e 采用「自动化套件 + 证据包」双层，并分删除前后两轮

自动化套件（`packages/pi-tidy/test/e2e/*.e2e.ts` + `test:e2e`）负责回归防护：用假 `pi`/`ctx` harness 在同一进程按序加载多个扩展，断言 patch 归属、补丁链可组合、纯渲染能力、私有 API 降级与错误行去重。旧 Starline 配置键的迁移提示集成测试延迟到移除 Starline 后，以避免仍读取这些键的 Starline 污染迁移断言。证据包（`artifacts/pi-tidy/e2e/<date>/`）负责证明无法无头断言的部分：真实 TUI 中的用户消息外观、悬停高亮与手型光标、OSC 52 剪贴板。

两轮的边界：**删除前**那一轮不加载 `pi-starline`（它没有开关可以关掉自绘用户消息，混在一起无法判断 `pi-tidy` 的观感），并记录 `UserMessageComponent.prototype.render` 的 patch 链基线快照；**删除后**那一轮加载全部五个插件，把基线快照改为「链上只剩 `pi-tidy`」的期望值。

**理由**：两类断言的性质不同。补丁链与文本变换是纯函数级的，适合 CI；视觉与鼠标行为依赖真实终端，只能靠录像加回放分析。仓库对两种形态都有先例（`pi-goal-x/tests/e2e`、`artifacts/pi-group-collapse/e2e`），沿用即可，不新造规范。

**替代方案**：只做证据包——无法防回归；只做自动化——无法证明视觉与悬停；只做一轮且包含 `pi-starline`——无法判断 `pi-tidy` 自身的观感。

### D10：默认开启 `frameMessages`，以保留用户消息 `frame`

上游 `patchContainerBoxes` 用一个 `enabled` 开关同时控制用户消息 frame 与 compaction、branch、skill、custom message 的边框；`patchUserMessages` 只绘制 `rail`/`rules`，对 `frame` 会透传。为保留已经选定的 `userMessageStyle: "frame"`，fork 默认开启 `frameMessages`，并接受一般消息也默认带框。

**替代方案**：把用户消息默认改为 `rail`（改变已选定的视觉）；新增上游接缝来拆分用户/一般消息开关（超出最小二开边界，并增加后续同步冲突面）。

### D11：最终回复框外保留 Pi 的折叠思考行

Pi 1.5 的 `pi-thinking-collapse` 会在思考完成后把 AssistantMessageComponent 的思考 MouseRegion 折叠成可点击提示；上游 pi-tidy 为最终回复绘制边框时会省略这些思考行。fork 在 `fork/thinking-row.ts` 中、位于 pi-tidy 的 group-boundary renderer 之后重新绘制该 Pi 自有 MouseRegion，并把点击路由回原组件，使提示位于最终回复框外、仍可展开/折叠；上游 `src/` 除现有 `index.ts` 接缝外保持字节稳定。

**替代方案**：关闭 `finalReplyStyle` 会丢掉目标视觉；直接改上游 `presentTurn` 会扩大每次 subtree 同步的冲突面，因此都不采用。

## Risks / Trade-offs

- [上游调整 `installHoverTracking` 的导出或调用位置] → fork 按导出名导入，每次同步复核该函数仍可独立调用。
- [上游新增无开关的重叠能力] → 每次同步复核 `ToolFrameOptions` 字段列表与入口的 `patch*` 调用清单，发现新重叠项时补进 fork 默认值。
- [`finalReplyStyle` 会省略 `pi-thinking-collapse` 的折叠提示] → fork-only 适配器复用 Pi 原有 MouseRegion 和点击处理，在最终回复框外补回折叠行；真机 e2e 验证完成态、展开与重新折叠，Pi 私有组件结构变更时需复核该适配器。
- [丢失 `colorSources.userMessages`] → 由 `warnMovedUserMessageKeys` 一次性提示，并在 `FORK-CHANGELOG` 与 `README` 中说明替代键；`cleanCopy` 默认关闭，文档明确说明 `tidy.cleanCopy: true` 可恢复干净复制。
- [用户未关闭 `pi-tool-display` 的用户消息框时仍会与 `pi-tidy` 争抢] → 不通过改默认值解决；由文档给出前置配置，真机 e2e 显式设置该键后验证独占。
- [第 11 个 subtree 增加维护面] → 复用现有元数据 schema 与分歧审计；二开面只有 1 个目录 + 2 行接缝。
- [pi-tidy 上游测试与 fork 默认值不一致] → fork 只覆盖入口，不改上游 `DEFAULTS`，`loadConfig` 测试不受影响；行为测试若涉及入口需按 fork 默认值调整。
- [删除前无法用配置关掉 pi-starline 的自绘用户消息，两轮 e2e 的观测面不同] → 删除前那一轮不加载 pi-starline，并把 patch 链写成基线快照；删除后那一轮才断言链上只剩 pi-tidy。
- [e2e 需要同进程加载五个扩展，模块级单例状态可能相互污染] → harness 为每个测试提供隔离的 HOME 与 `settings.json`，并快照/恢复被 patch 的 prototype 方法。

## Migration Plan

1. `pi-upstream-subtree` 流程导入 pi-tidy，写 `subtrees/pi-tidy.json`，记录精确 commit。
2. 在 `pnpm-workspace.yaml` 为 `@xzzpig/pi-tidy` 增加 Pi 1.5 overrides。
3. 建 `fork/defaults.ts` 与 `fork/install.ts`，在入口打两行接缝。
4. 通过 `typecheck` 与上游测试。
5. 建自动化 e2e 套件并跑绿，包括 `UserMessageComponent` patch 链的**删除前基线快照**。
6. 录删除前证据包（不加载 `pi-starline`），断言 `pi-tidy` 自身观感可接受——这是删除的闸门。
7. **两轮验证通过后**删除 pi-starline 的 3 个文件与 4 处接缝，采纳 `warnMovedUserMessageKeys`。
8. 重跑自动化 e2e（基线快照改为期望值）并录删除后全量证据包（五个插件全部加载）。
9. 更新 `subtrees/pi-starline.json`（`reapplyOnSync` 32→31）、`versions.json`、`FORK-CHANGELOG.md`、`README.md`、`AGENTS.md`。
10. 跑全量门禁：`typecheck`、`test`、`test:e2e`、`audit:fork-divergence`、`prettier --check`。

### 回滚策略

- 第 6 步失败（`pi-tidy` 观感不可接受）：删除 `packages/pi-tidy` 与其元数据，pi-starline 未改动，零影响。
- 第 7 步之后发现问题：`git revert` 该删除提交即可恢复 pi-starline 的实现，pi-tidy 保留；必要时把 `userMessageStyle` 改回 `off`。

## Open Questions

- pi-tidy 的确切导入 ref：导入时由 `pi-upstream-subtree` 流程确定并写入元数据，不影响本次设计。
