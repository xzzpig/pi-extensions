# goal-persisted-event-channels Specification

## Purpose

定义 `@xzzpig/pi-goal-x` fork 写入会话分支的三条持久化消息通道：完整目标上下文（`pi-goal-context-event`）、每回合状态快照（`pi-goal-state-event`）、一次性引导说明（`pi-goal-steering-event`）。三条通道都只追加、不重写、不参与常规 UI 展示、不触发新的 agent 回合，使请求上下文保持可缓存、可重放。

## ADDED Requirements

### Requirement: 完整目标上下文通道

系统 SHALL 在以下时机向会话分支追加一条 `pi-goal-context-event` 消息，内容为完整的目标上下文（目标、验证契约、生命周期策略与任务树），并以 `display: false` 写入：

- 目标创建时，`reason` 为 `"created"`；
- 会话压缩之后，`reason` 为 `"compacted"`（压缩摘要会吃掉此前的副本）；
- 会话载入且该分支在最后一次压缩之后没有副本时，`reason` 为 `"rehydrated"`；
- 目标被调整之后，`reason` 为 `"tweaked"`。

消息 details SHALL 为 `{ version: 1, kind: "context", goalId, revision, reason, timestamp }`。

该消息 SHALL 以追加方式持久化且永不重写，SHALL NOT 触发新的 agent 回合；写入失败 SHALL 只记录错误，不得中断会话。没有聚焦目标或目标已完成时 SHALL 不发送。

#### Scenario: 目标创建时发送完整上下文

- **WHEN** 用户创建一个目标
- **THEN** 会话分支追加一条 `pi-goal-context-event` 消息，`reason` 为 `"created"`，内容含目标、验证契约、生命周期策略与任务树

#### Scenario: 压缩后重发完整副本

- **WHEN** 会话发生压缩
- **THEN** 追加一条 `reason` 为 `"compacted"` 的完整上下文消息（完整副本而非增量）

#### Scenario: 分支缺少副本时在载入时重发

- **WHEN** 会话载入，且分支在最后一次压缩之后没有目标上下文副本
- **THEN** 追加一条 `reason` 为 `"rehydrated"` 的完整上下文消息

#### Scenario: 目标调整后重发

- **WHEN** 用户在目标草稿阶段调整了目标
- **THEN** 追加一条 `reason` 为 `"tweaked"` 的完整上下文消息

#### Scenario: 已完成目标不再发送

- **WHEN** 没有聚焦目标，或聚焦目标的状态为 `complete`
- **THEN** 不追加任何完整上下文消息

#### Scenario: 写入失败不中断会话

- **WHEN** 追加消息时抛出异常
- **THEN** 错误被记录，会话继续运行

### Requirement: 每回合状态快照通道

系统 SHALL 每个回合至多追加一条 `pi-goal-state-event` 状态快照，且 SHALL 按以下路径分发：

- 自动续跑路径：在每个 v2 checkpoint 标记之前发送，并把 `checkpointSeq` 与该标记配对；
- 用户驱动的回合：作为 `before_agent_start` 的消息返回值发送。

快照 SHALL 以 `display: false` 写入，details 为 `{ version: 3, kind: "state", goalId, revision, checkpointSeq?, timestamp }`；`checkpointSeq` 仅在续跑路径上有意义。

快照 SHALL 在写入后永不被重写，以保证请求上下文只追加、对提示缓存友好。没有聚焦目标或目标已完成时 SHALL 不产生快照。

#### Scenario: 用户回合产生一条快照

- **WHEN** 存在聚焦目标且用户提交一个回合
- **THEN** 该回合通过 `before_agent_start` 的消息返回值携带一条状态快照

#### Scenario: 续跑路径在标记前产生快照

- **WHEN** 自动续跑触发一个 v2 checkpoint
- **THEN** 在该 checkpoint 标记之前追加一条状态快照，其 `checkpointSeq` 与该标记配对

#### Scenario: 同一回合不重复

- **WHEN** 一个回合已经产生状态快照
- **THEN** 该回合不再追加第二条快照

#### Scenario: 已完成目标无快照

- **WHEN** 目标状态为 `complete` 或没有聚焦目标
- **THEN** 不产生状态快照

### Requirement: 一次性引导通道

系统 SHALL 用 `pi-goal-steering-event` 承载不属于每回合状态的一次性引导说明（例如存在未聚焦目标时的提示），以 `display: false` 写入，details 为 `{ reason, timestamp }`。

同一情形 SHALL 只发送一次（边缘触发）；该情形解除（例如目标重新聚焦）后 SHALL 允许再次发送。写入失败 SHALL 不影响会话载入或聚焦切换。

#### Scenario: 首次出现未聚焦目标时发送一次

- **WHEN** 存在打开的目标但没有聚焦目标，且此前未就此发送过引导
- **THEN** 追加一条 `reason` 为 `"unfocused"` 的引导消息

#### Scenario: 同一情形不重复发送

- **WHEN** 上述情形持续存在（仍未聚焦）
- **THEN** 不重复追加引导消息

#### Scenario: 情形解除后可再次发送

- **WHEN** 目标重新被聚焦，之后再次出现未聚焦但有打开目标的情形
- **THEN** 允许再次追加一条引导消息

#### Scenario: 写入失败不影响会话

- **WHEN** 追加引导消息时抛出异常
- **THEN** 会话载入与聚焦切换正常完成

### Requirement: 通道消息的共同保证

三条通道的消息 SHALL 均以 `display: false` 写入，因此不参与常规 UI 展示；它们 SHALL 只以追加方式写入会话分支，SHALL NOT 触发新的 agent 回合。

完整上下文通道 SHALL 是目标权威状态的持久化副本：恢复或压缩后的继续执行 SHALL 以该完整副本为来源，而不是依赖增量。

#### Scenario: 消息不参与常规展示

- **WHEN** 上述任一通道写入消息
- **THEN** 该消息不出现在常规 UI 输出中

#### Scenario: 不触发额外回合

- **WHEN** 完整上下文或引导通道写入消息
- **THEN** 不因该写入而启动新的 agent 回合

#### Scenario: 压缩后以完整副本为准

- **WHEN** 会话在压缩后继续执行
- **THEN** 目标上下文来自重发的完整副本（含目标、验证契约、生命周期策略与任务树）
