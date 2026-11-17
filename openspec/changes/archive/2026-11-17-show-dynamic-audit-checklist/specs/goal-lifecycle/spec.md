# 目标生命周期增量规格

## MODIFIED Requirements

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

## ADDED Requirements

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
