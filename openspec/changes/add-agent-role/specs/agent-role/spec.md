## Purpose

主会话角色管理能力：允许用户在交互式 Pi 会话中通过命令与图形选择器，以内存态方式将 pi-subagents 自定义 agent 或 sandbox/permission 命名 profile 应用到当前主会话，并同步驱动 pi-sandbox 与 pi-permission-system 的策略生效，使主会话获得与子代理一致的命名化权限/隔离角色。

## ADDED Requirements

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
