## Why

`pi-goal-x` 当前自行创建隔离的 `AgentSession` 来执行完成审计，导致 retry、扩展生命周期、工具白名单和 MCP 能力与用户正常的 Pi/子代理配置脱节，同时重复实现了 `pi-subagents` 已经提供的子进程隔离、能力选择、取消和结构化结果机制。将完成审计交给专用子代理，可以缩小 `pi-goal-x` 的运行时职责，并让审计能力使用统一、可验证的配置入口。

## What Changes

- 使用 `@xzzpig/pi-subagents` 的 structured delegation API 运行完成审计，不再由 `pi-goal-x` 直接创建和管理嵌套 `AgentSession`。
- 随 `pi-goal-x` 发布一个默认的 `goal-auditor` package agent；用户可通过 `pi-subagents` agent 定义或 override 配置审计模型、thinking、extensions、skills、严格工具白名单及 `mcp:<server>/<tool>` 选择。
- 审计子进程读取正常的全局和受信任项目 Pi settings，使 retry、provider timeout、transport 等配置自然适用于审计运行。
- 使用 JSON Schema 约束的结构化审计结果替代 `<approved/>`/`<disapproved/>` 文本标记解析，并将 verdict、报告和 findings 接入现有完成事务与 ledger。
- 将 structured delegation 的 started/update/response/cancel 生命周期映射到现有五阶段 audit dashboard、Esc 取消和完成/拒绝 result card。
- 删除 `pi-goal-x` 自有的 live transcript overlay、`/goal-audit`、最近 transcript state 及仅为该面板使用的 `@xzzpig/pi-components` 依赖；详细 review 过程统一通过 `pi-subagents` Fleet/transcript 查看。
- 新增 `/goal-subagent-eject [global|project]`：显式选择或交互选择 scope，将默认 `goal-auditor` 安全弹出到 user/project agent 目录以供定制，现有目标文件绝不覆盖。
- 在请求的 agent、`pi-subagents` runtime、工具或扩展不可用时 fail closed，保持目标为 active 并返回可操作的配置错误。
- 在 capability spec 中建立带稳定 ID 的“预期差异/必须不变”兼容性矩阵；实现前保存改造前基线，实现后逐项提交测试命令、结果和证据，未覆盖或失败项阻塞交付。
- **BREAKING**：启用独立完成审计时要求兼容版本的 `@xzzpig/pi-subagents` extension 已加载；不保留 embedded auditor fallback。旧的 `auditorProjectResources` 配置不再控制审计资源加载，资源能力改由 `goal-auditor` agent 配置负责。`/goal-audit` 与 goal-owned transcript overlay 被移除，用户改用 Fleet 查看详细审计过程。

## Capabilities

### New Capabilities

- `goal-completion-auditing`: 定义通过受配置约束的专用子代理执行目标完成审计、返回结构化裁决、上报进度、响应取消并在依赖或运行失败时保持目标未完成的行为。

### Modified Capabilities

无。

## Impact

- `packages/pi-goal-x/extensions/goal-auditor.ts` 将从嵌套 session host 重构为 structured delegation 客户端；完成流程、进度状态和测试适配新的事件与结果协议。
- `packages/pi-goal-x` 将新增 package agent 和 child-only progress provider、manifest 声明，并增加对 `@xzzpig/pi-subagents` delegation contract 的版本化运行时前置要求。
- 删除审计专用 `SettingsManager`、`ResourceLoader` 和文本 verdict parser；移除 transcript overlay、`/goal-audit`、最近 transcript state、相关测试及 `@xzzpig/pi-components` dependency/bundle，同时保留五阶段 dashboard 和 result card。
- `packages/pi-subagents` 的现有 structured delegation、agent 配置、工具/MCP 选择、扩展加载和 Fleet 能力成为审计运行及详细观察的权威实现；同时新增稳定的 public agent-management eject API，供 Goal-X 命令与现有管理 action 共用。
- README、设置说明、命令 surface、单元/集成测试和发布依赖需要同步更新；用户需要安装并加载兼容版本的 `@xzzpig/pi-subagents`。
- change 目录将维护最终 `compatibility-verification.md`，逐项证明全部预期差异已实现、全部兼容行为保持不变，且没有未声明回归。
