# goal-lifecycle Specification

## Purpose

定义 pi-goal-x 的目标生命周期契约：完成审计（独立子代理、结构化裁决、进度可观察、fail-closed）、持久化到会话分支的目标上下文与状态通道、完成审计使用的工作区变更清单与基线，以及 `/goal-clear` 时的回滚选择与执行。

## Requirements

### Requirement: 实现范围与 pi-subagents 修改边界

本变更的验收范围 SHALL 限定为 `pi-goal-x` 的完成审计改造，以及从 `pi-subagents` 现有 eject handler 抽取并复用共享 agent-management service 所必需的最小公共导出、适配和测试。用户明确批准的例外仅有：foreground executor 对既有 `message_end`/`toolResult` 与 `tool_result_end` progress event shape 的归一化/去重及直接测试，以及 `preflight.ts` 中 `packageVersion()` 对损坏 package metadata 的 fail-closed 错误包装。后者 MUST NOT 改变其 public async contract、launch 语义或工具计划。除上述范围外，`packages/pi-subagents` 的既有 delegation、preflight、运行时、MCP、skill、Fleet、mission、slash command 和其他实现 SHALL 保持不变。任何超出该边界的 `pi-subagents` 修改 MUST 在交付前还原；非修改范围内产生的额外 lint、warning 或格式问题不属于本变更验收项，也不得以此扩大修改范围。

#### Scenario: 验收变更边界

- **WHEN** 审查本变更的最终工作树和差异
- **THEN** `pi-subagents` 中除 shared eject service 及其直接 public export、必要适配和测试，以及明确批准的 foreground event normalization/去重和 `packageVersion()` fail-closed 错误包装外，不得存在本变更引入的实现差异；范围外 lint/warning 不阻塞本变更

### Requirement: 改造差异与兼容性基线

系统 SHALL 将下列 `D-*` 与 `I-*` 条目作为本次改造的完整行为验收基线。`D-*` 是允许且必须实现的预期差异，`I-*` 是改造后 MUST 保持不变的行为；任何未列入 `D-*` 的可观察行为变化 MUST 视为回归，除非先更新并重新批准本规格。

**预期差异：**

| ID   | 改造前                                                                                                  | 改造后（预期差异）                                                                                                                                                                                                                                                                                   | 验证重点                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | 审计在父 Pi 进程内由独立内存 `AgentSession` 执行                                                        | 审计由 `pi-subagents` 管理的 fresh-context 前台子 Pi 进程执行                                                                                                                                                                                                                                        | 证明请求经过 structured delegation，且父会话历史未复制到 child conversation                                                                                     |
| D-02 | 审计不依赖 `pi-subagents` extension                                                                     | 启用审计要求兼容的 `pi-subagents` extension 已加载                                                                                                                                                                                                                                                   | 缺失或版本不兼容时快速 fail closed，目标保持 active，且无 embedded fallback                                                                                     |
| D-03 | 审计使用独立内存 settings，retry 固定采用 Pi 默认值并忽略用户主会话设置                                 | 审计子进程读取正常的全局及受信任项目 Pi settings                                                                                                                                                                                                                                                     | 自定义 retry 次数、退避、provider timeout 与 transport 在审计中生效                                                                                             |
| D-04 | 资源能力由 `auditorProjectResources` 布尔开关粗粒度控制                                                 | 资源能力由 auditor agent 的 `extensions`、`subagentOnlyExtensions`、`skills` 与继承选项控制                                                                                                                                                                                                          | 默认保持隔离，显式配置的扩展/skill 可用，废弃设置只产生迁移提示                                                                                                 |
| D-05 | 工具集合硬编码为 `read`、`grep`、`find`、`ls`、`bash` 和内部进度工具                                    | 普通工具由 auditor agent 的严格 allowlist 决定；审计进度与结构化输出工具作为 package-required 内部能力提供                                                                                                                                                                                           | 默认普通工具能力等价；用户可收紧或增加普通/extension tool，但不能因 override 丢失 dashboard 与 verdict 所需的内部协议工具                                       |
| D-06 | 固定工具白名单无法向审计模型提供 MCP 工具                                                               | 用户可用 `mcp:<server>` 或 `mcp:<server>/<tool>` 精确选择 MCP direct tools                                                                                                                                                                                                                           | 只暴露解析出的 MCP 工具，不隐式授权其他 MCP 服务或普通工具                                                                                                      |
| D-07 | 审计通过普通文本中的 `<approved/>` / `<disapproved/>` 标记表达裁决                                      | 审计通过 schema-validated `{verdict, report, findings}` 结构化结果表达裁决                                                                                                                                                                                                                           | 文本伪批准、缺失字段和 schema-invalid 结果均不能完成目标                                                                                                        |
| D-08 | `pi-goal-x` 自动打开 live transcript overlay，并通过 `/goal-audit` 在当前 session 内重开最近 transcript | 删除 goal-owned transcript overlay、`/goal-audit`、内存 transcript 状态及其专用依赖；详细 review 过程统一在 `pi-subagents` Fleet/transcript 视图查看                                                                                                                                                 | 命令和 overlay 不再存在，审计不会自动弹窗；Fleet 可查看 child 原生消息、thinking、工具活动/results 和 retry；五阶段 dashboard/result card 按 `I-17`/`I-18` 保持 |
| D-09 | 审计复用父会话 `modelRuntime`，包括 runtime-only API key 和动态 provider                                | 子 Pi 使用磁盘认证、环境变量及自身加载的 provider extensions                                                                                                                                                                                                                                         | 存储认证与环境认证可用；runtime-only 父进程覆盖不会被误称为已继承                                                                                               |
| D-10 | Esc 通过父进程 `AbortController` 直接调用嵌套 session abort                                             | Esc 发送带 request/owner/node 完整 identity 的精确 delegation cancel                                                                                                                                                                                                                                 | 只取消当前审计 attempt，不影响其他子代理，并等待唯一终态                                                                                                        |
| D-11 | 工具、扩展和模型初始化问题通常汇总为嵌套审计错误                                                        | 子代理 preflight 提供缺失 agent/tool/provider、timeout、budget 等分类错误；对运行时注册 agent 做运行时感知回退（磁盘视图 `missing_agent` 时以 `discoverAgentsWithRuntime` 合并视图解析并校验协议工具），只有真正解析不到才 fail closed，裸 `pi -e` 会话中运行时注册的默认 auditor 正常通过 preflight | 所有非成功状态都 fail closed 且返回可操作诊断；运行时注册的默认 auditor 不再报 `Unknown agent: goal-auditor`                                                    |
| D-12 | 审计角色和 system prompt 固定在 `pi-goal-x` 代码中，仅 provider/model/thinking 可配置                   | 默认 `goal-auditor` 由 `pi-goal-x` 在 `session_start` 通过 pi-subagents 运行时注册契约注册（定义由代码持有）；用户通过嵌套 `auditor.*` 定义层合并定制，或以 `auditor.agent` 选择完全自定义的 agent                                                                                                   | 默认 agent 无需包内 markdown 即可发现；定义层合并规则生效；既有 provider/model/thinking override 仍可覆盖请求                                                   |
| D-13 | 用户必须通过 `pi-subagents` 管理工具或手工创建文件才能复制并定制默认 auditor agent                      | 内容定制统一走嵌套 `auditor.*` 设置（提示注入层与定义层）；`/goal-subagent-eject` 命令移除；此前 eject 出的 user/project `goal-auditor.md` 继续以配置 agent 身份生效                                                                                                                                 | 配置注入的各块按固定顺序渲染并转义；`/goal-subagent-eject` 不再注册；存在同名配置 agent 时运行时注册被跳过且审计使用该 agent                                    |
| D-14 | 提示注入与定义定制能力不存在，审计任务 prompt 完全固定                                                  | 新增提示注入层：`checklist`（整体替换默认清单）、`checklistExtra`、`evidenceRequests`、`strictness`（strict/lenient 注入对应姿态文本）、`instructions`（`<operator_instructions>` 块）、`reportFormat`（报告格式要求），按固定顺序渲染在审计清单之后                                                 | 全部转义后注入；未设置任一字段时任务 prompt 与改造前字节一致；清单替换后协议尾两行（进度上报与 structured_output 裁决约定）仍然保留                             |

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
| I-09 | Esc 后用户可选择"无审计完成"或"继续工作"；取消本身不批准目标                                                                                                                                                    | SHALL 保持两个选择及其既有 goal/ledger 结果                                                                                                | 只有用户明确 bypass 才完成，继续工作保持 active                              |
| I-10 | 临时错误重试耗尽、明确拒绝或审计错误后不会自动重新发起整个 review                                                                                                                                               | SHALL 仍要求后续重新调用 `update_goal({status:"complete"})`                                                                                | 单次请求只产生一个 logical audit attempt，失败后可手动重试                   |
| I-11 | `pi-goal-x` 的 provider/model/thinkingLevel 设置可选择审计模型与 thinking                                                                                                                                       | SHALL 映射为 delegation request override                                                                                                   | 有配置时精确覆盖，无配置时使用 agent/default model                           |
| I-12 | 用户能看到审计开始、运行进度、批准/拒绝/错误结果和 auditor label                                                                                                                                                | SHALL 保持这些状态可观察，允许文案和 transcript 来源按 `D-08` 变化                                                                         | UI/model events 覆盖 started、running、approved、rejected、error             |
| I-13 | 默认不会向审计模型暴露 `edit`、`write`、goal/task 管理工具；`bash` 仍不是强制只读沙箱                                                                                                                           | SHALL 保持默认普通工具安全边界且继续如实说明 `bash` 风险                                                                                   | 默认 registry 断言禁用 mutation/control tools，文档不宣称沙箱                |
| I-14 | progress/transcript observer 异常不会改变审计控制流或 verdict                                                                                                                                                   | SHALL 保持展示层故障隔离                                                                                                                   | 注入 observer 异常后审计结果不变且监听器被清理                               |
| I-15 | 审计批准报告进入完成输出；拒绝报告成为后续执行者可见反馈                                                                                                                                                        | SHALL 保持 report 的用户可见性和后续工作输入语义                                                                                           | completion report 与 rejection message 均包含结构化 report/findings          |
| I-16 | 中止或结束后不会留下当前审计的 AbortSignal listener、动画 timer 或可继续发事件的 session 订阅                                                                                                                   | SHALL 对 delegation listeners、timeout 和取消关联资源提供同等清理保证                                                                      | success、reject、error、timeout、cancel 均验证资源清理                       |
| I-17 | 审计运行时，上方 goal widget 显示五阶段 dashboard：Objective and success criteria、Verification contracts、Tasks and recorded evidence、Workspace inspection、Final decision，并按 20/40/60/80 百分比带依次推进 | SHALL 保持阶段名称、顺序、pending/running/passed/failed 状态、progress bar、auditor label、elapsed time 及展开后的 tool/recent-output 诊断 | 对 0/20/40/60/80/100 和终态 verdict 做模型与渲染断言，并验证响应式宽度不溢出 |
| I-18 | 审计结束后短暂显示 `APPROVED`、`CHANGES REQUIRED` 或 `ERROR` result card，随后恢复正常 goal dashboard；拒绝不会关闭目标                                                                                         | SHALL 保持三类 result card、findings 摘要、约 6 秒恢复和目标状态语义                                                                       | approved/disapproved/error 卡片与 timer 清理后正常 dashboard 均通过测试      |
| I-19 | 审计任务 prompt 未配置任何 `auditor.*` 提示注入字段时的内容                                                                                                                                                     | SHALL 与未提供嵌套设置组时字节一致（沿用 change manifest 的既有约定）                                                                      | 以 resolved-but-unset 设置与无设置两种输入断言 prompt 逐字节相等             |
| I-20 | 审计协议尾：`report_auditor_progress` 阶段上报约定与 structured_output 裁决约定                                                                                                                                 | SHALL 在任何清单替换或注入组合下保留；定义合并后进度工具 MUST 保留在有效 allowlist                                                         | 清单整体替换、excludeTools 剔除等场景断言协议尾与 preflight 结果             |
| I-21 | 此前 `/goal-subagent-eject` 产出的 user/project 作用域 `goal-auditor.md`                                                                                                                                        | SHALL 继续被发现并生效；运行时注册在检测到同名配置 agent 时 MUST 跳过且不产生告警副作用                                                    | 存在 user/project 同名 md 时注册跳过、审计解析到该 agent                     |

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

### Requirement: 独立子代理执行完成审计

当独立审计已启用且收到目标完成请求时，系统 SHALL 启动一个独立的、使用 fresh conversation context 的完成审计子代理，并向其提供目标、任务树、验证契约、执行者声明、与该目标相关的近期证据，以及在该执行窗口内可用时的工作区变更清单。系统 MUST NOT 将父会话对话历史作为隐式审计证据传入子代理。

工作区变更清单 SHALL 作为机器采集的工作区证据标注，其性质 SHALL 与执行者声明明确区分：执行者声明 MUST 保持 untrusted 标记，清单的出现 MUST NOT 软化、替代或弱化该标记，且审计员 MUST 仍以实际仓库内容核验清单条目。当变更清单不可用（非 git 仓库、采集失败或用户已关闭采集）时，审计输入的组成 SHALL 与今天完全一致。

#### Scenario: 启动独立完成审计

- **WHEN** active 目标满足本地完成前置条件且执行者请求完成
- **THEN** 系统启动一个 fresh-context 完成审计子代理，并仅通过明确构造的审计任务传入目标要求与证据

#### Scenario: 审计禁用时保持既有跳过行为

- **WHEN** 用户配置或兼容的目标记录明确禁用独立审计
- **THEN** 系统不启动审计子代理，并按照既有 audit-skipped 完成流程记录原因

#### Scenario: 审计输入包含工作区变更清单

- **WHEN** active 目标在其执行窗口内存在可用的工作区变更清单
- **THEN** 审计任务包含该清单，且清单按仓库分段、附有可直接执行的展开命令，并被标注为机器采集的工作区证据

#### Scenario: 变更清单不改变信任边界

- **WHEN** 审计任务同时包含执行者完成声明与工作区变更清单
- **THEN** 执行者声明仍标注为 untrusted claim，且清单不被表述为可替代执行者声明、可替代仓库核验或可单独构成批准依据的证据

#### Scenario: 变更清单不可用时输入不变

- **WHEN** goal 运行在非 git 仓库中、基线采集失败，或用户关闭了变更清单采集
- **THEN** 审计任务不包含任何清单块，其余输入组成与今天完全一致

### Requirement: 审计运行使用标准子代理配置

系统 SHALL 通过可配置的完成审计 agent 定义解析模型、thinking、skills、extensions、严格工具白名单和 MCP direct-tool 选择。审计子进程 SHALL 使用正常的全局 Pi settings，并仅在项目受信任时使用项目 Pi settings，以便其中的 retry、provider timeout 和 transport 配置适用于审计请求。

默认 `goal-auditor` agent SHALL 由 `pi-goal-x` 在会话启动时通过 pi-subagents 的运行时注册契约（`pi-subagents:runtime-agent-register:v1`）注册，定义由代码持有：system prompt 为规范审计原则文本，普通工具为严格 allowlist，child-only 进度提供器以绝对路径引用。注册 SHALL 遵循 pi-subagents 的运行时代理碰撞语义：运行时 agent 与任何已发现配置 agent（builtin/package/user/project）同名时在发现期报错而非遮蔽，因此 `pi-goal-x` MUST 在注册前探测同名配置 agent，仅在结果为 `missing_agent`（名字空闲）时注册；探测结果为其他失败码（如工具校验失败）或 pi-subagents 未加载时 MUST 跳过注册且不产生会话级告警副作用，由审计时的既有 preflight 错误路径给出可操作诊断。注册句柄 SHALL 在会话关闭时释放，并在重新注册前释放旧句柄。

设置中的定义定制层（`systemPromptExtra`、`extensions`、`subagentOnlyExtensions`、`skills`、`skillPath`、`tools`、`excludeTools`、`mcpDirectTools`、`defaultReads`、`inheritProjectContext`、`inheritSkills`、`sandbox`、`permissionProfile`）SHALL 在注册时合并进默认定义：`systemPromptExtra` 追加到 system prompt；`subagentOnlyExtensions` 与必需进度提供器取并集且进度提供器保留在前；`tools` 替换普通白名单时 MUST 自动并回 `report_auditor_progress`，`excludeTools` 在其后剔除；其余列表字段提供即替换；继承布尔字段提供即覆盖（默认保持隔离）；`sandbox`/`permissionProfile` 是两个 pi-subagents fork 的命名 profile 选择器（分别指向全局 `pi-sandbox` 配置的 profile 与全局 `pi-permission-system` 配置的 `profiles` 注册表），提供即覆盖、缺省即不设置。合并后的定义仍 MUST 通过 pi-subagents 的注册校验与审计 preflight 校验；定义定制仅影响默认 agent，`auditor.agent` 指向自定义 agent 时其定义由该 agent 自身拥有。

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
- **THEN** `pi-goal-x` SHALL 在 session_start 通过运行时注册契约注册默认 `goal-auditor`（child-only 进度提供器以绝对路径引用），无需包内 markdown、extra-agent-dir 物化或包发现声明；审计 SHALL 正常开始而不得报 `Unknown agent: goal-auditor`

#### Scenario: 同名配置 Agent 存在时跳过注册

- **WHEN** 会话启动时 user 或 project 作用域已存在 `goal-auditor` 配置 agent（例如旧 eject 产物），或 preflight 以 `missing_agent` 之外的原因结束
- **THEN** 系统 MUST 跳过运行时注册、不修改任何文件，审计解析到该配置 agent；注册失败不产生会话级通知，审计时的 preflight 路径仍返回可操作错误

#### Scenario: 定义合并不得破坏协议工具

- **WHEN** 用户以 `tools` 替换普通白名单、以 `excludeTools` 剔除工具，或同时省略进度工具
- **THEN** 合并后的定义 MUST 保留 `report_auditor_progress`，`structured_output` 继续由包内协议提供； effective allowlist 丢失任一协议工具时审计 preflight 在首个模型 turn 前 fail closed 并给出可操作错误

#### Scenario: 审计 profile 选择器合并进默认定义

- **WHEN** 用户设置 `auditor.sandbox` 与/或 `auditor.permissionProfile`（每个均为 pi-subagents fork 的命名 profile 选择器），且名字空闲时注册默认 agent
- **THEN** 注册合并后的定义携带对应的 `sandbox`/`permissionProfile` 标量：子进程通过 `pi-sandbox`/`pi-permission-system` 全局配置施加所选 profile；选择器只传裸名，系统绝不在 settings 或定义中接受内联策略

#### Scenario: profile 选择器校验与 fail-closed

- **WHEN** `auditor.sandbox`/`auditor.permissionProfile` 不是合法 profile 名（带空白、字面 `false`、超长或含非法字符），或指向的 profile 包（`pi-sandbox`/`pi-permission-system`）未安装、profile 未知
- **THEN** settings 解析层对非法名给出 `invalid_value` diagnostic 且不落盘；合法但缺包/未知 profile 时由 pi-subagents 的注册校验与审计启动路径 fail closed，审计不 launch 并返回可操作错误，绝不静默退化为未选择 profile 的基线

#### Scenario: 注册句柄随会话生命周期释放

- **WHEN** 会话关闭，或同一扩展运行时内发生重新注册（新会话/reload）
- **THEN** 系统释放（dispose）当前注册句柄后再注册新句柄，不产生同名运行时 agent 碰撞

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

系统 SHALL 将子代理 started/update/response 生命周期投影到完成审计的现有进度界面，至少包含当前工具、近期输出、模型和已用时间。用户中断审计（Esc）时，系统 SHALL **挂起（park）**与当前目标完成操作对应的精确审计 attempt 而非取消：子代理 MUST 保持运行、该 attempt 的事件监听 MUST 保留、系统 MUST NOT 发送取消请求，随后系统 SHALL 显示既有审计绕过选择。用户选择**继续审计**时，系统 SHALL 复用**同一**子代理 attempt 并等待其终态后进入既有批准/拒绝裁决流程；用户选择**直接完成**时，系统 SHALL 才向该精确 attempt 发送取消请求并等待其终态，然后按既有绕过流程标记目标完成。审计挂起且弹窗打开期间焦点丢失时，系统 SHALL 取消该 attempt 以防止孤儿子代理继续运行，并返回既有取消/焦点丢失结果、不得完成目标。审计 terminal timeout SHALL 继续作为挂起期间的防挂死兜底。审计总时长上限 SHALL 可通过 Goal-X 分层设置项 `auditorTimeoutMs` 配置：该值 MUST 为正整数毫秒且不超过 2_147_483_647（Node timer 安全上限）；project 层配置 SHALL 覆盖 global 层。系统 SHALL 将解析后的 `auditorTimeoutMs` 同时应用于审计委派 request 的运行时限与本地 terminal timer，二者 MUST 使用同一有效值。未设置或取值非法（非正整数、超过上限）时，系统 SHALL 回退到内建默认值 30 分钟，行为与未提供本设置项时完全一致。5 秒启动握手与 5 秒取消确认两个防挂死兜底 SHALL 保持内部固定值，MUST NOT 受 `auditorTimeoutMs` 或其他设置项影响。

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
- **THEN** 系统挂起该精确 attempt：不发送取消请求、不拆除事件监听、不影响其他子代理运行，并显示既有审计绕过选择

#### Scenario: 继续审计复用同一子代理

- **WHEN** 用户在 Esc 弹窗选择“继续审计”
- **THEN** 系统复用同一子代理 attempt 继续等待其终态，子代理的全部既有上下文与审计进度得以保留；approved 进入既有批准流程，disapproved 进入既有拒绝流程，目标在裁决前保持 active

#### Scenario: 直接完成时才取消

- **WHEN** 用户在 Esc 弹窗选择“直接完成（跳过审计）”
- **THEN** 系统才向该精确 attempt 发送取消请求并等待其终态，然后按既有绕过流程记录 `audit_skipped` 并标记目标完成

#### Scenario: 挂起期间焦点丢失

- **WHEN** 审计挂起且弹窗打开期间用户改变了目标焦点（例如 `/goal-unfocus`）
- **THEN** 系统取消该挂起 attempt 防止孤儿子代理继续运行，并返回既有取消/焦点丢失结果，不得完成目标

#### Scenario: 取消确认缺失时有界收敛

- **WHEN** 用户取消或 terminal timeout 已向精确 attempt 发送取消请求，但 child 在 cancellation deadline 前未发送匹配终态
- **THEN** 系统 SHALL fail closed 地结束该审计、清理 listener/timer；用户取消保持既有 Esc 选择，timeout 取消返回 audit error，二者均不得完成目标

#### Scenario: 取消后迟到批准不能授权完成

- **WHEN** 精确取消请求已发出后，该 attempt 发送 schema-valid `completed`/`approved` response
- **THEN** 系统 SHALL 将 response 视为已取消 attempt 的 acknowledgement，保持目标 active，并且不得读取或提交该结构化 verdict

#### Scenario: 挂起期间子代理已完成

- **WHEN** 审计挂起且弹窗打开期间，子代理产生了终态（approved/disapproved/失败）
- **THEN** 用户选择“继续审计”时系统 SHALL 立即获得该终态并进入既有裁决流程（不得重启子代理或重新审计）；用户选择“直接完成”时系统 SHALL 不将该终态当作裁决提交，按绕过流程记录 `audit_skipped` 且不产生重复的 `audit_result`

#### Scenario: 挂起超时按 fail closed 收敛

- **WHEN** 审计挂起且弹窗打开期间，审计 terminal timeout 到期
- **THEN** 系统 SHALL 照常向该 attempt 发送取消请求并按 fail closed 结束；用户选择“继续审计”时获得该超时取消的 error 终态、目标保持 active，不完成目标

#### Scenario: 恢复阶段重复中断不生效

- **WHEN** 用户已选择“继续审计”且正在等待同一子代理终态时再次按 Esc
- **THEN** 系统 SHALL 不中断该审计（键被消费但不动作），审计继续运行至终态

#### Scenario: 配置的审计时长上限生效

- **WHEN** 用户在 Goal-X global 或受信任 project 设置中将 `auditorTimeoutMs` 配置为 7200000（2 小时）
- **THEN** 完成审计委派 request 的运行时限与本地 terminal timer 均使用 7200000 毫秒，审计在 30 分钟处不再被中断，超时 fail closed 行为改在该上限处发生

#### Scenario: 未设置时保持默认上限

- **WHEN** 用户未在任何层配置 `auditorTimeoutMs`
- **THEN** 完成审计使用内建默认 30 分钟上限，行为与引入本设置项之前完全一致

#### Scenario: 非法值回退默认

- **WHEN** `auditorTimeoutMs` 被配置为负数、零、非整数、超过 2_147_483_647 的值或其他非正整数毫秒值
- **THEN** 系统拒绝该取值并回退到默认 30 分钟上限，同时提供可操作的设置诊断，审计不得因非法配置而无法启动

#### Scenario: project 层覆盖 global 层

- **WHEN** global 层将 `auditorTimeoutMs` 配置为 3600000，受信任 project 层将其配置为 7200000
- **THEN** 该项目内的完成审计使用 project 层的 7200000，其他项目继续使用 global 层的 3600000

#### Scenario: 防挂死兜底不受配置影响

- **WHEN** 用户将 `auditorTimeoutMs` 配置为任意合法值（包括远小于 5 秒或远大于 30 分钟的值）
- **THEN** 审计委派的启动握手时限与取消确认时限保持内部固定短时限，不随 `auditorTimeoutMs` 缩放

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

### Requirement: 完整目标上下文通道

系统 SHALL 在以下时机向会话分支追加一条 `pi-goal-context-event` 消息，内容为完整的目标上下文（目标、验证契约、生命周期策略与任务树），并以 `display: false` 写入：

- 目标创建时，`reason` 为 `"created"`；
- 会话压缩之后，`reason` 为 `"compacted"`（压缩摘要会吃掉此前的副本）；
- 会话载入且该分支在最后一次压缩之后没有副本时，`reason` 为 `"rehydrated"`；
- 目标被调整之后，`reason` 为 `"tweaked"`。

消息 details SHALL 为 `{ version: 1, kind: "context", goalId, revision, reason, timestamp }`。

该消息 SHALL 以追加方式持久化且永不重写，SHALL NOT 触发新的 agent 回合；写入失败 SHALL 只记录错误，不得中断会话。没有聚焦目标或目标已完成时 SHALL 不发送。

#### Scenario: 目标创建时发送完整上下文

- **WHEN** 用户创建一个目标
- **THEN** 会话分支追加一条 `pi-goal-context-event` 消息，`reason` 为 `"created"`，内容含目标、验证契约、生命周期策略与任务树

#### Scenario: 压缩后重发完整副本

- **WHEN** 会话发生压缩
- **THEN** 追加一条 `reason` 为 `"compacted"` 的完整上下文消息（完整副本而非增量）

#### Scenario: 分支缺少副本时在载入时重发

- **WHEN** 会话载入，且分支在最后一次压缩之后没有目标上下文副本
- **THEN** 追加一条 `reason` 为 `"rehydrated"` 的完整上下文消息

#### Scenario: 目标调整后重发

- **WHEN** 用户在目标草稿阶段调整了目标
- **THEN** 追加一条 `reason` 为 `"tweaked"` 的完整上下文消息

#### Scenario: 已完成目标不再发送

- **WHEN** 没有聚焦目标，或聚焦目标的状态为 `complete`
- **THEN** 不追加任何完整上下文消息

#### Scenario: 写入失败不中断会话

- **WHEN** 追加消息时抛出异常
- **THEN** 错误被记录，会话继续运行

### Requirement: 每回合状态快照通道

系统 SHALL 每个回合至多追加一条 `pi-goal-state-event` 状态快照，且 SHALL 按以下路径分发：

- 自动续跑路径：在每个 v2 checkpoint 标记之前发送，并把 `checkpointSeq` 与该标记配对；
- 用户驱动的回合：作为 `before_agent_start` 的消息返回值发送。

快照 SHALL 以 `display: false` 写入，details 为 `{ version: 3, kind: "state", goalId, revision, checkpointSeq?, timestamp }`；`checkpointSeq` 仅在续跑路径上有意义。

快照 SHALL 在写入后永不被重写，以保证请求上下文只追加、对提示缓存友好。没有聚焦目标或目标已完成时 SHALL 不产生快照。

#### Scenario: 用户回合产生一条快照

- **WHEN** 存在聚焦目标且用户提交一个回合
- **THEN** 该回合通过 `before_agent_start` 的消息返回值携带一条状态快照

#### Scenario: 续跑路径在标记前产生快照

- **WHEN** 自动续跑触发一个 v2 checkpoint
- **THEN** 在该 checkpoint 标记之前追加一条状态快照，其 `checkpointSeq` 与该标记配对

#### Scenario: 同一回合不重复

- **WHEN** 一个回合已经产生状态快照
- **THEN** 该回合不再追加第二条快照

#### Scenario: 已完成目标无快照

- **WHEN** 目标状态为 `complete` 或没有聚焦目标
- **THEN** 不产生状态快照

### Requirement: 一次性引导通道

系统 SHALL 用 `pi-goal-steering-event` 承载不属于每回合状态的一次性引导说明（例如存在未聚焦目标时的提示），以 `display: false` 写入，details 为 `{ reason, timestamp }`。

同一情形 SHALL 只发送一次（边缘触发）；该情形解除（例如目标重新聚焦）后 SHALL 允许再次发送。写入失败 SHALL 不影响会话载入或聚焦切换。

#### Scenario: 首次出现未聚焦目标时发送一次

- **WHEN** 存在打开的目标但没有聚焦目标，且此前未就此发送过引导
- **THEN** 追加一条 `reason` 为 `"unfocused"` 的引导消息

#### Scenario: 同一情形不重复发送

- **WHEN** 上述情形持续存在（仍未聚焦）
- **THEN** 不重复追加引导消息

#### Scenario: 情形解除后可再次发送

- **WHEN** 目标重新被聚焦，之后再次出现未聚焦但有打开目标的情形
- **THEN** 允许再次追加一条引导消息

#### Scenario: 写入失败不影响会话

- **WHEN** 追加引导消息时抛出异常
- **THEN** 会话载入与聚焦切换正常完成

### Requirement: 通道消息的共同保证

三条通道的消息 SHALL 均以 `display: false` 写入，因此不参与常规 UI 展示；它们 SHALL 只以追加方式写入会话分支，SHALL NOT 触发新的 agent 回合。

完整上下文通道 SHALL 是目标权威状态的持久化副本：恢复或压缩后的继续执行 SHALL 以该完整副本为来源，而不是依赖增量。

#### Scenario: 消息不参与常规展示

- **WHEN** 上述任一通道写入消息
- **THEN** 该消息不出现在常规 UI 输出中

#### Scenario: 不触发额外回合

- **WHEN** 完整上下文或引导通道写入消息
- **THEN** 不因该写入而启动新的 agent 回合

#### Scenario: 压缩后以完整副本为准

- **WHEN** 会话在压缩后继续执行
- **THEN** 目标上下文来自重发的完整副本（含目标、验证契约、生命周期策略与任务树）

### Requirement: 变更清单的仓库范围解析

系统 SHALL 以 cwd 所属的最内层仓库作为主仓库，并 SHALL 在同一份清单中纳入该仓库的递归 submodule、向上发现的祖先仓库，以及按配置的目录深度向下遍历发现的未注册嵌套仓库。系统 MUST NOT 无界递归，且 SHALL 以最内层仓库为准报告重叠路径，同一路径 MUST NOT 在清单中出现两次。

#### Scenario: cwd 位于 submodule 内

- **WHEN** goal 在某个 submodule 的工作目录内执行
- **THEN** 该 submodule 被解析为主仓库，其文件级改动按 submodule 自身根路径报告

#### Scenario: 主仓库包含递归 submodule

- **WHEN** 主仓库声明了 submodule，且其中被修改的 submodule 又被初始化
- **THEN** 每个被修改的 submodule 作为独立片段出现，路径以其在主仓库中的相对位置标识

#### Scenario: 存在祖先仓库

- **WHEN** 主仓库位于另一个仓库的工作树内（cwd 在嵌套仓库中，外层仓库也存在）
- **THEN** 祖先仓库同样被纳入清单，并按各自根路径分段报告

#### Scenario: 按目录深度发现未注册嵌套仓库

- **WHEN** 目录深度配置为 1
- **THEN** 只在主仓库根的直接子目录中发现嵌套仓库，且不进入更深层级
- **WHEN** 目录深度配置为 3
- **THEN** 最多遍历到主仓库根下三层目录，并跳过 `.git`、依赖目录与其他被忽略目录

#### Scenario: 重叠路径以最内层为准

- **WHEN** 同一路径同时被外层仓库和更内层仓库跟踪
- **THEN** 清单只按最内层仓库报告该路径一次，外层片段不再重复

#### Scenario: cwd 不在任何 git 仓库内

- **WHEN** cwd 及其祖先目录都不属于 git 仓库
- **THEN** 系统不采集任何基线，审计输入的组成与今天完全一致

### Requirement: 执行阶段起点的快照基线采集

系统 SHALL 在 goal 确认后的第一个执行回合开始时，对每个在范围内的仓库至多采集一次基线，且 MUST NOT 依赖任何工具调用、工具名判定或任务事件来决定触发时机。基线 SHALL 包含该仓库的 HEAD、脏状态指纹与 submodule 状态；当仓库存在 HEAD 时，SHALL 额外包含 `git stash create` 的结果。系统 MUST NOT 修改工作区内容、索引、引用或用户的 stash 列表，且在仓库干净时 MUST NOT 产生新的 git 对象。基线采集的任何失败 MUST NOT 阻塞 goal 执行。

#### Scenario: goal 创建后尚未开始执行

- **WHEN** goal 已创建但尚未进入执行回合（讨论/草拟阶段），或当前不存在 focused 且 active 的 goal
- **THEN** 系统不采集基线，之后的审计窗口从第一个执行回合开始时起算

#### Scenario: 第一个执行回合开始

- **WHEN** goal 处于 active 并开始第一个执行回合
- **THEN** 系统在该回合的任何工具调用之前、对范围内每个仓库采集一次基线，后续回合不再重复采集

#### Scenario: 触发不依赖工具调用

- **WHEN** 检查基线触发的实现
- **THEN** 触发时机只由“focused 且 active 的 goal 开始执行回合”决定，不存在以工具名集合、`tool_call` 钩子或 `task_started` 事件为条件的触发分支

#### Scenario: 仓库干净时的零成本基线

- **WHEN** goal 开始执行时仓库没有未提交改动
- **THEN** 批量暂存快照为空且不写入对象，审计期以 HEAD 作为基线

#### Scenario: 仓库已有未提交改动

- **WHEN** goal 开始执行时仓库已存在未提交改动
- **THEN** 基线记录该时点的完整工作树快照，使后续能识别"基线时已脏、窗口内又被进一步修改"的文件

#### Scenario: 仓库尚无任何 commit

- **WHEN** 范围内仓库处于无 commit 状态，快照与 HEAD 差异都无法计算
- **THEN** 系统降级为脏状态指纹基线，仅报告窗口内的文件存在性变化

#### Scenario: 基线采集失败

- **WHEN** 某仓库的 git 命令超时、报错或 git 不可用
- **THEN** 系统静默跳过该仓库，goal 执行不受影响，清单中不出现该仓库片段

### Requirement: 变更差异计算与清单渲染

系统 SHALL 在收到完成请求时，对每个持有基线的仓库计算窗口内差异，数据来源为基线与现状之间的文件级差异统计以及脏状态列表，并 SHALL 排除与基线一致的条目。被修改的 submodule SHALL 单独取其内部文件级差异。清单 SHALL 按仓库分段标注来源与路径根，SHALL 为每段附上可直接执行的展开命令，MUST NOT 内联全量差异内容，且 SHALL 受长度上界约束。差异计算的任何失败 MUST NOT 阻塞完成请求。

#### Scenario: 各类文件状态被区分

- **WHEN** 窗口内发生了修改、新增、删除、重命名与未跟踪文件创建
- **THEN** 清单以各自状态区分这些条目，并给出每个条目的行级增删统计（不可得时省略）

#### Scenario: 已脏文件被进一步修改

- **WHEN** 某文件在基线时已处于未提交状态，且在窗口内又被修改
- **THEN** 该文件出现在清单中，并反映窗口内的改动

#### Scenario: 仅在基线时脏的文件不出现

- **WHEN** 某文件在基线时已脏，但窗口内未再被修改
- **THEN** 该文件不出现在清单中

#### Scenario: submodule 内部改动

- **WHEN** 某 submodule 的工作树在窗口内被修改，或其 HEAD 在窗口内移动
- **THEN** 清单给出该 submodule 路径、基线 HEAD 与当前 HEAD，并在工作树被修改时附上其内部文件级差异

#### Scenario: 多个仓库同时有改动

- **WHEN** 主仓库与至少一个嵌套/祖先仓库在窗口内都有改动
- **THEN** 清单按仓库分段，每段的路径相对其自身根，不存在路径歧义

#### Scenario: 窗口内没有任何改动

- **WHEN** 所有范围内仓库的窗口内差异都为空
- **THEN** 清单仍作为明确记录出现，声明"未检测到工作区改动"，而不是静默缺省

#### Scenario: 超出深度或处于隔离 worktree 的改动

- **WHEN** 改动发生在超过配置目录深度的嵌套仓库中，或留在隔离 worktree 内
- **THEN** 该改动不出现在清单中，且清单 MUST NOT 声称自身完整

### Requirement: 快照基线的生命周期清理

系统 SHALL 在 goal 进入终态（完成、归档、中止、清除）时删除该 goal 的基线数据，并 SHALL 清理没有对应 goal 记录的孤儿基线。在清除路径上，基线数据 SHALL 在回滚选择、备份与回滚执行全部结束之后才被删除。系统 MUST NOT 执行会修剪用户对象的侵入式 git 操作，未引用的 git 对象交由 git 常规回收。清理失败 MUST NOT 阻塞生命周期转换，且清理 MUST NOT 删除 `goal-change-rollback` 在归档目录中留下的回滚备份。

#### Scenario: goal 成功完成

- **WHEN** 审计批准且目标完成事务提交成功
- **THEN** 该 goal 的基线数据被删除

#### Scenario: goal 被拒绝或审计出错

- **WHEN** 审计拒绝或运行出错，目标保持 active
- **THEN** 基线数据被保留，以便后续重新请求完成时继续计算同一窗口

#### Scenario: goal 归档、中止或清除

- **WHEN** goal 被归档、中止或被用户清除
- **THEN** 该 goal 的基线数据被删除

#### Scenario: 清除路径上的删除时机

- **WHEN** 用户在 `/goal-clear` 流程中选择回滚或选择不回滚
- **THEN** 基线数据在归档与清除完成之后才被删除，且回滚备份保持存在

#### Scenario: 孤儿基线

- **WHEN** 存在基线数据但其对应的 goal 记录已不存在
- **THEN** 诊断或恢复路径清理该孤儿基线

#### Scenario: 不触碰用户对象

- **WHEN** 清理基线数据
- **THEN** 用户的 stash 列表、引用与不可达对象均保持原样，系统不运行修剪对象的 git 命令

### Requirement: 变更清单的设置与静默生效

系统 SHALL 提供控制嵌套仓库扫描目录深度的设置项，默认值为 1，非法值回退默认值并给出可操作诊断；SHALL 提供显式关闭变更清单采集的设置项，供不希望仓库产生 git 对象写入的用户使用。设置在未显式配置时的默认行为 SHALL 为：处于 git 仓库内的 goal 自动采集清单，处于非 git 仓库的 goal 不产生任何新输出，且与今天的行为逐字节等价。设置解析 SHALL 遵循既有的分层规则（project 覆盖 global）。

#### Scenario: 默认深度

- **WHEN** 用户未配置目录深度
- **THEN** 有效深度为 1

#### Scenario: 非法深度值

- **WHEN** 用户为目录深度配置了非法值
- **THEN** 系统回退到 1，并在设置校验中给出可操作诊断

#### Scenario: 显式关闭

- **WHEN** 用户关闭变更清单采集
- **THEN** 系统不采集基线、不在审计输入中新增清单块，且不因该功能写入任何 git 对象

#### Scenario: 非 git 仓库下的零影响

- **WHEN** goal 在非 git 目录中运行
- **THEN** 审计输入与用户可见输出与今天完全一致，不出现空清单、告警或额外提示

### Requirement: 清除目标时提供回滚选择

`/goal-clear` 在用户确认清除后、归档与清除生效之前 SHALL 再询问一次是否回滚本次执行窗口内的工作区改动，且回滚选项 MUST 默认为否。当不存在可用基线、窗口内没有可回滚改动、或当前会话无交互 UI 时，系统 MUST NOT 提供回滚选择，并 MUST 保持清除流程与今天一致。

#### Scenario: 存在基线与改动时询问

- **WHEN** 用户确认清除目标，且该 goal 有基线并有窗口内改动
- **THEN** 系统在归档前询问是否回滚，默认选项为不回滚，并在询问中给出将被改动/删除的文件数量预览

#### Scenario: 用户选择不回滚

- **WHEN** 用户在回滚询问中选择不回滚
- **THEN** 工作区不被修改，清除与归档照常完成

#### Scenario: 没有基线时不再询问

- **WHEN** goal 运行在非 git 目录、采集被关闭或基线采集从未触发
- **THEN** 系统不询问回滚，清除流程与今天完全一致

#### Scenario: 窗口内无改动时不再询问

- **WHEN** 变更清单显示窗口内没有任何改动
- **THEN** 系统不询问回滚，避免无意义的二次确认

#### Scenario: 无交互 UI

- **WHEN** 在无交互 UI 的会话中调用 `/goal-clear`
- **THEN** 系统保持既有的"仅提示需在交互会话中确认"行为，不执行任何回滚

### Requirement: 回滚范围与动作

回滚 SHALL 只作用于变更清单中列出的窗口内改动，并 MUST NOT 触碰基线时已存在且窗口内未被修改的内容。对每个仓库，回滚 SHALL 把窗口内被修改或删除的已跟踪文件恢复到基线内容，并 SHALL 删除窗口内新建的文件。窗口内发生过的仓库 HEAD 移动（例如在 submodule 或嵌套仓库内提交）MUST NOT 被重置，且 MUST 在回滚结果中如实报告为未回滚项。

#### Scenario: 恢复被修改与被删除的文件

- **WHEN** 窗口内某已跟踪文件被修改或被删除
- **THEN** 回滚后该文件内容与基线一致

#### Scenario: 删除窗口内新建的文件

- **WHEN** 窗口内新建了文件（已跟踪新增或未跟踪）
- **THEN** 回滚后这些文件被删除

#### Scenario: 基线前已有的未提交改动不被触碰

- **WHEN** 某文件在基线时已处于未提交状态，且窗口内未被修改
- **THEN** 回滚不修改该文件

#### Scenario: 基线时已脏且窗口内又被修改

- **WHEN** 某文件在基线时已脏，窗口内又被修改
- **THEN** 回滚把该文件恢复到基线内容（而不是 HEAD 内容）

#### Scenario: 仅恢复工作树内容

- **WHEN** 回滚恢复文件内容
- **THEN** 系统的暂存区状态不被本次回滚改写，且用户的 stash 列表保持不变

#### Scenario: 仓库 HEAD 在窗口内移动

- **WHEN** 窗口内某 submodule 或嵌套仓库的 HEAD 发生了移动
- **THEN** 回滚不重置该 HEAD，并在结果中把该仓库列为未回滚项

#### Scenario: 多仓库分别回滚

- **WHEN** 多个仓库在窗口内都有改动
- **THEN** 每个仓库各自按其基线回滚，路径相对其自身仓库根

#### Scenario: 清理因删除而变空的目录

- **WHEN** 删除新建文件后留下仅由本次删除产生的空目录
- **THEN** 系统尽力删除这些空目录，MUST NOT 删除包含任何其他内容的目录

### Requirement: 回滚前的备份

执行任何回滚动作之前，系统 SHALL 先把将被丢弃的改动备份到归档目录下的自包含位置，内容包括可应用的补丁（支持二进制）与新建文件的副本。备份写入失败、部分失败或超出容量上限时，系统 MUST NOT 执行回滚，并 SHALL 报告原因。备份 MUST NOT 写入或修改用户的 stash 列表。

#### Scenario: 备份先于回滚完成

- **WHEN** 用户选择回滚
- **THEN** 系统先完成全部仓库的备份写入，确认成功后才开始修改工作区

#### Scenario: 备份失败则不回滚

- **WHEN** 备份写入失败、超时或超出容量上限
- **THEN** 系统不修改工作区，报告失败原因与目标备份位置，清除与归档照常完成

#### Scenario: 备份自包含且随归档保留

- **WHEN** 备份完成
- **THEN** 补丁与新建文件副本位于 `.pi/goals/archived/` 下与该 goal 归档文件同目录的独立位置，且不因基线清理而被删除

#### Scenario: 不污染用户 stash 列表

- **WHEN** 备份完成
- **THEN** `git stash list` 的内容与备份前完全一致

### Requirement: 回滚结果报告

回滚完成后系统 SHALL 报告逐仓库的结果，包括成功回滚的条目数量与任何未回滚或失败的条目；部分失败时 MUST 逐条列出失败路径与原因，并 SHALL 给出备份位置以便用户手工恢复。

#### Scenario: 全部回滚成功

- **WHEN** 所有仓库的全部条目回滚成功
- **THEN** 系统报告逐仓库的回滚条目数量与备份位置

#### Scenario: 部分条目失败

- **WHEN** 某些路径回滚失败
- **THEN** 系统逐条列出失败路径与原因，给出备份位置，且不清除或覆盖已成功回滚的部分

#### Scenario: 失败不阻塞清除

- **WHEN** 回滚失败或部分失败
- **THEN** goal 的清除与归档仍照常完成，失败只体现为报告内容

### Requirement: 回滚与基线清理的时序

系统 SHALL 在回滚选择、备份与回滚执行全部结束之后才归档并清除 goal，并 SHALL 仅在此之后删除该 goal 的基线数据；回滚备份 MUST 在基线清理中保持不受影响。

#### Scenario: 基线在回滚流程结束后才删除

- **WHEN** 用户选择回滚或选择不回滚并完成清除
- **THEN** 基线数据在归档与清除完成后才被删除

#### Scenario: 归档前的竞态保护保持不变

- **WHEN** 回滚流程期间有并发修改导致目标发生变化
- **THEN** 系统保持既有的 focus token 校验行为，不执行清除也不执行回滚

### Requirement: 主模型输入不包含非必要目标遥测

系统 SHALL 从 `pi-goal-x` 新生成的主模型可见内容中移除当前上下文 token 数、模型上下文窗口大小、占用比例和上下文遥测不可用占位；SHALL 移除目标累计耗时、没有有效 lifetime token budget 时的累计 token 消耗、没有有限运行额度时的运行次数统计，以及插件生成的审计成本/token/回合统计。系统 MUST NOT 用接近上下文上限作为暂停、阻塞、完成或要求用户另开会话的新增条件。

删除 SHALL 覆盖新生成的自动提示、目标上下文和状态消息、所有目标工具的模型可见返回、详细/历史查询、插件生成的压缩摘要及恢复说明。查询历史账本后新生成的返回属于本范围；已经存在于会话中的旧返回不属于本范围。仅属于 UI、持久化记录或宿主内部计费的数据不属于模型可见内容；如果这些数据通过模型可读取的结构化返回被暴露，SHALL 同样应用精简规则。

#### Scenario: 高上下文占用不进入主模型请求

- **WHEN** 一个未完成的 active 目标没有消费预算或有限运行额度，宿主报告上下文占用为 99%，目标还累积了大量 token 与耗时
- **THEN** 新生成的目标内容提供执行所需信息而不提供这些遥测；目标状态、续跑资格和完成 gate 不因遥测数值而改变

#### Scenario: 上下文遥测不可用时不输出占位

- **WHEN** 宿主无法提供上下文用量
- **THEN** 插件新生成内容不提供 `Context snapshot: unavailable` 或替代的空值/零值占用提示

#### Scenario: 所有生成渠道使用同一边界

- **WHEN** 主模型通过自动目标提示、创建/调整/更新/完成目标工具返回、`get_goal` 默认/verbose/历史查询和压缩恢复内容获取目标信息
- **THEN** 各渠道新生成的内容均不包含对应被移除的插件遥测，工具调用不会成为新内容的统计旁路；旧会话返回保持原样

### Requirement: 主模型保留真实消费和运行约束

系统 SHALL 在用户设置了有效 lifetime token budget 时保留预算总额、已用量与剩余量，并明确它是跨回合消费约束而不是上下文容量；已有预算耗尽引导和执行 gate MUST 保持原语义。系统 SHALL 保留有限运行额度及其禁用/耗尽含义，沿用既有运行计数展示设置；没有额度时 SHALL 不输出运行计数或仅用于展示的空限额占位。等待原因、deadline、轮询余量与执行准入等可行动的调度信息 MUST 保留。

#### Scenario: 有效消费预算仍可指导收尾

- **WHEN** 目标设置 lifetime token budget 且已有消费
- **THEN** 主模型能够获取真实预算的总额、已用与剩余数量以及消费约束含义，不会收到上下文容量快照；预算耗尽时既有收尾规则保持有效

#### Scenario: 有限运行额度与关闭续跑保持有效

- **WHEN** 配置有限运行额度，或额度为 0，或运行次数展示已关闭
- **THEN** 主模型仍能获取实际额度及相应执行约束；数量展示遵循既有设置，UI 设置不改变调度执行或把有限额度误报成无限

#### Scenario: 删除预算与额度后新内容使用当前约束

- **WHEN** 用户删除预算或有限运行额度后再次生成目标内容
- **THEN** 新生成的当前策略不保留旧约束或其遥测；真实约束变更记录仍可查询；已持久化的旧消息和旧工具返回不追溯修改

#### Scenario: 外部等待所需信息保留

- **WHEN** 目标正在等待外部条件并有 deadline 和有限轮询余量
- **THEN** 主模型仍收到等待原因、deadline、轮询余量和必要的执行准入说明，不把它们当作累计耗时遥测删除

### Requirement: 主模型保留执行和压缩恢复语义

精简 SHALL 保留目标原文及其信任标记、任务树与进度、当前任务、验证契约、完成审计 gate、审计 verdict/报告/findings、真实阻塞与恢复建议、焦点归属和状态边界。宿主自动压缩和压缩后目标恢复 MUST 保持原有行为；系统 MUST NOT 因移除遥测而删除有意义的目标状态快照或改变 checkpoint 配对、暂停/阻塞/预算受限 gate。

#### Scenario: 压缩后继续执行未完成目标

- **WHEN** active 目标执行期间发生自动压缩
- **THEN** 压缩后主模型仍能恢复目标、当前任务及其契约、未解决审计反馈和必要调度信息，并按既有流程继续；新生成的恢复内容不加入已排除的遥测；不清洗宿主压缩摘要或历史消息

#### Scenario: 真实暂停与审计拒绝不能被精简绕过

- **WHEN** 目标处于 paused、blocked 或 budget_limited，或收到审计拒绝/错误
- **THEN** 主模型仍能识别状态与原因，既有恢复入口和完成限制不变；审计报告保留而插件另加的审计成本统计不进入主模型返回

#### Scenario: 无焦点与过期 checkpoint 保护保持

- **WHEN** 存在未聚焦目标或出现不再可执行的 checkpoint
- **THEN** 既有未聚焦提示设置和过期 checkpoint 防护继续生效，精简不会自动选择、恢复或切换目标

### Requirement: 历史查询只提供执行所需的目标事件投影

`get_goal` 新生成的历史分页、verbose 历史与近期事件摘要 SHALL 保留生命周期、任务证据、真实预算变更、审计结论和错误；SHALL 排除纯审计消费事件及无当前有效预算时的累计消费字段，不把完整消费账本作为模型查询返回。返回内容 MUST 保持事件顺序和自由文本，字段选择 SHALL 在生成新返回和分页之前进行，继续使用既有分页和内容标识。不处理旧会话结果页，也不解析 JSON 碎片或重组旧 cursor 链。

#### Scenario: 查询含审计消费的历史

- **WHEN** 账本含审计消费事件、审计拒绝、任务完成证据与预算移除记录，且当前目标无预算
- **THEN** 主模型历史返回不含审计消费及累计 token 字段，仍含拒绝理由、任务证据和真实预算移除记录；磁盘账本不变

#### Scenario: 分页遍历不遗漏执行历史

- **WHEN** 被精简的历史超过一页且主模型沿 cursor 遍历所有页
- **THEN** 连接各页内容得到完整且顺序正确的执行历史投影，无重复、遗漏或遥测泄漏

#### Scenario: 新查询的 cursor 继续校验内容身份

- **WHEN** 一次新查询的 cursor 与当前返回内容不匹配
- **THEN** 查询返回既有过期/无效 cursor 提示，允许从首页重取；不新增投影版本或跨页重组协议，不修改已持久化的工具返回

### Requirement: 原始遥测与非目标内容保持隔离

精简 MUST NOT 删除或修改账本中的 usage、运行状态、内部计费数据、会话原始记录，以及 UI dashboard、状态/诊断展示所需统计；独立 auditor/Oracle 输入 MUST 保持既有语义。系统 SHALL 只在新内容生成边界选择主模型所需字段，MUST NOT 对旧 goal 消息或旧工具返回执行请求时遥测投影，MUST NOT 对任意消息进行全局 token/百分比文本删除。既有 display-only 过滤与 checkpoint 规范化不属于遥测清洗，保持原行为。

#### Scenario: UI 与内部计费仍完整

- **WHEN** 主模型返回被精简但目标和审计已经发生消费
- **THEN** UI 与诊断仍能显示原有统计，账本和工具内部 usage 上报仍完整，独立审计器获得原有输入

#### Scenario: 旧会话消息和旧工具返回不处理

- **WHEN** 恢复的会话含旧 goal 自有消息或工具返回，其生成段包含本规格排除的遥测，包括被旧分页边界截断的 JSON
- **THEN** 这些消息及旧返回保持原样，允许遥测随历史重放；不为此新增清洗、碎片解析或重组；同一会话新生成的内容仍遵守精简边界

#### Scenario: 用户原文和第三方消息保持原样

- **WHEN** 用户目标、任务证据、审计报告原文、其他插件消息或来源不明的旧摘要包含 token 数、百分比或 `Context snapshot` 字样
- **THEN** 系统不因字样相似而修改这些内容；本规格不承诺隐藏模型主动读取原始文件所得的统计，也不清洗模型或用户已经撰写的自由文本

### Requirement: 主模型信息精简不破坏请求结构与缓存边界

系统 SHALL 保留工具调用与结果的配对、会话/模型身份隔离、请求尾部有界保留和状态变更失效语义。只有已删除遥测变化而执行状态及真实约束未变化时，目标生成的主模型输入 SHALL 保持相同；没有真实消费/运行约束时 SHALL 不生成仅含空遥测的额外消息。

#### Scenario: 遥测单独变化不增长请求尾部

- **WHEN** 既无预算、也无有限运行额度的同一目标在执行状态不变时仅更新上下文用量、累计 token、耗时或无上限运行计数
- **THEN** 目标生成内容保持相同，不因这些变化追加新的尾部观测消息

#### Scenario: 工具循环与会话切换安全

- **WHEN** 工具循环连续构造请求，随后发生模型切换、会话恢复、压缩或预算变更
- **THEN** 工具调用/结果保持合法配对，旧保留尾部按既有失效规则处理，新生成的尾部不含已排除遥测；已持久化的旧消息仍允许原样重放

### Requirement: 遥测精简不扩大系统改造范围

系统 MUST 保持工具名称、参数 schema、存储版本和生命周期事务不变；MUST NOT 为本优化新增配置开关、命令、依赖、上下文阈值、强制压缩逻辑或新的自主停止策略。本规格声明的主模型呈现差异 SHALL 作为对既有生命周期兼容基线的补充，其余既有完成审计和消息通道契约保持有效。

#### Scenario: 比较改造前后公共契约

- **WHEN** 对比候选实现与本变更起点的工具注册、有效设置、目标状态转换、UI、审计输入和宿主压缩处理
- **THEN** 除已声明的新生成主模型呈现与新历史查询字段选择差异外契约保持不变，未出现新工具/配置或因上下文比例而自主停止的条件
