# subagent-context-injection Specification

## Purpose

定义 `@xzzpig/pi-subagents` fork 的上下文注入能力：父会话可以把选定的子代理预先声明在系统提示的 `<available_subagents>` 块中，使主代理无需先调用 `{ action: "list" }` 就能按描述选择子代理，同时保证注入内容在会话内字节稳定（不破坏 provider 提示缓存）、只广告真正可执行的代理、且对 fork/resume 重放幂等。

## ADDED Requirements

### Requirement: 注入来源与并集规则

系统 SHALL 支持两个注入来源并取其并集：

1. agent frontmatter 中的 `injectToContext: true`。
2. Pi 设置 `subagents.injectAgents` 列出的 agent 名称，名称 SHALL 同时按规范名与别名解析，内建 agent SHALL 允许被列出。

并集内按 agent 名称稳定排序，同名只出现一次。

#### Scenario: 仅由 frontmatter 声明

- **WHEN** 某个 agent 文件的 frontmatter 含 `injectToContext: true`，且设置中没有 `injectAgents`
- **THEN** 该 agent 出现在注入块中

#### Scenario: 仅由设置声明

- **WHEN** 设置为 `"subagents": { "injectAgents": ["worker"] }`，且 `worker` 的 frontmatter 未声明 `injectToContext`
- **THEN** `worker` 出现在注入块中

#### Scenario: 两个来源指向同一 agent

- **WHEN** 同一个 agent 既被 `injectAgents` 列出又声明了 `injectToContext: true`
- **THEN** 该 agent 在注入块中只出现一次

#### Scenario: 通过别名列出

- **WHEN** `injectAgents` 列出的名称是该 agent 的别名而非规范名
- **THEN** 该 agent 被正确解析并出现在注入块中

### Requirement: 注入块的渲染格式

系统 SHALL 把注入内容渲染为以 `<available_subagents>` 与 `</available_subagents>` 包裹的紧凑块：固定两行说明文字、一个空行，随后每个 agent 一行 `- <name>: <description>`。

agent 描述 SHALL 折叠为单行，多行 frontmatter 描述不得破坏该格式。没有任何 agent 被选中时，系统 SHALL 不追加任何内容。

#### Scenario: 块形状

- **WHEN** 选中的 agent 为 `security-reviewer` 与 `worker`
- **THEN** 块以 `<available_subagents>` 开头、以 `</available_subagents>` 结尾，且每个 agent 一行 `- <name>: <description>`

#### Scenario: 多行描述被折叠

- **WHEN** 某 agent 的 frontmatter 描述跨多行
- **THEN** 注入块中该 agent 仍只占一行

#### Scenario: 无候选时不注入

- **WHEN** 两个来源都没有选中任何 agent
- **THEN** 系统不修改系统提示（块为空字符串）

### Requirement: 会话快照与字节稳定

注入清单 SHALL 在会话开始（以及 reload）时解析一次，并在该会话的每个回合产生字节一致的块，以保证 provider 提示缓存不会在会话中途失效。

会话进行中修改 agent 文件或设置 SHALL 不影响当前会话，SHALL 在新会话生效；`{ action: "list" }` SHALL 保持为运行时权威来源。

#### Scenario: 同一会话内块保持字节一致

- **WHEN** 同一会话连续多个回合都触发注入
- **THEN** 追加的块逐字节相同

#### Scenario: 会话中修改不生效

- **WHEN** 会话开始后编辑某 agent 文件的描述或新增 `injectToContext: true`
- **THEN** 当前会话的注入块不变

#### Scenario: 新会话生效

- **WHEN** 上述修改之后开启新会话
- **THEN** 新会话的注入块反映修改

### Requirement: 只广告可执行 agent

系统 SHALL 不注入 `disabled: true` 的 agent，也 SHALL 不注入受当前会话 capability ceiling 限制的 agent。

#### Scenario: 禁用的 agent 不出现

- **WHEN** 某 agent 标记 `disabled: true` 且被 `injectAgents` 列出
- **THEN** 该 agent 不出现在注入块中

#### Scenario: 受能力上限限制的 agent 不出现

- **WHEN** 某 agent 不在当前会话的 capability ceiling 允许范围内
- **THEN** 该 agent 不出现在注入块中

### Requirement: 追加的幂等性

系统 SHALL 只在系统提示中不含 `<available_subagents>` 标记时追加注入块，因此 forked 或 resume 的会话在重放历史时不得重复注入。

#### Scenario: 已包含标记时不追加

- **WHEN** 传入的系统提示已经包含 `<available_subagents>` 标记
- **THEN** 系统返回"无需修改"，不追加第二个块

#### Scenario: fork 的会话不重复注入

- **WHEN** 会话由 fork 或 resume 产生、其历史系统提示已带注入块
- **THEN** 注入块仍然只有一个

### Requirement: 未知设置名不阻断启动

`subagents.injectAgents` 中无法解析的名称 SHALL 被忽略（不影响其余名称生效、不导致启动失败），并 SHALL 由 `/subagents-doctor` 报告。

#### Scenario: 未知名称被忽略并上报

- **WHEN** 设置为 `"injectAgents": ["worker", "does-not-exist"]`
- **THEN** `worker` 正常注入，`does-not-exist` 被忽略，且 `/subagents-doctor` 输出中包含该未解析名称

### Requirement: 子会话不继承注入

被启动的子会话 SHALL 不加载父会话的注入块；子会话仍可通过 `{ action: "list" }` 获取代理清单。

#### Scenario: 子会话的系统提示不含注入块

- **WHEN** 主代理启动一个子代理会话
- **THEN** 该子会话的系统提示中不包含 `<available_subagents>` 块
