# goal-lifecycle Specification

## Purpose

定义 pi-goal-x 的目标生命周期契约：完成审计（独立子代理、结构化裁决、进度可观察、fail-closed）、持久化到会话分支的目标上下文与状态通道、完成审计使用的工作区变更清单与基线，以及 `/goal-clear` 时的回滚选择与执行。

## Requirements

### Requirement: 实现范围与 pi-subagents 修改边界

本变更的验收范围 SHALL 限定为 `pi-goal-x` 的完成审计改造，以及从 `pi-subagents` 现有 eject handler 抽取并复用共享 agent-management service 所必需的最小公共导出、适配和测试。用户明确批准的例外仅有：foreground executor 对既有 `message_end`/`toolResult` 与 `tool_result_end` progress event shape 的归一化/去重及直接测试，以及 `preflight.ts` 中 `packageVersion()` 对损坏 package metadata 的 fail-closed 错误包装。后者 MUST NOT 改变其 public async contract、launch 语义或工具计划。另外，完成审计 supervisor 旁路允许新增版本化 responder API、精确 attempt 与实际 child 的启动前绑定、监督请求接管/回复/清理及其直接测试；接入 SHALL 限定为 API 导出、structured delegation 生命周期、前台 executor 的内部启动绑定回调和原生 supervisor 通道入口，普通子代理的默认监督、运行和终态语义 MUST 保持不变。另外，自动续跑事件门禁允许在 `pi-subagents` 扩展会话生命周期中接入同步监听器，并只读复用当前父会话的后台运行与原生通知交接状态；实现 SHALL 限于 fork-only 适配模块、必要的最小生命周期/状态读取接缝及直接测试，不得改变子代理启动、终态、结果唤醒或监督请求语义。除上述范围外，`packages/pi-subagents` 的既有 delegation、preflight、运行时、MCP、skill、Fleet、mission、slash command 和其他实现 SHALL 保持不变。任何超出该边界的 `pi-subagents` 修改 MUST 在交付前还原；非修改范围内产生的额外 lint、warning 或格式问题不属于本变更验收项，也不得以此扩大修改范围。

#### Scenario: 验收变更边界

- **WHEN** 审查本变更的最终工作树和差异
- **THEN** `pi-subagents` 中除 shared eject service 及其直接 public export、必要适配和测试，以及明确批准的 foreground event normalization/去重、`packageVersion()` fail-closed 错误包装和当前 audit supervisor 旁路的上述最小接入，以及自动续跑门禁监听的最小接入外，不得存在本变更引入的实现差异；范围外 lint/warning 不阻塞本变更

### Requirement: 改造差异与兼容性基线

系统 SHALL 将下列 `D-*` 与 `I-*` 条目作为本次改造的完整行为验收基线。`D-*` 是允许且必须实现的预期差异，`I-*` 是改造后 MUST 保持不变的行为；任何未列入 `D-*` 的可观察行为变化 MUST 视为回归，除非先更新并重新批准本规格。D-17 明确替代旧五阶段、百分比推算及终态补勾要求，并允许统一增加任务级 ID/逐项上报说明；其他要求中“输入不变”的表述不禁止这项统一协议变化，但原有审计要求、证据和信任边界 MUST 保持。

**预期差异：**

| ID   | 改造前                                                                                                  | 改造后（预期差异）                                                                                                                                                                                                                                                                                   | 验证重点                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | 审计在父 Pi 进程内由独立内存 `AgentSession` 执行                                                        | 审计由 `pi-subagents` 管理的 fresh-context 前台子 Pi 进程执行                                                                                                                                                                                                                                        | 证明请求经过 structured delegation，且父会话历史未复制到 child conversation                                                                                                             |
| D-02 | 审计不依赖 `pi-subagents` extension                                                                     | 启用审计要求兼容的 `pi-subagents` extension 已加载                                                                                                                                                                                                                                                   | 缺失或版本不兼容时快速 fail closed，目标保持 active，且无 embedded fallback                                                                                                             |
| D-03 | 审计使用独立内存 settings，retry 固定采用 Pi 默认值并忽略用户主会话设置                                 | 审计子进程读取正常的全局及受信任项目 Pi settings                                                                                                                                                                                                                                                     | 自定义 retry 次数、退避、provider timeout 与 transport 在审计中生效                                                                                                                     |
| D-04 | 资源能力由 `auditorProjectResources` 布尔开关粗粒度控制                                                 | 资源能力由 auditor agent 的 `extensions`、`subagentOnlyExtensions`、`skills` 与继承选项控制                                                                                                                                                                                                          | 默认保持隔离，显式配置的扩展/skill 可用，废弃设置只产生迁移提示                                                                                                                         |
| D-05 | 工具集合硬编码为 `read`、`grep`、`find`、`ls`、`bash` 和内部进度工具                                    | 普通工具由 auditor agent 的严格 allowlist 决定；审计进度与结构化输出工具作为 package-required 内部能力提供                                                                                                                                                                                           | 默认普通工具能力等价；用户可收紧或增加普通/extension tool，但不能因 override 丢失 dashboard 与 verdict 所需的内部协议工具                                                               |
| D-06 | 固定工具白名单无法向审计模型提供 MCP 工具                                                               | 用户可用 `mcp:<server>` 或 `mcp:<server>/<tool>` 精确选择 MCP direct tools                                                                                                                                                                                                                           | 只暴露解析出的 MCP 工具，不隐式授权其他 MCP 服务或普通工具                                                                                                                              |
| D-07 | 审计通过普通文本中的 `<approved/>` / `<disapproved/>` 标记表达裁决                                      | 审计通过 schema-validated `{verdict, report, findings}` 结构化结果表达裁决                                                                                                                                                                                                                           | 文本伪批准、缺失字段和 schema-invalid 结果均不能完成目标                                                                                                                                |
| D-08 | `pi-goal-x` 自动打开 live transcript overlay，并通过 `/goal-audit` 在当前 session 内重开最近 transcript | 删除 goal-owned transcript overlay、`/goal-audit`、内存 transcript 状态及其专用依赖；详细 review 过程统一在 `pi-subagents` Fleet/transcript 视图查看                                                                                                                                                 | 命令和 overlay 不再存在，审计不会自动弹窗；Fleet 可查看 child 原生消息、thinking、工具活动/results 和 retry；动态清单 dashboard/result card 按 `I-17`/`I-18` 保持                       |
| D-09 | 审计复用父会话 `modelRuntime`，包括 runtime-only API key 和动态 provider                                | 子 Pi 使用磁盘认证、环境变量及自身加载的 provider extensions                                                                                                                                                                                                                                         | 存储认证与环境认证可用；runtime-only 父进程覆盖不会被误称为已继承                                                                                                                       |
| D-10 | Esc 通过父进程 `AbortController` 直接中止嵌套 session                                                   | Esc 驻停同一 delegation；用户选择继续时恢复该审计，选择无审计完成时精确取消该 attempt                                                                                                                                                                                                                | 继续使用同一审计员与旁路；绕过仅取消对应 request/owner/node，不影响其他子代理                                                                                                           |
| D-11 | 工具、扩展和模型初始化问题通常汇总为嵌套审计错误                                                        | 子代理 preflight 提供缺失 agent/tool/provider、timeout、budget 等分类错误；对运行时注册 agent 做运行时感知回退（磁盘视图 `missing_agent` 时以 `discoverAgentsWithRuntime` 合并视图解析并校验协议工具），只有真正解析不到才 fail closed，裸 `pi -e` 会话中运行时注册的默认 auditor 正常通过 preflight | 所有非成功状态都 fail closed 且返回可操作诊断；运行时注册的默认 auditor 不再报 `Unknown agent: goal-auditor`                                                                            |
| D-12 | 审计角色和 system prompt 固定在 `pi-goal-x` 代码中，仅 provider/model/thinking 可配置                   | 默认 `goal-auditor` 由 `pi-goal-x` 在 `session_start` 通过 pi-subagents 运行时注册契约注册（定义由代码持有）；用户通过嵌套 `auditor.*` 定义层合并定制，或以 `auditor.agent` 选择完全自定义的 agent                                                                                                   | 默认 agent 无需包内 markdown 即可发现；定义层合并规则生效；既有 provider/model/thinking override 仍可覆盖请求                                                                           |
| D-13 | 用户必须通过 `pi-subagents` 管理工具或手工创建文件才能复制并定制默认 auditor agent                      | 内容定制统一走嵌套 `auditor.*` 设置（提示注入层与定义层）；`/goal-subagent-eject` 命令移除；此前 eject 出的 user/project `goal-auditor.md` 继续以配置 agent 身份生效                                                                                                                                 | 配置注入的各块按固定顺序渲染并转义；`/goal-subagent-eject` 不再注册；存在同名配置 agent 时运行时注册被跳过且审计使用该 agent                                                            |
| D-14 | 提示注入与定义定制能力不存在，审计任务 prompt 完全固定                                                  | 新增提示注入层：`checklist`（整体替换默认清单）、`checklistExtra`、`evidenceRequests`、`strictness`（strict/lenient 注入对应姿态文本）、`instructions`（`<operator_instructions>` 块）、`reportFormat`（报告格式要求），按固定顺序渲染在审计清单之后                                                 | 全部转义后注入；未设置任一字段时无设置与解析后未设置的任务 prompt 字节一致；允许 D-17 统一增加 ID 和逐项进度说明；清单替换后协议尾两行（进度上报与 structured_output 裁决约定）仍然保留 |

| D-15 | 审计监督问题唤醒主模型并可能使审计员 detach、原 audit 提前失败 | 当前精确 audit 的监督问题由隔离只读旁路答复，完成工具保持阻塞，审计员不 detach，真正终态与协调记录在原工具结果中一次性返回 | 主模型回合数为零、detach 为零、同一 child、唯一终态、无效/未解决答复 fail closed、记录与独立 usage 回流，最终真实 Pi/TUI + tmux + 真实 provider E2E |
| D-16 | 原 fork 对审计台账写入采用尽力记录，失败不阻止完成 | 采用上游 fail-closed：审计开始、跳过或结果记录无法写入时目标保持未完成；请求与用量记录仍尽力写入 | 分别注入开始、跳过、结果和请求写入失败，验证持久化错误与目标状态 |

| D-17 | 固定五阶段、百分比推算及终态自动补勾 | 改为实际生效清单快照与逐项状态；紧凑汇总、展开完整清单；检查项状态不新增完成门槛，未上报项不补勾；旧进度仍可显示但不驱动条目 | 清单一致性、状态及 ID 校验、attempt 隔离、空/长清单、旧 auditor、挂起/继续、verdict 独立 |

**必须保持不变：**

| ID   | 改造前必须保留的功能/行为                                                                                               | 改造后保证                                                                                                                | 验证重点                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| I-01 | 只有 active 目标通过本地生命周期、运行归属和任务完成 gate 后才启动审计                                                  | SHALL 保持相同前置 gate 与错误结果                                                                                        | 未满足 gate 时不产生 delegation 请求                                    |
| I-02 | 全局 auditor disabled 和兼容的 per-goal `skipAuditor` 会跳过审计并记录原因                                              | SHALL 保持两条 audit-skipped 完成路径及 ledger 原因                                                                       | 两种禁用来源都不启动 child，且仍可完成目标                              |
| I-03 | 审计输入包含目标、任务树、验证契约、详细摘要、近期 ledger evidence；`completion_summary` 仅是 untrusted claim           | SHALL 传递同等语义的显式输入，且 MUST NOT 把执行者声明当作证据                                                            | task payload 内容与 trust 标记可断言                                    |
| I-04 | 审计不读取或写入父会话历史，默认不继承项目 context、skills 或扩展                                                       | 默认 auditor agent SHALL 保持独立上下文与资源隔离                                                                         | fresh context 且默认 agent inheritance 均关闭                           |
| I-05 | 只有审计明确批准才能进入正常完成事务                                                                                    | 只有 schema-valid `approved` SHALL 完成目标                                                                               | approved report 被记录并进入同一 commit path                            |
| I-06 | 审计拒绝或运行错误会保持目标 active，并把反馈返回执行者                                                                 | SHALL 保持该状态与可重试行为                                                                                              | disapproved/error 后目标文件和 focus 未被完成或归档                     |
| I-07 | ledger 记录完成请求、审计开始与唯一终态                                                                                 | SHALL 保持审计事件顺序、verdict 语义和单一终态；关键记录写入失败按 D-16 阻止完成，完成请求尽力记录                        | approved、disapproved、error、skip 和写入失败各分支均断言 ledger        |
| I-08 | completion focus token、stale-operation 检查、单一完成事务、stop marker 和 deferred archival 防止并发错误完成           | SHALL 保持事务边界，不允许 child 直接修改 goal 或 ledger                                                                  | stale focus 不提交；成功仍由原完成事务写入和延迟归档                    |
| I-09 | Esc 后用户可选择无审计完成或继续处理审计                                                                                | SHALL 保留无审计完成与继续同一审计两个选择；取消本身不批准目标                                                            | 只有明确 bypass 才完成；继续审计复用原 child 与 attempt                 |
| I-10 | 临时错误重试耗尽、明确拒绝或审计错误后不会自动重新发起整个 review                                                       | SHALL 仍要求后续重新调用 `update_goal({status:"complete"})`                                                               | 单次请求只产生一个 logical audit attempt，失败后可手动重试              |
| I-11 | `pi-goal-x` 的 provider/model/thinkingLevel 设置可选择审计模型与 thinking                                               | SHALL 映射为 delegation request override                                                                                  | 有配置时精确覆盖，无配置时使用 agent/default model                      |
| I-12 | 用户能看到审计开始、运行进度、批准/拒绝/错误结果和 auditor label                                                        | SHALL 保持这些状态可观察，允许文案和 transcript 来源按 `D-08` 变化                                                        | UI/model events 覆盖 started、running、approved、rejected、error        |
| I-13 | 默认不会向审计模型暴露 `edit`、`write`、goal/task 管理工具；`bash` 仍不是强制只读沙箱                                   | SHALL 保持默认普通工具安全边界且继续如实说明 `bash` 风险                                                                  | 默认 registry 断言禁用 mutation/control tools，文档不宣称沙箱           |
| I-14 | progress/transcript observer 异常不会改变审计控制流或 verdict                                                           | SHALL 保持展示层故障隔离                                                                                                  | 注入 observer 异常后审计结果不变且监听器被清理                          |
| I-15 | 审计批准报告进入完成输出；拒绝报告成为后续执行者可见反馈                                                                | SHALL 保持 report 的用户可见性和后续工作输入语义                                                                          | completion report 与 rejection message 均包含结构化 report/findings     |
| I-16 | 中止或结束后不会留下当前审计的 AbortSignal listener、动画 timer 或可继续发事件的 session 订阅                           | SHALL 对 delegation listeners、timeout 和取消关联资源提供同等清理保证                                                     | success、reject、error、timeout、cancel 均验证资源清理                  |
| I-17 | 固定五阶段与百分比推算状态                                                                                              | SHALL 按 D-17 改为实际生效清单、逐项上报状态与紧凑汇总/展开明细；保留 auditor identity、elapsed time 和工具诊断           | 默认/替换/附加清单、逐项状态、长列表滚动、终态不补勾与 verdict 分离     |
| I-18 | 审计结束后短暂显示 `APPROVED`、`CHANGES REQUIRED` 或 `ERROR` result card，随后恢复正常 goal dashboard；拒绝不会关闭目标 | SHALL 保持三类 result card、findings 摘要、约 6 秒恢复和目标状态语义                                                      | approved/disapproved/error 卡片与 timer 清理后正常 dashboard 均通过测试 |
| I-19 | 未配置提示注入字段时的审计任务 prompt                                                                                   | SHALL 保持无设置与解析后未设置两种输入逐字节相等；D-17 允许统一增加清单 ID 与逐项上报说明，不要求与改造前 prompt 字节相等 | 比较两种未设置输入，核验审计要求和信任边界未变                          |
| I-20 | 进度上报与结构化裁决协议尾                                                                                              | SHALL 在任何清单替换或注入组合下保留进度工具与 structured_output 裁决约定；进度支持逐项状态及旧 label/percentage          | 空清单、清单替换、工具剔除、旧协议兼容与 preflight                      |
| I-21 | 此前 `/goal-subagent-eject` 产出的 user/project 作用域 `goal-auditor.md`                                                | SHALL 继续被发现并生效；运行时注册在检测到同名配置 agent 时 MUST 跳过且不产生告警副作用                                   | 存在 user/project 同名 md 时注册跳过、审计解析到该 agent                |

#### Scenario: 实现全部预期差异

- **WHEN** 候选实现按兼容性基线执行自动化与必要的人工验证
- **THEN** 每个 `D-*` 条目都表现为表中定义的改造后行为，且不存在 embedded auditor 执行路径

#### Scenario: 保持全部兼容行为

- **WHEN** 候选实现执行 approved、disapproved、error、skip、cancel、stale-focus 和 retry-exhausted 基线用例
- **THEN** 每个 `I-*` 条目都保持表中定义的结果、状态、事件和可观察反馈

#### Scenario: 检测未声明的行为变化

- **WHEN** 验证发现改造后的可观察行为与改造前不同且该差异没有对应 `D-*` 条目
- **THEN** 验证 MUST 失败，并在继续实现前更新和重新评审本规格或修复该回归

### Requirement: 审计关键记录的持久化失败必须阻止完成

完成流程 MUST 在启动审计、跳过审计及记录审计结果时立即持久化对应的 `audit_started`、`audit_skipped` 或 `audit_result`。若关键记录无法写入，系统 MUST 保持目标未完成，返回可操作的持久化错误并允许重试；不得提前宣称目标已完成。`completion_requested` 与审计用量记录仍为尽力写入，失败本身不阻止后续关键审计记录或完成。

#### Scenario: 审计关键记录写入失败

- **WHEN** 审计开始、跳过或终态记录无法持久化
- **THEN** 目标保持打开，调用方收到持久化错误；系统不宣称目标完成

#### Scenario: 非关键请求记录写入失败

- **WHEN** `completion_requested` 无法写入但审计开始及结果可以持久化，且审计明确批准
- **THEN** 审计与完成流程可以继续，仍须遵守现有焦点、版本和任务门控

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

交互式完成审计运行期间，系统 SHALL 在 goal widget 展示本次实际生效的动态审计清单，不再展示固定五阶段或按百分比推算检查项状态。紧凑视图 SHALL 显示已检查/总数、通过数、不通过数和当前检查项；展开视图 SHALL 支持浏览完整清单与逐项依据。系统 SHALL 保留 auditor identity、elapsed duration 和展开工具诊断；清单覆盖度与审计员旧百分比估计 MUST 明确区分。审计结束后 SHALL 保持既有 result card 与恢复普通 dashboard 的行为。

#### Scenario: 五阶段进度依次推进

- **WHEN** 旧审计员仅上报 0、20、40、60、80 或 100 百分比
- **THEN** 系统仅显示标明为审计员估计的百分比，不按历史五阶段阈值变更清单状态，不为未上报条目补勾

#### Scenario: Host Tool-result Event Shape Is Normalized

- **WHEN** 前台 child 将进度工具结果作为 `message_end` 的 `toolResult` 而不是独立 `tool_result_end` 发出
- **THEN** 现有 `pi-subagents` 归一化在 delegation update 的 `recentOutputLines` 中携带一次有界记录，Goal-X 从工具结果解析状态，不信任 `currentToolArgs` 显示预览

#### Scenario: 展开 Dashboard 显示工具诊断

- **WHEN** 审计正在执行工具且用户展开审计 dashboard
- **THEN** 用户可以浏览完整检查项与依据、当前工具、受限长度参数和近期输出；紧凑视图只显示汇总与当前项

#### Scenario: 审计结果卡后恢复正常视图

- **WHEN** 审计以 approved、disapproved 或 error 结束
- **THEN** 系统显示对应的 APPROVED、CHANGES REQUIRED 或 ERROR result card，disapproved/error 保持目标 active，并在既有展示窗口后恢复正常 goal dashboard

#### Scenario: Dashboard 在不同终端宽度内稳定

- **WHEN** 清单、依据或结果卡包含中文、超长内容，或终端变窄变矮
- **THEN** 可见行不超终端宽度，高度受可用区域约束，展开清单及依据可通过滚动完整访问，header 与汇总不被长清单挤掉

#### Scenario: 当前项与覆盖度

- **WHEN** 六项中两项通过、一项不通过、一项检查中、两项待检查
- **THEN** 紧凑视图显示已检查 3/6、通过 2、不通过 1 及检查中项目；覆盖度不表述为批准概率或通过率

#### Scenario: 显式空清单

- **WHEN** 生效清单为空
- **THEN** 显示没有配置检查项及 0/0，不出现除零、NaN、虚构阶段或自动批准；最终 verdict 仍独立展示

### Requirement: 详细审计观察统一使用 Fleet

系统 SHALL 移除 `pi-goal-x` 自有的 live transcript overlay、`/goal-audit` command、最近 transcript 内存状态以及仅为该面板存在的 transcript runtime 依赖。交互式审计启动时 MUST NOT 自动打开 goal-owned overlay。审计仍 SHALL 通过 `pi-subagents` 的正常前台运行注册到 Fleet，使用户可在 Fleet 中查看 child 的原生 user/assistant/thinking、工具活动与结果、retry 和终态；`pi-goal-x` 仅保留 `I-17`/`I-18` 定义的高层 dashboard 与 result card。

#### Scenario: 审计启动不再自动弹出 Transcript

- **WHEN** 在具有交互 UI 的 Pi session 中启动完成审计
- **THEN** `pi-goal-x` 不创建或打开 transcript overlay，但动态清单 audit dashboard 正常显示，且对应 child run 出现在 Fleet

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

- **WHEN** delegation update 携带有效逐项状态或改变审计 phase label、percentage
- **THEN** Goal-X 使用该 update 更新既有 dashboard，使动态清单状态、当前项与 elapsed duration 反映最新 child progress；旧 percentage 仅作为标明来源的审计员估计显示，不推导条目状态，而不等待审计终态

#### Scenario: 展示摘要不丢失 Auditor 进度

- **WHEN** 子代理 runtime 将活动工具参数压缩为仅供展示的 `currentToolArgs` 摘要
- **THEN** `report_auditor_progress` SHALL 在其 tool-result text 中携带版本化、可解析的进度记录（兼容 label/percentage，支持检查项 ID、状态及依据），Goal-X SHALL 从 delegation update 的近期输出恢复该 record、更新动态清单 dashboard，并且不得将内部 record 显示为审核输出；该 record MUST NOT 授予完成权限或影响 structured verdict

#### Scenario: Esc 取消当前审计

- **WHEN** 用户在审计运行期间按 Esc
- **THEN** 系统挂起该精确 attempt：不发送取消请求、不拆除事件监听、不影响其他子代理运行，并显示既有审计绕过选择

#### Scenario: 继续审计复用同一子代理

- **WHEN** 用户在 Esc 弹窗选择“继续审计”
- **THEN** 系统复用同一子代理 attempt 继续等待其终态，子代理的全部既有上下文、清单快照与逐项审计进度得以保留；approved 进入既有批准流程，disapproved 进入既有拒绝流程，目标在裁决前保持 active

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

系统 SHALL 用 `pi-goal-steering-event` 承载不属于每回合状态的其他一次性引导说明，以 `display: false` 写入，details 为 `{ reason, timestamp }`。存在打开目标但未聚焦 SHALL NOT 构成发送该消息的条件，系统 MUST NOT 新增 `reason: "unfocused"` 引导。

对于仍受支持的其他引导情形，系统 SHALL 保持同一情形只发送一次的边缘触发语义，情形解除后允许再次发送；写入失败 SHALL 不影响会话载入或聚焦切换。本要求是既有兼容性基线的明确预期差异，不改变其他通道保证。

#### Scenario: 首次出现未聚焦目标时发送一次

- **WHEN** 存在打开的目标但没有聚焦目标，且此前未就此发送过引导
- **THEN** 系统不再发送原先的一次性未聚焦引导，不追加 `reason: "unfocused"` 消息

#### Scenario: 同一情形不重复发送

- **WHEN** 上述情形持续存在（仍未聚焦）
- **THEN** 系统始终不追加未聚焦引导消息，而不是仅抑制重复发送

#### Scenario: 情形解除后可再次发送

- **WHEN** 目标重新被聚焦，之后再次出现未聚焦但有打开目标的情形
- **THEN** 系统仍不追加未聚焦引导；其他受支持的一次性引导在其情形解除后仍可再次发送

#### Scenario: 写入失败不影响会话

- **WHEN** 追加其他受支持的引导消息时抛出异常
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

当上游设置 `showContextUsage` 未配置或为 `false` 时，系统 SHALL 从 `pi-goal-x` 新生成的主模型可见内容中移除当前上下文 token 数、模型上下文窗口大小、占用比例和上下文遥测不可用占位；当用户显式配置为 `true` 时，活动目标的实时提示 SHALL 可包含上游格式的当前上下文快照（宿主不可用时包含 unavailable 占位）。无论该开关取值如何，系统 SHALL 移除目标累计耗时、没有有效 lifetime token budget 时的累计 token 消耗、没有有限运行额度时的运行次数统计，以及插件生成的审计成本/token/回合统计。系统 MUST NOT 用接近上下文上限作为暂停、阻塞、完成或要求用户另开会话的新增条件。

删除 SHALL 覆盖新生成的自动提示、目标上下文和状态消息、所有目标工具的模型可见返回、详细/历史查询、插件生成的压缩摘要及恢复说明。查询历史账本后新生成的返回属于本范围；已经存在于会话中的旧返回不属于本范围。仅属于 UI、持久化记录或宿主内部计费的数据不属于模型可见内容；如果这些数据通过模型可读取的结构化返回被暴露，SHALL 同样应用精简规则。

#### Scenario: 高上下文占用不进入主模型请求

- **WHEN** `showContextUsage` 未配置或为 `false`，一个未完成的 active 目标没有消费预算或有限运行额度，宿主报告上下文占用为 99%，目标还累积了大量 token 与耗时
- **THEN** 新生成的目标内容提供执行所需信息而不提供这些遥测；目标状态、续跑资格和完成 gate 不因遥测数值而改变

#### Scenario: 上下文遥测不可用时不输出占位

- **WHEN** `showContextUsage` 未配置或为 `false`，且宿主无法提供上下文用量
- **THEN** 插件新生成内容不提供 `Context snapshot: unavailable` 或替代的空值/零值占用提示

#### Scenario: 显式开启上下文快照

- **WHEN** 用户在全局或项目设置中显式启用 `showContextUsage`，活动目标的宿主报告当前上下文用量
- **THEN** 新生成的实时目标提示包含当前上下文 token 数、容量和占比；不附加无预算累计 token、累计耗时或审计成本，目标执行与真实预算规则不变
- **AND** 宿主无法提供用量时按上游格式提供 `Context snapshot: unavailable`；关闭开关后不生成新的上下文快照

#### Scenario: 关闭快照与请求前缀

- **WHEN** 同一会话先启用再关闭 `showContextUsage`，且目标策略与宿主会话历史没有其他失效变化
- **THEN** 请求可保留此前发送的快照以维持上游缓存前缀，但最新状态表明显示已关闭且不再生成新的占用读数；预算或其他执行约束变化仍按既有失效规则处理

#### Scenario: 所有生成渠道使用同一边界

- **WHEN** 主模型通过自动目标提示、创建/调整/更新/完成目标工具返回、`get_goal` 默认/verbose/历史查询和压缩恢复内容获取目标信息
- **THEN** 各渠道新生成的内容均不包含对应被移除的插件遥测；显式启用的上下文快照只进入实时目标提示，工具调用不会成为统计旁路；旧会话返回保持原样

### Requirement: 主模型保留真实消费和运行约束

系统 SHALL 在用户设置了有效 lifetime token budget 时保留预算总额、已用量与剩余量，并明确它是跨回合消费约束而不是上下文容量；已有预算耗尽引导和执行 gate MUST 保持原语义。系统 SHALL 保留有限运行额度及其禁用/耗尽含义，沿用既有运行计数展示设置；没有额度时 SHALL 不输出运行计数或仅用于展示的空限额占位。等待原因、deadline、轮询余量与执行准入等可行动的调度信息 MUST 保留。

#### Scenario: 有效消费预算仍可指导收尾

- **WHEN** 目标设置 lifetime token budget 且已有消费
- **THEN** 主模型能够获取真实预算的总额、已用与剩余数量以及消费约束含义；上下文容量快照仅在显式启用时提供，预算耗尽时既有收尾规则保持有效

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

精简 SHALL 保留目标原文及其信任标记、任务树与进度、当前任务、验证契约、完成审计 gate、审计 verdict/报告/findings、真实阻塞与恢复建议、焦点归属和状态边界。宿主自动压缩和压缩后目标恢复 MUST 保持原有行为；系统 MUST NOT 因移除遥测而删除有意义的目标状态快照或改变 checkpoint 配对、暂停/阻塞/预算受限 gate。未聚焦状态不再生成 open-goal 提醒属于明确预期差异，不依赖旧提示设置维持焦点边界。

#### Scenario: 压缩后继续执行未完成目标

- **WHEN** active 目标执行期间发生自动压缩
- **THEN** 压缩后主模型仍能恢复目标、当前任务及其契约、未解决审计反馈和必要调度信息，并按既有流程继续；新生成的恢复内容不加入已排除的遥测；不清洗宿主压缩摘要或历史消息

#### Scenario: 真实暂停与审计拒绝不能被精简绕过

- **WHEN** 目标处于 paused、blocked 或 budget_limited，或收到审计拒绝/错误
- **THEN** 主模型仍能识别状态与原因，既有恢复入口和完成限制不变；审计报告保留而插件另加的审计成本统计不进入主模型返回

#### Scenario: 无焦点与过期 checkpoint 保护保持

- **WHEN** 存在未聚焦目标或出现不再可执行的 checkpoint
- **THEN** 系统不自动选择、恢复或切换目标；未聚焦状态不生成 open-goal 提醒，需要焦点的工具校验和过期 checkpoint 防护继续生效

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

- **WHEN** `showContextUsage` 未启用，既无预算、也无有限运行额度的同一目标在执行状态不变时仅更新上下文用量、累计 token、耗时或无上限运行计数
- **THEN** 目标生成内容保持相同，不因这些变化追加新的尾部观测消息

#### Scenario: 工具循环与会话切换安全

- **WHEN** 工具循环连续构造请求，随后发生模型切换、会话恢复、压缩或预算变更
- **THEN** 工具调用/结果保持合法配对，旧保留尾部按既有失效规则处理，新生成的尾部不含已排除遥测；已持久化的旧消息仍允许原样重放

### Requirement: 遥测精简不扩大系统改造范围

系统 MUST 保持工具名称、参数 schema、存储版本和生命周期事务不变；除采纳上游默认关闭的 `showContextUsage` 外，MUST NOT 为本优化新增配置开关、命令、依赖、上下文阈值、强制压缩逻辑或新的自主停止策略。本规格声明的主模型呈现差异 SHALL 作为对既有生命周期兼容基线的补充，其余既有完成审计和消息通道契约保持有效。

#### Scenario: 比较改造前后公共契约

- **WHEN** 对比候选实现与本变更起点的工具注册、有效设置、目标状态转换、UI、审计输入和宿主压缩处理
- **THEN** 除已声明的新生成主模型呈现、新历史查询字段选择和上游 `showContextUsage` 开关外契约保持不变，未出现其他新工具/配置或因上下文比例而自主停止的条件

### Requirement: 完成审计监督问答在旁路同步闭环

完成审计 SHALL 为当前精确 attempt 的 `need_decision` 和 `interview_request` 提供旁路答复。被该 attempt 接管的监督请求 MUST NOT 启动主模型回合、MUST NOT detach 审计员、MUST NOT 使 `update_goal({status:"complete"})` 返回 pending 或提前报告审计错误；原工具 SHALL 等待同一个审计员的真正终态。只有原审计员通过验证的结构化 `approved` 才能提交完成事务。旁路答复、执行者声明、监督请求送达和普通文本中的批准词 MUST NOT 授权完成。

#### Scenario: 自由文本监督答复后批准

- **WHEN** 当前审计员发出 `need_decision`，旁路得到可确认的答案并成功回复，原审计员随后返回有效 `approved`
- **THEN** 原完成工具在问答期间保持未返回，主模型新增回合数与 detach 数均为零，审计员仅启动一次；只有真正批准后目标才完成

#### Scenario: 结构化访谈后拒绝

- **WHEN** 审计员发出 `interview_request` 并收到可解析的 JSON 答复，随后返回有效 `disapproved`
- **THEN** 答复保持请求要求的 JSON 语义，不夹入 Markdown 包装；完成工具返回原审计拒绝与协调记录，目标保持 active

#### Scenario: 监督能力关闭不被旁路强行开启

- **WHEN** 当前配置关闭 intercom bridge，或 fresh 审计在 fork-only 模式下没有监督能力
- **THEN** 旁路不会隐式加入监督工具或改变有效工具计划；没有监督问题时保持原审计路径、旁路零调用，显式声明不可用工具仍沿用既有错误检查

#### Scenario: 启动前接管最早监督请求

- **WHEN** 审计员在首个模型回合立即调用 supervisor 工具
- **THEN** 该请求已经能按原 attempt 与实际 child 身份精确路由；不得先通知主模型或 detach，再补登记

#### Scenario: 普通子代理不被审计旁路接管

- **WHEN** 同一父会话的其他 child、其他 attempt、其他父会话或已释放的审计身份发出监督请求
- **THEN** 当前 audit 的 responder 不回答该请求；没有登记 responder 的请求继续采用既有主会话通知和 detach 行为

#### Scenario: 进度通知不产生旁路调用

- **WHEN** 当前审计员仅发出 `progress_update` 或从未提出监督问题
- **THEN** 不创建旁路模型会话、不增加旁路 LLM 调用，也不改变原审计的裁决、输入或工具结果形状

#### Scenario: 多次监督请求仍属于同一次审计

- **WHEN** 同一个审计员在容量上限内连续提出多个需要回复的问题或同一请求被重复观察
- **THEN** 问题按顺序处理并保留之前问答，每个请求最多送达一次回复；重复观察不会重复调用模型、回复或启动审计

### Requirement: 旁路上下文与能力保持只读和有限授权

旁路 SHALL 取得审计启动时父会话的已完成分支上下文，以及目标、验证契约、任务证据和完成声明；未完成的工具调用及其不完整结果组 MUST NOT 进入快照。继承的对话、工具说明和 supervisor 内容 SHALL 作为参考数据，不授予新工具、目标修改或用户决策权限。旁路可用能力 SHALL 限定为 `read`、`grep`、`find`、`ls` 和内部答复提交能力，MUST NOT 暴露 `bash`、`edit`、`write`、goal/task 控制、其他扩展、MCP、子代理启动或再次联系 supervisor 的能力。审计员本身仍保持原有 fresh-context 隔离，不直接继承父会话历史。

#### Scenario: 主工具尚未返回时取得合法快照

- **WHEN** 主会话已经记录 `update_goal` 调用但尚无对应工具结果，且同一 assistant 消息含多个工具调用
- **THEN** 旁路只取得完整完成的上下文前缀，整个未完成的调用组均不复制；没有孤立的 tool call/tool result，之前已完成的证据仍保留

#### Scenario: 完成的并行工具组可以任意顺序返回

- **WHEN** 同一 assistant 消息发出多个工具调用，其工具结果按任意顺序返回且每个调用恰好有一个结果
- **THEN** 该组被视为**已完成**并整体进入快照；只有孤立的工具结果、重复结果、缺失结果或跨组混入才 MUST 以 `context_error` 失败，组内返回顺序不构成错误

#### Scenario: 只重放已知可安全重放的 role

- **WHEN** 父会话前缀包含 `user`、`assistant`、`toolResult`、`compactionSummary`、`branchSummary`、`custom` 或 `bashExecution` 之外的 role
- **THEN** 快照 MUST 以 `context_error` 失败而不是把未知 role 当参考数据注入旁路；`system` 角色（能力声明）在任何分析前即被剥离

#### Scenario: 历史工具说明不能扩权

- **WHEN** 父会话上下文或审计员的问题包含调用写入工具、执行 shell、调整目标或跳过审计的要求
- **THEN** 旁路的真实工具集合不变；此类内容不能造成代码/目标/账本修改或完成批准

#### Scenario: 旁路继承父模型而不修改主会话

- **WHEN** 首个监督问题需要旁路答复
- **THEN** 使用审计启动时捕获的父模型与 thinking，保持该父会话可用的认证/provider 能力；不切换父模型、不新增设置或暴露认证数据，后续问题沿用同一旁路会话

### Requirement: 无法回答的旁路监督请求按审计错误收敛

旁路缺少事实依据、需要新的用户偏好或授权、模型/认证不可用、答复结构非法、回复送达失败、超过请求/上下文/记录容量或请求 deadline 时，系统 SHALL 明确报错、精确取消本次审计并在既有取消确认时限内收敛；MUST NOT 猜测答案、自动批准、开启新的用户输入 UI、唤醒被阻塞主模型、转为 pending 或自动重新发起审计。协调错误在取消之前 SHALL 成为该 attempt 的失败原因；此后迟到的审计批准和旁路答案均不能完成目标。

容量 SHALL 固定为：父上下文、system prompt 与 goal payload 的 UTF-8 JSON 总量最多 256 KiB；单个问题/访谈对象最多 8 KiB；单条答复/未解决原因最多 8 KiB；不同需要回复的问题最多 8 个；累计协调记录 UTF-8 JSON 最多 96 KiB。等于上限允许、超出 1 字节拒绝。每个请求 SHALL 使用原 native ask expiry 与原 audit deadline 的较早者，后续请求/挂起/继续不得重置 deadline。

#### Scenario: 需要用户决策

- **WHEN** 问题需要现有用户要求未确定的产品/范围选择，旁路提交未解决原因
- **THEN** 当前审计被精确取消，工具返回“需要用户决策”及原问题/已完成协调记录；goal 不完成，不弹出新的访谈 UI

#### Scenario: 旁路启动或答复失败

- **WHEN** 旁路认证不可用、模型返回错误、没有有效答复，或 interview 答复不能解析为普通 JSON 对象
- **THEN** 该 attempt 以可操作审计错误结束，不将错误当作拒绝以外的批准，不影响其他子代理

#### Scenario: 错误之后迟到批准

- **WHEN** 协调错误或取消已经决定，而审计员随后返回 schema-valid `approved`，或旁路随后生成有效答案
- **THEN** 迟到结果不能被送达或提交，当前目标未完成，审计仍只产生一个终态

#### Scenario: 容量和时间上限

- **WHEN** 请求、上下文快照、答复或累计协调记录达到预先定义的有限容量，或该请求/审计 deadline 到期
- **THEN** 不截断正在送达的真实答案后继续批准，不延长或重置原 deadline；取消当前 attempt 并返回明确的容量/超时错误

#### Scenario: 外部异常诊断不回显认证或配置正文

- **WHEN** 父约束/runtime/snapshot捕获、SDK工厂或prompt/idle、deadline读取、序列化或队列边界抛出含认证、配置、长payload或嵌套cause的异常
- **THEN** 旁路返回固定的有界阶段诊断并保留原错误分类，不复制异常message/name/stack/cause或字符串异常正文，也不将被丢弃细节移入record/details/log/ledger；没有问题时仍不创建旁路模型会话
- **AND** 自动化内容oracle使用合成标记证明返回对象、协调记录及可观察诊断均不含原异常标记；仅验证长度不构成保密证明

#### Scenario: 安全诊断不降低失败关闭与默认工厂证明

- **WHEN** 原异常正文不再进入旁路错误返回
- **THEN** 无fallback、first-cause、精确取消与原生命周期保持；原两个正文依赖unit断言显式改验安全code/阶段，其他有效断言保持
- **AND** 默认工厂实际SDK创建、只读工具和父runtime借用仍须由既有无stub真实SDK测试证明，不能以直接调用stub、源码字符串或mock sessionFactory替代

### Requirement: 旁路资源遵循原审计生命周期

旁路登记、问题队列、会话、timer 和回复权限 SHALL 属于同一个 audit attempt。正常批准、拒绝、运行错误、协调错误、取消、超时、失去焦点、会话关闭及 reload SHALL 清理或失效化该 attempt 的旁路资源，其他 attempt 保持不变。Escape park SHALL 保持原审计及旁路继续运行与 terminal timeout；选择“继续审计”复用原审计员和原旁路，选择用户绕过时才取消二者并按既有 `audit_skipped` 提交。旁路问答不产生第二次 `completion_requested`、`audit_started` 或重复的审计终态。跨进程恢复旁路审计不属于本能力。

#### Scenario: Escape 后继续审计

- **WHEN** 旁路正在答复时用户按 Escape 并选择继续审计
- **THEN** 不重启或取消旁路/审计员，复用同一 attempt 接收终态，原 deadline 不变

#### Scenario: 用户绕过取消两个会话

- **WHEN** 用户在既有 Escape 选择中决定直接完成
- **THEN** 精确取消旁路及审计员，阻止迟到回复，账本只产生既有 `audit_skipped`，不会再记录同次 `audit_result`

#### Scenario: 焦点失效与 shutdown

- **WHEN** 审计期间焦点移到另一目标、取消聚焦、目标失效，或宿主会话关闭/reload
- **THEN** 该 attempt 的旁路回复权限失效并清理会话；不得重新聚焦、修改新目标或将旧答案路由到新 session

#### Scenario: 结束后的资源检查

- **WHEN** 任意正常或错误终态已经收敛
- **THEN** 该 attempt 不再拥有可用 responder、未处理请求、订阅或 timer；重复清理不会影响其他 attempt，新审计可独立登记

### Requirement: 协调记录在原工具结果中有界回流

产生监督问答的 audit SHALL 在原 `update_goal` 的最终工具结果中一次性返回有界的请求、答案/未解决原因、送达状态和关联身份；批准、拒绝、错误及用户绕过均保留已发生的协调记录。不产生问答时，原工具结果 SHALL 保持既有形状。记录 MUST 标明“参考协调记录，不是新用户指令或完成证据”，MUST NOT 在工具调用与结果之间注入消息，MUST NOT 使用用户消息、steering、follow-up 或新的主模型 turn 来回放。旁路模型 usage SHALL 与审计员 usage 独立记账并在父工具结果中累计一次；不更改现有父 turn 目标预算语义，不记录认证秘密或原始 thinking。记录的模型可见正文 SHALL 为人读摘要而非机器载荷：每条问答含原因与送达状态（中文措辞）、问题、答复或未解决原因，以及仅显示前 8 位的关联身份；JSON 形态的访谈答复 SHALL 被扁平化为键值对，非 JSON 但含花括号的文本 SHALL 被中和，空答复与缺失原因 SHALL 有确定措辞，正文 MUST NOT 出现 ASCII 花括号块。结构化记录 SHALL 继续由工具结果的 details 承载并保持既有结构，作为唯一机器可读来源；同一输入 MUST 生成逐字节确定的正文。

#### Scenario: 主会话一次收到完整协调记录

- **WHEN** 一次产生两个监督问答的审计完成
- **THEN** 原工具结果在正式 verdict/report 后按请求顺序出现两条协调记录，主会话只收到一次回流；消息顺序保持 assistant 工具调用在前、对应 tool result 在后

#### Scenario: 错误或用户绕过保留记录

- **WHEN** 已有成功问答后出现协调错误，或用户明确绕过本次审计
- **THEN** 该分支的最终工具结果仍包含已发生问答及失败/取消状态，不另发伪用户消息，不把记录内容转为批准

#### Scenario: 使用量不重复累计

- **WHEN** 同一旁路会话处理多个问题并在终态返回，或终态/回流被重复观察
- **THEN** 只累计该旁路已实际发生的模型 usage 一次，审计员原 usage 不被覆盖，不改变目标的父 turn token budget

#### Scenario: 正文是人读摘要且无 JSON 载荷

- **WHEN** 协调记录含 JSON 对象答复（访谈协议）、嵌套对象、数组、null、含花括号的散文、空答复或无原因的失败记录
- **THEN** 正文每条显示原因 · 状态、问题、答复或未解决原因、短身份；JSON 被扁平化为键值对、花括号被中和、空答复与缺失原因有确定措辞，正文不含 ASCII 花括号，也不含 undefined 或 null 字面量

#### Scenario: TUI 折叠与展开分别显示摘要与全文

- **WHEN** 用户在真实 TUI 中查看一次产生问答的完成的 `update_goal` 结果
- **THEN** 折叠态只增加一行摘要（条数 + 原因 · 状态），展开态显示完整人读记录（问题、答复或未解决原因、短身份），两态都不重复输出记录块，且正文中的记录不会被渲染丢失

#### Scenario: 无问答时渲染逐字节不变

- **WHEN** 一次完成没有产生任何监督问答
- **THEN** 工具结果正文与 goal 结果卡片的渲染输出与变更前逐字节一致，不新增标题、字段或行

#### Scenario: 自动化消费方读取结构化记录

- **WHEN** 自动化测试需要断言协调记录（包括未解决原因与身份绑定）
- **THEN** 它从工具结果的 details 读取结构化记录，而不是从正文解析 JSON；负向未解决判定与身份绑定强度不低于此前

### Requirement: 本次旁路监督变更使用完全自动化的验收证据

本次新增旁路监督契约及 D-15 SHALL 通过 agent 可运行的路由、消息配对、工具结果、取消、计费和真实 SDK 测试验收。既有基线中的历史“必要人工验证”措辞 MUST NOT 用作本次验收的替代路径；新增测试未执行、skip、取消或失败均不能标记本变更完成。生产默认 SDK 工厂与实际只读工具、父模型认证/runtime 借用 MUST 具有不经 stub 的自动化证据。

#### Scenario: Stub 测试不能代替真实 SDK

- **WHEN** mock/stub 单测通过但真实 SDK 测试缺依赖、被 skip 或未执行
- **THEN** 本次验收不通过，不宣称父认证/provider和实际工具隔离已验证，也不请求用户手工确认来代替测试

### Requirement: 最终验收包含真实 Pi 与真实模型的 E2E

本变更交付前 SHALL 在静态、单元与集成 gate 之后运行真实 Pi/TUI + 持久 tmux + 用户现有真实模型 provider 的 E2E，使用隔离临时工作目录及本地两个包源码，执行真实监督请求/回复与同一次审计终态。MUST NOT 用 scripted provider、mock Pi/SDK、禁用 auditor 或测试注入 verdict 代替此层验收。缺 Pi/tmux/凭据、超时、预期监督问答未发生或自动断言未通过 SHALL 报告失败或 blocked，MUST NOT skip/降级后标记完成。凭据不得被复制到命令行、提示、测试文件或证据日志，真实用户配置/goal 不得被修改。

#### Scenario: 真实可回答监督问题闭环

- **WHEN** 原审计员向 supervisor 请求父用户此前已决定的事实，旁路通过真实模型答复并送达
- **THEN** 自动证据证明父工具在问答期间未返回、窗口内父模型新请求为零、无detach、child只启动一次、该child实际收到答复后提交唯一真实批准，原工具结果一次返回裁决及协调记录，goal在实际归档边界完成

#### Scenario: 真实新授权问题保持未完成

- **WHEN** 原审计员提出父用户尚未授权的操作决策
- **THEN** 真实旁路返回未解决，当前审计明确报错并精确取消，原工具结果包含未解决记录，goal保持active且未归档，没有新增用户输入UI、自动授权或重新启动审计

#### Scenario: Live E2E 无法执行不能伪装为通过

- **WHEN** 真实模型凭据或持久 tmux 不可用，或模型没有执行预期监督请求，或只有 stub/SDK 模拟测试通过
- **THEN** 最终交付 gate 不通过并给出具体阻塞，保留实际命令/退出状态/运行证据；不切换假provider、不以人工确认代替、不宣称真实E2E完成

### Requirement: 自动续跑在最终发送前接受同步门禁

goal-x SHALL 在现有 timer 触发且目标与宿主 readiness 检查通过后、领取自主运行额度及追加状态快照/checkpoint 之前，发出 `pi-goal:before-auto-continue:v1` 事件。事件 SHALL 包含协议版本、父会话身份、目标身份和同步 `defer` 回调。监听者 SHALL 仅能阻止本次发送；无监听者或无人阻止时 SHALL 保持原有续跑行为。本变更 SHALL 作为既有兼容性基线的新增预期差异，其他目标生命周期与审计保证保持不变。

#### Scenario: 异步派发后未显式等待

- **WHEN** 父模型派发具有原生唤醒契约的异步子代理，未调用等待工具就结束执行，goal-x 随后准备自动发送 checkpoint
- **THEN** 门禁事件在领取额度和追加消息前发出，subagents 可以阻止该次发送，期间不产生 goal 自动唤醒的模型请求

#### Scenario: 未加载监听者

- **WHEN** 一次原本合法的自动续跑没有门禁监听者或所有监听者都不阻止
- **THEN** goal-x 沿用既有授权、状态快照/checkpoint 配对和发送流程，不增加等待时间或模型调用

#### Scenario: 宿主尚未就绪

- **WHEN** 原有 readiness 检查发现宿主忙碌或存在 pending messages
- **THEN** 本次不发门禁事件，继续沿用原有 50ms readiness 重试；本变更不改变这个周期

### Requirement: 门禁阻止具有单向且调用内有效的语义

任一同步监听者调用 `defer` 后，系统 MUST 阻止本次自动续跑，其他监听者 MUST NOT 将其覆盖为放行。事件派发返回后，迟到的异步回调 MUST NOT 改变决定或触发其他动作。监听者 MUST NOT 借此修改目标焦点、批准目标完成或绕过既有预算及授权 gate。事件处理 MUST NOT 依赖监听函数返回值。

#### Scenario: 多监听者顺序无关

- **WHEN** 一个监听者阻止，另一个监听者不阻止，且二者注册顺序互换
- **THEN** 两种顺序均阻止发送，不存在最后写入放行覆盖前一阻止的行为

#### Scenario: 迟到回调不生效

- **WHEN** 某监听者保存回调并在事件派发返回后调用
- **THEN** 该调用不改变已决定的发送结果，也不影响后续请求或产生异常唤醒

#### Scenario: 门禁处理期间目标失效

- **WHEN** 门禁监听期间目标失去焦点、暂停、完成，或出现新的宿主工作
- **THEN** 即使无人阻止也不得发送过期 checkpoint，最终授权与宿主状态校验仍生效

### Requirement: 被阻止的发送不派生重试或目标终态

门禁阻止 SHALL 仅结束当前发送尝试，不新增重试 timer、轮询、解除事件或模型调用，不消耗自主运行额度、等待检查额度或 checkpoint 序号，不追加配对快照及 checkpoint，不把目标改成 paused、blocked 或 complete。后续既有用户输入、子代理结果、监督请求和合法调度入口 SHALL 保持可用，每次新的自动发送尝试 SHALL 重新询问门禁。

#### Scenario: 阻止后经过多个原重试周期

- **WHEN** 门禁已阻止且没有新的合法调度入口，测试时钟跨过多个 50ms 周期
- **THEN** 不再次发送门禁事件、不产生新 timer 或 checkpoint，自主运行和等待检查次数均不增加

#### Scenario: 结果唤醒不受影响

- **WHEN** 阻止后子代理通过既有机制送达结果并唤醒父模型
- **THEN** 结果照常进入父会话；不需额外解除门禁，父模型处理结果后按原有 settled 流程重新判断自动续跑

#### Scenario: 用户继续交互

- **WHEN** 门禁阻止后用户发送新要求或操作目标
- **THEN** 用户输入及原有生命周期操作正常生效，门禁不形成用户输入屏障或自动选择其他目标

### Requirement: subagents 只根据当前父会话的原生唤醒工作阻止

subagents SHALL 同步读取其已有运行与通知交接状态，只为当前父会话拥有、且原生完成或监督路径承诺唤醒父模型的后台工作调用 `defer`。范围 SHALL 包含符合此条件的 async 运行、detached foreground 和结果尚未交接的终态工作。其他会话、仅展示任务或显式不触发父回合的任务 MUST NOT 单独造成阻止。监听器 MUST NOT 解析任意工具返回文本、通用 status/id 字段、扫描磁盘或调用模型。

#### Scenario: 当前父会话有原生异步工作

- **WHEN** 当前父会话存在具有原生结果唤醒的 queued 或 running 子代理
- **THEN** subagents 同步阻止 goal 自动发送，不要求模型额外声明 wait

#### Scenario: 最后一个子代理结束但结果未交接

- **WHEN** 最后一个子代理已进入成功、失败、停止等终态，但其应唤醒父模型的结果仍在原生通知交接中
- **THEN** subagents 仍阻止本次 goal 续跑，不让 checkpoint 抢在结果前发出；交接后沿用原有通知与去重语义

#### Scenario: 工作流根与 detached foreground

- **WHEN** 顶层 workflow 仍负责其子任务的结果交接，或 foreground 子代理已 detach 且仍通过原生监督/完成机制联系父会话
- **THEN** 对具有原生父会话唤醒契约的工作阻止自动续跑，不重复计算嵌套 child，不拦截监督请求

#### Scenario: 外部会话或无唤醒任务

- **WHEN** 只有其他父会话的工作，或只有明确不唤醒当前父模型的任务
- **THEN** subagents 不因此阻止当前 goal 自动续跑

#### Scenario: 监听器本地状态读取失败

- **WHEN** 本次适配器无法读取其必要内存状态
- **THEN** 适配器捕获错误并同步阻止本次发送，记录有界本地诊断，不自动暂停目标、不创建重试或伪造完成通知；用户输入仍可恢复交互

### Requirement: 门禁监听资源遵循扩展会话生命周期

subagents SHALL 在对应父会话准备好运行与交接状态后安装监听器，并在 shutdown、reload 和会话替换时释放或失效旧监听器。旧会话监听和迟到请求 MUST NOT 阻止新会话。该协议 SHALL 只作为进程内控制消息，不新增持久化记录版本、工具、设置、命令或模型上下文提示。

#### Scenario: 扩展加载顺序不同

- **WHEN** 两个扩展按不同顺序加载，随后完成会话初始化
- **THEN** 首次合法自动续跑可取得当前 subagents 的门禁判断；subagents 缺失时继续保持无人阻止的原行为

#### Scenario: 会话切换或重载

- **WHEN** 旧会话有后台工作而父会话切换或扩展 reload
- **THEN** 旧订阅被清理，重建后的监听器只使用当前会话与已恢复的权威状态，不残留永久阻止标志

#### Scenario: 未阻止时不改变模型输入

- **WHEN** 门禁无人阻止
- **THEN** 新生成的主模型消息内容、工具声明和状态快照/checkpoint 配对沿用原行为，门禁事件与理由不写入模型上下文

### Requirement: 未聚焦会话不自动提供其他目标的模型引导

当前会话没有 focused goal 时，系统 MUST NOT 仅因存在 open goal 而向模型新增目标数量、`[PI GOAL UNFOCUSED]` 提醒或要求用户先 focus 的引导。该约束 SHALL 覆盖请求上下文、隐藏持久化消息、会话载入和取消聚焦路径；普通交互 MUST NOT 被要求先选择 goal。已有历史消息、工具结果与压缩摘要 SHALL 保持原样，用户显式查询目标的结果不属于自动提醒。

#### Scenario: 多次普通请求

- **WHEN** 未聚焦会话存在一个或多个 open goal，连续发送普通请求并进入工具循环
- **THEN** 插件不生成新的未聚焦提醒，不阻塞普通交互，也不为此触发模型回合或修改 goal/focus

#### Scenario: 载入与取消聚焦

- **WHEN** 会话启动、恢复、reload、切换到未聚焦会话，或用户取消聚焦后发送请求
- **THEN** 插件不生成未聚焦提醒，其他会话的 focus 不被接管，已有 open goal 保持原状态

#### Scenario: 已有历史提醒保持原样

- **WHEN** 恢复的会话或压缩摘要已经含有旧未聚焦提醒
- **THEN** 系统不删除、重写或全局过滤该历史，也不据此生成新的提醒；不承诺历史重放中完全不出现旧标记

#### Scenario: 用户显式查询不受影响

- **WHEN** 用户主动执行目标列表、状态或聚焦相关命令
- **THEN** 系统按原契约展示或操作目标，不把用户主动查询当作应禁止的自动模型提醒

### Requirement: 未聚焦提示设置仅保留旧配置兼容

系统 SHALL 继续接受并按既有解析与持久化规则保留旧键 `hideUnfocusedPrompt`，但 MUST NOT 再以其取值决定模型提示行为。该键 SHALL 从可编辑设置菜单和常规设置展示中移除，不要求用户迁移或自动重写配置。`hideUnfocusedBanner` SHALL 继续独立控制未聚焦 UI，不影响 focused dashboard 或审计 UI。

#### Scenario: 旧键取值均不注入

- **WHEN** global/project 层中的旧键为缺省、`true`、`false` 或存在相互覆盖
- **THEN** 均不生成未聚焦提醒；合法旧配置仍能读取，保存其他设置时不会因本次废弃而主动删除旧键

#### Scenario: 设置入口与 UI 提示分离

- **WHEN** 用户查看或编辑设置，并分别开启或关闭 `hideUnfocusedBanner`
- **THEN** 旧提示键不再作为可编辑项或常规设置行出现；未聚焦 banner/status 按原 UI 开关显示或隐藏，模型均无新增提醒

### Requirement: 未聚焦执行权限由运行时保持

不发送未聚焦提醒 MUST NOT 授予模型 focus 选择权。需要 focused goal 的生命周期与任务操作 SHALL 继续在工具侧拒绝无焦点调用，返回明确的选择目标指引而不修改已有目标；失效 checkpoint SHALL 在原调度边界拒绝。聚焦目标的执行上下文、压缩恢复、真实预算约束及完成审计 SHALL 保持既有行为。

#### Scenario: 无焦点调用需要目标的工具

- **WHEN** 无 focused goal 时调用要求 focused goal 的生命周期或任务操作
- **THEN** 工具返回既有可操作错误，不选择目标、不修改目标或目标证据，不启动自动续跑

#### Scenario: 未聚焦时收到过期续跑

- **WHEN** 旧 checkpoint 在目标取消聚焦后被调度或送达
- **THEN** 原失效检查阻止其执行，不因移除提醒而进入目标工作；原有拒绝说明不受禁止普通提醒的约束

#### Scenario: 显式聚焦后正常执行

- **WHEN** 用户通过既有命令显式聚焦目标并开始执行，之后发生压缩或请求完成
- **THEN** 正常执行上下文、恢复、预算门禁与审计流程仍按既有契约运行，不把该目标误当作应静默的未聚焦状态

### Requirement: 目标调整默认展示语义差异

调整已有目标的确认流程 SHALL 默认展示当前权威目标与候选生效结果之间的差异，而不是新建目标预览。正文 SHALL 使用行级 `-` 删除、`+` 新增及少量相邻上下文；不变的大段正文 SHALL 以省略提示替代。调整确认框的实际可用内容区达到 120 列时 SHALL 并排显示旧值和新值，低于 120 列时 SHALL 使用上下排列。颜色 MUST NOT 是唯一的增删识别手段。没有实际变更时 SHALL 明确提示，不得伪造增删。

#### Scenario: 正文局部修改

- **WHEN** 长目标中只有中间两行被替换
- **THEN** 默认视图展示旧行、新行及相邻上下文，省略不变的大段内容，并明确标识删除和新增

#### Scenario: 重复行与中文正文

- **WHEN** 目标包含重复行、空行、中文或超长单行，且发生插入、删除或替换
- **THEN** 差异保留原文和顺序，不将折行或显示宽度变化当作内容修改，同一输入得到确定的差异

#### Scenario: 没有实际变更

- **WHEN** 规范化后的候选与当前目标在所有受本次调整影响的语义字段上相同
- **THEN** 界面明确显示“没有实际变更”或同义文案，沿用既有确认处理，不宣称创建新目标

#### Scenario: 宽屏并排及窄屏回退

- **WHEN** 调整确认框的实际可用内容区分别为 120 列或更宽、以及 119 列或更窄
- **THEN** 前者以有明确旧/新标识的左右两列展示，后者以上下排列展示同一组语义差异；缩放不改变候选或决策

#### Scenario: 多种语义字段的对应展示

- **WHEN** 本次调整同时改变目标正文、验证契约、相同 ID 任务的字段与顺序，并新增或删除其他任务、改变设置
- **THEN** 适合配对的旧值和新值在宽屏分别位于左右两侧；任务身份、父子关系与顺序保持明确，不能将移动伪装为无关任务的删除及新增；单侧变化和不适合配对的说明仍完整可辨

### Requirement: 差异覆盖任务与全部生效设置

目标调整差异 SHALL 覆盖目标正文、目标验证契约、任务增删改及父子层级和同级顺序、任务验证契约与轻量子任务标记、任务完成阻塞规则、预算和审计开关。既有调整规则导致的生命周期状态、当前任务或自动续跑策略变化 SHALL 同样显示。时间戳、revision、累计用量等簿记字段 MUST NOT 被当作目标内容变化；未变化字段不重复展开。

#### Scenario: 任务按身份匹配

- **WHEN** 相同 ID 的任务改标题、改父节点、改同级顺序或改验证契约，另有任务新增或删除
- **THEN** 相同 ID 标为修改并展示具体旧值和新值，新增和删除分别标识，不把移动伪装成无关任务的删除及新增

#### Scenario: 任务进度被保留

- **WHEN** 已完成或已跳过任务在候选中保留相同 ID，且仅修改结构性字段
- **THEN** 全文保留既有状态和证据，差异不声称这些任务被重置为待办；被删除的当前任务及当前任务引用变化被如实展示

#### Scenario: 只改预算或任务规则

- **WHEN** 正文不变，仅预算由有限改为无上限，或任务完成阻塞规则、轻量子任务标记发生变化
- **THEN** 差异只展示对应变化，预算明确表示跨回合消费上限，不重复输出未变正文和无关运行统计

#### Scenario: 确认导致恢复或预算受限

- **WHEN** 按既有准入规则，本次确认将恢复 paused/blocked 目标，或使其进入 budget_limited，或改变自动续跑策略
- **THEN** 预览展示可观察状态和策略的旧值与候选新值，不因本展示功能改变原准入规则

### Requirement: 差异基于与提交相同的有效候选

系统 SHALL 依照原有输入校验、正文与验证契约抽取、参数缺省保留、任务进度合并及状态准入规则构造候选，差异和修改后全文 SHALL 使用该候选。MUST NOT 将未生效的工具参数当作实际变化。用户在确认前修改审计开关时，当前差异及全文 SHALL 同步反映该选择。

#### Scenario: 缺省参数保留原值

- **WHEN** 调整省略任务和预算，或未提供新的目标验证契约
- **THEN** 预览遵循提交时的原值保留规则，不声称删除任务、移除预算或清除仍将保留的契约

#### Scenario: 显式空任务列表

- **WHEN** 工具显式提供空任务列表且通过既有校验
- **THEN** 预览与原提交语义一致，不能误当作省略参数，也不能另行从正文派生任务

#### Scenario: 审计开关实时变化

- **WHEN** 用户在确认框中切换审计开关，再切换差异与全文视图
- **THEN** 两种视图均反映当前选择；切回原值后对应差异消失，最终提交值等于确认时所见值

### Requirement: 差异与修改后全文可只读切换

交互确认 SHALL 提供可发现的“差异 / 修改后全文”切换。全文 SHALL 包含候选的完整正文、验证契约、任务树及本次涉及的有效设置。两种视图在窄屏和长内容情况下 SHALL 可滚动阅读全部内容并到达决策控件；切换 MUST NOT 提交、取消、重新发起模型回合或丢失当前审核状态。

#### Scenario: 查看全文后返回差异

- **WHEN** 用户切到全文阅读后返回差异
- **THEN** 仍处于同一待确认提案，审计选择和已输入反馈保持，未写入目标或触发执行

#### Scenario: 终端内容超过一屏

- **WHEN** 目标、任务或差异超出终端高度，或终端调整为窄屏
- **THEN** 所有实际变化及全文均可通过滚动到达，行宽受终端约束，确认、继续讨论和取消操作仍可到达

#### Scenario: 基础交互回退

- **WHEN** 宿主只有既有基础交互能力而不能渲染富确认视图
- **THEN** 同一提案仍可查看差异与全文并明确确认、继续讨论或取消；宿主完全不支持确认时沿用既有不可用处理，不静默批准

### Requirement: 调整确认文案与会话记录一致

调整已有目标 SHALL 使用“确认调整目标”“确认修改”等明确的调整文案，不得提示创建新目标。确认框、工具的人类可见展示和关闭后的结果记录 SHALL 使用同一语义差异；确认、继续讨论和取消后均 SHALL 保留当次差异和实际决策以便回看。结果全文 SHALL 可从展开记录查看，而不要求模型先输出重复的完整提案。

#### Scenario: 确认修改后回看

- **WHEN** 用户确认调整并关闭弹窗
- **THEN** 会话中仍能查看该次基线到候选的差异、修改后全文和成功结果，不以当前目标重新计算覆盖旧差异

#### Scenario: 继续讨论或取消

- **WHEN** 用户继续讨论并输入反馈，或取消调整
- **THEN** 记录保留差异及对应决策；反馈原样回传，继续讨论保留草拟，取消结束草拟，两者均不修改原目标，也不声称创建失败或删除目标

#### Scenario: 渲染先于权威状态读取

- **WHEN** 工具调用开始时只能取得尚未校验的内存目标，而执行阶段将读取权威目标
- **THEN** 初步展示明确标为待校验；确认之前提供与权威基线一致的完整差异，后续记录不把初步展示伪称为已确认结果

### Requirement: 差异审核保持既有事务和创建兼容性

目标调整的呈现差异 SHALL 作为既有生命周期兼容基线的明确补充；工具名称及原有参数语义、存储版本、任务合并与执行 gate MUST 保持不变。`propose_goal_draft` 仅新增可选的模型调整入口，手动调整不要求新参数。审核期间目标身份、焦点或 revision 失效时 MUST 拒绝过期提交并提示重新审核。新建普通目标和 Sisyphus 目标 SHALL 保持原展示及确认语义；只读查看不写目标、账本或触发额外模型回合。

#### Scenario: 审核期间发生并发修改

- **WHEN** 弹窗展示后磁盘目标 revision 改变、目标被替换或焦点改变
- **THEN** 原提案不能提交，返回明确过期提示，不将旧预览未经再次确认应用到新状态

#### Scenario: 创建流程不回归

- **WHEN** 用户通过新建普通目标或 Sisyphus 的草拟流程提交提案
- **THEN** 保留原完整提案展示、任务预览、审计选项及创建决策语义，不出现调整专用差异或按钮

#### Scenario: 无 UI 与显式自动确认

- **WHEN** 使用既有无 UI 或显式自动确认路径
- **THEN** 保持原确认策略，并在结果中保留同语义差异，不因缺少新视图而新增隐式批准或绕过校验

#### Scenario: 手动调整不回归

- **WHEN** 用户以 `/goal-tweak` 发起调整并使用原有参数提交提案
- **THEN** 仍使用原确认方式和事务，不要求提供 `tweak` 或额外理由，不改变原有可调整的目标状态

### Requirement: Goal-X 支持项目本地配置来源

系统 SHALL 自动读取 `<cwd>/.pi/pi-goal-x-settings.local.json`，对所有受支持的 Goal-X 配置按“已有配置项环境变量 > local > project > global > 默认值”解析。local MUST 以当前工作目录定位，不随 `PI_GOAL_SETTINGS_FILE` 改变；既有全局及项目路径覆盖保持原义。未提供 local 时 MUST 保持原有有效配置和生命周期行为，不自动创建配置文件。

#### Scenario: 三个文件同时提供不同字段

- **WHEN** global 提供通用设置，project 提供 `auditor.checklistExtra`，local 提供 `auditor.provider` 和 `auditor.model`
- **THEN** 三类字段同时生效，模型选择来自 local，审计清单来自 project，全局其他设置继续生效

#### Scenario: 同一字段存在多层覆盖

- **WHEN** 同一受支持字段在 global、project、local 中均有合法值
- **THEN** 使用 local 值；该字段如果已有且提供了有效配置项环境变量，则环境变量值优先

#### Scenario: 全部配置域可本地覆盖

- **WHEN** local 提供合法的任务设置、auditor、Oracle、网络恢复、命令或快捷键配置
- **THEN** 各域均使用相同三层优先级，不限制为审计模型专用配置

#### Scenario: 自定义共享配置路径

- **WHEN** `PI_GOAL_SETTINGS_FILE` 指向其他位置的项目配置文件
- **THEN** project 从该路径读取，local 仍从当前工作目录的固定本地文件读取，global 路径规则不变

#### Scenario: 缺少本地文件

- **WHEN** 本地文件不存在
- **THEN** 有效配置与原两层解析相同，不为缺失文件告警，也不因读取设置创建本地文件

### Requirement: 三层配置延续字段继承语义

系统 SHALL 在已有 schema 与校验规则内按字段继承，对数组整体覆盖而非拼接。合法 false、0、空数组 SHALL 保持显式覆盖语义；缺省字段继续继承。删除本层字段 SHALL 恢复向低层解析，MUST NOT 引入以 null 清除继承值的新协议。旧别名规范化规则 SHALL 在每个来源内部保持一致。

#### Scenario: 嵌套对象只覆盖一个字段

- **WHEN** project 设置审计清单和模型，local 只设置审计模型
- **THEN** local 模型覆盖 project 模型，但 project 审计清单仍保留

#### Scenario: 数组及假值覆盖

- **WHEN** local 对允许相应取值的字段配置 false、0 或空数组，而低层配置其他合法值
- **THEN** local 值生效；数组不与低层拼接，空数组不会被当成未配置

#### Scenario: 删除后逐层继承

- **WHEN** 用户删除 local 中的模型字段，再删除 project 中同一字段
- **THEN** 首先恢复 project 模型，随后恢复 global 或默认值，未修改其他层内容

#### Scenario: 兼容旧别名

- **WHEN** 不同层使用受支持的旧平面别名与嵌套规范键
- **THEN** 各层先沿用既有别名规则，再应用层级优先级；同层嵌套规范键优先

### Requirement: 设置界面完整支持三个编辑范围

`/goal-settings` SHALL 支持 global、project、local 三个编辑范围，首次打开默认仍为 project。界面 MUST 明示当前范围与目标路径，并区分最终生效值、来源、本层值或未设置状态；被高优先级来源覆盖时 SHALL 明确提示。Controls 子菜单 SHALL 支持同样范围与来源语义。范围切换和查看 MUST NOT 写文件或触发模型回合。

#### Scenario: 保留默认项目共享编辑

- **WHEN** 用户首次打开设置界面
- **THEN** 默认编辑 project，即使 local 已存在也不自动改为 local；顶部显示项目共享文件路径

#### Scenario: 编辑被本地层覆盖的共享值

- **WHEN** project 模型为 A、local 模型为 B，用户查看 project 并将模型改为 C
- **THEN** 界面区分本层 C 与生效 B，提示 local 覆盖；只保存 project，不修改 local 或 global

#### Scenario: 本地层恢复继承

- **WHEN** 用户切换到 local 并选择删除某项本层覆盖
- **THEN** 仅移除 local 对应字段，界面显示新的有效值和 project、global 或默认来源

#### Scenario: Controls 使用本地配置

- **WHEN** 用户在 local 范围编辑命令、快捷键或暂停顺序
- **THEN** 只写本地文件，删除覆盖按字段恢复继承，适用的刷新或 reload 提示沿用原有机制

#### Scenario: 已有环境变量覆盖

- **WHEN** 某行由已有配置项环境变量控制
- **THEN** 显示环境来源及既有只读提示，不允许通过编辑 local 绕过该环境值

### Requirement: 本地配置遵循既有诊断与安全写入契约

系统 SHALL 对 local 复用既有字段校验与诊断规则，诊断可定位范围、路径及问题字段；非法字段不抹除同文件合法兄弟字段。设置编辑 MUST 拒绝覆盖非法目标文件，并使用既有路径锁、锁内重读、原子写入、权限及符号链接防护。有效配置来源报告 SHALL 纳入 local，刷新边界 SHALL 与现有配置保持一致。

#### Scenario: 非法本地字段

- **WHEN** local 包含非法字段值以及其他合法字段
- **THEN** 非法值被诊断且不参与覆盖，合法字段仍生效；向下继承或默认处理沿用既有规则

#### Scenario: 损坏文件不能被设置界面覆盖

- **WHEN** 本地文件为非法 JSON，或被既有校验判定为非法目标层
- **THEN** 界面写入失败并报告 local 路径与原因，原文件及其他层保持不变

#### Scenario: 修改与刷新

- **WHEN** 通过设置界面修改 local，或在外部修改后经过既有会话启动、恢复、reload 或显式缓存失效边界
- **THEN** 后续配置读取和来源报告使用刷新后的本地值；不额外承诺无刷新边界的文件热监控

#### Scenario: 并发与文件安全

- **WHEN** 两个进程修改 local 的不同字段，或目标文件命中既有符号链接拒绝规则
- **THEN** 并发写入经锁内重读不丢失字段；不安全目标按既有规则拒绝，不能因此改写 global 或 project

### Requirement: 新配置层保持运行与存储边界

三层配置 SHALL 作为既有目标生命周期兼容基线的明确补充。系统 MUST 保留旧 project 读写接口的范围、per-goal auditor override 的优先级及审计各字段的生效时机，不改变目标工具 schema、存储版本、审计裁决和执行授权。插件 MUST NOT 自动迁移用户设置、自动修改 Git 忽略规则，或把本地层宣称为强制团队策略或凭据存储。

#### Scenario: 实际审计使用本地模型及共享纪律

- **WHEN** local 设置合法审计 provider/model，project 设置附加审计清单，且没有更高层的 per-goal override
- **THEN** 审计请求使用该模型和共享附加清单，global 中其他审计字段继续生效，完成仍须通过原有门禁和真实审计裁决

#### Scenario: 定义层仍按原时机生效

- **WHEN** 用户修改 local 中请求层设置或默认审计 agent 定义层设置
- **THEN** 请求层沿用下次审计生效规则，定义层仍按新会话或 reload 生效，不因新增来源改变注册生命周期

#### Scenario: 不污染共享及个人配置

- **WHEN** 安装或加载插件、读取设置或关闭设置界面而未执行编辑
- **THEN** 不迁移已有模型字段、不写全局或共享文件、不修改用户仓库 Git 规则；忽略本地文件由仓库维护者显式配置

### Requirement: 审计清单使用同一生效快照

系统 SHALL 在每次审计启动时基于已解析的有效设置生成唯一清单快照，供审计任务与 dashboard 共用。显式 `checklist` SHALL 替换默认清单，包括显式空数组；`checklistExtra` SHALL 按顺序追加。默认条件项 SHALL 继续遵循契约启用情况及变更清单可用性。每项 MUST 有审计内唯一 ID；同一 attempt 的挂起/继续 MUST 保留快照，配置变更只影响下一次审计。

#### Scenario: 默认与条件项

- **WHEN** 未设置 checklist，且验证契约已启用并存在、变更清单可用
- **THEN** dashboard 与审计任务包含相同顺序的默认项及对应条件项；关闭契约或无变更清单时相应项不出现

#### Scenario: 替换及附加

- **WHEN** 设置 checklist 和 checklistExtra
- **THEN** 生效清单仅包含替换清单后接附加清单，提示词与 dashboard 使用相同项目及 ID；相同文字的不同条目不合并

#### Scenario: 空替换与仅附加

- **WHEN** checklist 显式为空、checklistExtra 非空
- **THEN** 只使用附加条目，不恢复默认清单；两者都空时清单为空

#### Scenario: 审计中修改配置并继续

- **WHEN** 审计启动后配置改变，用户按 Escape 再继续原审计
- **THEN** 同一 child 和 attempt 继续使用原清单及既有状态；新审计才读取新配置，不将旧状态套到新清单

### Requirement: 逐项进度上报保持有界和隔离

系统 SHALL 接受当前审计工具结果中版本化的逐项 ID、状态及简短依据，状态为 pending、running、passed 或 failed。上报 MUST 只更新该 attempt 快照中的现有项目，不允许临时增删改清单；未知 ID、非法状态、损坏记录 MUST 不污染状态或改变 verdict。旧 label/percentage 上报 SHALL 继续可用，但 MUST NOT 推算条目状态。内部记录 MUST NOT 作为普通审核正文显示。

#### Scenario: 按 ID 更新及修正

- **WHEN** auditor 上报某项 running 后上报 failed，随后重新核验并上报 passed
- **THEN** 相应条目以最后一次有效上报为准，更新依据，其他条目不变；重复同一记录不重复计数

#### Scenario: 未知及非法上报

- **WHEN** 工具结果含未知 ID、非法状态、无效字段组合、损坏 JSON 或超限进度字段
- **THEN** 无效逐项更新被忽略并有有界诊断，不创建检查项、不影响有效结果或审计生命周期

#### Scenario: 跨 attempt 与迟到事件

- **WHEN** 非当前 attempt 的进度到达，或终态后又收到进度
- **THEN** 当前清单与已冻结终态不变，其他目标和审计不受影响

#### Scenario: 仅预览参数不能更新状态

- **WHEN** currentToolArgs 显示 passed 而没有有效的进度工具结果记录
- **THEN** dashboard 不将该项标记通过

### Requirement: 检查项展示不得成为新的完成门槛

逐项状态 SHALL 仅为审计员报告的展示数据，不是独立验证证据。系统 MUST 保留现有结构化 verdict、前置门控及完成事务，不因未检查项、失败项或缺失进度新增阻止完成条件；全项通过 MUST NOT 替代有效 approved。任意终态 MUST 保留最后有效逐项状态，不自动补勾，尚在检查中的条目 SHALL 明确标明审计已结束或中断，不伪装成仍在运行。

#### Scenario: 批准但上报不全

- **WHEN** 审计员返回合法 approved，但条目仍有 pending、running 或 failed
- **THEN** 继续原批准与完成流程；检查项不被自动改为通过，result card 只展示真实 verdict，不声称未上报检查项已核验

#### Scenario: 全项通过不能授权完成

- **WHEN** 所有项目 reported passed，但没有有效裁决，或裁决为 disapproved/error
- **THEN** 仍按原规则保持目标未完成，检查项数量和通过状态不能授予完成权限

#### Scenario: 超时及取消不补勾

- **WHEN** 审计失败、超时或取消
- **THEN** 保留最后有效状态并显示结束/中断提示，不把未检查项统一标为通过或失败；用户明确绕过仍按原 audit_skipped 路径处理

### Requirement: 普通任务视图按当前分支展开

普通目标 Dashboard 的紧凑与展开视图 SHALL 按原计划顺序显示可折叠任务树。自动跟随状态 SHALL 展开当前任务的全部祖先及当前任务自身的直接子任务（如有），其他分支收起；各已展开层级的同级任务保持可浏览。父任务 SHALL 有明确展开标记，叶子任务不得伪装成可展开。当前任务 SHALL 沿用已有显式焦点与推断回退语义，推断结果不写入目标。

#### Scenario: 执行后部深层任务

- **WHEN** 当前任务为后部根任务下的三级子任务
- **THEN** 祖先路径展开，当前任务及同级任务进入可浏览行序列，其他根分支只保留根行；不会仍只展示最前几个顶层任务

#### Scenario: 当前任务是父任务

- **WHEN** 当前任务本身有子任务
- **THEN** 其祖先与自身展开并显示直接子任务；非路径上的子分支仍收起，不递归展开所有后代

#### Scenario: 无有效显式任务焦点

- **WHEN** 持久化当前任务缺失、无效或已不再待办
- **THEN** 沿用已有的首个待办任务推断规则显示当前任务并展开对应路径，明确推断标记，不为展示修改焦点

#### Scenario: 已无待办任务或任务禁用

- **WHEN** 全部任务完成或跳过、任务为空，或任务功能被禁用
- **THEN** 无当前任务时默认收起全部分支；保留原有完成、空态或禁用展示，不虚构当前任务或不可用控件

### Requirement: 任务视口优先跟随当前任务

首次展示目标、切换目标或有效当前任务身份变化时，普通任务视图 SHALL 恢复自动分支状态并让当前任务进入实际可见窗口，优先保留祖先上下文和附近任务。紧凑与展开视图 SHALL 遵守各自有界容量，MUST NOT 依靠无限增高或仅定位最近完成任务来实现跟随。没有当前任务时 SHALL 使用有界的确定性回退位置。

#### Scenario: 未完成任务直接切换执行焦点

- **WHEN** 当前任务由第一个切换为后部任务，期间没有新增完成时间
- **THEN** 下一次展示定位到后部当前任务，不等待任务完成事件

#### Scenario: 跨分支执行

- **WHEN** 当前任务由分支 A 切换到分支 B
- **THEN** A 自动收起，B 路径自动展开，当前任务在紧凑和展开模式下均能实际看见

#### Scenario: 列表超出可用空间

- **WHEN** 当前分支或祖先数量超过可用行数，或终端变窄变矮
- **THEN** 在至少能容纳一条任务行的布局下，当前任务行优先于完整祖先路径和邻居保留；其余行可滚动访问，显示范围提示，不因最终高度裁切再次隐藏当前任务

#### Scenario: 终端无法容纳任务行

- **WHEN** 终端可用空间不足以在必要界面元素之外容纳一条任务行
- **THEN** 使用明确的空间不足摘要，不绘制越界行或不可见命中目标；恢复可用空间后按当前跟随或手动浏览状态重新布局

#### Scenario: 没有当前任务

- **WHEN** 目标有任务但没有任何待办任务
- **THEN** 初次定位到最近完成任务所属的可见祖先行，找不到时定位首行；不越界、不创建执行焦点

### Requirement: 手动任务浏览保持到执行焦点变化

键盘或鼠标手动滚动、展开或收起分支后，普通刷新 SHALL 保留浏览位置与分支状态，不因用量、耗时、无关任务完成时间变化而重置。有效当前任务身份变化或用户主动“回到当前任务”时 SHALL 清除手动覆盖并恢复自动路径与定位。手动收起当前路径 SHALL 被允许且不改变执行焦点。视图状态 SHALL 仅在当前组件生命周期内保存，不持久化。

#### Scenario: 手动查看其他任务

- **WHEN** 用户滚动到早期任务并展开其他分支，随后仅发生普通刷新或无关任务完成
- **THEN** 浏览状态保留，不自动拉回当前任务

#### Scenario: 手动收起当前路径

- **WHEN** 用户单击当前任务的父行将其收起
- **THEN** 子行隐藏而执行焦点不变；后续普通刷新不立即重新展开

#### Scenario: 恢复跟随

- **WHEN** 用户点击“回到当前任务”，或有效当前任务身份切换
- **THEN** 手动分支覆盖清除，当前路径重新展开并定位；主动恢复不触发任务启动或模型回合

#### Scenario: 模式切换与结构变化

- **WHEN** 用户切换紧凑/展开视图，或浏览时任务被删除、移动或终端尺寸变化
- **THEN** 两种模式共用分支状态，各自滚动位置合理保持并校正到合法范围；无效任务状态被清除，不将旧位置误认作另一个任务的身份

#### Scenario: 会话替换和重载

- **WHEN** 切换目标、替换会话、关闭组件或 reload
- **THEN** 旧点击手势与视图状态失效；新目标首次展示按自身当前任务初始化，不继承同名任务的旧覆盖

### Requirement: 鼠标滚轮限定在任务列表内部

鼠标位于普通 Dashboard 实际任务列表区域时，滚轮 SHALL 按宿主提供的有符号逻辑步长滚动可见任务树，不重复加速，不改变任务焦点。任务区内滚轮在首尾或内容不足一屏时 SHALL 仍被消费，避免滚动背后聊天记录；区域外事件 SHALL 保留宿主原有路由。

#### Scenario: 正反向滚动

- **WHEN** 在紧凑或展开任务列表内向上或向下滚动
- **THEN** 视口按当前可见树有界移动；折叠后代不计入滚动行数，不改变执行任务和聊天记录位置

#### Scenario: 边界不穿透

- **WHEN** 列表已到首尾或只有少量任务，用户继续在任务区滚动
- **THEN** 视口不越界、不回绕，背后聊天记录不滚动

#### Scenario: 非任务区域与浮层

- **WHEN** 指针在状态、验证契约、边框或编辑区滚动，或有前置浮层接管该位置
- **THEN** 普通任务滚动处理不消费该事件，不影响编辑区、浮层和宿主滚动

### Requirement: 父任务整行支持安全单击折叠

父任务整条可见内容行 SHALL 支持左键完整单击展开/收起，不要求精确点击箭头。切换 SHALL 只在同一目标上无拖动的完整单击后发生一次，按下事件 MUST NOT 被消费或抢占选区。叶子行、右键、拖动、链接及无效目标 MUST NOT 触发分支切换；双击选词的后续点击 MUST NOT 造成额外切换。任何此类操作 MUST NOT 修改任务状态。

#### Scenario: 点击标题或展开标记

- **WHEN** 用户在父任务的标题、缩进或展开标记处完成左键单击
- **THEN** 该父任务切换一次展开状态，不切换面板模式，也不启动或完成任务

#### Scenario: 拖选和非单击

- **WHEN** 用户从父行按下后拖动选择文本、右击，或进行双击选词
- **THEN** 不将拖动、右击或双击的后续点击当成额外切换；原有选择、复制和链接行为保留

#### Scenario: 叶子或非任务行

- **WHEN** 单击叶子任务、进度汇总、边框或空白填充行
- **THEN** 不切换任何分支；非控件位置不触发展示外的行为

### Requirement: 鼠标控件与命中遵循最终绘制

普通 Dashboard SHALL 在底边框提供可发现且可点击的面板展开/收起及“回到当前任务”控件；后者仅在存在当前任务时启用。任务与控件命中 SHALL 依据最终可见内容和当前任务身份，包含缩放、换行、截断及稳定高度填充后的几何。绘制失效或手势期间目标变化时 MUST 拒绝过期点击，MUST NOT 根据文本或固定行偏移猜测。

#### Scenario: 控件操作

- **WHEN** 用户完整单击面板展开/收起或可用的“回到当前任务”控件
- **THEN** 只执行该展示动作一次；保留编辑区键盘焦点，不生成目标变更或模型请求

#### Scenario: 缩放与裁切

- **WHEN** 终端尺寸、任务标题宽度或组件可用高度改变
- **THEN** 点击仅命中当前实际绘制的任务及控件；裁掉行和填充行没有残留命中区域，必要控件在支持的可用布局下可达

#### Scenario: 手势期间布局变化

- **WHEN** 按下后、完整点击前，滚动、折叠、任务重排、目标切换或布局变化使目标身份或位置失效
- **THEN** 旧手势不触发原目标或同位置新目标；新的有效单击才可执行动作

### Requirement: 任务交互保持兼容和生命周期隔离

本次普通任务 Dashboard 展示变化 SHALL 作为既有生命周期兼容基线的明确补充。自动跟随、键盘导航和鼠标交互 MUST NOT 改变目标工具 schema、任务进度、存储版本、模型上下文、审计及执行门禁。原生鼠标能力不可用时 SHALL 保留自动跟随与键盘浏览，按会话去重说明限制；共享鼠标包缺失不应关闭原生点击与滚轮。

#### Scenario: 不安装共享鼠标包

- **WHEN** 只加载 Goal-X 且宿主具备原生组件鼠标能力
- **THEN** 任务点击和滚轮正常工作，不要求额外安装共享包，不修改全局鼠标派发

#### Scenario: 鼠标不可用

- **WHEN** 宿主无法派发所需组件鼠标事件或终端没有上报鼠标
- **THEN** 不抛错、不模拟全局捕获；自动跟随和原有可用键盘操作继续工作，已能检测的能力缺失只说明一次

#### Scenario: 审计与结果卡保持原状

- **WHEN** 普通任务 Dashboard 被审计进度、结果卡或无目标界面替换
- **THEN** 普通任务命中映射失效，点击不会误操作隐藏任务；原审计滚动、中断、结果展示和恢复逻辑保持

#### Scenario: 查看不写入执行数据

- **WHEN** 连续进行滚动、折叠、展开面板和恢复跟随
- **THEN** 目标记录、任务状态、证据、账本和模型消息均不因这些展示操作变化

### Requirement: 审计 Dashboard 支持鼠标切换面板

交互式审计运行时，紧凑和展开 Dashboard SHALL 在底边框提供可发现的鼠标展开/收起控件。左键完整单击控件 SHALL 与既有展开快捷键操作同一面板状态；紧凑态保留汇总与当前项，展开态保留完整清单、依据及工具诊断。该操作 MUST 只改变展示，不改变审计 attempt、清单状态或裁决。

#### Scenario: 紧凑与展开互相切换

- **WHEN** 用户点击紧凑面板的展开控件，随后点击展开面板的收起控件
- **THEN** 依次显示原审计的展开清单与紧凑汇总，不启动新审计、不重置已报告状态

#### Scenario: 鼠标和键盘交替

- **WHEN** 用户先通过快捷键展开，再通过鼠标收起，或先点击展开再用快捷键收起
- **THEN** 操作作用于同一展开状态，原有快捷键和 Escape 语义不变

### Requirement: 审计展开清单支持有界鼠标滚轮

指针位于展开审计 Dashboard 的实际清单、依据及诊断滚动窗口内时，滚轮 SHALL 使用宿主提供的有符号逻辑步长移动现有审计视口，不重复加速。视口 SHALL 在边界停止；窗口内的滚轮在首尾、内容不足一屏或空清单时 MUST 仍被消费，不能穿透滚动背后聊天记录。

#### Scenario: 长清单与换行依据

- **WHEN** 审计清单及依据超出展开窗口，用户在其中上下滚轮
- **THEN** 按实际绘制行有界浏览完整内容，包括中文和长依据的续行，审计汇总、头部及停止提示保持可见

#### Scenario: 窗口边界与区域外

- **WHEN** 清单已到首尾或为空，用户在滚动窗口内继续滚动
- **THEN** 不越界、不回绕且聊天记录位置不变
- **WHEN** 鼠标位于标题、汇总、控件、编辑器或审计窗口外滚动
- **THEN** 本功能不消费该滚轮，保留宿主及其他组件路由

#### Scenario: 进度刷新与尝试切换

- **WHEN** 用户手动滚动后同一次审计继续上报进度
- **THEN** 视口保留浏览位置并在内容长度变化时限制在合法范围，不因普通进度刷新强制回到开头
- **WHEN** 审计 attempt 切换
- **THEN** 新审计不继承旧 attempt 的滚动位置或过期鼠标手势

### Requirement: 审计鼠标命中与选择安全

审计鼠标命中 SHALL 以最终实际绘制的控件与视口几何为准，包含边框、填充、缩放、换行和高度裁切。仅完整、无拖动、目标未变化的左键单击 SHALL 切换面板；按下 MUST NOT 被消费或抢占选区。拖选、链接、双击的后续点击、右键、空白及过期目标 MUST NOT 切换面板或触发审计动作。

#### Scenario: 控件边缘与分隔空白

- **WHEN** 用户点击可见控件的首列、末列或其相邻填充空白
- **THEN** 首末列各切换一次，空白不切换；不可见、被截断的不完整控件不提供命中

#### Scenario: 拖选和复制

- **WHEN** 用户从控件或清单内容按下并拖动选择文字
- **THEN** 不触发展开或收起，宿主的选区及复制行为继续工作

#### Scenario: 目标失效和浮层

- **WHEN** 按下后布局、终端尺寸、attempt、视图模式或控件位置发生变化，或前置浮层覆盖该位置
- **THEN** 旧手势不触发新目标，浮层拥有其位置的事件，隐藏的普通任务面板也不响应

### Requirement: 审计鼠标交互不改变审计事务

审计鼠标浏览和面板切换 SHALL 作为既有审计兼容基线的展示层补充。系统 MUST 保留同一 attempt 的清单快照、逐项状态、auditor identity、计时、Escape 挂起/继续及结构化 verdict；浏览 MUST NOT 写目标状态、改变检查结果、触发模型回合、批准完成或引入新完成门槛。本变更 MUST NOT 添加鼠标停止审计或检查项详情折叠。

#### Scenario: 浏览时进度与裁决独立

- **WHEN** 审计运行期间用户反复滚轮和切换面板，而 auditor 上报逐项状态并最终提交 verdict
- **THEN** 清单与最终 verdict 仍仅来自原审计协议；浏览不创造、修改或补全检查状态，完成只按原事务与 gate 决定

#### Scenario: 审计中断、终态与恢复

- **WHEN** 用户使用原 Escape 流程挂起并继续审计，或审计结束进入结果卡后恢复普通 Dashboard
- **THEN** 仍遵循原 attempt 和终态规则；审计、结果卡和普通任务视图之间的鼠标命中不会串用或重复执行

### Requirement: 审计鼠标功能可降级且不影响任务面板

具备宿主原生组件鼠标能力时，审计鼠标功能 MUST NOT 要求安装共享鼠标扩展。宿主不支持所需能力或终端不提供鼠标事件时，系统 SHALL 保留审计键盘导航和面板切换；可检测的能力缺失提示按会话去重，不依赖对未上报事件的猜测。普通任务树鼠标交互、全局选区、快捷键及其他插件 MUST 保持原行为。

#### Scenario: 共享扩展缺失或合装

- **WHEN** 仅加载 Goal-X，或与 Starline 和 Mouse Events 同时加载
- **THEN** 审计展开/收起与滚轮可用且每次事件只生效一次；普通任务视图与其他插件无鼠标抢占回归

#### Scenario: 非全屏或不支持鼠标

- **WHEN** 普通终端模式或宿主缺少必要组件鼠标能力
- **THEN** 不抛错、不自行接管全局事件；已有键盘操作和审计自动进度保持，已可检测的限制最多提示一次

### Requirement: 最终确认框支持安全的鼠标决策

目标创建和调整的最终确认框 SHALL 支持原生组件鼠标操作；完整单击决策行只改变当前选中项，MUST NOT 立即执行决定。用户可使用独立的明确确认控件或既有键盘确认执行当前选中项；默认高亮的选项视为已选。审计开关及调整的差异/全文切换 SHALL 可直接点击，且仅改变待确认展示状态。

#### Scenario: 选择后明确执行

- **WHEN** 用户依次点击“继续讨论”决策行和独立确认控件
- **THEN** 第一次点击仅更改高亮，不创建、修改或取消目标；第二次进入原有反馈流程，原有反馈与决策语义不变

#### Scenario: 默认选项与键鼠交替

- **WHEN** 用户不改变默认高亮直接点击独立确认控件，或点击某个选项后按原有 Enter 确认
- **THEN** 仅按当前高亮执行一次对应既有决策，不要求鼠标先额外选择一次；原键盘导航和确认保持可用

#### Scenario: 只读切换与审计选择

- **WHEN** 用户点击调整框的差异/全文切换或任一框中的审计开关
- **THEN** 相应状态按现有语义更新，差异与全文反映当前审计选择；不会确认、取消、写目标或启动模型回合

### Requirement: 确认弹窗正文可完整滚动

创建和调整最终确认框 SHALL 以可滚动正文展示完整提案或差异与全文，并在可用高度足够时固定决策区。滚轮 SHALL 使用宿主的有符号逻辑步长并受正文边界约束；在框内滚动至首尾或内容不足一屏时 MUST 不穿透到背后会话。极矮屏 MUST 以可滚动降级保留正文及全部操作的可达性。

#### Scenario: 长目标和任务

- **WHEN** 创建提案包含超出屏幕的长正文、空行和多级任务
- **THEN** 正文各部分与任务均能在确认框中完整浏览；高度允许时决策区保持可见，不再仅依赖会话记录寻找被截去的中段

#### Scenario: 长差异与独立视图位置

- **WHEN** 调整框的差异和修改后全文均超过一屏，用户滚动并切换两个视图
- **THEN** 两种视图的全部内容均可到达，保留各自浏览位置、审计选择和反馈草稿；查看不执行决策

#### Scenario: 短内容、边界及框外

- **WHEN** 鼠标位于确认框内且内容为空、短于视口或已滚到首尾，用户继续滚动
- **THEN** 不越界或回绕，也不滚动背后会话；框外事件交还宿主原有路由

#### Scenario: 极矮与窄屏

- **WHEN** 可用高度不足以同时固定所有操作，或终端缩窄
- **THEN** 界面高度和宽度保持有界，全部内容与确认、继续讨论及取消仍能通过键盘和可用鼠标访问，不出现隐藏控件的命中目标

### Requirement: 确认框鼠标命中不破坏选择与安全

鼠标命中 MUST 基于最终实际绘制的可见区域及当前提案身份。左键按下 MUST 透传给宿主；仅未拖动、同一目标的完整点击可选中或激活对应控件。布局、尺寸、视图、目标、滚动或可观察浮层变化后，旧手势 MUST 立即失效，即使随后恢复原状也不能复活。

#### Scenario: 拖选和双击不执行

- **WHEN** 用户从正文、决策行或确认控件拖选文字，或双击进行选词
- **THEN** 选区及复制继续由宿主处理，不确认、取消、切换审计或错误切换视图

#### Scenario: 实际可见控件边界

- **WHEN** 用户点击可见控件的首末单元格、相邻填充、边框或被裁掉的位置
- **THEN** 只有真实可见且完整的目标生效；空白、边框与不可见区域不触发动作，长标签换行对应正确目标

#### Scenario: 布局或浮层往返

- **WHEN** 按下控件后发生缩放、滚动、视图切换或浮层出现，再恢复为原先布局后释放
- **THEN** 旧按下不执行原目标或同位置的新目标；重新进行完整点击后才能操作

#### Scenario: 链接和编辑器

- **WHEN** 用户激活宿主支持的链接，或在反馈编辑器中点击定位与拖选
- **THEN** 由宿主链接及编辑器处理对应事件，不由底层决策控件重复执行；反馈内容和输入法焦点不丢失

### Requirement: 确认交互不改变目标事务与兼容性

新布局、差异排版及鼠标浏览 SHALL 仅改变最终确认的展示和选中状态。系统 MUST 保留原有确认、继续讨论、取消、Escape、无 UI 和显式自动确认语义，以及候选一致性和过期目标拒绝；MUST NOT 因浏览写目标或账本、生成新模型回合或改变审计与任务 gate。

#### Scenario: 浏览与反馈不写入

- **WHEN** 用户滚动、切换差异/全文、选择决策或输入尚未提交的反馈
- **THEN** 目标、任务、账本和模型消息不发生由展示操作产生的变更，最终决策仍遵循原事务

#### Scenario: 宿主不提供鼠标

- **WHEN** 宿主为普通终端模式、不派发鼠标事件或只提供基础对话框
- **THEN** 键盘、原有基础对话框及取消路径继续工作，不要求安装共享鼠标扩展或自行接管全局输入

#### Scenario: 并发目标变化及历史回看

- **WHEN** 审核期间焦点、目标身份或 revision 改变，或确认框关闭后目标再次改变
- **THEN** 原提案按既有规则拒绝过期提交；会话记录仍展示当时的原始语义差异及实际决策，不被当前目标重算覆盖

#### Scenario: 其他交互保持不变

- **WHEN** 用户使用草拟阶段的其他问答、Sisyphus 创建、任务树或审计 Dashboard
- **THEN** 原有问题、目标决策、任务树及审计交互继续工作；不因本次改动引入额外模型回合、完成批准或无关弹窗鼠标接管

### Requirement: 模型可显式发起当前目标的调整

执行中的主模型 SHALL 能以一次 `propose_goal_draft` 调用发起调整，无需用户先运行 `/goal-tweak`。首次发起 MUST 提供 `tweak.goal_id`、去除首尾空白后非空的 `tweak.reason` 及修改后的完整 `objective`。目标 MUST 是该会话当前聚焦且状态为 `active` 的目标，且调用须通过既有执行门禁。该入口 MUST NOT 创建目标、自动切换焦点或替换已有用户草稿。不提供 `tweak` 时 MUST 保持原草拟准入行为。

#### Scenario: 执行中直接提出有效调整

- **WHEN** 主模型在当前目标的执行回合中提供匹配的 `tweak.goal_id`、非空理由和有效新目标，且没有冲突草稿
- **THEN** 系统直接进入同一次调用的既有调整审核，不要求用户输入命令，不派生额外的草稿启动模型回合，且确认之前不修改目标定义或任务树

#### Scenario: 不符合准入条件

- **WHEN** 目标缺失、目标 ID 不匹配、目标不再处于允许的执行状态、执行门禁不允许、已有用户草稿，或调整理由为空
- **THEN** 系统提示具体拒绝原因，不弹确认框、不留下新的活动草稿、不修改目标或焦点；已有草稿保持不变

#### Scenario: 无草稿的旧式调用

- **WHEN** 模型没有活动草稿且未传入 `tweak`
- **THEN** 保持原拒绝行为，不将该调用推断为调整或创建

### Requirement: 调整原因在审核和结果中独立展示

模型发起的调整确认 SHALL 在正文顶部单独展示「调整原因」或等义文案，在差异和修改后全文中均可读，基础确认回退也 MUST 展示原因。原因 SHALL 作为提案信息，不写入目标正文或验证契约，不作为语义差异。每次审核结果 SHALL 保留当次理由与同一次审核的差异及实际结果，包括自动确认路径。

#### Scenario: 在确认弹窗中查看调整原因

- **WHEN** 用户打开默认差异视图，或切换到修改后全文
- **THEN** 两种视图的正文顶部均展示同一理由，再展示各自内容；长理由可滚动查看，不挤掉决策控件，也不会因切换视图而提交

#### Scenario: 基础宿主回退和历史回看

- **WHEN** 宿主只能显示基础确认，或用户在确认、继续讨论、取消或自动确认后回看当次工具结果
- **THEN** 都能看到该次提案理由和对应差异；后续提案或目标变化不改写此前记录

### Requirement: 模型发起的调整沿用既有确认策略

模型发起的调整 SHALL 使用现有调整决策与事务。`PI_GOAL_AUTO_CONFIRM=1` 时自动确认，值为 `0` 时不自动确认，未设置时有 UI 走交互确认、无 UI 沿用自动确认。应交互确认但宿主无法展示时 MUST NOT 应用。所有确认路径 MUST 校验目标身份、焦点、版本和候选一致性，保留既有任务合并、预算、执行和完成审计校验。

#### Scenario: 用户确认后才使用调整结果

- **WHEN** 交互宿主未启用自动确认，且用户确认修改
- **THEN** 系统将已审核候选应用到同一个目标；任务按原规则合并，之后的执行使用修改后的目标，不需要第二次确认

#### Scenario: 用户要求继续讨论

- **WHEN** 用户选择继续讨论或依既有交互按 Escape 返回草拟
- **THEN** 原目标不变，草稿仍绑定原目标；用户提供的反馈按既有规则回传，模型可在同一个草稿中再提案，不必要求用户输入 `/goal-tweak`

#### Scenario: 用户取消调整

- **WHEN** 用户取消模型提出的调整
- **THEN** 与手动 `/goal-tweak` 的取消语义一致：结束草稿，原目标、任务进度和预算不因取消改变，不额外暂停或强制续跑；模型不立即重提被取消的同一修订

#### Scenario: 自动确认策略矩阵

- **WHEN** 有效提案在 `PI_GOAL_AUTO_CONFIRM=1` 下执行，或在未设置该变量的无 UI 宿主执行
- **THEN** 沿用现有自动确认并跳过弹窗，在通过相同提交校验后应用候选，结果保留理由和差异

#### Scenario: 要求确认但宿主无法显示

- **WHEN** `PI_GOAL_AUTO_CONFIRM=0` 且无可用确认 UI，或默认要求交互的宿主无法提供有效确认决定
- **THEN** 不应用候选，明确告知确认不可用，不降级为自动批准

#### Scenario: 已审核候选失效

- **WHEN** 从读取权威候选到提交期间，目标身份、焦点、revision 或有效候选发生变化
- **THEN** 即使已手动确认或配置了自动确认，也拒绝提交并提示重新审核，不把旧候选套用到新状态

### Requirement: 交互式面板在底边框集中显示操作

待办和审计进度面板的紧凑与展开视图 SHALL 只在底边框显示一次面板切换控件，MUST NOT 再渲染专用按钮行或在正文、边框提示中重复该动作。方括号 SHALL 区分可点击控件和普通文字；配套快捷键若显示，SHALL 紧邻对应控件，使用当前实际生效的按键，不复述动作。非交互视图与结果卡保持既有行为。

#### Scenario: 待办控件与当前任务

- **WHEN** 底边框有足够空间，用户查看交互式待办面板
- **THEN** 紧凑态只显示一个 `[展开]`，展开态只显示一个 `[收起]`；有当前任务时在同一底边框显示 `[回到当前]`，没有当前任务时不显示该控件

#### Scenario: 审计等待上报或正在检查

- **WHEN** 用户查看等待逐项上报或已有当前检查项的交互式审计面板
- **THEN** 紧凑态只由底边框的 `[展开清单]` 表示展开，展开态对应 `[收起清单]`；等待提示只描述等待上报，不再重复「展开查看清单」；已有汇总和当前检查项仍按原规则显示

#### Scenario: 快捷键自定义或禁用

- **WHEN** 自定义或禁用面板切换、收起或审计中断按键
- **THEN** 若显示快捷键提示，只使用当前模式下仍有效的绑定，不显示已禁用的键；审计中断仍是独立的非点击提示，不把中断键标为收起控件的快捷键

### Requirement: 底边框控件在受限空间安全降级

底边框布局 SHALL 优先保留完整的面板切换控件。空间不足时 SHALL 先省略可选的快捷键、滚动等辅助提示，再省略放不下的 `[回到当前]`；审计清单控件可缩为完整的 `[展开]` / `[收起]`。MUST NOT 绘制半截按钮或为不可见内容留下命中，已有键盘操作不变。

#### Scenario: 终端变窄

- **WHEN** 展开或收起控件与其他内容不能同时完整显示
- **THEN** 按优先级省略辅助内容及次要控件；仅在按钮完整可见时才可点击。如果连简短按钮也放不下，不显示残缺按钮，不创建对应命中；尺寸恢复后可见控件恢复

#### Scenario: 终端变矮或高度被限制

- **WHEN** 可用高度减少到必须裁切部件，或面板被稳定高度的空行填充
- **THEN** 在现有高度规则允许完整绘制底边框时保留底边框控件；未绘制或被替换的底边框没有命中，填充行不响应点击。变高后恢复的控件只响应新手势

#### Scenario: 点击与滚轮作用域不同

- **WHEN** 鼠标位于底边框的控件、分隔线、快捷键文字或状态区域
- **THEN** 只有完整按钮标签范围内的有效单击触发对应展示动作；其他文字、边框填充、分隔和空白不响应操作，整个底边框都不消费列表滚轮

### Requirement: 普通 Dashboard 保留上次完成审计未通过原因

短时结果卡消失后，普通 Dashboard SHALL 从当前未完成目标的审计账本显示最近有效审计结果的拒绝或运行错误；两类结果 MUST 可区分。紧凑视图 SHALL 在任务区上方显示一行原因摘要，展开视图 SHALL 提供有界的报告预览；`/goal-status verbose` SHALL 提供完整的已记录失败报告。该信息 MUST 独立于任务进度和目标状态，不改变完成判定或新增返工进度。

#### Scenario: 任务全部完成但审计拒绝

- **WHEN** 所有任务已勾选完成，独立审计拒绝完成声明，且短时结果卡已消失
- **THEN** 普通 Dashboard 继续显示任务原有勾选，并在任务区上方显示上次审计未通过及原因摘要；展开同一个面板能看到更多报告内容

#### Scenario: 查看长报告

- **WHEN** 上次拒绝或运行错误的报告含有长段落、多行 findings 或中文，且超出当前面板空间
- **THEN** Dashboard 保持现有宽高边界，优先保留失败类型和摘要；预览被截断时，展开视图在有空间且命令启用时提示通过现有状态命令查看；`/goal-status verbose` 保留完整的已记录失败报告及行序，不沿用摘要字数上限

#### Scenario: 重启和切换目标

- **WHEN** 会话重启，或在两个目标之间切换焦点，且当前目标的最近有效审计曾被拒绝或运行出错
- **THEN** 从该目标的已记录结果恢复对应提示，即使失败事件已不在近期活动窗口；无对应失败记录或没有当前目标时不显示，不串用其他目标的报告

#### Scenario: 复审启动尚未得出裁决

- **WHEN** 失败后又开始一次审计，但这次尚无终态
- **THEN** 正在审计的面板仍展示本次清单；`/goal-status verbose` 将上一轮报告标为历史结果，不冒充本次裁决。若重启后只有新一轮的开始记录而没有正在运行的审计面板，普通 Dashboard 仍能显示上次有结果的失败原因

#### Scenario: 新的有效结果替代旧失败

- **WHEN** 同一目标的新一轮审计有效地记录了拒绝、运行错误、通过或显式跳过
- **THEN** 新拒绝或运行错误替换旧提示；通过或跳过清除普通 Dashboard 的旧失败提示；被新尝试取代的迟到结果不覆盖当前显示。此展示不提交、绕过或重试完成事务

### Requirement: 带用户消息恢复目标

`/goal-resume [消息]` SHALL 接受可选正文。提供非空白正文时，Goal-X SHALL 以收到命令时的焦点和既有目标选择规则确定目标，等当前轮次彻底结束后按既有规则恢复该目标，并以正文提交一条普通用户消息。无其他普通消息竞争启动时，正文 SHALL 启动恢复后的第一轮。保护范围从 Goal-X 确定目标开始，不包含 Pi 暂存命令、尚未将其交给 Goal-X 的阶段。系统 MUST NOT 为本次恢复另发自动启动回合或将该用户轮计入自主运行次数。无正文时 SHALL 保持既有恢复行为。

#### Scenario: 旧轮已结束

- **WHEN** 目标已暂停、会话已空闲，用户提交 `/goal-resume 先定位失败用例`
- **THEN** 目标恢复为 `active`，自主运行额度按既有规则重置，模型在第一轮收到已恢复的目标上下文和一条内容为 `先定位失败用例` 的用户消息，不另起自动启动回合

#### Scenario: 两次 Esc 后旧轮仍在收尾

- **WHEN** 在 `goal-first` 模式下，第一次 Esc 暂停目标，第二次 Esc 请求中止仍在运行的旧轮，用户在中止收尾完成前提交带正文的恢复命令
- **THEN** 旧轮收尾期间目标保持暂停且不发送正文；收尾完成后自动恢复并发送正文一次，无需重新提交，旧轮的取消不得使刚恢复的目标再次暂停

#### Scenario: 同一会话并发提交普通消息

- **WHEN** 同一会话另有一条普通消息与恢复命令并发提交并竞争启动新轮
- **THEN** Goal-X SHALL 仍遵守已运行旧轮的收尾等待与命令内的目标身份校验，恢复成功后只向 Pi 提交一次正文；系统不保证两条消息的先后或正文占据首轮，Pi 因竞争拒绝时 MUST NOT 新增排队、重发或回滚

#### Scenario: 原目标不再可恢复

- **WHEN** Goal-X 确定目标后、实际恢复前，会话或目标焦点变化，或既有恢复准入检查拒绝该目标
- **THEN** 系统 SHALL 给出相应提示，不发送正文，也不转而恢复另一个目标

#### Scenario: 无参恢复

- **WHEN** 用户提交 `/goal-resume` 或仅提供空白参数
- **THEN** 按原逻辑恢复和安排自动启动，不生成额外用户消息
