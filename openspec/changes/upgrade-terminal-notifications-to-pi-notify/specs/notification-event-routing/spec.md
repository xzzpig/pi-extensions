## ADDED Requirements

### Requirement: 封闭的低频语义事件目录

系统 SHALL 只支持 `agent-completed`、`agent-error`、`input-required`、`permission-required`、`context-compacted`、`task-completed` 和 `integration-error` 七个语义事件。事件 ID 常量 SHALL 同时驱动 TypeScript 类型、配置枚举、运行时校验和公共 API。

#### Scenario: 支持的来源事件

- **WHEN** Pi 或已知插件发出可映射的低频事件
- **THEN** 系统生成至多一个对应语义事件并交给路由器

#### Scenario: 未知事件 ID

- **WHEN** 配置或外部 publish payload 引用目录外事件
- **THEN** 系统不生成或路由该事件

#### Scenario: 高频或内部 Pi 事件

- **WHEN** Pi 发出 message/tool update、context、provider payload 或其它未列入目录的 hook
- **THEN** 系统不为该原始事件创建通知事件

### Requirement: 默认关注事件

渠道省略 events 时系统 SHALL 默认订阅 `agent-completed`、`agent-error`、`input-required`、`permission-required`、`task-completed` 和 `integration-error`。`context-compacted` SHALL 仅在渠道显式列出时路由。

#### Scenario: 使用默认订阅

- **WHEN** 已启用渠道省略 events
- **THEN** 正常完成、最终错误、等待输入、等待权限、插件任务完成和插件集成错误均可路由，context compacted 不路由

#### Scenario: 显式订阅压缩事件

- **WHEN** 渠道 events 包含 `context-compacted`
- **THEN** Pi session compact 完成时该渠道可收到通知

### Requirement: 逐渠道路由与通知总开关

路由器 SHALL 将一个语义事件独立发送到每个启用、可用且显式/默认订阅该事件的渠道。顶层 `enabled:false` SHALL 停止通知路由，但 MUST NOT 停止 Herdr 状态跟踪。

#### Scenario: 不同渠道选择不同事件

- **WHEN** OSC 只订阅 agent-completed 而 ntfy 只订阅 permission-required
- **THEN** 两类事件只投递到各自匹配渠道

#### Scenario: 通知总开关关闭

- **WHEN** 顶层 enabled 为 false 且 herdr.enabled 为 true
- **THEN** 不向任何通知渠道投递，但问答/权限仍正确发布 herdr:blocked

### Requirement: Agent 最终结果边界

系统 SHALL 从首次 `agent_start` 到对应 `agent_settled` 跟踪一次可见运行。中间 `agent_end`、自动重试、自动压缩和 continuation MUST NOT 产生最终事件。settled 时最终 stop reason 为 `error` 或 `length` SHALL 产生 `agent-error`；正常 stop 或未知结果 SHALL 产生 `agent-completed`；`aborted` SHALL 静默清理。

#### Scenario: 自动重试后成功

- **WHEN** 初始低层运行失败后 Pi 自动重试并最终正常 settled
- **THEN** 系统只产生一个 agent-completed，不产生中间 agent-error

#### Scenario: 最终 error 或 length

- **WHEN** 最后一次低层运行以 error 或 length 结束且随后 settled
- **THEN** 系统只产生一个 agent-error

#### Scenario: 用户主动中止

- **WHEN** 最后一次低层运行以 aborted 结束且随后 settled
- **THEN** 系统清理 active 状态且不产生任何通知事件

#### Scenario: 未知最终结果

- **WHEN** 已观察 active run，但 settled 时没有可识别 stop reason
- **THEN** 系统产生 agent-completed

#### Scenario: 无活动运行

- **WHEN** 扩展未观察到 agent_start 就收到 agent_settled
- **THEN** 系统不产生 agent-completed 或 agent-error

### Requirement: 工具与 provider 中间失败不通知

系统 MUST NOT 把单个 tool failure、provider HTTP 429/5xx 或自动重试转换为语义事件。只有最终 agent settled 结果能产生 agent-error。

#### Scenario: 工具失败后恢复

- **WHEN** 一个工具返回 isError 但代理随后正常完成
- **THEN** 系统不产生 tool-failed 或 integration-error，只产生 agent-completed

#### Scenario: Provider 重试成功

- **WHEN** provider 中间响应失败但 Pi 自动重试成功
- **THEN** 系统不产生错误通知

### Requirement: 输入等待适配器

系统 SHALL 将 `pi-ask` 开始事件转换为 `input-required`，并 SHALL 以 flowId 防止同一活动 flow 重复通知。ask 完成 SHALL 只清理活动状态，不产生 resolved 事件。通知文案 MUST NOT 包含原始问题、title 或用户输入。

#### Scenario: 问答开始

- **WHEN** 收到具有新 flowId 的 pi-ask started
- **THEN** 系统产生一个 input-required 并登记活动 flow

#### Scenario: 重复 started

- **WHEN** 相同活动 flowId 重复发送 started
- **THEN** 系统不重复产生 input-required

#### Scenario: 问答完成

- **WHEN** 收到活动 flowId 的 completed
- **THEN** 系统只清理 flow 和 Herdr 状态，不产生通知

### Requirement: 权限等待适配器

系统 SHALL 将 permission-system `permissions:ui_prompt` 转换为 `permission-required`，并 SHALL 以 requestId 防止同一活动请求重复通知。直接 decision 与 forwarded decision SHALL 沿用现有匹配规则清理状态。通知 MUST 使用通用文案，不包含 surface、value、message、命令、路径或 agent 名。

#### Scenario: 直接权限请求

- **WHEN** 收到新 requestId 的直接 UI prompt
- **THEN** 系统产生一个 permission-required 并跟踪到对应 decision

#### Scenario: 转发权限请求

- **WHEN** 父会话收到带 forwarding 的 prompt 并随后收到同 requestId 的 forwarded decision
- **THEN** 系统只产生一个 permission-required 并正确清理父会话状态

### Requirement: Herdr 独立状态机

系统 SHALL 保持公开 `herdr:blocked` event 名和 payload 不变。`herdr.enabled` SHALL 独立于通知 enabled 且默认 true；首个活动 input/permission 项产生 blocked，只有所有活动项完成或 session shutdown 才解除。

#### Scenario: 多个等待项并存

- **WHEN** input 与 permission 同时活动且其中一个先完成
- **THEN** Herdr 保持 blocked 直到最后一项完成

#### Scenario: Herdr 被显式关闭

- **WHEN** herdr.enabled 为 false
- **THEN** 系统不发布 herdr:blocked，但通知路由仍按顶层 enabled 工作

#### Scenario: Session shutdown

- **WHEN** session shutdown 时仍有活动等待项
- **THEN** 系统清空跟踪状态并在 Herdr 启用时发布解除 blocked

### Requirement: Context compacted 事件

系统 SHALL 将 `session_compact` 转换为 `context-compacted`，且 MUST NOT 把 compaction summary 或原始上下文放入事件 label 或通知正文。

#### Scenario: 压缩完成且渠道订阅

- **WHEN** Pi 发出 session_compact 且渠道显式订阅 context-compacted
- **THEN** 渠道收到固定安全文案通知

### Requirement: pi-subagents 适配器

系统 SHALL 监听 pi-subagents 公开 async/foreground completion 事件。成功 SHALL 映射为 `task-completed`，failed/timeout SHALL 映射为 `integration-error`，cancelled/stopped SHALL 静默。适配器 MAY 提供净化后的安全 label，但 MUST NOT 复制输出、任务 prompt、session path 或错误正文。

#### Scenario: 子代理成功

- **WHEN** async 或 foreground 子代理以成功终态完成
- **THEN** 系统产生 task-completed

#### Scenario: 子代理失败或超时

- **WHEN** 子代理终态为 failed 或 timeout
- **THEN** 系统产生 integration-error

#### Scenario: 子代理取消或停止

- **WHEN** 子代理终态为 cancelled 或 stopped
- **THEN** 系统不产生通知事件

### Requirement: 外部插件 publish 协议

系统 SHALL 监听 `pi-notify:publish`。payload SHALL 只接受已知 `eventId`、非空 `source` 和可选安全 `label`，MUST 丢弃其它字段，且 SHALL NOT 去重外部事件。label MAY 用于所有事件的固定正文。

#### Scenario: 有效外部发布

- **WHEN** 插件发布已知 eventId、source 和可选 label
- **THEN** 系统净化 payload、生成语义事件并应用正常渠道路由

#### Scenario: 重复外部发布

- **WHEN** 插件连续发布两个相同 payload
- **THEN** 系统分别路由两次，重复控制由发布插件负责

#### Scenario: 非法原始 emit

- **WHEN** 插件绕过 helper 手工 emit 非法 payload
- **THEN** 接收端忽略该 payload、显示去重后的本地 warning 且不向发布插件传播异常

### Requirement: 公共 API

包 SHALL 从 `@xzzpig/pi-notify/api` 导出 publish channel 常量、事件 ID 常量、事件/payload 类型、类型守卫、断言函数和 `publishNotification`。发布 helper SHALL 使用单对象参数与最小 `{emit(channel,data)}` event bus，并 SHALL 在 payload 非法时抛 `TypeError`。

#### Scenario: Helper 成功发布

- **WHEN** 消费者调用 `publishNotification({events,eventId,source,label})` 且 payload 有效
- **THEN** helper 向 `PI_NOTIFY_PUBLISH_EVENT` emit 规范 payload

#### Scenario: Helper 拒绝未知事件

- **WHEN** 消费者调用 helper 时提供未知 eventId 或空 source
- **THEN** helper 抛 TypeError 且不 emit

### Requirement: 固定安全文案

系统 SHALL 使用以下固定英文标题：

- agent-completed -> `Pi finished the task`
- agent-error -> `Pi encountered an error`
- input-required -> `Pi needs your input`
- permission-required -> `Pi needs permission`
- context-compacted -> `Pi compacted the context`
- task-completed -> `Pi completed a task`
- integration-error -> `Pi encountered an integration error`

正文 SHALL 按 Label、Project、Session 顺序，只使用净化 label、cwd basename 和 session display name；缺失项 SHALL 省略。

#### Scenario: 具有全部安全上下文

- **WHEN** 事件具有 label、项目目录名和 session display name
- **THEN** ntfy 正文按三行 Label/Project/Session 输出，OSC 按同顺序单行输出

#### Scenario: 原始事件包含敏感数据

- **WHEN** 来源 payload 包含完整路径、prompt、permission value、模型或错误正文
- **THEN** 这些字段不得进入内部通知或任何渠道文案
