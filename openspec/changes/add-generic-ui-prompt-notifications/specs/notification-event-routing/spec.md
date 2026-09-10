## MODIFIED Requirements

### Requirement: Herdr 独立状态机

系统 SHALL 保持公开 `herdr:blocked` event 名和 payload 不变。`herdr.enabled` SHALL 独立于通知 enabled 且默认 true；首个活动 UI 等待项产生 blocked，只有所有活动项完成或 session shutdown 才解除。

#### Scenario: 多个等待项并存

- **WHEN** 多个对话框 span 同时活动且其中一个先关闭
- **THEN** Herdr 保持 blocked 直到最后一个 span 关闭

#### Scenario: Herdr 被显式关闭

- **WHEN** herdr.enabled 为 false
- **THEN** 系统不发布 herdr:blocked，但通知路由仍按顶层 enabled 工作

#### Scenario: Session shutdown

- **WHEN** session shutdown 时仍有活动等待项
- **THEN** 系统清空跟踪状态并在 Herdr 启用时发布解除 blocked

## REMOVED Requirements

### Requirement: 输入等待适配器

**Reason**: pi 0.84.4 起的 `ui_prompt_start`/`ui_prompt_end` 事件已覆盖 pi-ask 的全部对话框（其 UI 经 `ctx.ui.custom` 展示），继续保留独立适配器需要引入抑制机制来消解与通用适配器的双发。带标签事件降级为通用适配器的分类上下文后，pi-ask 对话框的通知与 herdr 状态由 span 统一承载。

**Migration**: 需要 pi >= 0.84.4（`peerDependencies` 下限同步提升）。TUI 与带 UI 的 rpc 会话行为不变（对话框打开时通知、herdr 标题沿用问题标题）；headless / 无 UI 模式下的纯远程问答流程不再产生通知，此为接受的行为收窄。

### Requirement: 权限等待适配器

**Reason**: 与输入等待适配器同理：permission-system 的确认对话框经 `ctx.ui.custom` 展示，`ui_prompt_start` 事件已覆盖其生命周期，`permissions:ui_prompt`/decision 事件改为仅提供分类（待确认请求判定 `permission-required`）与标签（转发场景的请求方代理名），不再独立产生通知；span 关闭取代 decision 匹配成为 herdr 解除路径。

**Migration**: 需要 pi >= 0.84.4。`permission-required` 语义保留：由通用适配器在存在待确认 permission 请求时归类产生；旧版 pi 上问答与权限通知整体消失。

## ADDED Requirements

### Requirement: 通用 UI 等待适配器

系统 SHALL 监听 Pi core 的 `ui_prompt_start`/`ui_prompt_end` 生命周期事件，并 SHALL 仅在 agent run 活跃（首次 `agent_start` 到对应 `agent_settled` 之间）时把一个新的外层 UI 等待 span 转换为一个通知事件并登记活动 UI 等待项。`ui_prompt_end` SHALL 只清理对应 span 和 Herdr 状态，不产生 resolved 事件。agent 空闲期间打开的对话框 MUST NOT 产生通知或 Herdr 等待项。带标签插件事件（pi-ask `started`/`completed`、permission-system `ui_prompt`/decision 系）MUST NOT 直接产生通知或 Herdr 等待项，SHALL 仅作为 span 的分类上下文：span 打开时存在待确认 permission 请求的 SHALL 归类为 `permission-required`，Herdr 标签在转发场景 SHALL 包含净化后的请求方代理名；否则存在活动 ask flow 的 SHALL 归类为 `input-required` 并以净化后的问题标题作 Herdr 标签；其余 SHALL 归类为 `input-required` 并使用默认文案。通知文案 SHALL 使用对应事件的固定标题与安全正文，MUST NOT 包含对话框标题、问题标题、选项或用户输入。带标签上下文 SHALL 在对应流程结束（ask `completed`、permission decision 系事件）或 session shutdown 时清理。Pi core 不发出这些事件时适配器 SHALL 惰性不触发且不产生任何问答/权限通知。

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
