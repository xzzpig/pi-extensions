## Why

`pi-subagents` fork 新增的上下文注入能力——agent frontmatter 的 `injectToContext: true`、Pi 设置的 `subagents.injectAgents`、以及父系统提示中的 `<available_subagents>` 块——已经在代码（`src/extension/context-injection.ts`）和 fork-only 文档（`docs/fork-extensions.md` 的 Context injection 一节）中完整实现与描述，但 openspec 里没有对应的 spec：这段行为契约目前在 `subtrees/pi-subagents.json` 的 `notes` 里只有一行提及。

同步 `git subtree pull` 时，判断"注入的哪些保证必须保留"（字节稳定、只广告可执行 agent、幂等、子会话不继承）需要逐条对照文档与代码。把它固化为 spec，可以让同步取舍有清单可依，也让 notes 只保留维护契约。

## What Changes

- 新增 capability `subagent-context-injection`，把**既有实现**的行为契约写为规范：注入来源与并集规则、块渲染格式、会话快照与字节稳定性、只广告可执行 agent、幂等追加、未知设置名的处理、子会话不继承。
- **不改变任何运行行为**：本 change 只补规范。
- 该能力在 `subtrees/pi-subagents.json` `notes` 中的叙述改由本 spec 承载，notes 只保留上游接缝、每次同步需重做的手工步骤与"不要再引入"的决定。

## Capabilities

### New Capabilities

- `subagent-context-injection`: 定义父会话系统提示中被预先声明的子代理清单（来源、并集、渲染、会话快照、可执行性过滤、幂等与隔离）及其对提示缓存的影响。

### Modified Capabilities

无。本 change 不改动任何既有 capability 的要求。

## Impact

- 归档后新增 `openspec/specs/subagent-context-injection/spec.md`。
- 相关实现（只读引用，不修改）：`packages/pi-subagents/src/extension/context-injection.ts`（`resolveInjectableAgents` / `applyInjectionBlock` / `renderInjectionBlock`）、`src/extension/index.ts`（会话启动时解析并注入）、`src/extension/doctor.ts`（上报未解析名称）。
- 对外文档：`packages/pi-subagents/docs/fork-extensions.md`（Context injection）、`docs/agents.md`（`injectToContext` 字段）、`README.md` 已经是该行为的权威描述，spec 与它们必须一致。
- 无 API、依赖或运行行为变化。
