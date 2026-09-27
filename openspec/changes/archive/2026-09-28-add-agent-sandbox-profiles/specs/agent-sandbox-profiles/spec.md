# agent-sandbox-profiles Specification

## Purpose

为 `pi-subagents` 的自定义 agent 提供可选择的命名 sandbox profile，使不同子代理在不共享同一套宽泛沙盒策略的情况下获得可验证的网络和文件系统边界，并保留现有全局与项目配置的兼容行为。

## ADDED Requirements

### Requirement: 自定义 agent 可选择命名 sandbox profile

系统 SHALL 允许 native Pi child agent 在 YAML frontmatter 中通过 `sandbox: <profile-name>` 选择一个命名 sandbox profile。该字段的值 MUST 为非空的安全 profile 名称；它仅表示选择名称，MUST NOT 接受内嵌的网络、文件系统或其他原始 sandbox 配置。未声明该字段的 agent SHALL 保持既有 extension 发现和 sandbox 配置行为。

#### Scenario: 自定义 agent 选择 profile

- **WHEN** 可执行的自定义 agent 声明 `sandbox: reviewer-strict`
- **THEN** 该 child 以名为 `reviewer-strict` 的 profile 启动，并将该 profile 的有效 sandbox 策略应用于 child 的 bash、read、write 与 edit 操作

#### Scenario: agent 未选择 profile

- **WHEN** 自定义 agent 未声明 `sandbox` frontmatter
- **THEN** child 的 extension 加载与 sandbox 配置解析保持变更前行为，不因本能力新增额外 sandbox 限制或 profile 查找

#### Scenario: 非法 profile 名称

- **WHEN** agent 的 `sandbox` 值为空、包含路径逃逸成分或不符合 profile 名称格式
- **THEN** agent 被报告为不可执行，诊断指出有问题的 `sandbox` frontmatter，且系统 MUST NOT 启动未受预期 profile 约束的 child

### Requirement: Profile 配置支持全局继承选项

全局 `sandbox.json` SHALL 支持 `profiles` 名称映射。每个 profile SHALL 包含现有 sandbox 配置字段的子集，并可声明布尔字段 `inheritGlobalConfig`。字段省略时 MUST 等同于 `true`。

当 `inheritGlobalConfig` 为 `true` 时，profile SHALL 以既有的全局 sandbox 配置为基线；当其为 `false` 时，profile SHALL 以内建安全默认值而非顶层全局配置为基线。无论该值为何，可信项目的 sandbox 配置仍按项目层规则解析，且 profile 的显式设置对其基线具有确定的优先级。profile 的来源 MUST 是用户全局 sandbox 配置；项目配置不得定义或替换 profile 名称映射。

#### Scenario: 默认继承全局配置

- **WHEN** agent 选择未声明 `inheritGlobalConfig` 的 profile，且顶层全局配置允许 `github.com`
- **THEN** profile 的有效配置继承该全局基线，并继续应用 profile 自身的显式设置

#### Scenario: 禁止继承全局配置

- **WHEN** agent 选择 `inheritGlobalConfig: false` 的 profile，且顶层全局配置包含该 profile 未声明的网络或文件系统允许项
- **THEN** 有效 profile 不继承这些顶层全局允许项，而以安全默认值和该 profile 的显式设置计算边界

#### Scenario: 硬拒绝规则不可被 profile 删除

- **WHEN** 全局或可信项目基线包含拒绝写入敏感文件或拒绝访问域名的规则，而所选 profile 未重复该规则或尝试使用允许项覆盖它
- **THEN** 有效配置仍保留该拒绝，child 无法借由选择 profile 绕过硬拒绝边界

#### Scenario: 不存在的 profile

- **WHEN** agent 选择的 profile 在全局 `profiles` 映射中不存在
- **THEN** child 在首次模型调用前失败，并给出 profile 名、配置文件路径和可用修复方向

### Requirement: Profile 选择不会扩大 agent frontmatter 的授权能力

系统 MUST 将 agent frontmatter 限制为 profile 选择器，不得允许 agent 文件直接增加允许域名、允许读取路径、允许写入路径、关闭网络限制或关闭已启用的 sandbox。profile 的权限内容仅能由全局配置的操作者定义。项目 agent 的 profile 选择和项目 sandbox 配置 SHALL 仅在项目受信任时生效；未受信任项目的 agent 不得借由本能力影响全局 sandbox 基线。

#### Scenario: agent 不能内嵌允许目录

- **WHEN** agent frontmatter 在 `sandbox` 下提供对象、允许路径或允许域名等原始配置
- **THEN** agent 被拒绝为无效配置，系统不解释这些值也不启动 child

#### Scenario: 未受信任项目的 profile 选择

- **WHEN** 当前项目未受信任，且仅项目级 agent 声明了 `sandbox: reviewer-strict`
- **THEN** 该项目级选择不生效，child 不得因该项目文件获得或改变 sandbox profile；系统给出可诊断的信任状态说明

### Requirement: 选择 profile 的 child 必须以 sandbox 运行

声明 `sandbox` 的 native Pi child SHALL 加载 `pi-sandbox`，即使 agent 使用显式 `extensions` allowlist。若 sandbox extension 不可解析、扩展能力被上层限制、runner 不是 native Pi child、profile 配置无效或当前平台不能初始化 sandbox，启动 MUST 在模型首轮之前 fail closed，并说明具体原因。系统 MUST NOT 在 profile 请求失败后静默以未 sandbox 的 child 降级运行。

#### Scenario: 显式 extension allowlist 下加载 sandbox

- **WHEN** agent 同时声明 `extensions` allowlist 和有效的 `sandbox` profile
- **THEN** child 的有效 extension 集合包含 `pi-sandbox`，同时保持该 allowlist 的其他限制

#### Scenario: 外部 runner 请求 sandbox profile

- **WHEN** `runner.type` 为非 native Pi child 的 agent 声明 `sandbox`
- **THEN** 启动被拒绝，并说明该 runner 无法承载 Pi sandbox extension

#### Scenario: 上层禁止 child extensions

- **WHEN** 上层 capability ceiling 禁止 child extensions，而 agent 请求 sandbox profile
- **THEN** 启动被拒绝，且不启动未受 sandbox 保护的 child

### Requirement: Headless child 的未授权访问保持 fail-closed

profile sandbox 运行在无 UI child 中时，未被有效配置预先允许的域名、读取路径或写入路径 MUST 被阻断。系统 MUST NOT 将 sandbox 询问伪装为 Permission System 的父会话审批，也 MUST NOT 因无 UI 自动授予访问。阻断结果 SHALL 标明访问类型和适用的 sandbox 配置边界。

#### Scenario: 无 UI child 请求未允许的网络域名

- **WHEN** 选择 profile 的 headless child 通过 bash 访问未列入有效 `allowedDomains` 的域名
- **THEN** 命令被阻断，child 收到可诊断的网络 sandbox 错误，且父会话不出现伪造的 sandbox 审批对话

#### Scenario: 无 UI child 写入未允许路径

- **WHEN** 选择 profile 的 headless child 通过 write、edit 或 bash 写入未列入有效 `allowWrite` 的路径
- **THEN** 写入被阻断，不创建持久化 session allow 规则，且运行记录可识别该阻断来自 sandbox
