## Purpose

定义目标完成声明如何由受用户配置约束的独立子代理进行验证，确保审计能够使用标准 Pi 设置、扩展、工具和 MCP 能力，同时只有经过结构化批准的结果才能完成目标。

## ADDED Requirements

### Requirement: 实现范围与 pi-subagents 修改边界

本变更的验收范围 SHALL 限定为 `pi-goal-x` 的完成审计改造，以及从 `pi-subagents` 现有 eject handler 抽取并复用共享 agent-management service 所必需的最小公共导出、适配和测试。用户明确批准的例外仅有：foreground executor 对既有 `message_end`/`toolResult` 与 `tool_result_end` progress event shape 的归一化/去重及直接测试，以及 `preflight.ts` 中 `packageVersion()` 对损坏 package metadata 的 fail-closed 错误包装。后者 MUST NOT 改变其 public async contract、launch 语义或工具计划。除上述范围外，`packages/pi-subagents` 的既有 delegation、preflight、运行时、MCP、skill、Fleet、mission、slash command 和其他实现 SHALL 保持不变。任何超出该边界的 `pi-subagents` 修改 MUST 在交付前还原；非修改范围内产生的额外 lint、warning 或格式问题不属于本变更验收项，也不得以此扩大修改范围。

#### Scenario: 验收变更边界

- **WHEN** 审查本变更的最终工作树和差异
- **THEN** `pi-subagents` 中除 shared eject service 及其直接 public export、必要适配和测试，以及明确批准的 foreground event normalization/去重和 `packageVersion()` fail-closed 错误包装外，不得存在本变更引入的实现差异；范围外 lint/warning 不阻塞本变更

### Requirement: 改造差异与兼容性基线

系统 SHALL 将下列 `D-*` 与 `I-*` 条目作为本次改造的完整行为验收基线。`D-*` 是允许且必须实现的预期差异，`I-*` 是改造后 MUST 保持不变的行为；任何未列入 `D-*` 的可观察行为变化 MUST 视为回归，除非先更新并重新批准本规格。

**预期差异：**

| ID   | 改造前                                                                                                  | 改造后（预期差异）                                                                                                                                   | 验证重点                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | 审计在父 Pi 进程内由独立内存 `AgentSession` 执行                                                        | 审计由 `pi-subagents` 管理的 fresh-context 前台子 Pi 进程执行                                                                                        | 证明请求经过 structured delegation，且父会话历史未复制到 child conversation                                                                                     |
| D-02 | 审计不依赖 `pi-subagents` extension                                                                     | 启用审计要求兼容的 `pi-subagents` extension 已加载                                                                                                   | 缺失或版本不兼容时快速 fail closed，目标保持 active，且无 embedded fallback                                                                                     |
| D-03 | 审计使用独立内存 settings，retry 固定采用 Pi 默认值并忽略用户主会话设置                                 | 审计子进程读取正常的全局及受信任项目 Pi settings                                                                                                     | 自定义 retry 次数、退避、provider timeout 与 transport 在审计中生效                                                                                             |
| D-04 | 资源能力由 `auditorProjectResources` 布尔开关粗粒度控制                                                 | 资源能力由 auditor agent 的 `extensions`、`subagentOnlyExtensions`、`skills` 与继承选项控制                                                          | 默认保持隔离，显式配置的扩展/skill 可用，废弃设置只产生迁移提示                                                                                                 |
| D-05 | 工具集合硬编码为 `read`、`grep`、`find`、`ls`、`bash` 和内部进度工具                                    | 普通工具由 auditor agent 的严格 allowlist 决定；审计进度与结构化输出工具作为 package-required 内部能力提供                                           | 默认普通工具能力等价；用户可收紧或增加普通/extension tool，但不能因 override 丢失 dashboard 与 verdict 所需的内部协议工具                                       |
| D-06 | 固定工具白名单无法向审计模型提供 MCP 工具                                                               | 用户可用 `mcp:<server>` 或 `mcp:<server>/<tool>` 精确选择 MCP direct tools                                                                           | 只暴露解析出的 MCP 工具，不隐式授权其他 MCP 服务或普通工具                                                                                                      |
| D-07 | 审计通过普通文本中的 `<approved/>` / `<disapproved/>` 标记表达裁决                                      | 审计通过 schema-validated `{verdict, report, findings}` 结构化结果表达裁决                                                                           | 文本伪批准、缺失字段和 schema-invalid 结果均不能完成目标                                                                                                        |
| D-08 | `pi-goal-x` 自动打开 live transcript overlay，并通过 `/goal-audit` 在当前 session 内重开最近 transcript | 删除 goal-owned transcript overlay、`/goal-audit`、内存 transcript 状态及其专用依赖；详细 review 过程统一在 `pi-subagents` Fleet/transcript 视图查看 | 命令和 overlay 不再存在，审计不会自动弹窗；Fleet 可查看 child 原生消息、thinking、工具活动/results 和 retry；五阶段 dashboard/result card 按 `I-17`/`I-18` 保持 |
| D-09 | 审计复用父会话 `modelRuntime`，包括 runtime-only API key 和动态 provider                                | 子 Pi 使用磁盘认证、环境变量及自身加载的 provider extensions                                                                                         | 存储认证与环境认证可用；runtime-only 父进程覆盖不会被误称为已继承                                                                                               |
| D-10 | Esc 通过父进程 `AbortController` 直接调用嵌套 session abort                                             | Esc 发送带 request/owner/node 完整 identity 的精确 delegation cancel                                                                                 | 只取消当前审计 attempt，不影响其他子代理，并等待唯一终态                                                                                                        |
| D-11 | 工具、扩展和模型初始化问题通常汇总为嵌套审计错误                                                        | 子代理 preflight 与 terminal status 提供缺失 agent/tool/provider、timeout、budget 等分类错误                                                         | 所有非成功状态都 fail closed，并返回可操作诊断                                                                                                                  |
| D-12 | 审计角色和 system prompt 固定在 `pi-goal-x` 代码中，仅 provider/model/thinking 可配置                   | `pi-goal-x` 发布默认 `goal-auditor` package agent，用户可 shadow、eject 或 override                                                                  | 默认 agent 可发现；自定义 agent 生效；既有 provider/model/thinking override 仍可覆盖请求                                                                        |
| D-13 | 用户必须通过 `pi-subagents` 管理工具或手工创建文件才能复制并定制默认 auditor agent                      | 新增 `/goal-subagent-eject [global\|project]`，可交互选择或显式弹出默认 agent 到 user/project scope                                                  | scope、路径、冲突、project trust、headless usage、可运行性和零 goal 副作用均可验证                                                                              |

**必须保持不变：**

| ID   | 改造前必须保留的功能/行为                                                                                                                                                                                       | 改造后保证                                                                                                                                 | 验证重点                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| I-01 | 只有 active 目标通过本地生命周期、运行归属和任务完成 gate 后才启动审计                                                                                                                                          | SHALL 保持相同前置 gate 与错误结果                                                                                                         | 未满足 gate 时不产生 delegation 请求                                         |
| I-02 | 全局 auditor disabled 和兼容的 per-goal `skipAuditor` 会跳过审计并记录原因                                                                                                                                      | SHALL 保持两条 audit-skipped 完成路径及 ledger 原因                                                                                        | 两种禁用来源都不启动 child，且仍可完成目标                                   |
| I-03 | 审计输入包含目标、任务树、验证契约、详细摘要、近期 ledger evidence；`completion_summary` 仅是 untrusted claim                                                                                                   | SHALL 传递同等语义的显式输入，且 MUST NOT 把执行者声明当作证据                                                                             | task payload 内容与 trust 标记可断言                                         |
| I-04 | 审计不读取或写入父会话历史，默认不继承项目 context、skills 或扩展                                                                                                                                               | 默认 auditor agent SHALL 保持独立上下文与资源隔离                                                                                          | fresh context 且默认 agent inheritance 均关闭                                |
| I-05 | 只有审计明确批准才能进入正常完成事务                                                                                                                                                                            | 只有 schema-valid `approved` SHALL 完成目标                                                                                                | approved report 被记录并进入同一 commit path                                 |
| I-06 | 审计拒绝或运行错误会保持目标 active，并把反馈返回执行者                                                                                                                                                         | SHALL 保持该状态与可重试行为                                                                                                               | disapproved/error 后目标文件和 focus 未被完成或归档                          |
| I-07 | ledger 记录 `completion_requested`、`audit_started` 以及唯一的 `audit_result` 或 `audit_skipped`                                                                                                                | SHALL 保持事件种类、顺序、verdict 语义和单一终态                                                                                           | approved、disapproved、error、skip 各分支均断言 ledger                       |
| I-08 | completion focus token、stale-operation 检查、单一完成事务、stop marker 和 deferred archival 防止并发错误完成                                                                                                   | SHALL 保持事务边界，不允许 child 直接修改 goal 或 ledger                                                                                   | stale focus 不提交；成功仍由原完成事务写入和延迟归档                         |
| I-09 | Esc 后用户可选择“无审计完成”或“继续工作”；取消本身不批准目标                                                                                                                                                    | SHALL 保持两个选择及其既有 goal/ledger 结果                                                                                                | 只有用户明确 bypass 才完成，继续工作保持 active                              |
| I-10 | 临时错误重试耗尽、明确拒绝或审计错误后不会自动重新发起整个 review                                                                                                                                               | SHALL 仍要求后续重新调用 `update_goal({status:"complete"})`                                                                                | 单次请求只产生一个 logical audit attempt，失败后可手动重试                   |
| I-11 | `pi-goal-x` 的 provider/model/thinkingLevel 设置可选择审计模型与 thinking                                                                                                                                       | SHALL 映射为 delegation request override                                                                                                   | 有配置时精确覆盖，无配置时使用 agent/default model                           |
| I-12 | 用户能看到审计开始、运行进度、批准/拒绝/错误结果和 auditor label                                                                                                                                                | SHALL 保持这些状态可观察，允许文案和 transcript 来源按 `D-08` 变化                                                                         | UI/model events 覆盖 started、running、approved、rejected、error             |
| I-13 | 默认不会向审计模型暴露 `edit`、`write`、goal/task 管理工具；`bash` 仍不是强制只读沙箱                                                                                                                           | SHALL 保持默认普通工具安全边界且继续如实说明 `bash` 风险                                                                                   | 默认 registry 断言禁用 mutation/control tools，文档不宣称沙箱                |
| I-14 | progress/transcript observer 异常不会改变审计控制流或 verdict                                                                                                                                                   | SHALL 保持展示层故障隔离                                                                                                                   | 注入 observer 异常后审计结果不变且监听器被清理                               |
| I-15 | 审计批准报告进入完成输出；拒绝报告成为后续执行者可见反馈                                                                                                                                                        | SHALL 保持 report 的用户可见性和后续工作输入语义                                                                                           | completion report 与 rejection message 均包含结构化 report/findings          |
| I-16 | 中止或结束后不会留下当前审计的 AbortSignal listener、动画 timer 或可继续发事件的 session 订阅                                                                                                                   | SHALL 对 delegation listeners、timeout 和取消关联资源提供同等清理保证                                                                      | success、reject、error、timeout、cancel 均验证资源清理                       |
| I-17 | 审计运行时，上方 goal widget 显示五阶段 dashboard：Objective and success criteria、Verification contracts、Tasks and recorded evidence、Workspace inspection、Final decision，并按 20/40/60/80 百分比带依次推进 | SHALL 保持阶段名称、顺序、pending/running/passed/failed 状态、progress bar、auditor label、elapsed time 及展开后的 tool/recent-output 诊断 | 对 0/20/40/60/80/100 和终态 verdict 做模型与渲染断言，并验证响应式宽度不溢出 |
| I-18 | 审计结束后短暂显示 `APPROVED`、`CHANGES REQUIRED` 或 `ERROR` result card，随后恢复正常 goal dashboard；拒绝不会关闭目标                                                                                         | SHALL 保持三类 result card、findings 摘要、约 6 秒恢复和目标状态语义                                                                       | approved/disapproved/error 卡片与 timer 清理后正常 dashboard 均通过测试      |

#### Scenario: 实现全部预期差异

- **WHEN** 候选实现按兼容性基线执行自动化与必要的人工验证
- **THEN** 每个 `D-*` 条目都表现为表中定义的改造后行为，且不存在 embedded auditor 执行路径

#### Scenario: 保持全部兼容行为

- **WHEN** 候选实现执行 approved、disapproved、error、skip、cancel、stale-focus 和 retry-exhausted 基线用例
- **THEN** 每个 `I-*` 条目都保持表中定义的结果、状态、事件和可观察反馈

#### Scenario: 检测未声明的行为变化

- **WHEN** 验证发现改造后的可观察行为与改造前不同且该差异没有对应 `D-*` 条目
- **THEN** 验证 MUST 失败，并在继续实现前更新和重新评审本规格或修复该回归

### Requirement: 基线驱动的测试与验收证据

开发完成后，系统维护者 MUST 以 `D-*` / `I-*` 基线为索引执行测试验证，并生成逐项追踪记录。每个 ID MUST 映射到至少一个测试用例或有理由的人工验证步骤，同时记录测试位置、执行命令、预期结果和实际结果；存在未覆盖、未执行或失败的 ID 时，变更 MUST NOT 标记为完成。

#### Scenario: 全部基线验证通过

- **WHEN** 每个 `D-*` 与 `I-*` ID 都有已执行且通过的验证证据
- **THEN** 验收记录标记所有基线条目通过，并允许变更进入完成评审

#### Scenario: 基线条目缺少证据

- **WHEN** 任一 `D-*` 或 `I-*` ID 没有测试映射、执行结果或必要的人工验证说明
- **THEN** 验收 MUST 失败并列出所有缺失条目

#### Scenario: 测试暴露规格冲突

- **WHEN** 某项基线无法在不改变已批准行为的前提下实现或验证
- **THEN** 维护者 MUST 先修改并重新验证 proposal、spec、design 和 tasks，而不是静默调整测试期望

### Requirement: 保留结构化审计可视化 Dashboard

交互式完成审计运行期间，系统 SHALL 继续在 goal widget 中显示五阶段审计 dashboard。五个阶段 MUST 按 Objective and success criteria、Verification contracts、Tasks and recorded evidence、Workspace inspection、Final decision 的顺序呈现，并根据审计进度依次进入 pending、running、passed 或 failed；dashboard SHALL 保留 auditor identity、elapsed duration、percentage progress bar，以及展开视图中的当前工具、参数和近期输出。审计结束后，系统 SHALL 显示与 verdict 对应的 `APPROVED`、`CHANGES REQUIRED` 或 `ERROR` result card，并在短暂展示后恢复正常 goal dashboard。

#### Scenario: 五阶段进度依次推进

- **WHEN** 审计进度依次达到 0、20、40、60、80 和 100 百分比
- **THEN** 五个阶段按既有百分比带依次从 pending 进入 running/passed，progress bar、auditor label 和 elapsed duration 同步更新

#### Scenario: Host Tool-result Event Shape Is Normalized

- **WHEN** the foreground child host emits a progress tool result as `message_end` with `role: "toolResult"` rather than a separate `tool_result_end` event
- **THEN** `pi-subagents` includes the bounded tool-result record exactly once in the structured delegation update's `recentOutputLines`, and Goal-X uses that record to update the phase and percentage without trusting `currentToolArgs`

#### Scenario: 展开 Dashboard 显示工具诊断

- **WHEN** 审计正在执行工具且用户查看展开的审计 dashboard
- **THEN** dashboard 显示当前工具、受限长度的参数和近期输出，而紧凑视图保持简洁

#### Scenario: 审计结果卡后恢复正常视图

- **WHEN** 审计以 approved、disapproved 或 error 结束
- **THEN** 系统显示对应 result card，disapproved/error 保持目标 active，并在结果展示窗口结束后恢复正常 goal dashboard

#### Scenario: Dashboard 在不同终端宽度内稳定

- **WHEN** 审计 dashboard 或 result card 在受支持的窄屏和宽屏终端渲染
- **THEN** 所有可见行均不超过终端宽度，固定阶段、header 和 verdict 信息不会被裁掉

### Requirement: 详细审计观察统一使用 Fleet

系统 SHALL 移除 `pi-goal-x` 自有的 live transcript overlay、`/goal-audit` command、最近 transcript 内存状态以及仅为该面板存在的 transcript runtime 依赖。交互式审计启动时 MUST NOT 自动打开 goal-owned overlay。审计仍 SHALL 通过 `pi-subagents` 的正常前台运行注册到 Fleet，使用户可在 Fleet 中查看 child 的原生 user/assistant/thinking、工具活动与结果、retry 和终态；`pi-goal-x` 仅保留 `I-17`/`I-18` 定义的高层 dashboard 与 result card。

#### Scenario: 审计启动不再自动弹出 Transcript

- **WHEN** 在具有交互 UI 的 Pi session 中启动完成审计
- **THEN** `pi-goal-x` 不创建或打开 transcript overlay，但五阶段 audit dashboard 正常显示，且对应 child run 出现在 Fleet

#### Scenario: Fleet 查看详细 Review 过程

- **WHEN** 审计 child 正在运行或已有可查看的 Fleet transcript
- **THEN** 用户通过 `pi-subagents` Fleet/transcript 视图查看原生消息、thinking、工具活动/results 和 retry，而不依赖 goal-owned transcript state

#### Scenario: `/goal-audit` 从命令面移除

- **WHEN** Pi 注册 `pi-goal-x` curated commands
- **THEN** `/goal-audit` 不再注册，command palette 与 surface baseline 不再包含该命令

#### Scenario: 删除面板不改变审计事务

- **WHEN** 审计以 approved、disapproved、error 或 cancelled 结束
- **THEN** transcript 面板的移除不改变 verdict、goal 状态、ledger、Esc audit cancellation 或 completion transaction 结果

#### Scenario: Goal 包不再保留 Transcript Runtime

- **WHEN** 构建并打包 `pi-goal-x`
- **THEN** 包内不包含 auditor transcript overlay/测试，不再依赖或 bundle 仅用于该面板的 `@xzzpig/pi-components`，且 GoalCore 不保存最近 transcript

### Requirement: `/goal-subagent-eject` 弹出默认 Auditor Agent

系统 SHALL 注册 curated command `/goal-subagent-eject`，用于把随 `pi-goal-x` 发布的 `goal-auditor` package agent 弹出为可编辑的 global/user 或 project agent，并复用 `pi-subagents` 的 agent discovery、scope、shadow 和冲突规则。命令 MUST 支持显式参数 `global` 与 `project`；无参数且有交互 UI 时 SHALL 提供 Global/Project 选择；无参数或参数无效且无法交互时 MUST 只显示用法且不写文件。命令 MUST NOT 覆盖任何现有 agent/chain/file，MUST NOT 修改 goal、ledger 或审计状态，并且写出的定义 MUST 在目标位置保持可解析、可 preflight 和可启动，包括其 package-relative extension/skill 依赖。

#### Scenario: 显式弹出到 Global Scope

- **WHEN** 用户执行 `/goal-subagent-eject global` 且 global scope 尚无同名自定义 agent 或冲突文件
- **THEN** 系统通过 `pi-subagents` public agent-management API 将 package `goal-auditor` 写入尊重 `PI_CODING_AGENT_DIR` 的 user agents 目录，返回目标路径，并说明它会 shadow package agent

#### Scenario: 显式弹出到 Project Scope

- **WHEN** 用户在受信任项目中执行 `/goal-subagent-eject project` 且 project scope 尚无同名自定义 agent 或冲突文件
- **THEN** 系统将 package `goal-auditor` 写入当前项目配置的 agents 目录，返回目标路径，并说明 project agent 优先于 user/package 定义

#### Scenario: 无参数时交互选择 Scope

- **WHEN** 用户在具有交互 UI 的会话中执行 `/goal-subagent-eject` 且未提供参数
- **THEN** 系统显示 Global 与 Project 两个选项，仅在用户确认其中一个 scope 后执行 eject；取消选择不写文件

#### Scenario: Headless 无参数或参数无效

- **WHEN** 无交互 UI 的调用未提供 scope，或调用提供的参数不是 `global`/`project`
- **THEN** 系统返回 `/goal-subagent-eject global|project` 用法和错误原因，不创建目录或文件

#### Scenario: Project Scope 未受信任

- **WHEN** 用户请求 project scope 但当前 project 未被 Pi 信任
- **THEN** 系统 fail closed，说明需要 project trust，不写入项目配置

#### Scenario: 目标定义或文件已存在

- **WHEN** 目标 scope 已有 `goal-auditor` 自定义 agent、同名 chain 或无法解析的同名文件
- **THEN** 系统拒绝覆盖并返回现有路径或冲突说明，原文件保持逐字节不变

#### Scenario: Ejected Agent 保持可运行

- **WHEN** eject 成功后从目标 scope 重新发现 `goal-auditor`
- **THEN** 发现结果来自目标 scope，system prompt、普通工具配置及 package-required progress/extension 依赖保持有效，并能通过 launch preflight

#### Scenario: Eject 不改变 Goal 状态

- **WHEN** `/goal-subagent-eject` 成功、失败或被用户取消
- **THEN** 当前 goal、focus、runtime、ledger、auditProgress 和 completion 状态均不改变

### Requirement: 独立子代理执行完成审计

当独立审计已启用且收到目标完成请求时，系统 SHALL 启动一个独立的、使用 fresh conversation context 的完成审计子代理，并向其提供目标、任务树、验证契约、执行者声明及与该目标相关的近期证据。系统 MUST NOT 将父会话对话历史作为隐式审计证据传入子代理。

#### Scenario: 启动独立完成审计

- **WHEN** active 目标满足本地完成前置条件且执行者请求完成
- **THEN** 系统启动一个 fresh-context 完成审计子代理，并仅通过明确构造的审计任务传入目标要求与证据

#### Scenario: 审计禁用时保持既有跳过行为

- **WHEN** 用户配置或兼容的目标记录明确禁用独立审计
- **THEN** 系统不启动审计子代理，并按照既有 audit-skipped 完成流程记录原因

### Requirement: 审计运行使用标准子代理配置

系统 SHALL 通过可配置的完成审计 agent 定义解析模型、thinking、skills、extensions、严格工具白名单和 MCP direct-tool 选择。审计子进程 SHALL 使用正常的全局 Pi settings，并仅在项目受信任时使用项目 Pi settings，以便其中的 retry、provider timeout 和 transport 配置适用于审计请求。

#### Scenario: 用户扩展审计工具能力

- **WHEN** 用户为完成审计 agent 配置 `lsp_diagnostics` 及其提供扩展
- **THEN** 审计子代理可以看到并调用 `lsp_diagnostics`，且未列入严格工具白名单的其他工具不可用

#### Scenario: 用户限制 MCP 能力

- **WHEN** 用户仅为完成审计 agent 配置一个 `mcp:<server>/<tool>` 选择
- **THEN** 审计子代理只获得该选择解析出的 MCP direct tool，而不会因该选择自动获得其他 MCP 服务或普通 Pi 工具

#### Scenario: 审计继承 retry 配置

- **WHEN** 有效的全局或受信任项目 Pi settings 修改 retry 次数、退避或 provider timeout
- **THEN** 完成审计子进程使用这些有效设置处理临时模型或网络错误

#### Scenario: 裸 Extension 加载仍可发现默认 Auditor

- **WHEN** 用户以 `-e` 直接加载 `pi-goal-x` 与 `pi-subagents` extension，而未将 `pi-goal-x` 安装为 Pi package，且未配置同名 user/project auditor
- **THEN** `pi-goal-x` SHALL 通过 `pi-subagents` 既有的 extra-agent-dir discovery 暴露一个进程私有的默认 `goal-auditor` 定义，并将其 child-only progress provider 规范化为绝对路径；审计 SHALL 正常开始而不得报 `Unknown agent: goal-auditor`

### Requirement: 审计返回结构化且经过验证的裁决

系统 SHALL 要求完成审计子代理返回符合固定 JSON Schema 的结构化结果，其中包含 `verdict`、`report` 和 `findings`。只有 `verdict` 为 `approved` 且结构化结果验证成功时，系统 SHALL 提交目标完成事务；文本中类似批准标记的内容 MUST NOT 代替结构化结果。

#### Scenario: 结构化批准完成目标

- **WHEN** 审计子代理成功返回 schema-valid 的 `approved` 裁决
- **THEN** 系统记录批准报告并通过现有完成事务将目标标记为 complete

#### Scenario: 结构化拒绝保持目标 active

- **WHEN** 审计子代理成功返回 schema-valid 的 `disapproved` 裁决
- **THEN** 系统记录拒绝报告和 findings，保持目标为 active，并把反馈返回给执行者

#### Scenario: 无效结果不能批准

- **WHEN** 子代理未提交结构化结果、结果不符合 schema 或仅在普通文本中声称批准
- **THEN** 系统将审计视为错误并保持目标为 active

### Requirement: 审计进度和取消保持可观察

系统 SHALL 将子代理 started/update/response 生命周期投影到完成审计的现有进度界面，至少包含当前工具、近期输出、模型和已用时间。用户取消审计时，系统 SHALL 只取消与当前目标完成操作对应的精确审计 attempt，并等待该 attempt 的终态后进入既有的继续工作或用户确认绕过审计流程。

#### Scenario: 显示子代理进度

- **WHEN** 审计子代理启动、调用工具或产生近期输出
- **THEN** 审计界面更新对应的运行状态，且进度观察失败不会改变审计裁决

#### Scenario: Dashboard 显示委派进度

- **WHEN** delegation update 改变审计 phase label 或 percentage
- **THEN** Goal-X 使用该 update 更新既有 dashboard，使五阶段状态、percentage progress bar 和 elapsed duration 反映最新 child progress，而不等待审计终态

#### Scenario: 展示摘要不丢失 Auditor 进度

- **WHEN** 子代理 runtime 将活动工具参数压缩为仅供展示的 `currentToolArgs` 摘要
- **THEN** `report_auditor_progress` SHALL 在其 tool-result text 中携带版本化、可解析的 label/percentage record，Goal-X SHALL 从 delegation update 的近期输出恢复该 record、推进五阶段 dashboard，并且不得将内部 record 显示为审核输出；该 record MUST NOT 授予完成权限或影响 structured verdict

#### Scenario: Esc 取消当前审计

- **WHEN** 用户在审计运行期间按 Esc
- **THEN** 系统向当前 request、owner 和 node 标识的精确 attempt 发送取消请求，不影响其他子代理运行，并在取消确认后显示既有审计绕过选择

#### Scenario: 取消确认缺失时有界收敛

- **WHEN** 用户取消或 terminal timeout 已向精确 attempt 发送取消请求，但 child 在 cancellation deadline 前未发送匹配终态
- **THEN** 系统 SHALL fail closed 地结束该审计、清理 listener/timer；用户取消保持既有 Esc 选择，timeout 取消返回 audit error，二者均不得完成目标

#### Scenario: 取消后迟到批准不能授权完成

- **WHEN** 精确取消请求已发出后，该 attempt 发送 schema-valid `completed`/`approved` response
- **THEN** 系统 SHALL 将 response 视为已取消 attempt 的 acknowledgement，保持目标 active，并且不得读取或提交该结构化 verdict

### Requirement: 审计依赖和运行失败时 fail closed

当完成审计 agent、子代理 runtime、请求的模型、工具、扩展或结构化输出能力不可用，或者子代理失败、超时、被中断或耗尽预算时，系统 SHALL 拒绝完成请求、保持目标为 active，并返回可操作的错误。系统 MUST NOT 静默切换到 embedded auditor、放宽工具配置或将运行错误解释为审计拒绝以外的批准。

#### Scenario: 子代理 runtime 未加载

- **WHEN** 独立审计已启用但兼容的子代理 runtime 未在父 Pi 进程中加载
- **THEN** 系统立即返回明确的依赖错误并保持目标为 active

#### Scenario: 请求工具未注册

- **WHEN** 完成审计 agent 的严格白名单包含未由任何已加载 provider 注册的工具
- **THEN** 审计在首个模型 turn 前失败，错误指出缺失工具及扩展/provider 配置问题

#### Scenario: 子代理运行异常终止

- **WHEN** 审计子代理失败、超时、中断、取消或耗尽 turn/tool budget，且用户未明确选择绕过审计
- **THEN** 系统记录 error 结果、保持目标为 active，并允许后续重新请求完成审计
