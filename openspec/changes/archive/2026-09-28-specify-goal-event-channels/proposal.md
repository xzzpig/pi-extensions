## Why

`pi-goal-x` fork 把目标状态写入会话分支的方式是 fork 分歧：上游没有 `pi-goal-context-event`、`pi-goal-state-event`、`pi-goal-steering-event` 这三条持久化通道（已核对上游 `upstreamCommit` 树：三个常量在上游均为 0 处命中）。这些通道的契约——何时发送、`reason` 取值、追加不重写、不触发回合、失败不中断——目前只存在于代码注释与 `subtrees/pi-goal-x.json` 的 `notes` 里。

同一包内的相关行为已经有 spec 覆盖：`ui_prompt_start/end` 的 Escape 防护在 fork 新增的包内 spec `packages/pi-goal-x/specs/2026-09-12-escape-foreign-ui-prompt-guard/`，prompt-cache 前缀处理在上游 spec `specs/2026-09-16-prompt-cache-prefix`。因此本 change 只补齐**尚未被任何 spec 覆盖**的持久化事件通道部分。

## What Changes

- 新增 capability `goal-persisted-event-channels`，把**既有实现**的三条持久化通道契约写为规范：完整目标上下文通道（发送时机与 `reason`）、每回合状态快照通道（分发路径与 `checkpointSeq` 配对）、一次性引导通道（边缘触发与复位），以及它们的共同保证（`display: false`、追加不重写、不触发回合、写入失败不中断会话）。
- **不改变任何运行行为**：本 change 只补规范。
- 该能力在 `subtrees/pi-goal-x.json` `notes` 中的叙述改由本 spec 承载，notes 只保留上游接缝、每次同步需重做的手工步骤与"不要再引入"的决定。

## Capabilities

### New Capabilities

- `goal-persisted-event-channels`: 定义 pi-goal-x 写入会话分支的三条持久化消息通道（完整目标上下文、每回合状态快照、一次性引导）的触发时机、内容、元数据与共同保证。

### Modified Capabilities

无。本 change 不改动任何既有 capability 的要求。

## Impact

- 归档后新增 `openspec/specs/goal-persisted-event-channels/spec.md`。
- 相关实现（只读引用，不修改）：`packages/pi-goal-x/extensions/goal-format.ts`（通道常量）、`goal-record.ts`（消息 details 类型）、`goal-state.ts`（`sendGoalContextMessage`、`buildTurnSnapshot`、引导消息）、`goal-events.ts`（`session_compact` 重发、状态快照分发）、`goal-drafting.ts`（调整后重发）。
- 包内既有 spec：`packages/pi-goal-x/specs/2026-09-12-escape-foreign-ui-prompt-guard/`（Escape 防护）与本 change 描述的通道机制相邻但职责不同，spec 之间不得相互矛盾。
- 无 API、依赖或运行行为变化。
