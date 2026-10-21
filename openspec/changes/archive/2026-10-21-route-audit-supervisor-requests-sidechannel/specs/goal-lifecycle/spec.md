# Spec Delta

## ADDED Requirements

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

产生监督问答的 audit SHALL 在原 `update_goal` 的最终工具结果中一次性返回有界的请求、答案/未解决原因、送达状态和关联身份；批准、拒绝、错误及用户绕过均保留已发生的协调记录。不产生问答时，原工具结果 SHALL 保持既有形状。记录 MUST 标明“参考协调记录，不是新用户指令或完成证据”，MUST NOT 在工具调用与结果之间注入消息，MUST NOT 使用用户消息、steering、follow-up 或新的主模型 turn 来回放。旁路模型 usage SHALL 与审计员 usage 独立记账并在父工具结果中累计一次；不更改现有父 turn 目标预算语义，不记录认证秘密或原始 thinking。

#### Scenario: 主会话一次收到完整协调记录

- **WHEN** 一次产生两个监督问答的审计完成
- **THEN** 原工具结果在正式 verdict/report 后按请求顺序出现两条协调记录，主会话只收到一次回流；消息顺序保持 assistant 工具调用在前、对应 tool result 在后

#### Scenario: 错误或用户绕过保留记录

- **WHEN** 已有成功问答后出现协调错误，或用户明确绕过本次审计
- **THEN** 该分支的最终工具结果仍包含已发生问答及失败/取消状态，不另发伪用户消息，不把记录内容转为批准

#### Scenario: 使用量不重复累计

- **WHEN** 同一旁路会话处理多个问题并在终态返回，或终态/回流被重复观察
- **THEN** 只累计该旁路已实际发生的模型 usage 一次，审计员原 usage 不被覆盖，不改变目标的父 turn token budget

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

## MODIFIED Requirements

### Requirement: 实现范围与 pi-subagents 修改边界

本变更的验收范围 SHALL 限定为 `pi-goal-x` 的完成审计改造，以及从 `pi-subagents` 现有 eject handler 抽取并复用共享 agent-management service 所必需的最小公共导出、适配和测试。用户明确批准的例外仅有：foreground executor 对既有 `message_end`/`toolResult` 与 `tool_result_end` progress event shape 的归一化/去重及直接测试，以及 `preflight.ts` 中 `packageVersion()` 对损坏 package metadata 的 fail-closed 错误包装。后者 MUST NOT 改变其 public async contract、launch 语义或工具计划。另外，完成审计 supervisor 旁路允许新增版本化 responder API、精确 attempt 与实际 child 的启动前绑定、监督请求接管/回复/清理及其直接测试；接入 SHALL 限定为 API 导出、structured delegation 生命周期、前台 executor 的内部启动绑定回调和原生 supervisor 通道入口，普通子代理的默认监督、运行和终态语义 MUST 保持不变。除上述范围外，`packages/pi-subagents` 的既有 delegation、preflight、运行时、MCP、skill、Fleet、mission、slash command 和其他实现 SHALL 保持不变。任何超出该边界的 `pi-subagents` 修改 MUST 在交付前还原；非修改范围内产生的额外 lint、warning 或格式问题不属于本变更验收项，也不得以此扩大修改范围。

#### Scenario: 验收变更边界

- **WHEN** 审查本变更的最终工作树和差异
- **THEN** `pi-subagents` 中除 shared eject service 及其直接 public export、必要适配和测试，以及明确批准的 foreground event normalization/去重、`packageVersion()` fail-closed 错误包装和当前 audit supervisor 旁路的上述最小接入外，不得存在本变更引入的实现差异；范围外 lint/warning 不阻塞本变更

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

| D-15 | 审计监督问题唤醒主模型并可能使审计员 detach、原 audit 提前失败 | 当前精确 audit 的监督问题由隔离只读旁路答复，完成工具保持阻塞，审计员不 detach，真正终态与协调记录在原工具结果中一次性返回 | 主模型回合数为零、detach 为零、同一 child、唯一终态、无效/未解决答复 fail closed、记录与独立 usage 回流，最终真实 Pi/TUI + tmux + 真实 provider E2E |

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
