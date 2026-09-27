# agent-permission-profiles Specification

## Purpose

为 `pi-subagents` 的自定义 agent 提供可选择的命名 permission profile，使不同子代理（reviewer、只读委托、受限角色等）复用由 operator 在全局配置中定义的完整策略块（bash / mcp / skill / external_directory 模式映射与 `'*'` 兜底），同时保留现有四作用域合并与失败关闭语义。

## ADDED Requirements

### Requirement: 自定义 agent 可选择命名 permission profile

系统 SHALL 允许 native Pi child agent 在 YAML frontmatter 中通过 `permission-profile: <profile-name>` 选择一个命名 permission profile。该字段的值 MUST 为非空的安全 profile 名称（仅字母、数字、下划线、连字符，以字母或数字开头，长度不超过 128）；它仅表示选择名称，MUST NOT 接受内嵌的 permission 规则或其他原始策略配置。未声明该字段的 agent SHALL 保持既有权限解析行为。

#### Scenario: 自定义 agent 选择 profile

- **WHEN** 可执行的自定义 agent 声明 `permission-profile: reviewer-strict`
- **THEN** 该 child 的权限策略以名为 `reviewer-strict` 的 profile 规则为基底装配，且 profile 规则在 review 日志中可溯源

#### Scenario: agent 未选择 profile

- **WHEN** 自定义 agent 未声明 `permission-profile` frontmatter
- **THEN** 权限解析保持变更前行为，不查找、不应用任何 profile

#### Scenario: 非法 profile 名称

- **WHEN** agent 的 `permission-profile` 值为空、含路径成分、为字面 `false` 或不符合名称格式
- **THEN** agent 被报告为不可执行，诊断指出有问题的 `permission-profile` frontmatter，且系统 MUST NOT 以未经验证的 profile 选择启动 child

### Requirement: Profile 注册表仅存在于全局配置

全局 pi-permission-system 配置 SHALL 支持 `profiles` 名称到命名规则集的映射。每个 profile 的规则集 MUST 使用与 `permission:` frontmatter 相同的语法（工具名→决策标量、bash/mcp/skill/external_directory/special 等命名词面的模式映射、`'*'` 通用兜底）。项目配置 MUST NOT 定义、覆盖或删除 profile：项目配置出现 `profiles` 键时，该项目配置 SHALL 被判定为无效并触发现有失败关闭语义。

#### Scenario: 全局配置定义 profile

- **WHEN** 全局配置在 `profiles` 下定义了 `reviewer-strict`，其规则集声明 `'*': ask`、`read: allow`、`write: deny`
- **THEN** 引用该 profile 的 agent 对 read 放行、对 write 拒绝、对其余所有请求向父会话发起 ask，且所有规则标注来自该 profile

#### Scenario: 项目配置尝试定义 profile

- **WHEN** 项目 `.pi/extensions/pi-permission-system/config.json` 包含 `profiles` 键
- **THEN** 项目配置作用域被判定为无效，项目作用域的全部 allow 按既有失败关闭语义钳为 ask，并产生配置诊断

#### Scenario: profile 内容无效

- **WHEN** 全局配置的 `profiles` 项不符合规则集 schema（例如规则值不是合法的 allow/ask/deny）
- **THEN** 全局配置整体按既有规则拒绝加载并产生配置诊断，权限解析回退到内置默认（ask 兜底）

### Requirement: Profile 与既有作用域按逐模式覆盖合并

系统 SHALL 将所选 profile 作为独立作用域插入现有合并管线，位于项目配置之上、agent frontmatter 之下。profile 未提及的 (surface, pattern) 保留低层作用域（含全局 deny）的规则；agent frontmatter 的 `permission:` 对同一 (surface, pattern) 的重定义覆盖 profile 规则。

#### Scenario: profile 为基底、frontmatter 逐模式覆盖

- **WHEN** agent 同时声明 `permission-profile: reviewer-strict`（其规则为 `bash: { '*': ask }`）与 `permission: { bash: { 'git status': allow } }`
- **THEN** `git status` 命令被放行，其余 bash 命令保持 ask，两个来源的规则均可分别溯源

#### Scenario: profile 未提及的全局 deny 保留

- **WHEN** 全局配置对 `bash: { 'git push': deny }` 设定了 deny，所选 profile 未提及该 pattern
- **THEN** `git push` 仍被 deny，profile 无法通过不提及的方式撤销既有 deny

### Requirement: 子代理通过受控通道接收 profile 名称

pi-subagents SHALL 将所选 profile 名称（仅名称，MUST NOT 传输原始规则或配置）注入 child 启动环境。pi-permission-system 解析 child 策略时 MUST 优先采用启动环境中的 profile 名称；当该通道不存在时（例如其他注入 `<active_agent>` 标签的扩展），MUST 从 agent frontmatter 直接读取同名选择字段。

#### Scenario: 启动环境携带 profile 名称

- **WHEN** pi-subagents 启动 child 时设置了 profile 名称环境变量
- **THEN** child 的权限解析应用该名称对应的全局 profile，且不读取或传输 profile 的规则内容

#### Scenario: 无启动环境、frontmatter 直读

- **WHEN** child 由未设置 profile 名称环境变量的扩展启动，但 agent frontmatter 声明了 `permission-profile`
- **THEN** 权限解析仍应用该 frontmatter 对应的全局 profile

### Requirement: 未知或空的 profile 失败关闭

当 agent 引用的 profile 在全局注册表中不存在、或其规则集为空时，系统 SHALL 将 agent 作用域判定为无效并触发现有失败关闭语义：该 agent 的所有 allow 规则钳为 ask、产生配置诊断并写入 review 日志。系统 MUST NOT 静默忽略 profile 选择（不得以更宽松的策略运行）。

#### Scenario: 引用不存在的 profile

- **WHEN** agent 声明 `permission-profile: does-not-exist`，而全局注册表中没有该名称
- **THEN** 该 agent 的全部 allow 钳为 ask，所有请求转父会话审批，并产生命名该 profile 的诊断

#### Scenario: profile 规则集为空

- **WHEN** agent 引用的 profile 存在但未声明任何规则
- **THEN** 该 agent 的全部 allow 钳为 ask，并产生命名该 profile 的诊断

### Requirement: 信任门控与兼容性

项目 agent 文件中声明的 `permission-profile` MUST 仅在项目受信时生效；未受信项目的该字段 SHALL 被忽略并记录。profile 选择不得影响既有跨会话 ask 转发：服务端按请求者 agent 名解析策略时 SHALL 应用该请求者的 profile 规则。

#### Scenario: 未受信项目的 profile 选择被忽略

- **WHEN** 未受信项目 `/.pi/agents/<name>.md` 中的 agent 声明 `permission-profile`
- **THEN** 该项目作用域（含 profile 选择）不参与策略解析，并按既有机制记录

#### Scenario: 跨会话转发保留请求者 profile

- **WHEN** 带 profile 的 child 将 ask 请求转发给父会话审批
- **THEN** 父会话按请求者 agent 名的完整策略（含其 profile 规则）解析该请求
