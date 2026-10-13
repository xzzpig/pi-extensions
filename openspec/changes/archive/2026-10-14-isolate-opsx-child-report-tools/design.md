# Design

## Context

动机见 `proposal.md::Why`，行为契约见 `specs/pi-openspec-x/spec.md`。本修订吸收 `reviews.md` 中 G1–G9 及第一轮三个阻塞项；只调整 `packages/pi-openspec-x/`，不修改 pi-subagents / pi-goal-x peers。

已经核实的依据：

- `src/index.ts` 无条件调用 `src/report-tools.ts::registerReportTools`；三个报告工具因此进入主会话声明及专用规则。
- `src/agents.ts::OPSX_AGENT_DEFINITIONS` 已有角色工具白名单；reviewer 已通过 `subagentOnlyExtensions` 加载独立工具。pi-subagents 的 `resolvePiLaunchToolPlan` 同时处理前台与后台子资源；`PI_SUBAGENT_CHILD` 不能识别共用进程的前台子会话。
- pi-subagents 的公开 `@xzzpig/pi-subagents/shared-types` 提供 `SingleResult`、`Details`、`AsyncStartedEvent`，**不导出** `AsyncStatus` 或 `SUBAGENT_LIFECYCLE_ARTIFACT_VERSION`。私有源码中的 v3 status 结构只作为读取依据；本包声明 D3 的最小结构及支持版本，不生产 import 私有类型/常量。公开 `@xzzpig/pi-subagents/preflight::resolveSubagentLaunchContract` 的成功结果提供 `contract.protocol.lifecycleArtifactVersion`（当前为 **3**）与 packageVersion，可核对协议声明。
- Pi 的公开 `parseSessionEntries`、`SessionEntry`、`ReadonlySessionManager.getLeafId/getEntry` 可用于只读处理 v3 会话树。`SessionManager._appendEntry` 先更新 id/parentId 树再执行同步持久化；会话文件完整保留 assistant 工具调用和 toolResult.details，而不是工具参数预览。
- pi-subagents 的后台 `events.jsonl` 是 best-effort 诊断日志，漏写不一定标记截断；**不能成为门控报告的完整性依据**。后台 sessionFile 才是 Pi 的规范会话记录。
- `packages/pi-subagents/src/extension/tool-result.ts::finalizeToolResult` 在前台工作流失败时会抛出普通 Error，丢弃部分 Details；`foreground-complete` 不保留原始 messages。不能保证从失败前台根结果回收成功兄弟报告。
- `src/goal-base.ts::readGoalBaseSummaries` 只返回全部目标的 id/status/objective，不能回答焦点。goal-x 以当前分支的 `pi-goal-focus` v1 条目持久化焦点，`goal-record.ts::normalizeGoalFocusEntry`、`goal-pool.ts::resolveSessionFocus` 与 `goal-state.ts::loadState` 定义恢复语义。
- goal-x 的 `goal-format.ts::goalDetails` 返回 v3 的完整目标快照。`goal-task-tools.ts` 的缺少 evidence、子任务未完成、任务禁用、已完成任务等逻辑拒绝也可返回该快照而不设置 isError；成功 complete 才产生任务的 complete 状态与 completedAt。
- `src/implement-command.ts` 的流程/tracker 是进程内 Map；现有恢复只提示 `/goal-resume` 和重装 auditor。必须恢复完成门的绑定，不能只恢复报告。
- 后台 notifier 可先唤醒主会话再发布 `async-complete`；完成门需要主动读取已归属运行的当前终态，不依赖通知先后。

上述 peer 私有源码只作为依据，生产代码不深路径 import pi-subagents 的实现。goal-x 已发布辅助模块沿用本包现有动态加载方式；这里“只读”指不修改目标/焦点/任务，不承诺 helper 内部零缓存或派生快照写入，具体边界见 D6。不新增依赖或修改主扩展 manifest。当前验证基线为 Pi 1.0.1、pi-subagents 0.20.0、pi-goal-x 0.9.0；不是对任意 `*` 版本的兼容承诺。

## Goals / Non-Goals

**Goals:**

- 主入口零子报告工具注册；三个子角色分别取得自己的工具和规则。
- 自动接收实际成功工具结果，并关联父会话、分支流程、目标、原生子运行及任务。
- 保留实际 diff/验证审查及最终独立审计，复用单项和批量 `update_goal_task` 完成申请。
- 明确冷恢复、焦点变化、失败、证据不可取得和版本不兼容时的行为。

**Non-Goals / Must-NOT-Have:**

- 不先注册再隐藏，不增加主会话兼容别名，不改变主系统提示或技能集合。
- 不新增 `review_work`、派发工具、通用 transport/provider、IPC 服务或单独报告文件账本。
- 不修改 goal-x 参数、目标状态/任务树/全局策略，不把报告塞进 evidence，不自动确认审批、执行测试、完成任务或恢复目标执行。
- 不为读取报告再启动子代理；不支持远程/外部 runner，不解析模型总结、预览或诊断日志作为交付证明。
- 不修 change-id 解析、不扩大 diff 审查策略、不操作用户安装、不升版本、不提交/推送/发布/自动归档。

## Decisions

### D1：角色专用入口与本包私有的 attempt 元数据

新增 `src/child-report-extensions/gap-analysis.ts`、`plan-review.ts`、`worker.ts`。各入口只注册本角色的一个工具；通过 D2 的内部辅助函数给该工具附加 attempt 元数据，而不是加载完整主扩展。

`src/agents.ts` 用 `fileURLToPath(new URL("./child-report-extensions/<entry>.ts", import.meta.url))` 生成绝对路径，分别放入对应定义的单项 `subagentOnlyExtensions`。保留工具白名单、thinking、上下文和 acceptanceRole；reviewer 的 goal-x 子扩展不变。新路径不进入 `package.json::pi.extensions`。

`src/index.ts` 删除 `registerReportTools` import/调用；`src/report-tools.ts` 删除该批量注册函数，保留三个纯定义、常量和 `createReportTools`。原工具名、参数 schema、业务 payload、确认文本及 sequential 执行模式不变。纯定义仍回显 `details: params`；子入口注册的包装定义改为返回 `details: { version: 1, attemptId, agent, report: params }`。这只是本包接收器消费的结果元数据，**不新增模型可填的参数**；接收器对内部 `report` 使用原 schema 校验。

每个子入口的 `before_agent_start` 钩子调用 `beginChildReportAttempt`：生成新的随机 attemptId，通过 `pi.appendEntry` 写入 `pi-openspec-x/child-report-attempt:v1`，记录角色、子 session id、开始时间、实际 prompt 的 SHA-256 及唯一任务标记。每次新 prompt/resume 均更新 attempt，不能继承上轮 nonce。写入失败时该 attempt 不可上报；包装 execute 明确报错，不返回假成功。无 marker 的 worker resume 也明确拒绝用于门控。

选择理由：复用 SDK 的子扩展及会话元数据，无环境变量猜角色、无额外 IPC。默认资源隔离不试图禁止用户主动把内部子入口手工加载到主会话。

### D2：规范会话记录为后台权威来源，诊断日志退出门控

新增 `src/child-report-reader.ts`，集中 `beginChildReportAttempt`、工具包装、`readChildReportMessages`、`readChildReportSession`、`validateChildReport`。角色到工具映射只有三个既有角色。

**前台成功返回：** 从所属 `Details.results` 的实际 `SingleResult.messages` 取得本次消息，使用实际 runId/index/agent；无独立 runId 时仅允许本次 Details.runId 加原生 SingleResult.index。仅处理本次实际 user 派发之后的消息与最后一个 attemptId，不接受继承历史中的报告。

**后台及后台工作流子项：** 从已归属的启动记录给出的 asyncDir 读取 v3 `status.json`，仅把它用于身份、sessionRoot、steps 定位及终态。sessionFile 必须来自匹配原生 step，realpath 后仍位于该所属 sessionRoot；打开后核对文件身份，不接受报告 payload 指定路径或越界 symlink。读取 Pi v3 sessionFile，不读取 `events.jsonl` 的报告内容。

会话读取约束：

1. 严格检查完整 JSON 行、唯一 entry id、有效 parentId 链及 v3 header，再使用公开解析器；不能利用其跳过坏行的容错来忽略证据缺口。不调用可能修复文件的 `SessionManager.open/loadEntriesFromFile`，不修改子会话。
2. 按 id/parentId 选择当前叶子分支，匹配最新 attempt 条目及其 nonce。attempt 的 session id、角色、实际 user prompt 摘要/任务标记必须一致，开始时间不得早于该原生 step 的 startedAt；成为 ready 时 attempt、报告及正常结尾还必须位于该 step 的 startedAt/endedAt 区间内，两个边界缺失则不能证明归属。**实现期已知限制（2026-10-07，经用户裁决）：**工作流式重派发（`subagent` 调用不带 `agent`、子项角色写在脚本里）在派发时刻无法判定是否含 `opsx-worker`，故**不会作废该任务的旧回执**，旧证据在此期间仍可授权勾选；两条候选修法均被否决——种全局屏障会让只含「不写报告的角色」（如 `opsx-gap-analysis`）的工作流永久阻塞整个会话，而在 `results[]` 到达时逐项失效会删掉**刚到达的合法回执**。要覆盖需先改屏障的解除条件（从「由回执解除」改为「由该工作流全部子项到达终态解除」）。**不计为已修**。

**实现期已知限制（2026-10-11，经用户裁决）：**审计第 5 轮 F11 要求「同一批次一个子项成功、一个失败」的确定性用例必须经**真实 subagent 工具 execute/finalizeToolResult 包装与受控 executor** 产出。pi-subagents 的公开面只暴露注册表与 preflight，不暴露 executor，故无受控注入点；手工 tmux 下模型会主动避免派发注定失败的兄弟，无法稳定诱导。因此该形态记为**已知限制**：确定性层由既有用例承担（对 `finalizeToolResult` 传入伪造的 partial Details，证明外层抛错后不会假装取得部分 messages；并对真实工具结果的抛错边界做负向断言），真实运行证据由 e2e.md 的 E4 相位 B/B2 与 E5 批量用例提供。**不计为已修**。

**实现期取舍（2026-10-07，经用户裁决）：**该区间校验只在边界可得时执行——前台摄取不读 `status.json`（其 `sessionFile` 来自 `result.sessionFile`，调用方手上没有 step 时间），故前台不供边界；后台在 step 缺 `startedAt`/`endedAt` 时按「不可校验」跳过而非拒绝，因为真实运行已观察到 complete 运行不带 `sessionFile` 的形态，把缺字段收紧为拒绝会让回执产不出、完成门永久关闭。绑定的实际强度由 attempt nonce 承担，时间窗是补充性证据。**后台路径额外收紧：**原生 step 已处终态时其结束边界必须存在——终态 step 一定写下 `endedAt`，缺失即说明这份报告无法被限定在该运行区间内，此时不产出 ready（运行仍自称进行中则为 pending、否则 failed），而不是接受半开窗口。旧分支、旧 nonce、旧 user 派发及同一 sessionFile 中其他运行的内容不进入本次报告集合。3. 配对 assistant toolCall 与相同 toolCallId 的 toolResult；角色/工具名一致、结果非 isError，结果 envelope v1 与 attempt 一致。分别通过真实 `validateToolArguments` 和原 schema 校验调用与 report；使用校验后的 report，不把调用参数本身当交付。4. 同运行按调用顺序而非重复结果的到达顺序判断最新报告。最后一次失败、无效或没有配对结果的报告调用使该 attempt 不可 ready，不能退回早先成功。5. 后台 ready 还要求本次分支最后存在工具结果之后的正常 assistant stop（无待执行 toolCall）、完整父链以及原生成功子终态。缺少尾部、链断裂、持久化失败或读取时文件改变均保持不可 ready；诊断日志“完整”不能替代这些条件。

去重键为 flowId/runId/stepIndex/attemptId/toolCallId。工作流使用实际 child runId/workflowKey；只有 v3 原生 status 的有序 steps 才按其生产者定义的下标定位 step，不能用模型输出或展示顺序猜子身份。

**证据不可取得的边界：** 前台失败工作流被实际工具包装抛错后没有 messages 时，本次根调用中的 worker 不产生 ready receipt，即使完成通知声称某个兄弟成功；保留明确诊断并等待后续新的有效派发，不宣称回收丢失的证据。后台独立子项只有各自规范记录和成功终态均可验证时才可独立接收。内存型前台子会话有完整本次 messages 时可支持，但该回退路径必须绑定 envelope 自身的 attempt nonce（`readChildReportMessages` 的 `attemptId` 为必填，由 `reportAttemptFromMessages` 提供）；它没有规范子会话可交叉核对，故绑定强度弱于会话路径，取不到 nonce 即不产出 ready。后台未持久化 sessionFile 时明确 fail-closed，不要求主模型转录。

选择理由：规范会话树能发现漏行造成的缺失配对/父链断裂，并有 prompt/attempt 边界；best-effort 诊断日志没有这种完整性契约。

### D3：有版本边界的自动接收与确定性的完成前刷新

新增 `src/child-report-ingestion.ts::registerChildReportIngestion`，在主入口接线一次。本包内部声明 `SUPPORTED_LIFECYCLE_VERSION = 3` 及最小 v3 status/step 结构，并做运行时校验，不从不存在的公开导出取类型/常量。最小根字段为 lifecycleArtifactVersion、runId、sessionId、state、startedAt，以及实际读取的 steps；completionOwnerId、sessionRoot、endedAt 和子项的 agent/status/runId/workflowKey/sessionFile/startedAt/endedAt/exitCode/失败标志按 D2、D5 的来源与 ready 前提逐项检查，缺少某项不能证明的事实就不能放行，不用 TypeScript 类型断言冒充校验。

增强流程的协议兼容性**不设独立的预检查**：`resolveSubagentLaunchContract` 只从文件系统解析 agent（builtin 目录、`~/.pi/agent/agents`、`~/.agents`），而 `opsx-*` 角色由本包运行时注册、对文件系统解析器不可见，因此以真实 opsx 角色探测必然以 `missing_agent` 失败；实现期曾退而使用一个无关的 builtin agent 让检查通过，经 2026-10-07 完成审计判定为「以无关契约替代所需契约」的偏离。**经用户于 2026-10-07 决策，该预检查整体移除**：每个子运行的状态文件在解析时本来就校验 `lifecycleArtifactVersion` 必须等于受支持版本（不兼容即拒绝该运行），该运行时校验已经承担了兼容性声明，预检查属冗余，且移除后不再需要目标级协议屏障及其通知路径。**2026-10-11 用户再次确认该裁决并要求正式修订计划文本**：目标步骤 4.1 中「调用公开 preflight 边界并验证不启动子运行、不在热路径重复调用」一项由本决定取代，计划与目标随之对齐，实现保持不变。实际后台 status 为 v3、Pi 会话为 v3、子 envelope/attempt 为 v1、goal 焦点为 v1及结果快照为 v3；未知数据不能凭报告完成。官方 skill 轨和普通目标不因协议不支持被关闭。

监听主 session 的 `tool_call/tool_result`、原生 `subagent:async-started`、`subagent:async-complete`、`subagent:foreground-complete` 与 session 边界。根调用捕获 toolCallId、当前流程/goalId 和直接派发的原始 task；启动事件只作所属关系，必须与本会话启动回执的 runId 配对后才读文件。不得从 workflow 脚本、脱敏 task 或预览推断 child。

worker 的 Task 段携带 `[OPSX WORKER DISPATCH task=<编码后的 taskId>]`，编码/解码使用 encodeURIComponent/decodeURIComponent；实际 user 派发中必须唯一。**提取层刻意不要求它独占一行**：契约仍要求派发方把它写成独立行，但真实模型会写成 `Task: [OPSX WORKER DISPATCH task=1.1]` 这种带标签的形式；此时它仍只命名一个任务，而按“必须行首”拒绝会让子工具包装抛错、worker 的上报永远失败、回执永远产生不了、任务永久死锁——即以“保护”之名造成比它防的风险更严重的后果（实现期由真实运行定位，见 design 文末“审查发现的处置”）。因此安全属性落在**唯一性**上：唯一标识不一致（含两个不同 taskId）即判为不可归属。直接调用由原始 task 交叉核对，工作流由该子项实际 user prompt 与 attempt 数据核对，最终必须等于 report.taskId 且属于绑定目标任务树。未知 worker 任务关联不能绕过门：沿用现有“未标明任务的派发影响全部任务”的保守语义，形成该目标的未解决派发屏障，不影响普通目标。

运行中的有效报告只是 candidate/进度，成功子终态后才可成为 ready receipt。新派发/resume 立即使相应旧 receipt 失效；前台根失败且缺少子证据时保留未知屏障。后续新且明确的有效 worker 运行只能解除其对应任务的屏障，不凭相同 taskId 复活旧报告。

`refreshForCompletion` 在完成门中主动执行：await 同运行已在进行的读取，**重新读取所属 status 和规范会话新增内容**，再决定 pending/ready/failed。它不只等待已触发的 async-complete，因此能处理“通知已经唤醒、完成事件尚未投递”。每次完成申请只做一轮有界刷新；仍在 running/证据未齐就明确阻塞，等待原生后续事件或新的完成申请，无等待轮询或睡眠。已经完整成功的 status/会话可在通知尚未到达时幂等持久化 receipt。

**实现期补强（第 5 轮审计发现，2026-10-11）：**以下六条把 D3 的语义落到可判定的行为，均已在实现与测试中固定，且每条都有停用修复即失败的回归。其一，**未标明任务的派发不再只加屏障**：`invalidateForDispatch` 对 `taskId === undefined` 的派发除抬高代际与加 `'*'` 屏障外，还会**收回**该会话已持有的回执并把 `latestRunByTask` 置为待派发——只加屏障会让无关子项的报告清掉屏障而旧回执仍可用（F1）。其二，**报告证明的任务归属回填到 run**：派发未命名任务时，验证通过的报告会把 `taskId` 记到对应 run 条目上，否则刷新无法在新派发后退休该 run，其过期失败会否决更新的有效报告（F2，前台与后台两条路径各自实现）。其三，**撤销必须可重放**：回执被收回时写 `pi-openspec-x/child-report-revoke:v1` 分支条目，冷重建按分支顺序重放，使「撤销」不依赖进程内存（F3）。其四，**运行身份必须完整**：`status.json` 缺 `completionOwnerId` 即拒绝该状态；`details.results[]` 缺原生 `index` 即跳过该结果，不再以 `runId#0` 造出无法核对的身份（F4、F6）。其五，**计划流程也参与摄取**：主入口的 `flowFor` 在无实现流时回查只读计划绑定，使计划阶段的上报仍能到达进度板；`plan-command` 在 `session_start` 之外再挂首个 `tool_call` 兜底，覆盖冷启动漏掉会话边界的形态（F12）。其六，**读取预算可协作中断**：`IncrementalSessionReader.read` 接受 deadline 并在逐行解析中检查，超时即失败并 latch，不回退到此前解析出的部分视图（F7）。

### D4：进度复用与资源上限，不建立第二套调度系统

原生消息能直接接收时直接处理；后台仅为保留实际 progress，观察已归属 status 和规范 sessionFile 的新增内容。每 asyncDir 一个 status 目录监听，session 文件按路径共享监听；按 byte offset 增量读取并串行化同一来源，尚未创建的文件由所属目录通知发现。fs.watch 失败时报告实时进度降级，**不启动轮询**；终态事件与完成前刷新仍主动读取。

固定资源边界在两个新模块声明并测试：最多 32 个活跃原生子项、32 MiB/单规范会话、4 MiB/单 JSON 行、512 KiB/业务报告、128 次上报调用/attempt、32,768 个会话树节点。只保留父链索引、调用摘要和最新报告，不缓存普通输出、图片或思考签名（读取器收纳每条记录时即把非文本、非工具调用的内容部件替换为类型标记，故规范会话中的图片与思考签名不驻留内存）；终态后释放 watcher/句柄/增量缓冲，历史只在所属分支条目中保留。超预算明确不可用于门控，不静默截断后放行。

完成前一次刷新最多 1,000 ms，使用可取消 I/O及代际校验；超时返回 pending 并拒绝完成，迟到读取不能对已切换上下文写入 receipt。无持续 timer、全仓/全 sessions 扫描或 status 命令调用。

`src/progress-observer.ts` 提供 `recordChildReportProgress`，继续复用 `progressUpdateFrom/projectProgress` 和既有展示条目；仅投影匹配 attempt 的有效成功上报。相同进度去重，进度不设置完成、不触发审批。父侧计划工具不变，自动接收不替代 `opsx_plan_verdict` 的用户批准流程。

选择理由：监听只为保留现有报告进度，门控主动读取；不复制 native watcher 的调度、进程探测、状态查询或通知系统。

**范围收敛（用户 2026-10-13 决策）**：共享 `fs.watch` 与串行增量读取原属本决策，但实现完成后审计发现其从未接入生产路径（`watchSessionPath`、`IncrementalSessionReader` 仅有单测调用），而完成前刷新本就按需重读规范会话，增量读取对正确性并非必需。故该部分明确 **descope 并从实现中移除**，相应 I/O 计数证明一并取消；实时进度降级、轮询禁令与终态主动读取的要求继续成立。资源上限、只读证据面与门控语义不受影响。

### D5：先恢复流程/目标绑定，再恢复 receipts，禁止冷启动跳过门

流程键为 `(parentSessionId, modeEnteredEntryId, changeId, mode, goalId?)`，modeEntered 必须来自当前分支且未被 modeExited 结束。只看全 sessions 的最新 statusSnapshot 不足以绑定。

新增主分支自定义条目 `pi-openspec-x/flow-binding:v1`：成功创建实现目标后记录 modeEntered entry id、changeId、mode、**实际 goal-x 结果中的 goalId**。创建结果必须是 v3、目标 objective 的 opsx change 标记匹配；不能从全部目标列表猜“唯一目标”。`src/implement-command.ts` 提供只恢复 Map/完成门上下文的 `rebindImplementFlow`；`src/plan-command.ts` 提供对应只读计划绑定恢复，不重新运行命令。

`session_start/session_switch/session_tree` 及首次 tool_call 的惰性兜底按顺序执行：

1. 读当前分支 mode/binding，核对 goal-x 实际记录与 objective 所属；恢复流程查询及 gate 上下文，明确区分 agent/direct。
2. 然后重建 `pi-openspec-x/child-report-run:v1` 与 `pi-openspec-x/child-report-receipt:v1`；仅接收同 flowId/goalId，按新派发、失效、成功 receipt 的顺序恢复 latest-run 关系。
3. pending 运行只从当前分支已记录的所属 asyncDir/sessionRoot 恢复，重新核对 v3 status 的 run/角色/step及规范会话；不导入别的分支或扫描其他目录。

binding/run/receipt 使用直接 `pi.appendEntry`，不经 best-effort 展示包装；写入抛错不能 ready，即使内存分支已出现条目也要标记该流程证据损坏并拒绝放行。成功 receipt 写入后确认在当前分支；重复投递幂等。

读分支使用 `getLeafId/getEntry` 增量索引，同 leaf 不重扫；tree/switch 使代际和缓存失效。冷读上限同 D4。缺 binding 的旧 opsx agent 目标若可由 objective、模式条目确认归属，则进入“恢复绑定/证据不足”的拒绝态，不能因为 Map 为空而放行；旧父侧 report_work 从不转成新 receipt。直接模式及非 opsx 目标不要求 worker receipt。

恢复只重绑定插件内部观察与完成门，不创建目标、选择焦点、修改任务、自动恢复执行、重新审批或切换权限；既有 `/goal-resume` 提示、显式模式入口及 auditor 安装保留。源代码沙箱启动/恢复的其他治理不在本修复中扩大。

### D6：权威焦点读取与完成前后代际校验

在 `src/goal-base.ts` 增加独立可注入的只读 `GoalXFocusFacet` 和 `readFocusedGoalSnapshot`，不复用 summaries 当焦点。动态加载 goal-x 已发布辅助模块：`goal-record.ts` 的 normalizeGoalFocusEntry/normalizeGoalRecord、`goal-pool.ts` 的 resolveSessionFocus、`goal-settings.ts` 的 loadGoalSettings、storage 模块的 goalStorageRoot/readActiveGoalPoolAsync/parseGoalFile。不取得或调用活的 GoalCore；本包不直接修改 peer 缓存，不调用 invalidate/写目标/focus/task API。

只读边界是**目标/焦点/任务领域状态不变**，不是 helper 零副作用：允许 goalStorageRoot 自身固定配置 root、初始化外部 root 的 `.metadata` 目录及维护 roots 缓存；允许 readActiveGoalPoolAsync/parseGoalFile 自身维护解析/池缓存、写既有派生池快照及移除旧派生快照。不得由本包额外创建这类维护调度、直接操作 peer 缓存/快照，或因此写目标文件、目标账本、焦点条目及任务。辅助函数失败按 unknown 处理，不主动扩沙箱或改变存储配置。task 3.1 通过规范目标文件字节、实际焦点/任务状态不变验收，允许上述既有缓存/目录/派生快照维护；不得断言所有 filesystem writes 为零。

算法复用 `goal-state.ts::loadState` 语义：在当前分支取最新有效焦点条目及 legacy state；按配置 root 检查 storageRoot，不符合则无焦点；以本地 Map 副本解析焦点，只有 settings.autoSelectSingleGoal 明确为真时才允许单目标默认选择。显式 null 不回退选目标。当前焦点记录的任务快照由该 id 的规范 goal 文件和主会话真实 goal 工具 v3 details 合并，选 updatedAt 最新的完整记录，同时间戳时优先本分支较新的真实工具结果；后者覆盖尚未 turn-flush 的任务变更。文件通过已知 activePath/配置 root 定位，不能因热路径全目录遍历或使用 summary 代替。

返回三态：known-focused、known-unfocused、unknown（缺能力、未知版本、不可读/不完整）。同时返回 token：session/分支代际、配置 root、焦点 entry id、goalId。首次加载/焦点变化读池，缓存已知路径；每次完成前按已知路径刷新目标状态，不使零操作池缓存成为过期状态证明。

完成申请开始时只对“焦点 goalId 等于本流程绑定目标且 mode=agent”的请求检查 worker 条件；普通/direct 按原行为执行。已确认属于本 agent 流程而焦点/目标来源未知时明确拒绝，不猜目标。完成前 flush 之后再次读取焦点 token 与流程绑定；切到普通目标、其他目标/分支或切走再切回导致代际变化时，阻塞这次旧申请并提示按新焦点重试，不把旧审查结果应用到新目标。第一次就在普通目标上的请求不加 worker 条件。

选择理由：目标焦点是 goal-x 的会话级事实，summary 列表不是；复制已发布只读解析语义比借用可变 GoalCore/扩展私有状态安全。

### D7：单项/批量门控及真实状态变更后的完成事件

`src/implement-command.ts` 删除消费主会话 report_work/workReportFrom 的路径，增加 `rememberWorkerReportReceipt` 接缝。tracker 使用已持久化的当前 goal/task 最新原生运行与 ready receipt；验证失败/缺失、虚报文件仍阻塞，未声明的实际文件在既有运行时噪声过滤后仍只警告，保留结构化 verificationPassed 优先级。

`createImplementTickGateHandler`：D5 绑定 → D6 焦点/任务前快照 → D3 有界刷新 → 再核对焦点/流程 → 逐项检查单项或 updates[] 的 complete 项。任一 complete 项失败就 block 整个请求；不先 noteTick、不改任务、不改变 goal-x 的原子事务。非 complete 项仍由 goal-x 验证。

不能把 `!event.isError` 当作完成成功。按 toolCallId 保留 gate 前的目标/任务快照；tool_result 后只接受真实 goal-x v3 details、相同目标及未变化的焦点/流程。每个申请 complete 项须从非 complete 实际变为 complete，且出现新的 completedAt；只有全部 complete 项真实转换才 noteTick、写 taskTicked/publish task_completed。缺快照、逻辑拒绝、目标不一致或不确定则不发布完成。按 goalId/taskId/completedAt 去重；普通目标的完成不投影为 opsx 完成。

因此真实任务工具返回“缺 evidence”“子任务未完成”“任务禁用”“已经完成”但无 isError 时，也不会产生虚假完成事件。最终独立审计、任务树同步以及 goal-x 的 evidence/层级规则保留。

### D8：文案、迁移与最小测试边界

`objective.ts::agentBoundaries` 的六段 Task 写明确任务标记，包含新派发和 resume；删除主会话核对后调用 report_work 的指令。worker 提示保留真实验证、完整 changedFiles、不改 openspec/不勾选；README 说明子工具作用域、自动接收、证据不可用/预算超限的诊断，以及主会话实际审查后 complete/evidence。

测试保留纯定义的 schema/确认文本/details 回显，新增子包装 envelope/nonce 与加载失败测试；不添加已删除父侧上报的兼容入口。隔离矩阵通过真实默认资源加载而不只比较 tools 数组。

至少三个模型调用无关的集成接缝必须走实际 peer 边界：

- SDK 资源加载与子入口注册，覆盖前台/后台 launch tool plan；确定性假模型驱动实际 before_agent_start/report 工具/SessionManager，验证规范会话的实际格式。
- 实际 subagent 工具 execute/finalizeToolResult 包装：以受控 executor 返回一成功 worker 加一失败兄弟，证明抛错后没有可取得的 Details 时拒绝，而不是伪造一个永远可读取的内部 fixture。
- 实际 goal-x 任务工具与临时目标存储：成功单项/批量及无 isError 的逻辑拒绝，核对真实任务状态和插件事件；不只给 tool_result 手工设置 isError。

### D9：完整真实运行时 E2E 是独立必做验收层

用户在计划审批中要求补充 E2E，并选择“完整真实运行链路”。新增本 change 的 `e2e.md` 作为决策完备的运行步骤：E0 真实启动/认证与隔离，E1–E2 主会话与实际子角色工具表面，E3 前台/后台/工作流报告接收及完成，E4–E5 缺报告/失败/新 attempt/批量/原生拒绝，E6 冷进程重启，E7 ordinary/direct，E8 最终独立审计与清理。具体启动 flags、companion 路径、fixture、TUI 操作、机器断言、超时和证据格式均以该文件为准。

本包 `test/e2e/` 只保留 `probe.ts`（只观测、不注册上报工具）：按用户 2026-10-10 的裁决，`run-live.mjs` 与 `assert-live.mjs` 已删除，live 验收改为**手工 tmux 驱动真实 Pi 并逐步观测 pane**（见 `e2e.md`）。无论用哪种方式，驱动对象都是临时环境里的真实 Pi/model/TUI，不是新的生产 transport。静态/单元/SDK 假模型集成通过不能替代 live 验收；tasks 6.2 的无模型/网络前提只属于确定性层，tasks 7 明确需要可用凭据和 host tmux，缺失则 BLOCKED、保持未勾选，不能宣称全部完成。

所有测试业务修改只在 `/tmp` 的独立 fixture；以 runtime 读取的绝对 PI_CODING_AGENT_DIR、PI_SUBAGENTS_TEMP_ROOT、PI_GOAL_ROOT 隔离配置/会话/native 子数据，并机器核对实际解析路径，禁止写用户全局 trust/settings/目标、启用 ambient 旧插件或自动确认。当前已验证 host tmux 可连接；CLI 信息探测曾在计划沙箱因全局 trust lock 写入被拒，说明必须先设置临时 agentHome，不能据此放宽当前沙箱。计划阶段不创建 pane、运行模型或执行 E2E。长流程在实现后的前置检查确认凭据，证据断言由 agent/脚本完成，不把“用户手动测试/看屏幕确认”作为验收。

## 文件与验证边界

可修改的既有文件均在 `packages/pi-openspec-x/`：

- `src/index.ts`、`src/report-tools.ts`、`src/agents.ts`。
- `src/implement-command.ts`、`src/dispatch-gate.ts`、`src/plan-command.ts`、`src/goal-base.ts`、`src/flow-recovery.ts`。
- `src/objective.ts`、`src/agent-prompts.ts`、`src/progress-observer.ts`、`README.md`。
- 对应已有 `test/discover.test.ts`、`agents.test.ts`、`report-tools.test.ts`、`implement-command.test.ts`、`dispatch-gate.test.ts`、`goal-base.test.ts`、`flow-recovery.test.ts`、`plan-command.test.ts`、`objective.test.ts`、`progress-projection.test.ts`、`sandbox-profiles.test.ts`。`sandbox-profiles.test.ts` 的两行改动是为该文件的假 `ExtensionAPI` 补上 `events` 存根——原生完成事件订阅从 `pi.on` 迁到 `pi.events.on` 后，缺该存根的假 pi 会让该文件两个用例失败；经用户于 2026-10-07 授予计划修订授权后纳入本清单。

新增三个子入口、`src/child-report-reader.ts`、`src/child-report-ingestion.ts`、`test/child-report-isolation.test.ts`、`test/child-report-reader.test.ts`、`test/child-report-ingestion.test.ts`、`test/child-report-e2e-integration.test.ts`、`test/implement-command-gate-integration.test.ts`，以及测试专用 `test/e2e/run-live.mjs`、`test/e2e/assert-live.mjs`、`test/e2e/probe.ts`。最后两个集成测试文件承载 D8 要求的 peer 边界集成（子入口加载隔离、规范子会话读取、run/receipt 落盘、回执喂勾选门、真实 goal-x 任务工具），经用户于 2026-10-06 授予计划修订授权后纳入本清单。元数据类型、预算、nonce/helper 放在两个生产模块；E2E 文件不进入 manifest/files 发布范围，不新增通用框架或 peer API。

实现阶段从仓库根执行：

1. `pnpm --filter @xzzpig/pi-openspec-x run typecheck`。
2. `pnpm --filter @xzzpig/pi-openspec-x test`。
3. `pnpm exec prettier --check packages/pi-openspec-x openspec/changes/isolate-opsx-child-report-tools`。
4. `pnpm --filter @xzzpig/pi-openspec-x exec npm pack --dry-run --json --ignore-scripts`，校验三个子入口及依赖模块进入 files、主 pi.extensions 不变，不发布。
5. `pnpm run audit:fork-divergence`；本包不是 subtree，两个 peer 保持未改，不制造维护记录。
6. `openspec validate isolate-opsx-child-report-tools --strict`。
7. 按 `e2e.md` 在 `direnv exec` 下执行真实 E0–E8，并保留脱敏证据，才算新增 E2E 验收完成。**执行方式依据用户 2026-10-06 的明确指令调整**：用户否决了 runner 长链路（「你不要使用什么 run-live.mjs 来 e2e 测试了，直接自己使用 tmux 启动 pi 来进行测试，然后你自己观测 tmux pane 进行测试推进」），因此**主要路径是手工 tmux 驱动真实 pi 并逐步观测 pane**；`run-live.mjs --preflight` / `--suite full` 与 `assert-live.mjs --evidence` 保留为**次要/自动化辅助路径**（其隔离映射与 oracle 缺陷已修，见处置表）。实质要求不变：必须是真实 Pi 进程、真实模型、实际扩展资源加载与真实 TUI，且以真实会话条目与目标状态做机器断言；静态/单元/假模型结果不得替代。实际已通过项与诚实边界见 `e2e.md` 的「实际验证记录」。

本轮只执行计划格式/一致性检查及基础环境探测。确定性假模型运行时（`test/child-report-e2e-integration.test.ts` 与 isolation 的渲染后声明用例）现已实现并通过；真实 E2E 的已通过项与未覆盖项以 `e2e.md` 的「实际验证记录」为准，不以计划校验、tmux 可连接或假模型集成冒充 live 验证。

## 审查发现的处置

| 发现                                      | 处置与验收位置                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 / blocker 1：summary 不是焦点          | D6，tasks 3.1/5.2；初始普通焦点、flush 切换、切走再切回测试                                                                                                                                                                                                               |
| G2：版本与私有产物                        | D2/D3，tasks 2.2/4.1；固定协议版本，状态仅定位/终态，未知明确拒绝                                                                                                                                                                                                         |
| G3：未限定成本                            | D4，task 4.3；逐项上限、无变化零字节读、关闭与超时测试                                                                                                                                                                                                                    |
| G4：第二套观察器膨胀                      | D4；不复刻调度/轮询，观察仅用于既有 progress，门控主动刷新                                                                                                                                                                                                                |
| G5 / blocker 2：冷启动 Map 为空           | D5，task 3.2；先恢复绑定再恢复记录、空 Map 冷重启集成测试                                                                                                                                                                                                                 |
| G6 / blocker 3：失败前台部分 Details 丢失 | D2/D8，task 4.2；明确不可取得时拒绝，经过真实工具包装验证                                                                                                                                                                                                                 |
| G7：诊断日志静默漏失败                    | D2，task 2.2；规范会话最后失败/缺配对/缺尾部/断链测试                                                                                                                                                                                                                     |
| G8：无 isError 的逻辑拒绝                 | D7，task 5.3；真实状态转换及实际 goal-x 工具拒绝测试                                                                                                                                                                                                                      |
| G9：通知早于完成事件                      | D3，task 4.1；先通知、延迟事件且已完成 status 的确定性顺序测试                                                                                                                                                                                                            |
| R2 minor 1：公开导出范围不准确            | D3，task 4.1；本包最小结构/运行时校验与公开 preflight 字段，不加 peer export                                                                                                                                                                                              |
| R2 minor 2：helper 非零副作用             | D6，task 3.1；允许既有缓存/派生维护，验证领域状态不变，不主动修改 peer                                                                                                                                                                                                    |
| R4 E2E blocker 1：agentHome 变量错误      | D9/e2e E0/task7.1；PI_CODING_AGENT_DIR 与 PI_SUBAGENTS_TEMP_ROOT，实际主/子路径校验                                                                                                                                                                                       |
| R4 E2E blocker 2：direct 事件断言冲突     | e2e E7/task7.5；ordinary 无 opsx 投影，direct 保留正确 mode/goal/flow 的完成事件                                                                                                                                                                                          |
| R4 E2E minor：wrapper 与 fixture 映射     | e2e E0；wrapperEnv 即 fixture，首次 launcher 初始化，固定 session-dir/精确重启与 direnv host 环境                                                                                                                                                                         |
| 实现期 live 发现 1：marker 行首锚定致死锁 | D3 正文已修订；提取只要求**唯一**，不再要求独占一行（真机复现：子会话 `report_work(err=true)`，包装报 no unique marker，回执永远产不出）。测试 `matches a marker that is not on its own line` 与 `a marker repeated with different ids stays ambiguous`，前者已实测鉴别力 |
| 实现期 live 发现 2：派发 agent 记录顺序   | D3；`dispatchAgents.set` 移到 `tool_call` 处理器最前（原先写在协议检查之后，检查抛错就永远记不上，分支有 dispatch 条目却 0 条 run）。测试 `binds the dispatched agent before any fallible work runs`，已实测鉴别力（插 `await` 后报 `expected [] to have a length of 1`） |
| 实现期发现 3：断言脚本的 oracle 缺陷      | D9；`assert-live` 的 `noSecondReportWork` 原先递归扫全部会话（含子会话），子会话合法调用 `report_work` 故必然误报。改为只扫 `mainSessionFiles`；对先前 exit 1 的真实 E3 证据重跑现为 PASS/exit 0                                                                          |
| 实现期发现 4：模式进入的确定性证据        | D1/D8，task 1.3；新增 `no lifecycle hook adds a tool to the main session`——经 SDK 的 `extension.handlers` 直接驱动六个生命周期频道后断言 `extension.tools` 不增长；已实测鉴别力（注入钩子内 `registerTool` 即失败）                                                       |

## Risks / Trade-offs

- [失败前台工作流没有可访问证据] → 明确拒绝本次 worker 完成并需新的有效派发，不能伪称恢复成功兄弟；后台独立证据仍可接受。
- [后台 session 持久化关闭/新版本/超预算] → 具体诊断和 fail-closed；不转录、不切换 runner、不自动补派。
- [文件通知丢失/失败] → 实时进度降级，终态及完成前主动读；通知不是完整性证明。
- [焦点或分支在异步读取期间变化] → token/代际复验和取消，旧结果不改变新目标。
- [不能证明模型认真审查] → 不增加形式化确认工具；实际审查纪律、窗口 diff 门和最终独立审计继续承担各自责任。
- [版本/元数据接缝维护成本] → 只有本包 envelope/attempt 及现有协议，真实边界 fixture 与兼容诊断；不承诺未知 peer 兼容。

## Migration Plan

实现验证完成后用户另行选择安装/重新加载，本 change 不操作全局副本。新主注册表不含三个子工具；旧会话上下文规则不能追溯删除。旧父上报或无原生身份的记录不转成 ready；已有未完成 agent 目标恢复为显式受限的证据不足状态，而不是漏门放行。回退仅回退本包实现并重新加载，不删除目标、会话或计划台账。

计划通过 review 的 OKAY 仍须 `opsx_plan_verdict` 打开用户批准，不能把本文件或 reviewer 意见当审批；批准定稿后启动实现还须显式进入 apply/implement 流程。

## 验证边界（实现期记录）

本节记录实现期确认的**证据分层**，避免用低强度证据冒充高强度结论。

- **确定性层**（`test/*.test.ts`）证明：工具面与注册表不变（含经真实 SDK 加载的主/子入口、真实 `registerTool` 结果、`extension.commands` 真实命令处理器驱动的 plan/agent/direct 入口路径）、消息与规范会话读取的全部拒绝分支、门控判定与回执撤销。
- **宿主渲染面**（系统提示中实际出现的工具与规则）**不由本包渲染**，插件无法在确定性测试中产出；该面由 live 的 E1/E2 probe 条目 `pi-openspec-x-e2e/surface:v1` 覆盖（其 `registered`/`active`/`promptMentions` 三个数组必须为空）。
- **真实运行层**（`e2e.md` 的 E0–E8）证明真实 Pi 进程、真实模型、真实 TUI、真实子运行与真实目标状态下的端到端行为；静态检查、单元结果与假模型结果**不得**替代该层。
- **本变更的改动窗口**：本变更的实现是工作树中的未提交改动——`git status --porcelain=v1` 共 33 行，其中 23 个受跟踪文件全部位于 `packages/pi-openspec-x/`，其余为本变更目录 `openspec/changes/isolate-opsx-child-report-tools/` 的未跟踪文件；相对 HEAD 的 `git diff --name-only` 同样不含任何 peer 包。HEAD 为 `bf461ad3ec`，而 objective 注入的基线是 `61aa36d81`：两者之间的提交属于**另行的上游同步工作**（pi-subagents 0.77.0 子树同步与 change 目录归档移动），因此相对 `61aa36d81` 的 diff 会显示 500 余个文件，其中绝大多数不属于本变更。同理 `packages/pi-goal-x` 0.9.1 与 `packages/pi-subagents` 0.21.0 的版本来自该同步，本变更未改动任何 peer 包的版本或源码。
- **尚未实现**：objective 2.2 所写的「以确定性假模型运行时产生规范记录」。已探明的接入点是扩展工厂中的 `pi.registerProvider(name, { api, models })`（`docs/custom-provider.md`），或 `<agent-dir>/models.json` 配置兼容端点（`docs/models.md`）。在该项落地前，规范会话记录由测试直接经真实 `SessionManager` 写入，而非由假模型驱动产生。
