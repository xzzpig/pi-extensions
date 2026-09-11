## Context

pi-permission-system 现有四作用域策略模型（global config → project config → agent frontmatter → project-agent frontmatter），由 `mergeScopesWithOrigins` 逐 (surface, pattern) 覆盖合并，非全局作用域无效时 `floorAllowsToAsk` 失败关闭；`permission:` 前端块键同时被 pi-subagents 的 `validatePermissionRules` 解析（只收平铺标量、拒绝 bash），富策略只能写在全局/项目 config.json。本设计参照已交付的 add-agent-sandbox-profiles（前端块 `sandbox:` 标量引用 + 全局唯一注册表 + env 传递），为 pi-permission-system 提供同名策略块。动机详见 proposal.md - Why。

## Goals / Non-Goals

**Goals:**

- 在全局 config.json 提供命名的 permission 规则集注册表，供 agent 通过前端块标量字段复用
- 完全复用既有作用域合并管线与失败关闭语义，不引入新合并规则
- 子代理（含 runtime 定义 agent）与第三方 `<active_agent>` 注入者均可指定 profile
- profile 规则在 review 日志中可溯源（新 origin 值）

**Non-Goals:**

- 不提供 profile 内的配置旋钮（yoloMode、wrapperFloors、authorizerChain 等保持全局/项目专属）
- 不提供 inheritGlobalConfig 开关（覆盖语义已保证未提及规则保留）
- 不支持项目定义 profile（硬拒绝）；不支持 profile 继承/组合（v1 平铺）
- 不新增"拒绝启动"机制（权限系统保持 ask 兜底哲学）

## Decisions

### 1. Frontmatter 只选择 profile 名称

agent 文件（及内置覆盖）声明标量 `permission-profile: <name>`，规则永远留在全局注册表。名称校验复用 sandbox 同款（`^[A-Za-z0-9][A-Za-z0-9_-]*$`、≤128、拒绝空值/路径/字面 `false`）。

- 理由：`permission:` 键受 pi-subagents 验证器约束，富语法写不进前端块；标量引用让 pi-subagents 只做格式校验（加载期拒绝非法名，agent not runnable），规则内容由 pi-permission-system 自己解析——agent 文件永不成为权限授予源。
- 备选：允许前端块内嵌对象——被否：与 sandbox 同样的安全边界（角色文件不能成为策略来源）。

### 2. Profile 注册表只存在于全局 config.json

全局配置新增 `profiles: { <name>: { permission: <规则集> } }`，规则集语法与 `permission:` 前端块一致（工具→决策标量、bash/mcp/skill/external_directory/special 模式映射、`'*'` 兜底），解析复用 `normalizeFlatPermissionValue`（非法条目宽容丢弃，与前端块一致）。项目配置出现 `profiles` 键 → 配置 schema 拒绝 → 项目作用域 invalid → `floorAllowsToAsk`。全局 profile 内容无效 → 全局配置整体按既有规则拒绝（空配置 + issues → 全 ask 兜底）。

- 理由：项目不得影响 profile 定义（镜像 sandbox 边界）；全局配置 schema 已校验，坏 profile 走既有失败关闭而非静默。
- 实现要点：`validateUnifiedConfig` 需区分全局/项目（参数化允许 profiles），使项目文件带 `profiles` 时产生 schema 错误。

### 3. Profile 作为独立作用域插入现有合并管线

合并序列变为 `[global, project, profile, agent, project-agent]`，`RuleOrigin` 联合类型新增 `'profile'`。profile 为基底、前端块 `permission:` 逐模式覆盖；未提及的 pattern（含全局 deny）保留。`failClosedScopes` 增加 `'profile'` 分支，消息自然读作 "Invalid profile configuration detected"。

- 理由：用户决策"叠加"语义；完全复用 `mergeScopesWithOrigins`，零新合并代码。
- 备选 A：profile 替换 agent 作用域（互斥）——被用户否。
- 备选 B：跨作用域最严格获胜——被否：破坏前端块逐模式微调能力，且与既有覆盖模型不一致。
- 无 inheritGlobalConfig 的理由：覆盖语义天然保留未提及规则；"纯 profile 策略"留作未来显式开关。

### 4. 传递：启动环境优先，前端块直读兜底

pi-subagents 注入 `PI_SUBAGENT_PERMISSION_PROFILE`（仅名称，原始规则永不传输）。pi-permission-system 解析策略时按 env > 项目 agent 文件 > 全局 agent 文件 的顺序确定 profile 名称。

- 理由：env 来自启动器（已解析、已校验的 agent 定义），覆盖 runtime 定义 agent（无前端块文件）；前端块直读使 pi-agent-router 等其他注入 `<active_agent>` 的扩展零集成生效。
- 备选：仅前端块直读——被否：runtime 定义 agent 无文件，无法生效。

### 5. 未知/空 profile 失败关闭，而非拒绝启动

名字非法 → pi-subagents 加载期拒绝；引用了不存在的 profile 或规则集为空 → invalid `'profile'` 作用域 → `floorAllowsToAsk` + 诊断 + review 日志。

- 理由：权限系统既有哲学是 ask 兜底（headless child 的 ask 转发父会话，人仍在环），系统中没有"拒绝会话"机制；静默忽略 profile 才是真正危险（更宽松策略运行），被显式排除。
- 备选：sandbox 式拒绝启动——被用户否（需新增拒绝会话机制，改动面大）。

### 6. 缓存、信任门、跨会话转发零新代码

- 缓存：profiles 在全局 config 文件内（`getCacheStamp` 的 global 段已覆盖）；profile 名称来自 agent/project-agent 文件（戳已覆盖）或 env（启动时固定）——无需新戳。
- 信任门：项目 agent 文件的 `permission-profile` 仅在项目受信时加载（既有 22.0.0 起行为）。
- 跨会话 0008：服务端 `resolvePermissions(intent.agentName)` 自然包含请求者的 profile（同一 loader/缓存），仅需测试覆盖。

## Risks / Trade-offs

- [全局 config.json 写坏 → 全局配置整体拒绝 → 全 ask] → 既有失败关闭 + 诊断已覆盖；文档补充修复指引
- [profile 与前端块 `permission:` 并存时规则来源混淆] → origin='profile' 溯源 + review 日志可见 + 文档示例
- [空规则集被当作"未提及→继承全局"而静默宽松] → 显式判定为空 = invalid，钳 ask（spec 已固化）
- [env 与前端块双通道不一致] → env 优先 + 单测覆盖双通道一致性（启动器序列化值与文件值同源）
- [pi-subagents 镜像落点遗漏（async-resume 恢复描述符白名单、async-status/nested-events 投影）] → 逐项对照 sandbox 的 13 个落点实现并补测
- [与 yoloMode 组合] → profile 不引入旋钮；yolo 为全局 deny-preserving，组合语义不变，文档注明
- [旧版本互操作] → 字段纯增量：旧 pi-permission-system 不读 env、忽略前端块新键（只取 `permission`），行为等同未声明

## Migration Plan

1. 发布顺序：pi-permission-system 0.7.0 与 pi-subagents 0.12.0 同日发布（无相互依赖的发布期约束；旧版互操作见上）。
2. 无配置迁移：既有全局/项目 config.json 与 agent 文件无需改动（`profiles` 可选、字段增量）。
3. 回滚：移除 env 注入/忽略字段即恢复变更前行为；无需数据迁移。
4. 文档：`docs/configuration.md`（pi-permission-system）与 `docs/agents.md`（pi-subagents）补充 profile 语法、合并顺序与示例。
