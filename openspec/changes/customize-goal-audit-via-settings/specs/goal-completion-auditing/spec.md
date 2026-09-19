# goal-completion-auditing Delta

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: `/goal-subagent-eject` 弹出默认 Auditor Agent

**Reason**：默认 `goal-auditor` 改为运行时注册后，其定义由代码持有且没有可被 eject 的包内 markdown 源文件；pi-subagents 的 eject API 仅支持有源文件的 builtin/package agent，无法 eject 运行时注册的 agent。内容定制由嵌套 `auditor` 设置组的提示注入层与定义层承接，完全接管由 `auditor.agent` 指向自定义 agent 定义承接。

**Migration**：此前 eject 出的 user/project 作用域 `goal-auditor.md` 继续被发现并生效（运行时注册自动跳过同名配置 agent）；删除该文件即回到代码内默认定义；需要更深定制的用户在 `auditor.agent` 配置自己的 agent 定义，或使用 `auditor.*` 定义层合并扩展、技能与工具。命令不再注册，README 命令表与设置章节已同步更新。
