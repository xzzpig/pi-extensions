# Proposal: fleet-native-transcript

## Why

pi-subagents 的 fleet inspector 中"结构化会话 transcript"采用手写 rail 线渲染（`◆ Assistant` / `◇ Supervisor` / `├─ ✓ tool`），工具只显示名称与参数预览，无法呈现 edit diff、read 文件预览等富内容，直观性不足。仓库内的 `@xzzpig/pi-components` transcript 组件已封装 Pi 原生 `UserMessageComponent` / `AssistantMessageComponent` / `ToolExecutionComponent` 渲染链路，且同仓库的 pi-btw 已验证了相同的集成模式，具备落地条件。

## What Changes

- **pi-subagents fleet inspector 接入原生渲染**：详情面板的结构化会话视图改由 `@xzzpig/pi-components/transcript` 的 `renderTranscriptLines` 渲染——用户/助手消息走 Pi 原生组件（含 thinking、Markdown、代码高亮），工具调用走原生 `ToolExecutionComponent`（diff、文件预览等）。保留现有 trusted-root 校验、fingerprint 缓存、`x` 全局展开切换、Prompt Audit 等交互不变。
- **pi-components 组件针对性改造**：为简化 pi-subagents 的接入逻辑，对 `packages/pi-components/src/transcript.ts` 做向后兼容的能力增强：
  - 将现有私有的 entries 状态操作逻辑（turn 管理、tool-call/result 配对 upsert 等）提升为公开 API，支持"从历史/已完成记录构造 entries"的非实时摄入场景；
  - 增加 host 兼容性守卫所需的降级探测辅助（可选）。
- **抽离 pi-subagents 与 pi-btw 的共同逻辑到 pi-components**：pi-btw 目前手写了约 200 行与 pi-components 内部几乎重复的状态机代码（appendTranscriptEntry / ensureTranscriptTurn / finishTranscriptTurn / removeTranscriptTurn / findLatestTranscriptEntry / upsert 系列），统一迁移为使用 pi-components 公开导出，消除双份维护。
- **pi-btw 保持兼容**：重构后 pi-btw 的对外行为（渲染效果、交互）不变，仅内部实现改为共享 API。
- **快捷键切换渲染界面**：fleet inspector 内新增可配置快捷键（默认 `v`），在本能力引入的原生渲染界面与原有文本渲染界面之间即时切换，作为用户可控的运行时回退入口。
- **依赖与仓库治理**：pi-subagents 新增 `dependencies: @xzzpig/pi-components`；因 pi-subagents 为 upstream subtree，需在 `subtrees/pi-subagents.json` notes 中记录本地分歧。

## Capabilities

### New Capabilities

- `transcript-builder-api`: `@xzzpig/pi-components` transcript 模块的公开 entries 构造/状态操作 API——支持非实时（历史记录回放）场景下的 user/thinking/assistant/tool-call/tool-result/notice 条目写入、turn 边界管理、toolCallId 配对与截断参数降级，作为 pi-subagents 与 pi-btw 的共享基础。
- `fleet-native-transcript`: pi-subagents fleet inspector 结构化会话视图的原生渲染行为——JSONL 子代理 transcript 经适配层转换为 TranscriptEntry 后由 Pi 原生组件渲染，含全局展开切换、缓存失效、旧版宿主降级回退等可观察行为。

### Modified Capabilities

（无——`openspec/specs/` 当前为空，本变更全部为新能力。）

## Impact

- **代码**：
  - `packages/pi-components/src/transcript.ts`（新增公开导出，行为向后兼容）+ `tests/transcript.test.ts`（新增用例）
  - `packages/pi-btw/extensions/btw.ts`（删除重复状态机代码，改用共享 API；注意其为 upstream subtree，改动应最小化并记录分歧）
  - `packages/pi-subagents/src/tui/fleet-native-transcript.ts`（新文件：JSONL→entries 适配层 + 渲染包装）、`src/tui/fleet.ts`（最小侵入接入 + 降级分支）、`src/tui/fleet-transcript.ts`（保留作为降级路径）、`package.json`
  - `subtrees/pi-subagents.json`（notes 记录本地分歧）
- **依赖**：pi-subagents 运行时新增 `@xzzpig/pi-components`（其 peer 要求 `@earendil-works/* >=0.83 <1`）；pi-btw 已有该依赖，无变化。
- **风险面**：fleet inspector 键位组合（x/p/H/s/D 与新组件状态）、32KB 截断 argsPayload 的降级路径、窄面板下原生 diff/bash 渲染的视觉验收；其余 fleet 视图（常驻状态条、文本版 status、Herdr 窗格）不受影响。
