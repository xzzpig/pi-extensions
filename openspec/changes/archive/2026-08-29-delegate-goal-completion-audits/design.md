## Context

参见 `proposal.md` 的动机以及 `specs/goal-completion-auditing/spec.md` 的行为契约。当前 `pi-goal-x` 在 `runGoalCompletionAuditor()` 内直接创建内存 `AgentSession`，自行处理模型 runtime 复用、资源加载、工具注册、retry 事件、进度工具、取消和文本 verdict 解析。该路径与正常 Pi 启动及 `pi-subagents` 的 agent 配置分离，并且扩展生命周期与清理需要依赖 Pi SDK 内部细节。

`@xzzpig/pi-subagents` 已发布供其他扩展使用的 structured delegation API。它可以运行一个前台、fresh-context、配置驱动的 leaf agent，提供 started/update/response/cancel 事件，支持 schema-validated structured output，并复用普通子代理的模型、tools、extensions、skills、MCP、预算、artifact 和进程生命周期实现。

完成审计在 `update_goal({status:"complete"})` 工具执行期间同步发生，因此调用方必须等待一个确定的终态；现有异步 RPC `spawn` 不适合该控制流。现有目标完成事务、ledger、五阶段审计 dashboard、结果卡片和 Esc 后的用户选择仍由 `pi-goal-x` 拥有。最近新增的 live transcript overlay 与 `/goal-audit` 命令不再保留，详细 child 过程统一交给 `pi-subagents` Fleet。

## Goals / Non-Goals

**Goals:**

- 让 `pi-goal-x` 只负责构造审计任务、调用子代理、投影进度及消费裁决。
- 让审计 agent 使用 `pi-subagents` 已有的模型、工具、扩展、skills 和 MCP 配置语义。
- 以独立 JSON Schema 输出作为唯一批准信号。
- 保持现有完成事务、audit ledger、五阶段 dashboard、结果卡、拒绝反馈和 Esc 绕过选择的语义。
- 删除 goal-owned transcript overlay 与 `/goal-audit`，让 Fleet 成为详细 review 过程的唯一查看入口。
- 提供 `/goal-subagent-eject`，让用户安全地把默认 auditor agent 弹出到 global/project scope 后编辑。
- 对缺失依赖、配置错误、取消、超时和子代理异常提供确定且 fail-closed 的结果。

**Non-Goals:**

- 不在 `pi-goal-x` 中增加通用子代理编排、异步 workflow 或 agent 管理能力。
- 不增加 auditor-specific Pi settings overlay；审计子进程使用正常的全局及受信任项目 Pi settings。
- 不把严格工具白名单描述为操作系统沙箱；`bash` 和可信扩展仍具有其正常进程权限。
- 不保留 embedded `AgentSession` 作为 fallback。
- 不保留或重建 `pi-goal-x` 自有的 live transcript overlay、`/goal-audit`、最近 transcript 状态或 transcript persistence；详细过程使用 Fleet。
- 不删除五阶段 audit dashboard 或最终 result card，它们是 goal 状态的高层摘要，而不是 Fleet 的重复实现。
- 不在本变更中扩展 `pi-subagents` transcript 协议；现有 structured delegation progress 与 Fleet 已满足选定 UI 范围。

## Decisions

### 1. 使用 structured delegation API，而不是模型工具或异步 RPC

`pi-goal-x` 将通过 `@xzzpig/pi-subagents/delegation` 的版本化事件契约发出一个 `SubagentDelegationRequest`。请求使用：

- 随机 `requestId` 标识一次 attempt；
- 当前 goal id 作为 `ownerRunId`；
- 包含完成操作 revision 的 `nodeId`，避免并发完成操作互相取消；
- `context: "fresh"`；
- 配置的 auditor agent 名称，默认 `goal-auditor`；
- 现有目标、任务、验证契约、completion summary 和 warm ledger evidence 组成的 task；
- 固定的 structured result schema；
- 从现有 goal settings 映射得到的可选 model、thinking 和 timeout。

调用方必须先订阅 started/update/response，再 emit request，并只接受 request/owner/node 三元组全部匹配的事件。收到 terminal response 或启动超时后必须释放所有监听器。

选择该 API 是因为它是同步前台 leaf execution，正好匹配完成工具调用；它还提供 schema 输出和精确取消。异步 RPC `spawn` 只能 detached 执行，会把完成事务拆成额外状态机。直接调用模型可见 `subagent` 工具则会形成递归工具协议，并绕过公开的 extension integration contract。

### 2. 随 `pi-goal-x` 发布默认 package agent

新增 `agents/goal-auditor.md`，并通过 package manifest 的 `pi.subagents.agents` 声明。默认定义使用：

- `systemPromptMode: replace`；
- `inheritProjectContext: false`；
- `inheritSkills: false`；
- `extensions: []`，避免默认加载 ambient extensions；
- 通过 `subagentOnlyExtensions` 加载随包发布的轻量 auditor-progress provider；
- `tools: read, grep, find, ls, bash, report_auditor_progress`，其中普通验证工具保持当前能力，进度工具是 dashboard 所需的 package-required 协议能力；
- `acceptanceRole: read-only` 与 `completionGuard: false`；
- 明确禁止修改工作区、管理目标或启动其他子代理的 system prompt。

`bash` 保留是行为兼容取舍，不构成强制只读保证。需要更严格隔离的用户可以在项目/用户 agent override 中删除 `bash`，或加载 `pi-permission-system` 配置命令与路径规则。

当用户以 `pi -e .../goal.ts -e .../pi-subagents/index.ts` 直接加载两个 extension 时，Pi 不会把 `pi-goal-x` 外围目录作为 package 注册给 agent discovery。若默认 `goal-auditor` 因此缺失，或仅以 package source 发现且仍携带相对 child-only provider 路径，Goal-X 会通过 `pi-subagents` 既有的 `PI_SUBAGENT_EXTRA_AGENT_DIRS` 机制 materialize 一个进程私有的默认定义。该定义保留默认 agent 内容，但将 progress provider 重写为绝对包路径；显式 user/project `goal-auditor` 定义始终优先，其他自定义 `auditorAgent` 名称不会触发该 fallback。

用户可以 shadow/eject 该 package agent，或通过 `subagents.agentOverrides` 修改模型、thinking、普通 tools、extensions、skills 及 `mcp:` 选择。`pi-goal-x` 不复制这些配置字段。`report_auditor_progress` 与 `structured_output` 属于完成审计协议所需内部能力；preflight 必须在它们缺失时给出配置错误，而不是静默降级五阶段 dashboard 或 verdict。

### 3. 配置所有权保持单一

`pi-goal-x` settings 新增可选 `auditorAgent`，默认 `goal-auditor`。现有 provider/model/thinkingLevel 继续作为 delegation request override，以保持当前配置兼容；未设置时由 agent 和 `pi-subagents` 默认模型解析决定。

`auditorProjectResources` 标记为废弃：加载时可以继续识别以避免 unknown-key 错误，但不再影响审计资源。状态与文档必须提示用户把资源配置迁移到 auditor agent 的 `extensions`、`subagentOnlyExtensions`、`skills` 和 `tools`。

retry、provider timeout、transport 和网络设置由子 Pi 正常读取 `~/.pi/agent/settings.json` 及受信任项目的 `.pi/settings.json`。不把这些值复制进 goal settings，避免再次形成两套 Pi 配置。

### 4. 结构化 verdict 是唯一完成授权

请求的 JSON Schema 固定为：

```json
{
  "type": "object",
  "properties": {
    "verdict": { "enum": ["approved", "disapproved"] },
    "report": { "type": "string" },
    "findings": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["verdict", "report", "findings"],
  "additionalProperties": false
}
```

`pi-subagents` 的 package-owned `structured_output` 工具负责捕获和验证结果；它不需要出现在用户工具白名单中。只有 terminal status 为 `completed`、结果 kind 为 `structured` 且 verdict 为 `approved` 时，适配器才返回 `approved: true` 给完成流程。

`disapproved` 映射为正常审计拒绝；其他 terminal status、缺失结果或无效数据映射为 audit error。现有 `<approved/>`/`<disapproved/>` parser 删除；`report_auditor_progress` 从内嵌 custom tool 移到 auditor agent 的 child-only provider，以保持五阶段 dashboard。

### 5. 高层进度留在 Goal Widget，详细过程交给 Fleet

started 事件初始化现有 `auditProgress`。默认 auditor agent 通过 child-only `report_auditor_progress` tool 报告阶段 label 与 percentage；`currentToolArgs` 是 `pi-subagents` 的展示摘要，不能被视为原始 JSON 参数。progress provider 因此在 tool-result text 中发送版本化的 machine-readable record。`pi-subagents` foreground executor 必须将真实 Pi 的 `message_end`/`toolResult` 与传统 `tool_result_end` 归一化为一次 bounded `recentOutput` update，并按 `toolCallId` 去重；adapter 只从 `recentOutputLines` 解析该 record，同时映射 `currentTool`、`currentToolArgs`、`model` 和 `durationMs`。内部 record 在 Goal-X dashboard 的近期输出中隐藏。为兼容旧 provider，adapter 也识别现有的可读 progress text。response 将进度置为 done/100%，继续驱动现有五阶段 dashboard 与 result card。展示或参数解析异常不得影响审计 verdict。

删除 `SessionTranscript`、`lastAuditTranscript`、auditor transcript overlay、自动打开/refresh/close 逻辑、`/goal-audit` command 及其测试。`pi-goal-x` 不再消费或保存 child 原生 transcript，也不实现 Fleet 的替代查看器。由于该 transcript 是 `pi-goal-x` 使用 `@xzzpig/pi-components` 的唯一位置，同时移除该 dependency、bundledDependency 和 pack 内容。

structured delegation 仍使用 `pi-subagents` 正常 foreground executor，因此 active/recent child 自动进入 Fleet。用户在 Fleet/transcript 视图查看原生 user/assistant/thinking、工具活动/results、retry 和完整 child 状态；`pi-goal-x` dashboard 只提供 goal completion 相关的五阶段摘要和最终 verdict。

外部 AbortSignal 触发时发送包含完整 request/owner/node identity 的 `SUBAGENT_DELEGATION_CANCEL_EVENT`。调用方继续等待匹配 terminal response，随后复用现有 Esc audit-cancellation 对话框：用户可以明确无审计完成，或保持目标 active 继续工作。取消本身绝不批准目标。

取消一旦发出即成为该 attempt 的终态授权边界：任何随后到达的匹配 response（包括 schema-valid `approved`）都只能收敛为取消结果，不能读取或提交 verdict。无论取消来自用户 Esc/unfocus 还是 terminal timeout，调用方都必须启动有界 cancellation deadline；在 deadline 前没有 terminal acknowledgement 时，系统 fail closed 并清理监听器/timer。用户发起的取消仍进入既有 Esc 选择，timeout 发起的取消仍进入 audit error 路径。

### 6. 依赖和可用性检查 fail closed

`@xzzpig/pi-subagents` 作为 `pi-goal-x` 的运行时 dependency 提供 delegation contract，并要求用户将其 Pi extension 加入已加载 packages。Goal extension 启动本身不内嵌注册 `pi-subagents`，避免用户同时安装两者时发生重复工具和监听器注册。

每次请求设置短的 started/terminal handshake timeout。如果事件总线上没有兼容 bridge 响应，则返回“pi-subagents extension 未加载或版本不兼容”的 audit error。agent、模型、extension 或工具不可用的 preflight/child error 原样归一化为可操作错误，不降级到旧后端或更宽工具集。

版本声明锁定到首次包含当前 structured delegation contract 的兼容范围，并以集成测试覆盖常量、请求 shape 和 terminal status 映射，防止协议漂移。

### 7. 保持完成事务边界不变

`runGoalCompletionFlow()` 仍然拥有 completion_requested、audit_started、audit_result、audit_skipped 和最终 goal mutation。新的 delegation adapter 只返回审计结果和进度，不直接写 goal 文件或 ledger。

这样审计运行替换不会改变 stale-focus 检查、并发 revision token、deferred archival、拒绝后继续工作及用户明确绕过审计的事务语义。

### 8. 兼容性基线是实现与发布 gate

`specs/goal-completion-auditing/spec.md` 中的 `D-*` / `I-*` 编号是实现验收的唯一兼容性索引。实现开始前先运行并保存当前 embedded auditor 的相关测试结果，作为“改造前”可重复基线；实现后使用相同用例语义和新增 delegation 用例验证“改造后”状态。

测试按以下层次覆盖：

1. 纯函数与 schema 单元测试：覆盖结构化 verdict、terminal status 映射和文本伪批准，主要关联 `D-07`、`D-11`、`I-05`、`I-06`、`I-15`。
2. Event-bus adapter 测试：使用可控事件总线覆盖 identity、订阅顺序、handshake、progress tool 参数、cancel 和资源清理，主要关联 `D-01`、`D-02`、`D-08`、`D-10`、`I-12`、`I-14`、`I-16`、`I-17`。
3. Completion-flow 集成测试：覆盖本地 gate、ledger、focus token、完成事务、skip、拒绝、错误、Esc 和手动重试，主要关联 `I-01` 至 `I-11`、`I-15`、`I-18`。
4. 真实或 loader-based child Pi 测试：覆盖 agent discovery、标准 Pi settings、extensions、strict tools、MCP direct tools、progress provider、认证边界、preflight 和 Fleet foreground registration，主要关联 `D-03` 至 `D-06`、`D-08`、`D-09`、`D-12`、`I-04`、`I-13`、`I-17`。
5. Agent-management API/command 测试：覆盖 global/project 目标、交互选择、headless usage、trust、冲突、no-overwrite、portable dependencies、post-eject preflight 和零 goal 副作用，关联 `D-13`。
6. TUI/人工验证：只用于自动化测试无法可靠证明的 Fleet 可见性和终端 result-card 展示；五阶段 dashboard 模型、响应式渲染、timer、command surface、eject 文件行为和 transcript 代码删除必须自动化验证。

测试名称或最终追踪记录必须显式引用对应 ID。实现完成时在 change 目录生成 `compatibility-verification.md`，每行包含：baseline ID、测试文件/用例、执行命令、预期结果、实际结果、PASS/FAIL 及必要证据。一个测试可覆盖多个 ID，但每个 ID 必须至少有一条已执行映射；未覆盖、未执行或失败均阻塞完成。发现未声明差异时，先更新 OpenSpec artifacts 并重新 strict validate，不能只修改测试期望。

### 9. `/goal-subagent-eject` 复用公开的 Agent Management API

`pi-subagents` 新增稳定 export `@xzzpig/pi-subagents/agent-management`，提供结构化 `ejectAgentDefinition({ cwd, agent, scope, projectTrusted })` API。实现从现有 model-facing `eject` handler 中抽取单一 eject service，使两种入口共享 package/builtin source 查找、user/project 目录解析、shadow 优先级、名称冲突和 no-overwrite 规则。公共 API 返回判别式结果，包括 success/error code、scope、source 和 target path；Goal-X 不解析 model tool 文本，也不导入内部 executor。

`/goal-subagent-eject` 固定目标 `goal-auditor`：

- `global` 映射 `pi-subagents` 的 `user` scope，并尊重 `PI_CODING_AGENT_DIR`；
- `project` 映射当前项目 agent scope，且调用前要求 `ctx.isProjectTrusted()`；
- 无参数且 `ctx.hasUI` 时使用 Global/Project selector；取消不执行；
- headless 无参数及所有无效参数只返回 usage；
- 已存在 custom agent、同名 chain 或同名无效文件时拒绝覆盖；
- 成功后通知目标路径和 shadow 关系，下一次审计按正常 discovery 读取新定义；
- 命令全程不调用 goal mutation/service/ledger API。

默认 package agent 包含 progress provider 等相对资源，因此 eject service 不能只证明“文件复制成功”。它必须在目标位置保留可运行性：要么将 path-bearing frontmatter 规范化为可解析的稳定路径，要么 materialize 并重写其依赖；写入后重新 discovery/preflight `goal-auditor`，失败则不得报告成功。现有目标文件始终不覆盖，避免因半成品修复破坏用户配置。

## Risks / Trade-offs

- [子进程启动比内存 session 慢] → 审计是低频完成边界；立即显示 delegation started/update，并保留 timeout 与取消。
- [父进程 runtime-only API key 或动态 provider 不会自动进入子进程] → 使用磁盘认证、环境变量，或在 auditor agent 中加载相同 provider extension；文档明确该边界。
- [默认 `bash` 仍可修改文件] → 明确其非沙箱属性，允许用户从严格白名单移除，并推荐配合 `pi-permission-system`；不以 prompt 约束冒充强制只读。
- [Fleet 成为详细审计 UI 后依赖其可用性] → `pi-subagents` 已是审计运行时硬依赖；集成测试验证 foreground child 在 Fleet 可见，Goal widget 继续提供独立的高层阶段与 verdict，不因 Fleet UI 故障改变事务。
- [progress provider 被用户 override 移除] → 将其声明为 package-required 内部能力并在 preflight 失败时提供修复指引，不静默退化为无阶段 dashboard。
- [删除 `/goal-audit` 与 transcript overlay 是用户可见破坏性变化] → 在 spec 的 `D-08`、README 和 CHANGELOG 明确迁移到 Fleet，并从 command surface baseline 中显式删除。
- [用户只安装 npm dependency 但未加载 Pi extension] → handshake fail closed 并给出安装/配置指引，不挂起完成调用。
- [项目 settings 或 extensions 未因 trust 生效] → 遵循子 Pi 的标准 project-trust 行为，并在缺失工具/扩展错误中指出有效配置来源。
- [外部协议版本变化] → 使用公开 export、兼容版本范围及跨包集成测试；不导入 `pi-subagents` 内部 executor。
- [Ejected agent 的 package-relative 路径可能在新目录失效] → eject service 负责可移植路径/materialization，并以目标 scope 的 discovery + preflight 作为成功条件。
- [用户已有同名定义或文件] → 与现有 `pi-subagents` eject 一致地 fail closed，返回冲突路径，不提供 overwrite 开关。
- [项目命令写入未受信任目录] → project scope 强制检查 `ctx.isProjectTrusted()`；global scope 仍要求显式参数或交互确认。

## Migration Plan

1. 发布带 package agent、child-only progress provider 和 delegation dependency 的 `pi-goal-x`，并在 README/CHANGELOG 标明必须同时加载兼容 `pi-subagents` extension。
2. 将现有 provider/model/thinkingLevel 映射到 delegation request；加入 `auditorAgent`，默认选择随包发布的 `goal-auditor`。
3. 识别但停止应用 `auditorProjectResources`，在 `/goal-status verbose` 和设置文档中给出迁移到 agent 配置的提示。
4. 切换完成审计到 structured delegation，删除 embedded session 与文本 verdict；将 progress tool 移到 child-only provider，保留五阶段 dashboard/result card。
5. 删除 live transcript overlay、`/goal-audit`、最近 transcript state、相关测试和 `@xzzpig/pi-components` 依赖，并记录 Fleet 迁移。
6. 在 `pi-subagents` 提取公开 agent-management eject API，注册 `/goal-subagent-eject`，并验证 global/project 弹出后的定义可发现、可 preflight 且不覆盖现有文件。
7. 在修改运行时代码前执行现有 auditor、completion、settings、dashboard、transcript、command palette 和 Escape 相关测试，并将命令与结果记录为改造前基线。
8. 通过单元、集成和真实子进程测试验证批准、拒绝、配置缺失、工具缺失、retry settings、MCP direct tool、Fleet 可见性、五阶段进度、eject、取消及 ledger/事务行为。
9. 生成 `compatibility-verification.md`，将规格中的每个 `D-*` / `I-*` ID 映射到测试命令和 PASS 证据；任何缺失或失败项阻塞交付。
10. 回滚时恢复上一版本 `pi-goal-x`；本变更不迁移持久 goal/ledger schema，因此不需要数据回滚。
