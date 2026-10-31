# 目标生命周期规格增量

## MODIFIED Requirements

### Requirement: 一次性引导通道

系统 SHALL 用 `pi-goal-steering-event` 承载不属于每回合状态的其他一次性引导说明，以 `display: false` 写入，details 为 `{ reason, timestamp }`。存在打开目标但未聚焦 SHALL NOT 构成发送该消息的条件，系统 MUST NOT 新增 `reason: "unfocused"` 引导。

对于仍受支持的其他引导情形，系统 SHALL 保持同一情形只发送一次的边缘触发语义，情形解除后允许再次发送；写入失败 SHALL 不影响会话载入或聚焦切换。本要求是既有兼容性基线的明确预期差异，不改变其他通道保证。

#### Scenario: 首次出现未聚焦目标时发送一次

- **WHEN** 存在打开的目标但没有聚焦目标，且此前未就此发送过引导
- **THEN** 系统不再发送原先的一次性未聚焦引导，不追加 `reason: "unfocused"` 消息

#### Scenario: 同一情形不重复发送

- **WHEN** 上述情形持续存在（仍未聚焦）
- **THEN** 系统始终不追加未聚焦引导消息，而不是仅抑制重复发送

#### Scenario: 情形解除后可再次发送

- **WHEN** 目标重新被聚焦，之后再次出现未聚焦但有打开目标的情形
- **THEN** 系统仍不追加未聚焦引导；其他受支持的一次性引导在其情形解除后仍可再次发送

#### Scenario: 写入失败不影响会话

- **WHEN** 追加其他受支持的引导消息时抛出异常
- **THEN** 会话载入与聚焦切换正常完成

### Requirement: 主模型保留执行和压缩恢复语义

精简 SHALL 保留目标原文及其信任标记、任务树与进度、当前任务、验证契约、完成审计 gate、审计 verdict/报告/findings、真实阻塞与恢复建议、焦点归属和状态边界。宿主自动压缩和压缩后目标恢复 MUST 保持原有行为；系统 MUST NOT 因移除遥测而删除有意义的目标状态快照或改变 checkpoint 配对、暂停/阻塞/预算受限 gate。未聚焦状态不再生成 open-goal 提醒属于明确预期差异，不依赖旧提示设置维持焦点边界。

#### Scenario: 压缩后继续执行未完成目标

- **WHEN** active 目标执行期间发生自动压缩
- **THEN** 压缩后主模型仍能恢复目标、当前任务及其契约、未解决审计反馈和必要调度信息，并按既有流程继续；新生成的恢复内容不加入已排除的遥测；不清洗宿主压缩摘要或历史消息

#### Scenario: 真实暂停与审计拒绝不能被精简绕过

- **WHEN** 目标处于 paused、blocked 或 budget_limited，或收到审计拒绝/错误
- **THEN** 主模型仍能识别状态与原因，既有恢复入口和完成限制不变；审计报告保留而插件另加的审计成本统计不进入主模型返回

#### Scenario: 无焦点与过期 checkpoint 保护保持

- **WHEN** 存在未聚焦目标或出现不再可执行的 checkpoint
- **THEN** 系统不自动选择、恢复或切换目标；未聚焦状态不生成 open-goal 提醒，需要焦点的工具校验和过期 checkpoint 防护继续生效

## ADDED Requirements

### Requirement: 未聚焦会话不自动提供其他目标的模型引导

当前会话没有 focused goal 时，系统 MUST NOT 仅因存在 open goal 而向模型新增目标数量、`[PI GOAL UNFOCUSED]` 提醒或要求用户先 focus 的引导。该约束 SHALL 覆盖请求上下文、隐藏持久化消息、会话载入和取消聚焦路径；普通交互 MUST NOT 被要求先选择 goal。已有历史消息、工具结果与压缩摘要 SHALL 保持原样，用户显式查询目标的结果不属于自动提醒。

#### Scenario: 多次普通请求

- **WHEN** 未聚焦会话存在一个或多个 open goal，连续发送普通请求并进入工具循环
- **THEN** 插件不生成新的未聚焦提醒，不阻塞普通交互，也不为此触发模型回合或修改 goal/focus

#### Scenario: 载入与取消聚焦

- **WHEN** 会话启动、恢复、reload、切换到未聚焦会话，或用户取消聚焦后发送请求
- **THEN** 插件不生成未聚焦提醒，其他会话的 focus 不被接管，已有 open goal 保持原状态

#### Scenario: 已有历史提醒保持原样

- **WHEN** 恢复的会话或压缩摘要已经含有旧未聚焦提醒
- **THEN** 系统不删除、重写或全局过滤该历史，也不据此生成新的提醒；不承诺历史重放中完全不出现旧标记

#### Scenario: 用户显式查询不受影响

- **WHEN** 用户主动执行目标列表、状态或聚焦相关命令
- **THEN** 系统按原契约展示或操作目标，不把用户主动查询当作应禁止的自动模型提醒

### Requirement: 未聚焦提示设置仅保留旧配置兼容

系统 SHALL 继续接受并按既有解析与持久化规则保留旧键 `hideUnfocusedPrompt`，但 MUST NOT 再以其取值决定模型提示行为。该键 SHALL 从可编辑设置菜单和常规设置展示中移除，不要求用户迁移或自动重写配置。`hideUnfocusedBanner` SHALL 继续独立控制未聚焦 UI，不影响 focused dashboard 或审计 UI。

#### Scenario: 旧键取值均不注入

- **WHEN** global/project 层中的旧键为缺省、`true`、`false` 或存在相互覆盖
- **THEN** 均不生成未聚焦提醒；合法旧配置仍能读取，保存其他设置时不会因本次废弃而主动删除旧键

#### Scenario: 设置入口与 UI 提示分离

- **WHEN** 用户查看或编辑设置，并分别开启或关闭 `hideUnfocusedBanner`
- **THEN** 旧提示键不再作为可编辑项或常规设置行出现；未聚焦 banner/status 按原 UI 开关显示或隐藏，模型均无新增提醒

### Requirement: 未聚焦执行权限由运行时保持

不发送未聚焦提醒 MUST NOT 授予模型 focus 选择权。需要 focused goal 的生命周期与任务操作 SHALL 继续在工具侧拒绝无焦点调用，返回明确的选择目标指引而不修改已有目标；失效 checkpoint SHALL 在原调度边界拒绝。聚焦目标的执行上下文、压缩恢复、真实预算约束及完成审计 SHALL 保持既有行为。

#### Scenario: 无焦点调用需要目标的工具

- **WHEN** 无 focused goal 时调用要求 focused goal 的生命周期或任务操作
- **THEN** 工具返回既有可操作错误，不选择目标、不修改目标或目标证据，不启动自动续跑

#### Scenario: 未聚焦时收到过期续跑

- **WHEN** 旧 checkpoint 在目标取消聚焦后被调度或送达
- **THEN** 原失效检查阻止其执行，不因移除提醒而进入目标工作；原有拒绝说明不受禁止普通提醒的约束

#### Scenario: 显式聚焦后正常执行

- **WHEN** 用户通过既有命令显式聚焦目标并开始执行，之后发生压缩或请求完成
- **THEN** 正常执行上下文、恢复、预算门禁与审计流程仍按既有契约运行，不把该目标误当作应静默的未聚焦状态
