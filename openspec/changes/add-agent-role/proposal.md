## Why

pi-sandbox 与 pi-permission-system 均已支持通过 pi-subagents 自定义 agent 前端块选择命名 profile（`sandbox:` 与 `permission-profile:`），但这些配置目前**只对子代理生效**：主会话（交互式 Pi 会话）没有 profile 概念，也无法复用 agent 定义作为自己的权限/隔离角色。用户每次想要不同的权限氛围（如严格审查模式、只读模式）都要手动改配置文件或逐条批准。

本变更引入一个独立新插件 pi-agent-role，作为"主会话角色层"：用命令 + 图形选择器把 agent 或命名 profile 应用到当前主会话（内存态，不持久化），并同步驱动 sandbox 与 permission 两个系统。

## What Changes

- 新增 npm 包 `pi-agent-role`（@xzzpig/pi-agent-role，初始 0.1.0），注册三个 TUI 图形选择器命令：
  - `/role`：列出可用 agent（含其他插件运行时注册的 agent），选中即切换主会话角色；每行显示该 agent 声明的 sandbox/permission profile 徽章；提供 `none` 清除选项
  - `/sandbox-profile`：单独切换主会话的 sandbox profile（单选，含 `none`）
  - `/permission-profile`：单独切换主会话的 permission profile（单选，含 `none`）
  - 选择器交互：`j`/`k`/`↑`/`↓` 导航、`Enter` 确认、`Esc` 取消、`/role` 无参显示当前状态
- 主会话角色状态为**内存态**（session-scoped，重启丢失）：`agentName?` + 显式 `sandboxProfile?` + 显式 `permissionProfile?`
  - 优先级：显式设置 > agent 文件声明 > 无
  - 切换 agent = 完整换装：重置所有显式覆盖为 agent 声明
- 三通道广播（全部对现有包零/极小改动）：
  1. `ctx.sessionManager.appendEntry('active_agent', { name })`（清除用 `{ name: null }`）→ pi-permission-system 的现有 active_agent 解析自动生效（agent 作用域 + permission-profile 作用域 + `permission:` 前端块）
  2. 写入/清除 `process.env[PI_SUBAGENT_PERMISSION_PROFILE]` → pi-permission-system 的 `resolvePermissions` 读 env（已存在）；子会话在 `session_start` 固化该选择，避免子代理继承或覆盖（见 design D3）
  3. 调用 pi-sandbox 新增的显式服务 `getSandboxService().setProfile(name | undefined)`
- pi-sandbox 新增 `SandboxService`（公开 API）：
  - `setProfile(profileName: string | undefined): { ok: boolean; message?: string }`——验证名称、应用配置；**沙箱未启用时不强制开启**，返回警告信息由 UI 展示
  - `getProfile(): string | undefined`、`listProfiles(): string[]`（全局注册表，供选择器）
  - 按 session 注册/注销（Symbol.for 全局注册表，仿 pi-permission-system 的 getPermissionsService 先例）
- pi-subagents 公开 API 增加 agent 发现导出（约 1-2 行），使角色插件能复用完整发现（builtin/package/user/project + runtime 注册 agent 合并、诊断、信任信息）
- 底部状态栏：`ctx.ui.setStatus('role', text)`，仅展示当前角色（方案 A 简洁格式：`role: worker`）；**none 时传 `undefined` 清除不展示**；headless（mode !== 'tui'）跳过；cosmetic 容错
- 信任门：**仅**项目作用域 agent 切换需要（agent 来自项目且项目不受信任 → 拒绝并提示）；显式单独切换 profile 不需要信任门（profile 注册表仅全局可定义）
- pi-permission-system：一处最小改动——子会话（subagent child）在 `session_start` 固化 launcher env 中的 profile 选择，之后不再读活 env；主会话保持惰性读取（切 profile 立即生效）

## Capabilities

### New Capabilities

- `agent-role`: 主会话角色管理——通过命令/图形选择器在内存态下为当前 Pi 会话应用 agent 或 sandbox/permission 命名 profile，并同步驱动权限与沙箱策略

### Modified Capabilities

- pi-permission-system（本 monorepo 的 fork 包，无 OpenSpec 主 spec）：新增「子进程 profile 选择固化」行为需求——带启动器标记 `PI_SUBAGENT_PERMISSION_PROFILE_PINNED=1` 的子进程在自身 `session_start` 固化本次启动 pin 的 profile 选择、此后不再读活 env；未标记会话（主会话等）保持惰性读取，所以会话中切 profile 仍在下一决策生效。既有裁决语义（四作用域合并、最严结果优先、fail-closed）不变。该改动是 R7（子代理身份隔离）可成立的必要条件，已获用户明确授权（ask_user 选择「A 彻底修正」），并记入 `packages/pi-permission-system/CHANGELOG.md` 的 Fork-specific deviation。
- pi-subagents（本 monorepo 的 fork 包，无 OpenSpec 主 spec）：子代理启动契约细化——每条子代理启动路径显式 pin（子代理未声明时显式清除）`PI_SUBAGENT_PERMISSION_PROFILE` 并写入标记，后台 runner 的继承 env 剔离该 launcher 专有键；另新增公开 agent 发现 API。两者均记入 `packages/pi-subagents/CHANGELOG.md`。
- pi-sandbox：仅新增 `SandboxService` 注册表与公开导出，不改变既有需求语义。

## Impact

- 新包 `packages/pi-agent-role`：manifest（peerDependencies: @earendil-works/pi-coding-agent、pi-subagents、pi-sandbox，均为可选）+ 扩展代码（命令注册、选择器渲染、内存态、广播、footer）+ 测试 + 文档 + CHANGELOG；versions.json 增加 `pi-agent-role: 0.1.0`
- `packages/pi-sandbox`：新增 `SandboxService` 注册表与公开导出（约 50 行）；version 0.5.0 → 0.6.0
- `packages/pi-subagents`：`src/api/agents.ts` 导出 agent 发现 API（1-2 行）；version 0.12.0 → 0.13.0
- 交互影响：主会话切换角色后权限策略与 sandbox 配置在下一决策/下一 turn 生效；子代理不受影响（子代理的 `<active_agent>` 仍由 pi-subagents 按其自身 agent 注入，且启动器为每条子代理启动显式 pin/清除 `PI_SUBAGENT_PERMISSION_PROFILE` —— 见上 Modified Capabilities）
- 仓库级附带改动（为使门禁诚实、非功能变更）：`pnpm exec prettier --check .` 此前对这 6 个 openspec 主 spec 报格式问题（它们本就不在 `.prettierignore` 中，该文件本次未改动），因此对这 6 个文件做纯空白/换行格式化；`git diff --ignore-all-space` 核对为 14 行空行删除、零内容变更。已获用户确认保留。
- 任务清单口径：目标描述为 17 项，实际 `tasks.md` 为 20 项（提案阶段细化为更小粒度，每项均带可复核证据）；差异已获用户确认保留。
