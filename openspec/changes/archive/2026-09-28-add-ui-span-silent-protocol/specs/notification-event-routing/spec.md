## ADDED Requirements

### Requirement: 静默标记协议

系统 SHALL 监听 `pi-notify:ui_span_silent` 事件。payload SHALL 为仅含可选 `reason`（非空白字符串）的对象；非对象、reason 空白或类型不符的原始 emit SHALL 被忽略且不产生异常。打开非 agent 等待对话框的插件 SHALL 在调用阻塞式 `ctx.ui.*` 前同步发出该事件（发出与对话框打开之间 MUST NOT 存在 await），发出 SHALL 使用 observational try/catch，且插件 MUST NOT 依赖 pi-notify 包来发送（未安装 pi-notify 时该 emit 为无害 no-op）。事件名常量 SHALL 从 `@xzzpig/pi-notify/api` 导出供类型化引用。挂起标记 SHALL 被下一个 `ui_prompt_start` 打开的 span 一次性消费；session start/shutdown 重置时未消费标记 SHALL 被清除。

#### Scenario: 有效标记消费

- **WHEN** 插件在打开监控面板前同步发出静默标记且对话框随后打开
- **THEN** 该 span 静默注册：不产生通知、不登记 Herdr 等待项

#### Scenario: 非法 payload 忽略

- **WHEN** 插件绕过契约手工 emit 非对象或 reason 空白的标记
- **THEN** 接收端忽略该 payload 且不向发出方传播异常

#### Scenario: 未安装 pi-notify

- **WHEN** 宿主未安装 pi-notify 时插件照常发出标记
- **THEN** 事件无人消费，插件自身行为不受影响

#### Scenario: 未消费标记清理

- **WHEN** 会话内发出标记但从未有 span 打开，随后 session 重置
- **THEN** 标记被清除，后续打开的对话框不被静默

## MODIFIED Requirements

### Requirement: 通用 UI 等待适配器

系统 SHALL 监听 Pi core 的 `ui_prompt_start`/`ui_prompt_end` 生命周期事件，并 SHALL 仅在 agent run 活跃（首次 `agent_start` 到对应 `agent_settled` 之间）时把一个新的外层 UI 等待 span 转换为一个通知事件并登记活动 UI 等待项。`ui_prompt_end` SHALL 只清理对应 span 和 Herdr 状态，不产生 resolved 事件。agent 空闲期间打开的对话框 MUST NOT 产生通知或 Herdr 等待项。带标签插件事件（pi-ask `started`/`completed`、permission-system `ui_prompt`/decision 系）MUST NOT 直接产生通知或 Herdr 等待项，SHALL 仅作为 span 的分类上下文：span 打开时存在挂起静默标记的 SHALL 优先静默注册该 span——不产生通知、不登记 Herdr 等待项，但仍跟踪 span 以配对 `ui_prompt_end` 并清理，且静默注册不依赖 `herdr.enabled`；否则存在待确认 permission 请求的 SHALL 归类为 `permission-required`，Herdr 标签在转发场景 SHALL 包含净化后的请求方代理名；否则存在活动 ask flow 的 SHALL 归类为 `input-required` 并以净化后的问题标题作 Herdr 标签；其余 SHALL 归类为 `input-required` 并使用默认文案。通知文案 SHALL 使用对应事件的固定标题与安全正文，MUST NOT 包含对话框标题、问题标题、选项或用户输入。带标签上下文 SHALL 在对应流程结束（ask `completed`、permission decision 系事件）或 session shutdown 时清理。Pi core 不发出这些事件时适配器 SHALL 惰性不触发且不产生任何问答/权限通知。

#### Scenario: agent 等待用户输入

- **WHEN** agent run 活跃期间收到无上下文匹配的新 `ui_prompt_start`
- **THEN** 系统产生一个 input-required 并登记活动 UI 等待项

#### Scenario: 权限对话框分类

- **WHEN** permission-system 已发出待确认 `ui_prompt` 且其对话框随后打开
- **THEN** 系统只产生一个 permission-required，Herdr 标签在转发场景包含请求方代理名，且不产生重复通知

#### Scenario: 问答对话框标签

- **WHEN** pi-ask flow 活动且其对话框随后打开
- **THEN** 系统只产生一个 input-required，通知正文不含问题内容，Herdr 标签使用净化后的问题标题

#### Scenario: 带标签事件不再独立通知

- **WHEN** pi-ask started 或 permission ui_prompt 到达但没有对应对话框打开
- **THEN** 系统不产生通知也不登记 Herdr 等待项

#### Scenario: 用户自行操作对话框

- **WHEN** agent 空闲期间用户通过命令打开设置对话框
- **THEN** 系统不产生通知也不登记 Herdr 等待项

#### Scenario: 监控或管理对话框静默

- **WHEN** agent run 活跃期间插件在打开监控/管理面板前发出静默标记
- **THEN** 该 span 不产生通知也不登记 Herdr 等待项，收到对应 `ui_prompt_end` 时只清理

#### Scenario: 静默后真实对话框仍通知

- **WHEN** 静默 span 关闭后 agent 随后打开提问对话框
- **THEN** 系统正常产生一个通知与 Herdr 等待项，静默不泄漏到后续 span

#### Scenario: 静默标记优先于分类

- **WHEN** 同时存在挂起静默标记与待确认 permission 请求
- **THEN** 静默优先，不产生 permission-required 也不登记 Herdr 等待项

#### Scenario: 对话框关闭

- **WHEN** 收到与活动 span 对应的 `ui_prompt_end`
- **THEN** 系统只清理该 span 和 Herdr 状态，不产生通知

#### Scenario: 嵌套对话框合并

- **WHEN** agent 等待的外层对话框内部又打开子对话框
- **THEN** 只有外层 span 产生一次通知与一个 Herdr 等待项

#### Scenario: headless 问答流程

- **WHEN** headless 会话中 pi-ask 发出 started/completed 而始终没有对话框打开
- **THEN** 系统不产生通知也不登记 Herdr 等待项

#### Scenario: 老版本 Pi core

- **WHEN** Pi core 版本低于 0.84.4，不发出 `ui_prompt_start`/`ui_prompt_end`
- **THEN** 适配器不触发任何事件，问答与权限均不产生通知
