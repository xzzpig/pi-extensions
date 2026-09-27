# agent-profiles Specification

## Purpose

定义按角色选择子代理配置的能力：会话角色切换与优先级、自定义 agent 通过 frontmatter 选择命名 permission/sandbox profile、profile 注册表与合并语义、受信任项目可定义 profile 的信任门与诊断。

## Requirements

### Requirement: 角色切换命令

主会话 SHALL 提供三个图形化切换命令：`/role`（agent 角色面板）、`/sandbox-profile`（sandbox profile 单选）、`/permission-profile`（permission profile 单选）。所有命令在 TUI 模式下 MUST 渲染可导航的选择器：`j`/`k`/`↑`/`↓` 导航、`Enter` 确认、`Esc` 取消。`/role` 面板 MUST 列出所有可发现的 agent（含其他插件运行时注册的 agent），并为每个 agent 显示其声明的 sandbox 与 permission profile 徽章；所有选择器 MUST 提供 `none` 清除选项。`/role` 无参调用 MUST 显示当前角色状态（当前 agent 名与已生效的 profile，或 none）。

#### Scenario: 通过面板切换 agent

WHEN 用户在 TUI 模式下执行 `/role` 并选择一个 agent
THEN 选择器关闭，该 agent 成为当前主会话角色，所有配置广播立即执行

#### Scenario: 通过面板清除角色

WHEN 用户在 `/role` 面板中选择 `none`
THEN 当前 agent 角色被清除，agent 身份与相关 profile 全部失效，底部状态栏不再展示角色

#### Scenario: 单独切换 sandbox profile

WHEN 用户执行 `/sandbox-profile` 并从列出的全局注册表 profile 中选择一项
THEN 该 profile 作为显式 sandbox profile 应用到主会话，不影响当前 agent 身份

#### Scenario: 单独切换 permission profile

WHEN 用户执行 `/permission-profile` 并从列出的全局注册表 profile 中选择一项
THEN 该 profile 作为显式 permission profile 应用到主会话，不影响当前 agent 身份

### Requirement: 内存态角色与优先级

主会话角色状态 MUST 为内存态（session-scoped）：重启 Pi 后自动回到 none，不写回任何配置文件。角色状态由三个可空字段组成：agent 名、显式 sandbox profile、显式 permission profile。生效配置的优先级 MUST 为：显式设置 > agent 文件声明 > 无。切换 agent MUST 重置所有显式覆盖（完整换装语义）：agent 声明成为唯一来源。

#### Scenario: 显式设置覆盖 agent 声明

WHEN 当前角色为某 agent（其声明 sandbox profile `A`），用户随后单独切换 sandbox profile 为 `B`
THEN 主会话 sandbox 生效 profile 为 `B`（显式覆盖 agent 声明）

#### Scenario: 切换 agent 重置显式覆盖

WHEN 用户已单独设置 sandbox profile `B`，随后通过 `/role` 切换到声明 sandbox profile `C` 的另一个 agent
THEN 显式设置被清除，主会话 sandbox 生效 profile 为 `C`

#### Scenario: 重启后回到 none

WHEN Pi 进程重启并再次启动同一会话目录
THEN 角色状态为空（none），不展示角色状态栏，权限与沙箱策略回到默认合并结果

### Requirement: 权限系统跟随

角色插件 MUST 通过两条既有协议广播身份与 permission profile：向会话追加 `active_agent` 自定义条目（agent 名；清除时 name 为 null），以及写入/清除 `PI_SUBAGENT_PERMISSION_PROFILE` 环境变量。pi-permission-system SHALL 在其既有解析路径下自动应用：agent 作用域、permission-profile 作用域与 `permission:` 前端块随 agent 身份生效，显式 env 选择随 env 变化生效。

本变更新增一条 pi-permission-system 行为需求（该包无 OpenSpec 主 spec，故在提案的 Modified Capabilities 中登记，并记入其 CHANGELOG）：启动器标记的子进程（`PI_SUBAGENT_PERMISSION_PROFILE_PINNED=1`）SHALL 在自身 `session_start` 固化为本次启动显式 pin 的 profile 选择，此后不再读取活 env；未被标记的会话（主会话，以及由子代理再启动的 pi 会话）SHALL 继续惰性读取，因此会话中切换 profile 仍在下一个决策生效。pi-permission-system 的既有裁决语义（四作用域 per-pattern 合并、最严结果优先、fail-closed）MUST NOT 改变。

#### Scenario: 切换 agent 后权限策略生效

WHEN 用户切换到声明 `permission-profile: locked` 与 `permission: {write: deny}` 的 agent
THEN 主会话后续工具调用按 locked profile 与 deny 规则裁决（pi-permission-system 的既有四作用域合并路径直接生效）

#### Scenario: 子代理不继承主会话的角色选择

WHEN 主会话持有 permission profile `role-auditor`（bash `touch *` 为 deny）并启动一个未声明 profile 的子代理
THEN 子代理进程收到显式清除的 `PI_SUBAGENT_PERMISSION_PROFILE` 与启动器标记 `PI_SUBAGENT_PERMISSION_PROFILE_PINNED=1`
AND 子代理的工具调用不因主会话的 profile 被拒绝，其审查日志中的裁决 origin 不含该 profile
AND 子代理结束后主会话的后续工具调用仍按 `role-auditor` 裁决

#### Scenario: 清除 agent 身份

WHEN 用户选择 `none` 清除 agent 角色
THEN `active_agent` 条目以 null name 追加，agent 作用域与 agent 声明的 profile 不再参与权限合并

### Requirement: sandbox 显式服务

pi-sandbox SHALL 提供公开的会话级服务 `SandboxService`，供同进程扩展调用：`setProfile(profileName: string | undefined): Promise<{ ok: boolean; message?: string }>`、`getProfile(): string | undefined`、`listProfiles(): string[]`。`setProfile` MUST 校验 profile 名为合法标识符且存在于全局注册表；非法或缺失名称 MUST 返回 `ok: false` 与明确消息，不得改变当前配置。当沙箱当前未启用时，`setProfile` MUST 应用配置但 MUST NOT 强制开启沙箱，并返回警告消息说明隔离未生效。服务 SHALL 按会话注册/注销，未注册会话的调用 MUST NOT 抛出未捕获异常。

#### Scenario: 设置合法 profile

WHEN 调用 `setProfile('strict')` 且 `strict` 存在于全局注册表
THEN 返回 `{ ok: true }`，后续配置解析按 strict profile 合并

#### Scenario: 设置非法 profile

WHEN 调用 `setProfile('../escape')` 或注册表中不存在的名称
THEN 返回 `{ ok: false, message }`，当前配置保持不变

#### Scenario: 沙箱未启用时设置 profile

WHEN 沙箱处于关闭状态（如 `--no-sandbox` 或用户禁用）时调用 `setProfile('strict')`
THEN 返回 `ok: true` 且消息警告"profile 已应用但沙箱未启用，隔离未生效"，沙箱开关状态不被改变

#### Scenario: 已启用沙箱下重新初始化失败

WHEN 沙箱已启用且 `setProfile` 选中的合法 profile 在重新初始化时失败
THEN 返回 `{ ok: false, message }`，会话保持 fail-closed（后续输入被阻塞），MUST NOT 静默以旧配置继续运行

### Requirement: 项目信任门

agent 角色切换 SHALL 实施信任门：当所选 agent 来自项目作用域（项目 agent 文件或项目作用域覆盖）且当前项目不受信任时，切换 MUST 被拒绝并给出明确诊断，角色状态保持不变。显式单独切换 sandbox/permission profile MUST NOT 要求信任门（profile 注册表仅全局可定义）。

#### Scenario: 拒绝不受信任项目的 agent

WHEN 项目不受信任且用户选择来自项目 `.pi/agents/` 的 agent
THEN 切换被拒绝，提示项目不受信任，角色状态保持不变

#### Scenario: 受信任项目允许切换

WHEN 项目受信任且用户选择来自项目 `.pi/agents/` 的 agent
THEN 切换成功，该 agent 成为当前角色

#### Scenario: 显式 profile 切换不受信任门约束

WHEN 项目不受信任时用户显式选择全局注册表中的一个 sandbox 或 permission profile
THEN 切换成功，不触发信任门

### Requirement: 底部状态栏可见性

TUI 模式下，当前角色 SHALL 在底部状态栏可见：格式为简洁的 agent 名（如 `role: worker`），不展示 profile 细节。角色为 none 时 MUST 清除状态（不展示）。headless 模式（print/json）MUST NOT 渲染状态栏且不得因状态渲染失败影响会话运行。状态渲染属装饰性：任何失败 MUST 被吞掉而不影响命令与广播结果。

#### Scenario: 展示当前 agent

WHEN 用户切换到 agent `worker` 且会话处于 TUI 模式
THEN 底部状态栏展示 `role: worker`

#### Scenario: none 不展示

WHEN 角色为 none（初始状态或已清除）
THEN 底部状态栏不展示角色段

#### Scenario: headless 跳过

WHEN 会话以 print 或 json 模式运行且切换角色
THEN 不产生状态栏渲染，广播与命令结果不受影响

### Requirement: 子代理身份隔离

角色切换 SHALL 只影响主会话。子代理会话的 agent 身份 SHALL 继续由 pi-subagents 按其自身 agent 定义注入，主会话角色 MUST NOT 覆盖或泄漏到子代理的 `<active_agent>` 身份。

#### Scenario: 主会话角色不影响子代理

WHEN 主会话角色为 agent `A`，随后运行一个使用 agent `B` 的子代理任务
THEN 子代理按 agent `B` 的配置运行，其 sandbox/permission 选择不受主会话角色影响

#### Scenario: 主会话的 permission profile 不泄漏到子代理

WHEN 主会话已选择 permission profile `P`，随后启动子代理（包括 `host:'runner'` 的子进程与 `host:'parent'` 的同进程内子代理）
THEN 子代理不应用 `P`；子代理未声明 profile 时不被应用任何 profile，子代理声明了 `Q` 时应用 `Q` 而非 `P`
AND 子代理创建后主会话仍保持 `P`

#### Scenario: 并发子代理互不影响

WHEN 同一进程内同时启动多个子代理，各自声明不同的 permission profile（或均未声明）
THEN 每个子代理按自己启动时的选择裁决，不因其他子代理的启动/结束而改变，也不把选择残留到宿主会话

### Requirement: 自定义 agent 可选择命名 permission profile

系统 SHALL 允许 native Pi child agent 在 YAML frontmatter 中通过 `permission-profile: <profile-name>` 选择一个命名 permission profile。该字段的值 MUST 为非空的安全 profile 名称（仅字母、数字、下划线、连字符，以字母或数字开头，长度不超过 128）；它仅表示选择名称，MUST NOT 接受内嵌的 permission 规则或其他原始策略配置。未声明该字段的 agent SHALL 保持既有权限解析行为。

#### Scenario: 自定义 agent 选择 permission profile

- **WHEN** 可执行的自定义 agent 声明 `permission-profile: reviewer-strict`
- **THEN** 该 child 的权限策略以名为 `reviewer-strict` 的 profile 规则为基底装配，且 profile 规则在 review 日志中可溯源

#### Scenario: agent 未选择 permission profile

- **WHEN** 自定义 agent 未声明 `permission-profile` frontmatter
- **THEN** 权限解析保持变更前行为，不查找、不应用任何 profile

#### Scenario: 非法 permission profile 名称

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

### Requirement: 自定义 agent 可选择命名 sandbox profile

系统 SHALL 允许 native Pi child agent 在 YAML frontmatter 中通过 `sandbox: <profile-name>` 选择一个命名 sandbox profile。该字段的值 MUST 为非空的安全 profile 名称；它仅表示选择名称，MUST NOT 接受内嵌的网络、文件系统或其他原始 sandbox 配置。未声明该字段的 agent SHALL 保持既有 extension 发现和 sandbox 配置行为。

#### Scenario: 自定义 agent 选择 sandbox profile

- **WHEN** 可执行的自定义 agent 声明 `sandbox: reviewer-strict`
- **THEN** 该 child 以名为 `reviewer-strict` 的 profile 启动，并将该 profile 的有效 sandbox 策略应用于 child 的 bash、read、write 与 edit 操作

#### Scenario: agent 未选择 sandbox profile

- **WHEN** 自定义 agent 未声明 `sandbox` frontmatter
- **THEN** child 的 extension 加载与 sandbox 配置解析保持变更前行为，不因本能力新增额外 sandbox 限制或 profile 查找

#### Scenario: 非法 sandbox profile 名称

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

### Requirement: 项目配置可定义 permission profile

项目配置文件 SHALL 允许 `profiles` 名称映射，语法与全局配置一致（profile 名称为非空安全标识符，规则集结构与全局 profile 相同）。项目至少定义一个新的 profile 名称时，该名称可被 `permission-profile:` frontmatter / `PI_SUBAGENT_PERMISSION_PROFILE` 选择，如同全局定义。现有「项目配置含 `profiles` 键 → 整体拒绝（项目 scope invalid）」的规则 SHALL 移除。

#### Scenario: 项目定义新的 permission profile

- **WHEN** 受信任项目的配置定义 `profiles: { "docs-reviewer": { permission: { "read": "allow" } } }`，且 agent frontmatter 声明 `permission-profile: docs-reviewer`
- **THEN** profile 作为作用域参与权限合并（介于 project 与 agent 之间），`read` 规则生效

#### Scenario: 项目定义不存在的 permission profile 被选择

- **WHEN** 项目未受信任，agent 选择仅在项目配置中定义的 profile 名称
- **THEN** 该 profile 解析为未知名称 → profile 作用域 invalid → `allow` 被 clamp 为 `ask`（沿用 fail-closed），诊断指明该 profile 无法解析

### Requirement: 同名 permission profile 合并语义

项目 profile 与全局同名 profile 冲突时，系统 SHALL 在 `(surface, pattern)` 键上合并：项目 profile 覆盖全局同名 profile 的单个 pattern，未提及的 pattern 保留全局同名 profile 的值。合并只在决议时发生（每次权限解析重算），不修改任何配置文件。

#### Scenario: 同名合并覆盖单个 pattern

- **WHEN** 全局定义 `profiles: { "dev": { permission: { "bash/*": "ask", "read": "allow" } } }`，项目定义 `profiles: { "dev": { permission: { "read": "ask" } } }`
- **THEN** 合并后的 `dev` 有效规则为 `bash/*: ask`（保留全局）与 `read: ask`（项目覆盖），origin 标注区分全局 profile 贡献与项目 profile 贡献

### Requirement: permission profile 的项目信任门

项目配置的 `profiles` 注册表 SHALL 仅在平台项目信任（`ctx.isProjectTrusted()` 为真）时参与 profile 解析与合并。项目未受信任时：项目新增 profile 名称解析为未知（fail-closed），同名选择退化为仅使用全局同名 profile；同时系统 SHALL 产生警告「项目定义了 N 个 permission profile，未应用（项目未受信任）」。

#### Scenario: 未信任项目忽略同名定义并仅用全局

- **WHEN** 项目未受信任，agent 选择 `dev`（全局与项目均定义该名称）
- **THEN** 使用全局 `dev` profile，项目 `dev` 的覆盖不生效，产生「未应用」警告，权限不退化放宽

#### Scenario: 未信任项目的新 profile 选择 fail-closed

- **WHEN** 项目未受信任，agent 选择仅在项目配置定义的 profile 名称
- **THEN** profile 解析为未知 → 该 agent 的 `allow` clamp 为 `ask`（沿用 fail-closed 语义与诊断消息）

#### Scenario: 受信任项目 permission profile 正常生效

- **WHEN** 项目受信任，项目配置存在 `profiles` 注册表
- **THEN** 项目 profiles 参与解析与同名合并，无「未应用」警告

### Requirement: permission profile 子目录启动继承信任

从受信任项目目录的任意子目录启动会话时，项目 profile SHALL 生效，效果与在项目根启动相同（平台祖先信任决策继承语义）。子目录无需单独信任决策。

#### Scenario: 子目录启动项目 permission profile 生效

- **WHEN** 项目根 `~/work/app` 受信任，agent 在 `~/work/app/packages/svc` 下选择项目定义的 profile
- **THEN** 项目 profile 正常解析生效，不因 cwd 非项目根而失败

### Requirement: 警告与诊断

「项目 profiles 未应用」警告 SHALL 与现有配置问题诊断合并呈现（`getConfigIssues` / UI 通知通道），且 MUST NOT 使信任的项目场景或未选择项目 profile 的场景产生任何额外错误。

#### Scenario: 未信任项目有 profiles 时产生警告、不阻断

- **WHEN** 项目未受信任且项目配置定义了 profiles，无论当前是否选择 profile
- **THEN** 产生「项目定义了 N 个 permission profile，未应用（项目未受信任）」警告，叠加在现有配置问题诊断上，权限解析不因警告本身失败

#### Scenario: 受信任或未定义 profiles 的项目无警告

- **WHEN** 项目受信任且项目配置定义了 profiles，或任何项目未定义 profiles
- **THEN** 不产生「未应用」警告，解析行为与 change 前一致

### Requirement: 项目配置可定义 sandbox profile

项目 `sandbox.json` SHALL 允许 `profiles` 名称映射，语法与全局配置一致（profile 名称为非空安全标识符，字段集合与全局 profile 相同）。项目到少定义一个新的 profile 名称时，该名称可被 `sandbox:` / `PI_SUBAGENT_SANDBOX_PROFILE` 选择，如同全局定义。

#### Scenario: 项目定义新的 sandbox profile

- **WHEN** 受信任项目的 `sandbox.json` 定义 `profiles: { "project-dev": { filesystem: { allowWrite: ["build/"] } } }`，且 child 以 `sandbox: project-dev` 启动
- **THEN** profile 生效，其有效 sandbox 策略为全局基线（或全局同名 profile）与项目定义的合并结果，`build/` 可写

#### Scenario: 项目定义不存在的 sandbox profile 被选择

- **WHEN** 项目未受信任，child 选择仅在项目 `sandbox.json` 中定义的 profile 名称
- **THEN** 项目定义不参与解析，启动失败且诊断指明该 profile 未定义或项目未受信任，MUST NOT 以未约束的策略启动

### Requirement: 同名 sandbox profile 合并语义

项目 profile 与全局同名 profile 冲突时，系统 SHALL 合并：项目 profile 的字段覆盖或并集于全局同名 profile，但合并 MUST NOT 削弱全局的 deny 边界。数组字段沿用现有语义：allow 类（`allowRead`、`allowWrite`、`allowedDomains`、`allowUnixSockets` 等）由项目替换，deny 类（`denyRead`、`denyWrite`、`deniedDomains`、`protectNonexistentFiles` 等）取并集且不可被项目清空或移除。敏感放宽项（`allowBrowserProcess`、`enableWeaker*` 等）沿用 `preserveRestrictedBoolean` 语义：全局基线未启用的，项目 profile 不得启用。

#### Scenario: 同名合并保留全局 deny

- **WHEN** 全局定义 `profiles: { "dev": { filesystem: { denyWrite: ["/secrets"], allowWrite: ["/tmp"] } } }`，项目定义 `profiles: { "dev": { filesystem: { allowWrite: ["build/"] } } }`
- **THEN** 合并结果中 `allowWrite` 为 `["build/"]`（项目替换），`denyWrite` 仍含 `["/secrets"]`（全局 deny 保留）

#### Scenario: 项目合并不能启用全局基线未开启的敏感放宽

- **WHEN** 全局基线未启用 `allowBrowserProcess`，项目同名或新增 profile 尝试设置 `allowBrowserProcess: true`
- **THEN** profile 加载失败（保持不变量的 `preserveRestrictedBoolean` 行为），服务不降级启动

### Requirement: sandbox profile 的项目信任门

项目 `sandbox.json` 的 `profiles` 注册表 SHALL 仅在平台项目信任（`ctx.isProjectTrusted()` 为真）时参与 profile 解析与合并。项目未受信任时：项目新增 profile 名称的解析视为「未知名称」处理（不发生放宽）；但系统 MUST NOT 因此直接启动失败——未信任导致的忽略 SHALL 产生警告，提示「项目定义了 N 个 sandbox profile，未应用（项目未受信任）」，且解析退化为仅使用全局注册表（无同名合并）。

#### Scenario: 未信任项目忽略 profile 并警告

- **WHEN** 项目未受信任，且项目 `sandbox.json` 存在 `profiles` 注册表
- **THEN** 项目 profiles 不参与解析，给出警告；若当前选择只存在于项目注册表的名称，则该启动失败（见「项目定义不存在的 profile 被选择」）
- **AND** 未选择任何项目独有 profile 时，行为等同于项目 profiles 为空：全局注册表正常使用，本次更改不引入额外失败

#### Scenario: 受信任项目 sandbox profile 正常生效

- **WHEN** 项目受信任，且项目 `sandbox.json` 存在 `profiles` 注册表
- **THEN** 项目 profiles 参与解析与同名合并，无警告，行为如「项目配置可定义 sandbox profile」与「同名 profile 合并语义」所述

### Requirement: sandbox profile 子目录启动继承信任

从受信任项目目录的任意子目录启动会话时，项目 profile SHALL 生效，效果与在项目根启动相同（平台 `findNearestTrustEntry` 祖先决策继承语义）。子目录无需单独信任决策。

#### Scenario: 子目录启动项目 sandbox profile 生效

- **WHEN** 项目根 `~/work/app` 受信任，child 在 `~/work/app/packages/svc` 下以项目定义的 profile 启动
- **THEN** 项目 profile 正常解析生效，不因 cwd 非项目根而失败

### Requirement: 警告通道

「项目 profiles 未应用」警告 SHALL 通过既有诊断/通知通道传递：有 UI 的会话显示通知，无 UI 的 child 写入启动诊断（`SANDBOX_DIAGNOSTICS_PATH`）并可在 stderr 可见。警告 MUST NOT 被当作失败（进程退出码不变），除非另有导致失败的独立原因（如选择未定义名称）。

#### Scenario: 未信任项目有 profiles 但未选择项目独有名

- **WHEN** 项目未受信任且项目 `sandbox.json` 定义了 profiles，但未选择任何仅在项目注册表存在的名称（选择落空或选择全局名）
- **THEN** 会话产生「项目定义了 N 个 sandbox profile，未应用（项目未受信任）」警告，进程正常启动，退出码不变

#### Scenario: 无 UI child 通过启动诊断收到警告

- **WHEN** 无 UI 的 child 在项目未受信任且项目 `sandbox.json` 定义了 profiles 时启动
- **THEN** 警告写入启动诊断（`SANDBOX_DIAGNOSTICS_PATH`）且可在 stderr 可见，child 不因警告本身失败
