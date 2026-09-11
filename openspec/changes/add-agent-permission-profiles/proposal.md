## Why

pi-subagents 自定义 agent 前端块中的 `permission:` 键受 pi-subagents 自身验证器约束（只接受平铺的 `工具→allow/ask/deny` 标量，拒绝 bash 规则和嵌套模式映射），无法表达 pi-permission-system 的完整策略面（bash / mcp / skill / external_directory 模式映射、`'*'` 通用兜底）。同时，为不同角色（如 reviewer、yolo-dev、只读委托）复用命名策略块需要一种不重复编写、不绕过验证器的指定方式。

## What Changes

- **Profile 注册表**：pi-permission-system 全局 config.json（`<agentDir>/extensions/pi-permission-system/config.json`）新增 `profiles` 键。每个 profile 是命名的 permission 规则集，语法与前端块 `permission:` 完全一致（工具→决策标量 + bash/mcp/skill/external_directory/special 模式映射 + `'*'` 通用兜底）。项目配置出现 `profiles` 键 → schema 拒绝 → 项目作用域 invalid → fail closed（项目不可定义 profile，镜像 sandbox profile 边界）。
- **前端块引用**：agent 文件（及内置覆盖）新增标量字段 `permission-profile: <name>`。名字格式校验与 sandbox profile 相同（`^[A-Za-z0-9][A-Za-z0-9_-]*$`、≤128 字符、拒绝空值/路径/字面 `false`）。与 `permission:` 可共存：profile 为基底，`permission:` 逐模式覆盖。
- **作用域装配**：profile 作为新作用域插入现有合并管线，序列变为 `[global, project, profile, agent, project-agent]`，完全复用 `mergeScopesWithOrigins` 的逐模式覆盖语义，不新增合并逻辑。规则来源标注 `origin='profile'`，review 日志可溯源。
- **子代理传递**：pi-subagents 启动器注入 `PI_SUBAGENT_PERMISSION_PROFILE` 环境变量；pi-permission-system 子进程解析时 env 优先、前端块直读兜底（对其他注入 `<active_agent>` 标签的扩展如 pi-agent-router 零集成自动生效）。
- **失败语义**：名字非法 → pi-subagents 加载期拒绝（agent not runnable，同 sandbox）；引用了不存在的 profile 或 profile 规则集为空 → invalid **profile 作用域** → `floorAllowsToAsk`（allow 全部钳为 ask）+ 诊断 + review 日志，不拒绝启动。
- **无 inheritGlobalConfig**：逐模式覆盖语义天然保证 profile 未提及的 pattern（含全局 deny）保留，无需继承开关。
- **版本**：pi-permission-system 0.6.0 → 0.7.0，pi-subagents 0.11.0 → 0.12.0（minor）。

## Capabilities

### New Capabilities

- `agent-permission-profiles`: 通过 agent frontmatter 的 `permission-profile` 字段在子代理中应用命名 permission profile，包括全局唯一注册表、作用域合并、env 传递、失败关闭与诊断。

### Modified Capabilities

<!-- 当前 openspec/specs 中没有描述 pi-permission-system 或 agent permission 策略的既有 capability，因此不修改现有 capability。 -->

## Impact

- **packages/pi-permission-system**（fork，0.6.0 → 0.7.0）：`config-schema.ts`（`profiles` 键 schema，全局允许/项目拒绝）、`config-loader.ts`（profiles 解析与合并）、`policy-loader.ts`（前端块提取 `permission-profile`、env 读取）、`permission-manager.ts`（profile 作用域装配、`failClosedScopes` 新增 `'profile'`）、`rule.ts`（`RuleOrigin` 联合类型新增 `'profile'`）、`docs/configuration.md`、测试。
- **packages/pi-subagents**（fork，0.11.0 → 0.12.0）：`agent-serializer.ts`（KNOWN_FIELDS）、`runtime-agent-registry.ts`（校验白名单）、`agents.ts`（解析 + 格式校验 + 序列化）、`child-launch.ts`（env 注入）、`async-resume.ts`（恢复描述符白名单）、`async-status.ts` / `nested-events.ts`（状态投影）、`subagent-runner.ts` / `subagent-executor.ts`（透传）、`agent-management.ts`、`docs/agents.md`、测试。
- **无新运行时依赖**；信任门（项目 agent 文件的 profile 选择仅在项目受信时加载）、缓存戳（profiles 位于全局 config 文件内）与跨会话 ask 转发（0008）均自动继承现有机制，零新代码。
