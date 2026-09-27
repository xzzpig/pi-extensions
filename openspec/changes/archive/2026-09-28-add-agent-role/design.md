## Context

两个既有系统已具备子代理侧的命名 profile 能力：pi-sandbox（`sandbox:` 前端块，profile 仅全局注册，env 传名，`loadConfig({profileName})` 合并）与 pi-permission-system（`permission-profile:` 前端块，profile 作为 [global, project, profile, agent, project-agent] 合并层之一，env 惰性读 + agent 前端块直读，`resolvePermissions` 每次决策时惰性读 `PI_SUBAGENT_PERMISSION_PROFILE` 且 env 参与缓存键）。主会话侧的缺口：pi-permission-system 已有完整的 `active_agent` 身份解析管道（`sessionManager.getEntries()` 读 `{type:'custom', customType:'active_agent'}` 条目，其次 system prompt 标签，最后兜底上次已知名）——主会话一旦获得身份，agent 作用域与 permission-profile 自动生效；pi-sandbox 完全没有主会话 profile 路径（`selectedSandboxProfile` 是模块级只读 env 的一次性常量）。pi-subagents 是 agent 定义的所有者（builtin/package/user/project 发现 + runtime 注册 agent 合并 + 诊断），其公开 API 目前仅导出注册面（`registerAgent`/`registerAgentViaEvents`），未导出发现面。

本设计实现 proposal 的"主会话角色层"：新插件 pi-agent-role 聚合三套数据源，通过图形选择器让用户在内存态下切换 agent 或单个 profile，并经三条既有/新增通道驱动两个系统。

## Goals / Non-Goals

**Goals:**

- 新包 pi-agent-role 作为主会话身份与 profile 的单一所有者（命令、内存态、广播、状态栏）
- 对 pi-permission-system 仅做一处最小改动（子会话在 session_start 固化 launcher env 选择，见 D3）；对 pi-subagents 增加 1-2 行公开导出，另修正子代理启动时的 profile 键固定；对 pi-sandbox 仅新增 SandboxService 服务面
- 复用 pi-subagents 的完整 agent 发现（含 runtime 注册 agent），而非复刻
- 保持既有设计原则：profile 只传名字（raw config 永不跨进程/跨层传输）、profile 注册表仅全局定义、切角色为完整换装

**Non-Goals:**

- B1 完整接管（model/thinking/tools/extensions/systemPrompt 随 agent 切换）——未来可扩展，不在本变更
- 角色状态持久化（内存态是本变更的明确决策）
- 子代理行为的任何改变（子代理身份仍由 pi-subagents 注入）
- 修改 profile 注册表本身（sandbox/permission 的全局注册表及其校验保持原样）

## Decisions

### D1: 新插件包 pi-agent-role 作为角色层，而非改造三个既有包

主会话身份是横切关注点，落在任何既有包都会破坏其单一职责（pi-sandbox 刻意与 pi-subagents 无依赖；pi-permission-system 只消费身份不生产身份）。新包聚合三件事：命令 UI、内存态、广播。替代方案（在 pi-subagents 加主会话命令）被否：pi-subagents 是子代理编排者，其命令面（/run、/subagents-refine）语义都在子代理域内，且会让角色功能受限于子代理插件是否安装。

### D2: agent 发现复用 pi-subagents 公开 API（路径 A）

pi-subagents 的 `discoverAgentsForRuntime`（extension/index.ts）已合并文件发现与 runtime 注册 agent（其他插件通过 `registerAgent`/事件注册的 agent 在列表中）——这是用户明确选择路径 A 的理由。本变更给 `src/api/agents.ts` 增加一个薄导出（转发 `discoverAgentSnapshot`/`discoverAgentsAll` 的运行时合并版本或其最小投影），角色插件经此拿 agent 列表、来源（builtin/package/user/project）与诊断。替代方案（自实现文件发现）被否：会漏掉 runtime 注册 agent，且复制 pi-subagents 的信任/诊断逻辑。

### D3: 权限广播走既有 env 协议 + 子会话固化选择（pi-permission-system 一处最小改动）

两条既有通道恰好覆盖两种切换：

- agent 切换 → `ctx.sessionManager.appendEntry('active_agent', { name })`；清除 → `{ name: null }`（pi SDK 原生 API，pi-agent-router 同款；`getActiveAgentName` 对 null name 返回 null 已处理）
- 显式 permission profile → 写入/清除 `process.env[PI_SUBAGENT_PERMISSION_PROFILE]`（同进程可见；`resolvePermissions` 惰性读 env 且 env 参与缓存键，写后下一决策立即生效）

**隔离不是天然的，需要三处配合（审计指出原前提错误后修正）**：env 是进程级的，而子代理有两类宿主形态——`host:'runner'` 的子进程会继承宿主 env（`async-execution.ts` 以 `process.env` 启动 runner），`host:'parent'` 的同进程内子代理共用同一 `process.env`（launcher 只在创建窗口内存改、随后恢复）。因此：

1. **pi-subagents 固定选择**：每条子代理启动路径都显式 pin 该键（子代理未声明即显式清除），因此 spawn 的子进程与 runner 都不会继承主会话角色，也不会被父会话 env 覆盖自己声明的 profile；runner 的继承 env 另外剥掉 launcher 专有的 profile 键。
2. **pi-permission-system 按 session 固化**：被启动器标记的子进程在自身的 `session_start`（仍在创建窗口内）把 env 选择快照下来，此后不再读活 env；主会话不冻结，继续惰性读取，所以会话中切 profile 仍在下一个决策生效。这同时避免两个同进程内子代理互相覆盖、以及交错 restore 把别人的值留在宿主 env 里。**判定依据是启动器标记 `PI_SUBAGENT_PERMISSION_PROFILE_PINNED=1`，不是子代理检测启发式**：pi-subagents 会在根会话设置 `PI_SUBAGENT_PARENT_SESSION`（供子进程继承），而现有检测把该键当作「本进程是子代理」，若据此冻结会让宿主会话在 session_start 冻住空选择、导致会话中切换 profile 失效（实测复现）。
3. **pi-agent-role 只写 env**：不感知子代理，也不需要新的跨扩展 API。

替代方案（给 permission 系统加显式 setProfile API）仍被否：env 通道语义完整，且修正面小（子代理侧 pin + pps 侧快照）。

### D4: pi-sandbox 新增显式 SandboxService（用户明确要求，不用 env 桥）

pi-sandbox 的 `selectedSandboxProfile` 是模块级一次性读 env 的常量，env 桥需要改读点为惰性且语义上复用 `PI_SUBAGENT_SANDBOX_PROFILE`（子代理专用键名）不清晰。显式服务仿 pi-permission-system 的 `getPermissionsService` 先例（Symbol.for 全局注册表 + session 键）：

- `session_start` 注册、`session_shutdown` 注销（服务注册为可选能力：宿主未暴露会话标识时跳过注册而不得让 session_start 失败，否则会连带失去沙箱初始化）
- `setProfile(name | undefined): Promise<{ ok: boolean; message?: string }>`：异步以便等待重新初始化完成；`validateSandboxProfileName` + 全局注册表存在性校验（经 `loadConfig` 复用全部校验，校验失败不触碰任何状态）→ 失败返回 `{ ok: false, message }` 不改变状态；成功则更新内部选名并刷新配置（`resolveSandboxConfig` 已支持 profileName 参数）；沙箱未启用（`sandboxInitialized === false`）时不强制开启，返回警告消息；已启用但重新初始化失败时返回 `ok: false` 并保持 fail-closed（不静默回退到旧配置）
- `listProfiles()`：读全局 sandbox.json 的 profiles 键（仅名字，非法名跳过不报错，供选择器）
- `getProfile()`：当前选名
- 因此 `selectedSandboxProfile` 由模块级常量改为可变会话状态（env 仍是启动初始值）
  服务在未启用 sandbox 时也可注册（profile 应用与沙箱开关解耦，警告语义见 spec）

### D5: 沙箱未启用时仅应用配置 + 警告（用户决策，替代强制开启）

子代理语义（profile = 不可拒绝的隔离请求）不直接迁移到主会话：主会话的沙箱开关是用户显式控制面（Alt+S、--no-sandbox、/sandbox）。`setProfile` 应用配置但不改开关，返回消息"profile 已应用但沙箱未启用，隔离未生效"，由角色插件以 UI 通知呈现。风险：用户可能误以为已隔离——由明确的警告消息缓解（见 R2）。

### D6: 内存态 + 切 agent 重置显式覆盖（用户决策）

角色状态三个字段（agentName?/sandboxProfile?/permissionProfile?）仅存扩展内存；`/role` 切 agent 时清空两个显式 profile 字段（完整换装）；单独切换只改对应字段。生效配置 = 显式 ?? agent 声明 ?? 无。重启回到 none（footer 清除、无广播残留——env 是进程内变量随进程消亡，appendEntry 条目随会话 JSONL 保留但重启后新会话 entries 不含旧条目……注意：同一 session-dir 重启时旧 `active_agent` 条目可能仍在 entries 中。处理：插件 session_start 时若检测到残留角色条目且非本进程所设，显式清除（appendEntry null）或忽略？——决定：session_start 时无条件重置（appendEntry('active_agent', { name: null }) 若检测到任何 active_agent 条目），保证重启后 none 语义。）

### D7: 信任门仅覆盖项目作用域 agent（用户决策）

判定条件：agent 的 `source === 'project'` 或 `override?.scope === 'project'`（与 add-agent-permission-profiles 的门同款判定）且 `ctx.isProjectTrusted?.() === false` → 拒绝切换并提示。显式 profile 切换无门（注册表仅全局）。复用 pi-subagents 发现结果中的 source 字段，不自行判定路径。

### D8: 底部状态栏用 `ctx.ui.setStatus('role', ...)`，简洁格式（用户决策）

pi SDK 的 `setStatus(key, text | undefined)` 是 footer 多 key 状态机制（pi-sandbox 已用 `'sandbox'` key 展示沙箱状态含 profile 后缀）。角色插件用独立 `'role'` key 展示 `role: worker`（仅 agent 名，profiles 是内部细节；单独切换 profile 时展示对应段：`role: sandbox strict` 或 `role: perm locked`——单一 profile 场景仍一行简洁）。none → `setStatus('role', undefined)` 清除。headless（`ctx.mode !== 'tui'`）跳过，try/catch 吞掉装饰性失败（pi-sandbox 同款容错先例）。

### D9: 选择器渲染用 `ctx.ui.custom`

pi 的 `ctx.ui.custom` 组件渲染（permission prompt 与 pi-sandbox UI 已有成熟先例）。选择器组件：标题 + 可导航列表（jk/↑↓）+ Enter 确认 + Esc 取消 + 当前项高亮 + agent 行的 profile 徽章（`[sandbox: strict] [perm: locked]`，无声明不显示）。无可用项时渲染空态提示。键盘输入经 `onTerminalInput`（pi-sandbox 的 ui.ts 先例）。

## Risks / Trade-offs

- [R1: 广播时序——permission 的 before_agent_start 每次 turn 重载，sandbox 的 profile 在下次配置解析生效；同一 turn 内切换后立刻发生的工具调用可能用旧策略] → 角色插件在命令确认后同步完成全部广播；permission env 写入即时生效（每决策重读），sandbox setProfile 同步刷新内部状态；残余窗口极小且方向是"旧策略多生效一次"，不构成越权。
- [R2: 沙箱未启用时选 profile 的用户误解（以为已隔离）] → 强制警告消息 + footer 状态栏仍显示沙箱关闭状态（pi-sandbox 自有 key），双通道提示。
- [R3: appendEntry 的 active_agent 残留条目（同 session-dir 重启、或与 pi-agent-router 并存）] → D6 的 session_start 重置 + 与 pi-agent-router 共存时以"最后写入者"语义运行（entries 倒序取最近）；文档注明并存行为。
- [R4: 依赖可选性——pi-agent-role 需要 pi-subagents（发现）与 pi-sandbox（服务）为 peerDependencies] → 三包同仓同发布节奏；缺 pi-subagents 时 /role 报"需要 pi-subagents"；缺 pi-sandbox 时 /sandbox-profile 报不可用，其余命令正常。
- [R5: Symbol.for 服务注册表与权限系统同名模式并存（getPermissionsService / getSandboxService）] → 各自独立 Symbol 键、按 sessionId 隔离、注册/注销生命周期对称，遵循既有先例。

## Migration Plan

- 发布顺序：pi-subagents（公开导出，0.13.0）→ pi-sandbox（SandboxService，0.6.0）→ pi-agent-role（0.1.0，依赖前两者为可选 peer）。既有用户升级任一旧包不受影响（新增 API 向后兼容）。
- 无数据迁移：角色状态是内存态，无持久化格式。

## Open Questions

- 选择器是否需要搜索/过滤（agent 数量多时）？可在实现阶段按 UI 复杂度和实际列表规模决定，不影响 spec。
- `/role` 无参详情视图是否同时展示"生效 profile 的来源"（显式 vs agent 声明）？当前设计只显示生效结果，来源展示可后补。
