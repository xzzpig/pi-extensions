# Design

## Context

动机见 `proposal.md::Why`，行为以 `specs/goal-lifecycle/spec.md` 为准。规划基线为 worktree `/home/xzzpig/.herdr/worktrees/pi-extensions/goal-x`、branch `goal-x`、HEAD `bf461ad3ec`；CLI 必须从该 worktree 执行。本设计不接管旧的未聚焦 goal。

当前 `runGoalCompletionFlow` 等待 `runGoalCompletionAuditor`，随后校验 focus 并进入唯一完成事务。`native-supervisor-channel.ts::poll` 对需要回复的请求发送主会话 wake 并 emit detach；`delegation-adapters.ts::resolveSubagentDelegationStatus` 把非零 detached 回执映射为失败。改动在请求进入默认监督路径之前分流，不修改这一普通子代理路径。

参考 `pi-btw` 的内存会话和 readonly 工具思路，但其私有命令/seed 不构成可复用 API；`buildBtwSeedState` 未修复尚未配对的工具消息，`sendThreadToMain` 会发送 user/follow-up 消息，均不可直接照搬。Goal-X 默认单测使用 `scripts/test-adapter-hooks.mjs`，其 SDK stub 不启动真实会话，因此额外安排真实 SDK 集成证据。

## Goals / Non-Goals

**Goals:** 让已登记 audit 的监督问答在父工具内部同步完成；以完整身份、原取消链和原终态验证保持权限边界；只有首次问题产生旁路 LLM 费用；终态时一次回流有界问答和独立 usage。

**Must-NOT-Have:** 不返回 pending，不新增 goal/scheduler 状态、用户输入 UI、模型设置、后台恢复系统、审计员重启、自动整个审计重试、可写旁路、旁路批准权或广泛工具屏障；不导入/修改 `pi-btw` 私有代码，不新增 runtime 依赖，不修改 Pi core/默认子代理监督、terminal status 枚举、model-visible tool/delegation schema，不改变工作区修改/回滚语义；不改 README、版本、发布、提交或推送。原 auditor 的 `bash` 仍不是强制只读沙箱，本变更不宣称整个工作区被冻结。

## Decisions

### D1. 以父工具阻塞为屏障；仅登记 audit 的请求由旁路处理

拒绝 `pending + scheduler/tool gate`：这会改变完成事务与主模型执行契约。拒绝仅设置 `workflowAwaitDetached`：它没有独立回答者，可能互相等待。选择独立 SDK responder，保持 child attached 和原等待 promise；除既有 Escape park 外，父工具只在 terminal 后返回。

为当前 audit 先登记 responder，再 emit structured delegation request。没有 supervisor 问题时仅登记/释放路由，不创建 SDK side session、不进行 provider/auth 请求。`intercomBridge.mode=off` 或 fresh 下 `fork-only` 不被本变更强行开启：保留现有 effective tool plan；无监督能力则照常审计且旁路零调用；用户显式声明不可用工具时继续由既有 preflight/runtime 检查失败。已登记且监督工具可用的请求不走主 wake/detach。

### D2. 版本化父扩展 API与启动前绑定，不把回调放进模型参数

新增 `packages/pi-subagents/src/api/supervisor-routing.ts`，导出：

- `SUPERVISOR_RESPONDER_REGISTER_EVENT = "pi-subagents:supervisor-responder-register:v1"`，版本 1。
- `SupervisorResponderScope = {sessionId, requestId, ownerRunId, nodeId, agent}`；`requestId` 是 delegation attempt id，不是 supervisor ask id。
- `SupervisorResponderRequest = {requestId, reason, message, interview?, runId, agent, childIndex, deadlineAt, signal}`；这里 `requestId` 是 ask id，回流中命名为 `supervisorRequestId`，避免混淆。
- `SupervisorResponderOutcome = {kind:"reply", message:string} | {kind:"error", code:string, message:string}`。
- `registerSupervisorResponderViaEvents({pi, scope, respond, onFailure})` 返回 `{dispose():void}`；登记失败抛出可操作 Error。只允许完整 scope，空值/非法字段/同 scope 重复登记拒绝；不得按 agent 名单独接管请求。

新 `src/intercom/fork-supervisor-routing.ts` 持有 owner-local registry；按 owning ExtensionAPI 保存，登记 event listener 使用该 owner 当前 `supervisorOwnerSessionId` 校验 `scope.sessionId`。该值来自 SDK `ctx.sessionManager.getSessionId()` 的运行时 session ID，禁止混用 session 文件路径、`state.currentSessionId` 的展示/恢复别名或父目录。登记事件沿用 `runtime-agent-events.ts` 的同步 result 回执模式，必须有 owner ack；旧 handle dispose 只移除它自身，不得误删替代登记。登记失败在 child 启动前 fail closed。

精确链条：

1. `runGoalCompletionAuditor` 生成现有 `(requestId, ownerRunId, nodeId)`，用当前 SDK session ID 和请求 agent 登记 responder。
2. `prompt-template-bridge.ts::PromptTemplateBridgeOptions.executeStructured` 增加内部可选第六参数 `request: SubagentDelegationRequest`；只传解析成功的完整 request。legacy executor 不变，现有 5 参数 callback 仍可忽略多余参数。模型可见 request schema 与 `toSubagentDelegationExecutionParams` 不变。
3. `extension/index.ts` 的 structured wrapper 根据完整 scope 取得 `createSupervisorLaunchHooks`，把内部 hooks 作为 `executeDelegated` 的可选第六参数交给 executor；callback/handle 不进入模型参数、JSON artifacts 或 child env。
4. `subagent-executor.ts::createSubagentExecutor` 为内部 delegated call 保存 hooks（与现有 delegatedThinkingOverrides 相同的 WeakMap 形状）；`execute` 入口捕获 hooks，在真实前台 runId 已分配、真实 canonical agent 已解析、任何 child prompt/工具启动之前调用 `beforeNativeChildLaunch({runId, agent, index:0, parentSessionId, bridgeActive})`。同文件声明的 executor 接口和 `executeDelegated` clone 接入一并更新。不得根据第一个 progress/update 才绑定。
5. hook 校验登记 scope 等于原 request 和实时 owner，把 canonical actual agent 绑定到 `(sessionId, runId, agent, index)`。请求声明 agent 可为 alias，实际 route 必须采用 executor 已解析的 canonical agent；禁止从 child 自报字段推断绑定。scope 只能绑定一次，route 冲突/身份变化在 prompt 前失败，不调用模型。
6. native channel 只按绑定后的完整实际 route 匹配 ask。桥终态/finally、owner session 重置/shutdown 和登记 dispose 都释放绑定；未登记调用保持原有行为。

允许的子代理源代码 seam 只有 `package.json` 的 export、上述 bridge/extension/executor 及 native channel。无需修改 `api/delegation.ts`、`delegation-request.ts`、`delegation-adapters.ts`、`execution.ts`、`shared/types.ts` 或 child-runtime schema；callbacks 是 executor 内部 API，不是 `SubagentParamsLike` 的新模型参数。

### D3. 接管是独占的，有界回复仍由 native channel 写入

在 `native-supervisor-channel.ts::poll` 已完成 owner/lifecycle 校验并加入 pending 之后、发送 parentWake/emit detach 之前调用 fork dispatcher。dispatcher 同步返回是否 claimed；claimed 后 `poll` 立即跳过默认 wake/detach，不 await 模型以阻塞其他 channel 的扫描。

登记 route 内按 ask ID 建立 `claimed -> running -> delivered | failed | cancelled` 状态。相同 ID 重复观察只复用已有处理，不重复 prompt/写 reply。`progress_update` 保留原快路径。其他 route 的 native pending/wake/detach、watcher 和 before-settle 引导不变；已 claimed 的 ask 不产生主模型 reminder，也不能被通用 `subagent_supervisor(reply)` 再次写入，返回“由该 responder 管理”的明确错误。

native channel 给 dispatcher 一个仅针对当前 ask 的 `deliver(message)` 闭包；实际写入仍复用 `writeReply`/`appendSupervisorReplyEntry`，写之前重新确认 pending 存在、没有 reply、route owner/generation 仍有效、时间未过期。旁路没有全局 `subagent_supervisor` 工具，也不扫描/直接写 temp channel 文件。成功写文件是送达依据；journaling 失败仍遵循现有“文件 authoritative”的 best-effort 策略，不能撤销已写回复。

reply 必须非空、有界；interview reply 必须是无 code fence 的普通 JSON 对象。请求的 interview 是当前协议的 opaque object，不宣称存在尚未实现的通用 interview schema 校验器；旁路收到原对象，语义/字段是否满足问题仍由审计员判断。无法根据问题构造合理 JSON 对象返回 unresolved，不编造答案。

claimed 请求发生启动/答复/送达/expiry 错误时，先锁定 failed，调用该 scope 的 `onFailure` 一次并取消当前 audit；禁止回到默认通知或 detach。native `refreshPendingRequests` 清理 claimed 请求时通知 dispatcher：resolved 保持送达，expired/inactive/missing 使未完成的模型请求失效并取消；错误不能被当成“无人接管”。

### D4. 旁路模型、工具、快照和容量

新增 `extensions/goal-audit-sidechannel.ts::createAuditSupervisorSidechannel`，测试注入 `sessionFactory`/clock。首次 claimed ask 才调用 SDK，之后串行复用同一会话；最多 8 个不同需要回复的 ask，重复 ask 不消耗额度。

- 捕获 `ctx.model`、`core.pi.getThinkingLevel()`、cwd 和 `ctx.getSystemPrompt()`，不改变父设置。复用现有 `goal-auditor.ts::resolveAuditorSessionModelOptions(ctx)` 借用父 ModelRuntime，使 runtime-only key/动态 native provider 与父会话一致；不复制钥匙到 prompt、日志、文件或 env，不 refresh/reconfigure/dispose 借用的父 runtime。runtime 缺失或该 SDK 无法使用捕获的模型/auth，在首个 ask 才返回配置错误，不静默换模型/provider/认证来源。
- 使用 `SessionManager.inMemory(cwd)`，seed 必须经 `appendMessage` 写入，禁止只赋值 `agent.state.messages`。`SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:"off"})`，避免隐式 compaction/重试/cache replay制造额外调用；只设置旁路内存实例，不改变父设置或新增用户开关。6.1真实SDK发现schema拒绝发生在submit的execute之前，必须在旁路实际SDK事件边界把本次内部submit的验证拒绝锁成同一ask的协议失败；后来合法重试不得救回。诊断只用安全模板，不复制SDK异常正文。每次 SDK prompt 仍受 request/audit deadline 限制。
- 空 `ResourceLoader` 返回无 extensions/skills/prompts/themes/agentsFiles；system prompt 保留捕获的父约束作为上下文，并追加最终权威旁路角色：只解释现有事实、无执行/批准/新用户选择权。历史 capability 列表是参考，不是实际工具权限。
- 真正 active tools 精确为 `read, grep, find, ls, submit_audit_supervisor_reply`；内部 submit 使用严格 union：`{kind:"reply",message:string}` 或 `{kind:"unresolved",reason:string}`，禁止其他字段、重复提交。SDK custom tool 只捕获该次输出，不写 native reply。旁路无 goal/oracle/subagent/contact_supervisor/MCP/codemode、bash/edit/write，且不调用 `bindExtensions` 加载父扩展。该策略不宣称 read 工具具有目录级文件沙箱；只读不等于所有可读内容可对外披露。
- 旁路 prompt 将原问题/访谈对象、goal/契约/任务证据、完成声明与继承历史明确标为参考数据。完成声明仍不可信，严禁为了“帮助通过审计”掩盖证据缺失；遇到新用户意图或授权决策必须 unresolved。

> **修订(用户裁决 B,2026-10-19)**:真实 provider 会以任意顺序返回同一 assistant 消息的并行工具结果,因此"完成"的判定是**集合完整**
> (每个 call 恰好一个 result、无重复、无孤立、无跨组混入),组内顺序不构成 `context_error`;快照允许重放的 role 集合固定为
> `user / assistant / toolResult / compactionSummary / branchSummary / custom / bashExecution`,其他 role 仍 fail closed。
> 该修订只澄清既有"未完成组不进入快照"要求,不放宽任何能力或授权约束。
> 新 `goal-audit-context-snapshot.ts::captureCompletedAuditContext` 在 audit dispatch 前使用 SDK `buildSessionContext(getEntries(), getLeafId())`，按原分支/compaction上下文取得消息。当前有效父system约束已由`ctx.getSystemPrompt()`单独捕获；seed不重放父`role:"system"`消息的toolsAdded/toolsRemoved工具声明，避免历史能力声明覆盖旁路真实白名单；先剔除这些system消息再校验assistant工具组，完整组中插入能力声明不能被误判为未完成而丢弃已完成证据。保留已完成的对话/分支与compaction摘要作为参考；未知不能安全转换的role返回context_error而非原样作为能力指令重放。按每个 assistant 工具组收集 call IDs；找到首个不完整组即取该 assistant 之前的前缀，同组已回来的部分结果也不复制；前缀有孤立/重复/错序 toolResult 时返回 context_error，不合成假结果。最后一条当前 `update_goal` assistant 中含多个调用时整个组排除。完全配对的失败 toolResult 是合法完成组；pending/deferred 未收敛 assistant 不纳入。快照 deep clone，后续父 branch 变化不修改 seed；不把父 session 的 raw entry/credentials 注入 side会话，不以正则删 thinking 签名破坏合法 SDK replay。

容量是内部常量而非用户设置：捕获 system prompt + 合法消息 + goal payload 的 UTF-8 JSON 总量最多 256 KiB；每个 ask 的 `{message,interview}` 最多 8 KiB；每个有效 reply/unresolved reason 最多 8 KiB；不同 ask 最多 8；累计协调 record 的 UTF-8 JSON 最多 96 KiB。恰好上限允许、超出 1 字节拒绝。超过容量不截断后继续批准，也不额外调用 LLM 总结；快照/模型捕获错误先保存在 side factory，若本次没有 ask 不影响原审计。记录失败时只保留 error code 和最多 1024 字符的诊断，不回显原始超大 payload。每次写 native reply 前预留该条完整 record 容量，不能先送达后才发现记不下。每次ask的有效deadline精确取`min(native request.expiresAt, auditDeadlineAt)`；`auditDeadlineAt`在原`armTerminalTimeout`首次启动时与其timer同时设置为`now + terminalTimeoutMs`，不受后续ask/park/resume重置。它通过side factory闭包读取，不新增用户字段或delegation参数；没有有限deadline则以协议错误取消。每次request处理的timer到期先使其generation失效并锁定超时，再取消旁路/审计；写reply时再次读取clock并判定deadline。

record 只含 `(audit requestId, supervisorRequestId, runId, reason, question, answer/unresolvedReason, deliveryStatus)`，不含 raw thinking、token 流、认证配置或工具返回的原始敏感凭据。ask/answer是执行数据，按 JSON 字符串编码并添加参考数据边界，不能直接作为新的 system/user 指令渲染。

### D5. 取消、park、终态与所有权分离

在 `goal-auditor-delegation.ts::runGoalCompletionAuditor` 中，协调错误增加内部 `cancellationReason = coordination_error` 和锁定的 error；不要调用触发 Escape 的 `args.signal.abort()`。`onFailure` 先写 error/reply-invalid generation，再 emit 原完整 identity cancel；后续任何 completed response（即使 approved）只作为取消 acknowledgement，走 error 分支。保持原 5 秒 cancellation timeout；没有 ack 也必须有界返回错误。

原 `args.signal` 在 `parkOnAbort=true` 时仅触发 park，不能直接连到旁路 session.abort 或注册 handle.dispose。park 的中间 `GoalAuditorResult` 不携带冻结记录/usage，不释放 responder，旁路可继续问答，local/runtime audit timeout 都继续。resume 等待同一 terminal；user bypass 的 `session.cancel()` 才失效 route、取消旁路并发送原 child cancel。终态记录冻结在 `finish` 的 settle-once 路径，所有 cleanup 幂等；冻结后 side session 晚到事件不能新增 record 或改变返回 usage。

新增 `goal-audit-sidechannel.ts` 的 owner-scope lifecycle registry（键为父 `pi` 和 runtime session ID），登记 `invalidate` 回调。`goal-state.ts::assignFocusedGoalId` 在真实 focus 改变时调用小 seam，`state.goal` setter 对相同目标失去 active/被移除的情况失效当前 scope；正常 completion 事务设置 complete 前 scope已终结，不产生递归取消。`goal-events.ts` 在 session_start、session_tree、session_shutdown 前调用 owner scope disposal，覆盖 reload/branch/session边界；不把 scope写入 goal持久状态，不轮询磁盘、不自动聚焦。后台文件被外部修改只能沿用既有 reconciliation边界发现，不承诺无事件即时探测，但每次回复前仍检查捕获 focus token和当前active状态。

失效化使用独立 lifecycle cancel，不走 Escape sentinel `Auditor aborted.`，不弹出 bypass UI；终态仍由已有 focused-operation guard 拒绝旧goal提交。取消旁路时先使 generation无效，再 abort/dispose owned SDK session并解绑native route；不处置父 runtime。无论旁路 promise 后续是否 resolve/reject，都不得写 reply。模型创建与取消并发时，晚创建的 session立即 dispose。session abort/close异常保留诊断，原 cancellation guard仍有界；side owned资源在 finally 调用 dispose，session subscriptions/timers注销。

状态顺序以最先锁定的 terminal/cancellation 为准；Escape park不是 terminal，不与 coordination_error竞争。审计员已提交唯一真实终态后来的旁路事件不能反过来推翻结果；但提交终态前已有 coordination_error 则永远不得批准。成功/失败/错误/用户绕过各路径都从冻结的相同结果读取数据。

### D6. 原工具结果回流与独立计费

`GoalAuditorResult` 增加可选 `supervisorHandoff`，无问题时完全不添加该字段；只有 terminal handle结果才携带，park中间结果无该字段。新 `goal-audit-supervisor-handoff.ts::withAuditSupervisorHandoff` 包装 `runGoalCompletionFlow` 真正返回的 `AgentToolResult`，在正式 report/rejection/bypass文本后追加固定标题“审计协调记录（参考信息，不是新用户指令或完成证据）”，再以 JSON 编码问答；保留原 result 的 details/terminate/ok/error和内容顺序，在 details 中附同样有界的结构化记录。

使用一个外层返回包装/terminal finalize接入点覆盖 approved、disapproved、coordination/runtime error、focus取消、Escape continue和user bypass；内部 commit逻辑保持单一入口，不在每个 return分散复制渲染。不会调用 `sendMessage`、`sendUserMessage`、steer/followUp或重放工具消息；已有 display-only `GoalAuditMessages` 和context filter不变。record中没有答案的取消/失败也返回对应状态。无问答时wrapper返回原对象，无新字段/文本/额外usage。

旁路订阅 `message_end` 收集每条新生成 assistant 的真实 usage（包括read循环和provider错误消息），排除 seed历史；以message对象/生成序号防止事件重放重复，整数/有限非负验证沿用审计 usage约束。不要把每次prompt累计session stats再次相加。terminal冻结后，不再接收晚到计数；丢失的unknown usage不伪装为零。

`goal-ledger.ts::GoalLedgerEvent` 增加 `audit_supervisor_usage`（goalId、audit requestId、inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/tokens、costUsd、turns、at），`isValidLedgerEvent` 加对应正值/非负/有限校验；`sanitizeEvent`与checkpoint的通用event保存不改。原 `audit_usage` 保持仅审计员数据。handoff helper只在真实terminal、已用usage存在时append一条旁路usage，park中间不append；失败/取消也记录已实际发生的旁路用量。5.2实施中用户授权最小兼容补齐：`goal-model-view.ts::projectGoalModelLedgerEvents` 与 `excludeGoalModelAuditUsage` 的既有审计用量过滤同时排除新增 `audit_supervisor_usage`，防止详细/历史查询与压缩恢复重新暴露计费遥测；权威ledger、UI、宿主计费、独立审计输入和旧会话返回不改。不重构遥测、不增加配置，回归断言放在本次已有flow测试文件。

父工具 usage 是原审计员usage加旁路usage的投影，保持 `totalTokens` 与 `cost.total` 供宿主session统计识别；不修改 `goal.usage.tokensUsed` 或预算gate、不把side计费写成parent模型turn。原 `withAuditorUsage` 的 auditor显示保持不变，额外side用量显示由handoff helper负责。重复terminal只冻结/append/回流一次；同一result不再被多个wrapper重复累计。

### D7. 修改文件与只读依据的完整清单

| 文件                                                                                                                          | 修改点/新增符号                                                                                                                                                               | 先读依据                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/src/api/supervisor-routing.ts`（新）                                                                   | D2公共类型、event常量、登记client                                                                                                                                             | `src/agents/runtime-agent-events.ts`、`src/api/delegation.ts`                                                                                                                                                                                                                                         |
| `packages/pi-subagents/src/intercom/fork-supervisor-routing.ts`（新）                                                         | owner registry、`createSupervisorLaunchHooks`、claim/deliver/dispose                                                                                                          | `src/intercom/native-supervisor-channel.ts`、`src/shared/session-identity.ts`                                                                                                                                                                                                                         |
| `packages/pi-subagents/src/extension/index.ts`                                                                                | owner listener生命周期、native dispatcher deps、structured callback传第六参数/hooks                                                                                           | `registerPromptTemplateDelegationBridge`、`createNativeSupervisorChannel`、owner状态session赋值/cleanup                                                                                                                                                                                               |
| `packages/pi-subagents/src/slash/prompt-template-bridge.ts`                                                                   | `executeStructured` 内部第六参数、真正terminal/finally释放绑定                                                                                                                | `parseSubagentDelegationRequest`、现有ownedNodes/attemptControllers                                                                                                                                                                                                                                   |
| `packages/pi-subagents/src/runs/foreground/subagent-executor.ts`                                                              | `createSubagentExecutor`返回类型中的`executeDelegated`可选hooks、clone关联、分配runId后的native launch hook                                                                   | 同文件`delegatedThinkingOverrides`、`execute`原生/foreground选择和真实runId、同文件真实单次同步启动分支（调用`runSync`的路径）                                                                                                                                                                        |
| `packages/pi-subagents/src/intercom/native-supervisor-channel.ts`                                                             | poll在wake/detach前claim、复用安全reply/journal闭包、claimed请求lifecycle与通用reply拦截                                                                                      | 同文件`writeReply`、`requestLifecycle`、`requestMatchesOwner`、`observeRequestLifecycle`、`handleBeforeSettle`                                                                                                                                                                                        |
| `packages/pi-subagents/package.json`                                                                                          | 仅新增`./supervisor-routing` export                                                                                                                                           | 同包`./agents` export样式                                                                                                                                                                                                                                                                             |
| `packages/pi-subagents/test/unit/package-manifest.test.ts`                                                                    | 2.1同步expected exports map中的同一新增项，保留严格deepEqual与其余断言                                                                                                        | 原`published extension APIs use supported package entrypoints`用例；这是已批准export的直接适配，不是新行为或放宽验收                                                                                                                                                                                  |
| `packages/pi-goal-x/extensions/goal-audit-sidechannel.ts`（新）                                                               | SDK responder、scope registry、模型/usage队列/失效/close                                                                                                                      | `goal-auditor.ts::resolveAuditorSessionModelOptions`、`goal-oracle.ts`的内部submit只读session、BTW的只读会话模式、SDK工厂与dispose契约                                                                                                                                                                |
| `packages/pi-goal-x/extensions/goal-audit-context-snapshot.ts`（新）                                                          | completed prefix/deep clone/容量检查                                                                                                                                          | `buildSessionContext`、SDKmessage-types、BTW seed（不复制私有实现）                                                                                                                                                                                                                                   |
| `packages/pi-goal-x/scripts/test-adapter-hooks.mjs`、`tests/stubs/pi-coding-agent.ts`                                         | 3.1仅将真实SDK公开`buildSessionContext`转出给现有adapter，不实现其副本；其他stub行为和旧断言不变                                                                              | 现有preload、stub、安装SDK的公开export；在安装mock resolver之前捕获真实函数                                                                                                                                                                                                                           |
| `packages/pi-goal-x/extensions/goal-audit-supervisor-handoff.ts`（新）                                                        | 冻结结果、渲染/usage投影与单次append                                                                                                                                          | `goal-completion.ts::withAuditorUsage`、`goal-ledger.ts`读写/校验                                                                                                                                                                                                                                     |
| `packages/pi-goal-x/extensions/goal-auditor-delegation.ts`                                                                    | lazy import登记API、capture identity、side session接入、coordination/lifecycle cancel、terminal cleanup、可选handoff字段                                                      | 全文件尤其`park`、`finish`、`cancelAttempt`、identity校验和usagevalidation                                                                                                                                                                                                                            |
| `packages/pi-goal-x/extensions/goal-completion.ts`                                                                            | capture父thinking与focus scope，单一工具结果wrapper；4.1仅import和调用点传参，thinking捕获/诊断helper留在fork-only的`goal-auditor-delegation.ts`，不在上游文件追加fork helper | `runGoalCompletionFlow`、`commitGoalCompletion`、原Escape/usage分支                                                                                                                                                                                                                                   |
| `packages/pi-goal-x/extensions/goal-state.ts`                                                                                 | focus/state失效的小seam                                                                                                                                                       | `assignFocusedGoalId`、`focusedOperationToken`、`isFocusedOperationCurrent`、`state.goal` setter                                                                                                                                                                                                      |
| `packages/pi-goal-x/extensions/goal-events.ts`                                                                                | session_start/tree/shutdown scope dispose                                                                                                                                     | 对应原load/flush/cleanup handlers                                                                                                                                                                                                                                                                     |
| `packages/pi-goal-x/extensions/goal-ledger.ts`                                                                                | 新usage union variant和validator case                                                                                                                                         | `GoalLedgerEvent`、`isValidLedgerEvent`、checkpoint通用event保存                                                                                                                                                                                                                                      |
| `packages/pi-goal-x/extensions/goal-model-view.ts`                                                                            | 5.2用户授权仅在两个既有审计用量过滤谓词中同时排除`audit_supervisor_usage`；其他投影与旧消息保持                                                                               | `projectGoalModelLedgerEvents`、`excludeGoalModelAuditUsage`与shipped主模型遥测精简requirement                                                                                                                                                                                                        |
| `packages/pi-goal-x/package.json`                                                                                             | `files`显式纳入新doc，不改版本/依赖                                                                                                                                           | 原files清单                                                                                                                                                                                                                                                                                           |
| `packages/pi-goal-x/scripts/run-unit-tests.mjs`、`scripts/fork-test-runner.mjs`（新）、`tests/fork-test-runner.test.ts`（新） | 7.1用户授权必要测试入口适配：selfcheck成功后只退出清单检查；fork-only helper隔离新增SDK文件并执行所有组，上游runner仅import/调用接缝；新增直接回归                            | 现有discover/manifest及Node isolation能力探测、D8真实SDK不得加载stub要求；旧套件选择/断言与8.1全套必跑不变                                                                                                                                                                                            |
| `packages/pi-goal-x/tests/fixtures/goal-audit-supervisor-owner.ts`（新）                                                      | 旧纯事件单测的responder登记ack fixture，无模型调用                                                                                                                            | v1登记event契约                                                                                                                                                                                                                                                                                       |
| `packages/pi-goal-x/tests/goal-auditor.test.ts`、`tests/goal-auditor-package.test.ts`                                         | 4.1仅FakeEvents/baseArgs/假owner setup接入上述fixture；3.1只为package测试D-11 configured/shadowed临时项目ctx补`isProjectTrusted: () => true`，不改任何既有断言/其他ctx        | 两文件原FakeEvents与installFakeOwner；D-11有意发现临时项目agent，原fixture缺SDK信任字段导致HEAD也失败，补齐fixture而非改变生产trust                                                                                                                                                                   |
| `packages/pi-goal-x/tests/goal-auditor-agent-resolver.test.ts`                                                                | 4.1仅两个正向dispatch用例接入同一纯ack与SDK sessionId fixture，不改S2断言、四个负向audit调用或生产resolver                                                                    | 强制ack造成的两个新回归必须修复，不能记录成既有test debt                                                                                                                                                                                                                                              |
| `packages/pi-goal-x/tests/e2e/goal-audit-supervisor-live.mjs`（新）                                                           | 显式live E2E driver、tmux控制、隔离与自动证据断言                                                                                                                             | e2e技能、真实Pi CLI、现有goal-direct及session/ledger格式                                                                                                                                                                                                                                              |
| `packages/pi-goal-x/tests/fixtures/goal-audit-e2e-fixture.ts`（新）                                                           | 主会话登记唯一测试auditor别名及等价preflight resolver+观察main/child真实事件，不注册工具或改结果                                                                              | `goal-auditor-registration.ts::DEFAULT_AUDITOR_DEFINITION`、`goal-auditor-agent-resolver.ts::registerAuditorAgentResolver`/`resolveExternalAuditorAgentDefinition`、`@xzzpig/pi-subagents/agents::registerAgentViaEvents`、SDK tool_call/tool_result/before_provider_request、delegation公共event常量 |
| 新测试/文档/manifest/metadata                                                                                                 | 见D8/D9和tasks                                                                                                                                                                | 两包package scripts、fork skill与metadata schema                                                                                                                                                                                                                                                      |

只读、不改的源文件：`packages/pi-subagents/src/api/delegation.ts`、`src/slash/delegation-request.ts`、`src/slash/delegation-adapters.ts`、`src/runs/foreground/execution.ts`、`src/runs/shared/child-launch.ts`、`src/runs/shared/child-runtime-config.ts`、`src/shared/types.ts`；`packages/pi-goal-x/extensions/goal-auditor.ts`、`goal-auditor-registration.ts`、`goal-auditor-agent-resolver.ts`、`goal-service.ts`、`goal-session-safety.ts`、`goal-scheduler.ts`；`packages/pi-btw/` 全部。设计出现不可由这些seam表达的约束时必须先修订规划，不扩域写代码。

### D8. 可执行验收与测试层次

所有本次验收由agent执行；既有spec的历史“必要人工验证”不得用于代替D-15/本次新增场景。用deferred promise/barrier与短timer，不以长sleep等概率结果证明阻塞或竞态。

实施阶段用户已明确确认分阶段执行口径：早期任务使用下列同一loader/preload的 focused 命令，但文件列表仅取当前任务已创建的真实测试子集；尚待后续任务创建的文件不当作skip、不创建占位测试。2.1–2.3先运行新增unit文件；2.1还必须运行既有package-manifest用例，其精确expected exports map只同步新增`./supervisor-routing`一项，不减弱断言（实施时已源代码核验旧map会因此失败）。该上游测试的最小一行适配列入D7，7.2按inventory维护；2.4创建integration文件后立刻运行完整子代理focused命令；3.1先snapshot，3.2–3.3增加sidechannel，4.1创建flow后运行完整Goal-X focused集，6.2再次联验。8.1无条件执行这里列出的完整文件列表与全部gate。不得减少场景覆盖、改断言或把未来未执行的测试记为通过；这只澄清执行时序，不改变目标、任务顺序或最终验收。

| 测试文件（新增）                                                          | 必须证据                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/test/unit/fork-supervisor-routing.test.ts`         | 无owner/错误scope/重复注册失败；runtime sessionID隔离；actual canonical route绑定；绑定必须先于最早ask；重复ask一次回复；claimed拒绝通用reply；reply后journal异常不撤销送达；disposed/expired/foreign消息不回复；普通route默认行为                                                                                                           |
| `packages/pi-subagents/test/integration/fork-supervisor-routing.test.ts`  | 真实bridge+executor+nativechannel联合，fake child runtime在首个prompt立刻调用native contact_supervisor；parentWake与detach计数0；回执不是terminal，真正child terminal只发送一次；未登记route的wake/detach保持；bridge off既有能力不扩大                                                                                                      |
| `packages/pi-goal-x/tests/goal-audit-context-snapshot.test.ts`            | 真实SDK context builder的空branch/指定leaf/compacted branch；pending/deferred assistant、完整失败工具组、多工具只返回一部分、孤立/重复/错序toolResult、snapshot immutable、父system工具声明不重放、256KiB边界及over-by-one                                                                                                                   |
| `packages/pi-goal-x/tests/goal-audit-sidechannel.test.ts`                 | 零问答零LLM、串行8ask、duplicate、首次创建取消竞态、reply/unresolved/invalid结构、interview plain JSON、capacity边界、request/audit deadline、abort/dispose、seed不计费、message_end去重                                                                                                                                                     |
| `packages/pi-goal-x/tests/goal-audit-supervisor-flow.test.ts`             | 实际注册update_goal handler+真实auditor事件链+可控side factory：held completion promise；approved/disapproved/error/焦点/取消/coordination_error后迟到approved；Escape park/continue/bypass及park中terminal；回流一次且消息配对；一条原auditusage+一条sideusage、父toolusage总和、parentbudget不变；无问答toolresult深相等                   |
| `packages/pi-goal-x/tests/integration/goal-audit-sidechannel-sdk.test.ts` | 不经test-adapter-hooks，真实SDK+本地scripted provider：actual active tool名称精确匹配；真实read访问临时证据；dynamic native provider和runtime-only API key可用；父runtime未被dispose且父tool阻塞；合法seed生成provider payload且无父toolsAdded/toolsRemoved扩权；终态记录出现在父toolresult而非user/custom wake；reject未经授权write工具请求 |

3.1实施发现现有`tests/stubs/pi-coding-agent.ts`没有`buildSessionContext`导出。用户将处理决定交给主代理，采用真实SDK函数转接：`scripts/test-adapter-hooks.mjs`在注册mock resolver之前从安装SDK公开入口捕获真实builder，仅通过测试进程内`Symbol.for("@xzzpig/pi-goal-x/test-sdk-build-session-context")`传给stub新增的同名转出；缺SDK或函数必须报错，不复制SDK算法、不从raw entries造假结果、不使用SDK私有路径。既有`defineTool/createAgentSession/SessionManager/SettingsManager`等stub行为和adapter映射不变，真实AgentSession仍不可在bundled测试里创建；不创建session、读取真实凭据或调用provider。snapshot测试以真实SessionEntry/leaf/compaction验证生产helper的默认SDK调用，同时证明`createAgentSession`仍拒绝真实会话。3.1还运行既有`goal-auditor.test.ts`与`goal-auditor-package.test.ts`作为该adapter的直接回归；完整suite仍归8.1。实施A/B日志证实旧D-11 configured/shadowed用例在原preload和本轮preload下均因ctx缺`isProjectTrusted`而拒绝发现其有意配置的临时project agent；允许仅在该用例传给`runGoalCompletionAuditor`的ctx补`isProjectTrusted: () => true`，不改断言、其他ctx或生产信任逻辑、不新增knownDebt，保留原失败日志并复跑同一focused集合。D8命令、任务顺序/数量与最终验收不变，这不是生产SDK替代或auth/tool隔离证据；6.1无stub真实会话仍必跑。3.1允许改动这两个测试适配文件，manifest仍在7.1统一更新，7.2按真实inventory分类维护，不为fork-only自有逻辑新增债务。

既有 `tests/goal-auditor.test.ts` 的FakeEvents/baseArgs及 `tests/goal-auditor-package.test.ts` 的假owner只模拟旧delegation/agent登记，新增强制responder ack会让原测试在发request前失败。因此在新fork-only `tests/fixtures/goal-audit-supervisor-owner.ts` 实现v1纯登记ack fixture，通过两旧测试的最小setup调用接入（不修改原断言）；有意模拟缺owner/缺bridge的用例按原目的保留缺失，不增加production test-only bypass。新owner协议测试与真实SDK集成仍走真实实现，fixture不能替代它们。

4.1实施补充：强制ack使既有`tests/goal-auditor-agent-resolver.test.ts`的两个正向S2 dispatch用例新增失败，允许仅这两例复用同一fixture及SDK sessionId结构setup；所有原S2断言、其他负向用例和生产resolver保持不变。这是已批准登记契约的直接测试适配，不新增任务或债务；4.1起及后续Goal-X focused命令累积纳入该文件。原API必须首次使用才启动动态import，不能在生产模块求值时预热；可在fork-only runner暴露内部缓存加载helper供纯ack fixture在测试setup显式await预热，使旧同步dispatch断言不改，预热不登记/认领/回复请求、不构造会话、不跳过每次真实ack。新flow测试须在不加载该fixture的隔离Node进程以仅针对`@xzzpig/pi-subagents/supervisor-routing`的测试resolver模拟缺subpath或缺导出，证明导入Goal-X模块不访问新API、首次audit才加载、API缺失不崩溃且child request为0；该负向兼容模拟不能充当真实路由或SDK证明。完整suite仍归8.1，本轮已额外执行的baseline/final红灯日志必须如实保留，两个新失败不得假称历史债务。

7.1实施补充（用户已授权）：现有`scripts/run-unit-tests.mjs`对所有suite无条件预加载stub，且`--selfcheck`成功后仍继续执行unit，分别与新SDK测试的无stub要求和清单检查职责冲突。允许上游runner仅增加fork-only `scripts/fork-test-runner.mjs`的import/最小调用接缝和selfcheck成功后的退出；discover、manifest生成/漂移校验、suite选择、空发现拒绝和所有旧断言保持。helper精确按`tests/integration/goal-audit-sidechannel-sdk.test.ts`路径分类，不用泛化SDK文件名规则；原bundled组保留adapter与Node isolation能力探测，SDK组另启无adapter的新Node进程（清空该子进程的`NODE_OPTIONS`避免继承stub），不共享模块缓存。所有非空组均执行，前组失败不能跳过后组；任一组失败/启动错误使总结果非零，空组不启动Node隐式发现。不新增包scripts、配置、依赖或生产开关。新增`tests/fork-test-runner.test.ts`验证精确路由/两组argv/失败传播与不漏跑/空组/SDK隔离；其计入manifest及下列累积focused命令。7.1执行该回归、SDK独立8例及manifest检查，不把未执行全套或stub回归冒充SDK证明。`--selfcheck`只检查清单，不替代8.1的两个包完整unit/integration命令；历史失败不得借这次适配隐藏。7.2按实际inventory记录runner seam和确实镜像上游执行逻辑的helper同步责任，不为自有新增测试/文档加债务。live.mjs仍不被发现、不自动消费真实模型token；task数量/顺序/最终验收不变。

真实SDK测试创建临时HOME/cwd/只读证据，本地fake provider不访问网络或真实凭据、不启动真实LLM；缺SDK/deps必须失败（不得skip）。验证当前pins Pi 1.0.0及peer1.x所需能力，不能拿Pi shim或stub作为证明。生产helper可注入sessionFactory给unit，但真实SDK测试调用默认工厂。

实施在direnv/Nix中先 `pnpm install --frozen-lockfile`；当前worktree直接node测试曾缺`@earendil-works/pi-tui`，需先修复依赖安装，不修改锁文件/peer版本绕过。Node至少22.15，按两包runner现有preload执行。

精确命令（均repository root）：

```bash
pnpm --filter @xzzpig/pi-subagents run typecheck
pnpm --filter @xzzpig/pi-goal-x run typecheck
node --experimental-strip-types --import ./packages/pi-subagents/test/support/register-loader.mjs --import ./packages/pi-subagents/test/support/fork-test-environment.mjs --test ./packages/pi-subagents/test/unit/fork-supervisor-routing.test.ts ./packages/pi-subagents/test/integration/fork-supervisor-routing.test.ts
node --import 'data:text/javascript,import {after} from "node:test";const h=setInterval(()=>{},1000);after(()=>clearInterval(h));' --import ./packages/pi-goal-x/scripts/test-adapter-hooks.mjs --experimental-strip-types --test ./packages/pi-goal-x/tests/goal-audit-context-snapshot.test.ts ./packages/pi-goal-x/tests/goal-audit-sidechannel.test.ts ./packages/pi-goal-x/tests/goal-audit-supervisor-flow.test.ts ./packages/pi-goal-x/tests/goal-auditor.test.ts ./packages/pi-goal-x/tests/goal-auditor-package.test.ts ./packages/pi-goal-x/tests/goal-auditor-agent-resolver.test.ts ./packages/pi-goal-x/tests/fork-test-runner.test.ts
node --experimental-strip-types --test ./packages/pi-goal-x/tests/integration/goal-audit-sidechannel-sdk.test.ts
node ./packages/pi-goal-x/scripts/run-unit-tests.mjs --selfcheck
pnpm --filter @xzzpig/pi-subagents run test:unit
pnpm --filter @xzzpig/pi-subagents run test:integration
pnpm --filter @xzzpig/pi-goal-x run test:unit
pnpm --filter @xzzpig/pi-goal-x run test:integration
pnpm run audit:fork-divergence
openspec validate route-audit-supervisor-requests-sidechannel --strict
```

所有新增断言必须pass，取消/skip不算pass。既有全套失败只能依据`subtrees/*.json::knownDebt`已声明且与本次改动无关的精确baseline分类，不能新增债务掩盖回归。focused旧auditor测试需keepalive，原因是其unref timer在纯unit测试环境可能让event loop先结束；不改production timer策略。SDK命令绝不加载Goal-X的stub preload。

8.1验证环境草案（独立复审OKAY，待用户批准）：`baseline-repair-plan.md` 定义有限的命令局部身份隔离复验。现场C1见证表明，worker继承 `PI_SUBAGENT_CHILD=1` 时会触发测试中真实installer的child保护分支；仅在测试子命令清CHILD/DEPTH使所选见证由RED转GREEN，显式child安全测试仍通过。优先使用现有 `env -u`，不新增helper、不改D7源码清单、生产guard、runner spawn选项、原断言、并发、timeout或knownDebt；父worker环境不变，测试自行设置的child标记仍生效。先按草案A1/A2在同一D8顺序运行全部十条原验证程序/参数，保留原日志和精确残余归属；零源码方案只限定本轮测试宿主身份，不承诺全部262/25/35项消失。未覆盖失败/取消仍保持8.1 RED，修复新暴露的fixture/生产缺陷或永久入口调整须另拟范围并复审批准。本草案不修改spec行为、20项顺序或验收合同，复审通过不等于执行授权。

3.2诊断安全实施补充（独立静态复审OKAY、issues=[]，用户已批准并启动agent实施）：`diagnostic-repair-plan.md` 补充D4的异常安全边界。side模块不再读取/复制外部throw值的message/name/stack/cause，阶段文本固定；3.1 snapshot diagnostic在消费侧按code转安全文本，snapshot helper本身不改。仅 `goal-audit-sidechannel.ts` 与 `tests/goal-audit-sidechannel.test.ts` 两个fork-only文件；除已列明的两个旧正文依赖断言改为安全分类外，全部有效断言、错误code、首次ask惰性、五工具、容量/deadline、first-cause、park/usage/清理等保持。默认工厂实际SDK创建证据由既有无stub八例维持，不能用直接stub调用或mock取代。新增11入口内容oracle先RED后GREEN，额外SDK命令仅局部清NODE_OPTIONS，原D8七文件/两typecheck/两fork摘要必须回归；full8.1和live8.3不豁免。20项任务和验证契约不变；实施授权来自用户批准后的独立agent实施启动事件，而不是静态review本身。

### D9. 最后运行真实 Pi + tmux + 真实模型 E2E

用户在修订审批中要求最后的E2E，并明确选择真实模型provider，不接受scripted provider作为这一层证明。新增 `tests/e2e/goal-audit-supervisor-live.mjs` 的 `runLiveAuditSupervisorE2E` 与 `assertLiveAuditEvidence`，加 `tests/fixtures/goal-audit-e2e-fixture.ts` 的正常公开agent登记/只观察扩展。live runner直接执行，不放入现有 `run-unit-tests.mjs`（后者加载stub且自动发现`.test.ts`）；不修改该runner、不新增包scripts或production配置开关。运行时缺依赖/凭据/要求的路径没有发生均exit非0，不skip、不切换fake provider、不禁用auditor、不注入runCompletionAuditor/sessionFactory。D8本地scripted-provider SDK测试仍保留，不能替代D9。

实施前读取 `.agents/skills/pi-plugin-e2e-test/SKILL.md` 及其 `references/worked-example.md`、`scripts/pi-e2e-env.sh`，再读 `.agents/skills/pi-tmux-tmp-server/SKILL.md`。本机规划时两次不同bash调用的 `TMUX_TMPDIR=/tmp tmux ls` 均exit0，存在host会话；执行E2E时仍须重检。无可连接server时按skill交还用户启动，严禁在sandbox里创建server后声称它持久；不能杀host或其他会话。仅创建/清理driver自己命名的tmux session。

driver从现有agent settings只读取defaultProvider/defaultModel，使用当前用户已配置的真实provider，当前已核验为`axonhub/deepseek-v4-flash`；缺值即失败，不fallback。先执行 `pi auth check --provider <provider>`（只能check，不能print key/token、登录或刷新设置）以及60秒真实print-mode `pong` smoke，记录模型ID/版本/exit，不记录认证内容；smoke未成功立即停止。复用正常native认证入口，不复制key到新文件/argv/prompt/trace，不改真实HOME/settings/auth/models或真实goal。默认API-key provider可直接运行；若当前凭据必须交互登录或要求测试去写/更新原认证文件，报告前置阻塞而非自动授权。认证/配置完整性只在内存比较后记录布尔值，不输出文件内容或credential hash。

每次driver用mkdtemp建立权限0700的`/tmp/pi-audit-supervisor-live-*`，两个case各用独立cwd、`.pi`、session-dir和专属tmux session；保留全局认证/模型定义的只读使用，但关闭全部自动发现渠道。driver生成case的parentSessionId和唯一auditor alias，在临时`live-fixture.json`仅保存这些ID、trace路径和case标签（无凭据）。fixture只在`ctx.sessionManager.getSessionId()`等于该parentSessionId的session_start通过`registerAgentViaEvents`登记alias：复制源码`DEFAULT_AUDITOR_DEFINITION`，工具收窄为read/grep/find/ls/report_auditor_progress、extensions仅fixture自身、保留canonical required progress子扩展，其余skills/skillPath/mcpDirectTools/defaultReads为空，继承context/skills为false。同一parent scope在runtime登记成功后必须调用现有`registerAuditorAgentResolver`登记同步、无副作用的resolver：仅在捕获的parent scope仍有效且name精确等于该唯一alias时返回与`registerAgentViaEvents`完全一致的cloned definition，其他name返回undefined。这样现有`runGoalCompletionAuditor`磁盘discovery的`missing_agent`分支可通过`resolveExternalAuditorAgentDefinition`找到真实runtime注册定义，仍检查required progress与structured协议，不修改或skip preflight。fixture在session_start切换/reload、session_tree、session_shutdown及driver清理时先置scope无效再幂等调用resolver disposer；重复start先dispose旧handle，注册错误不留下resolver。通过现有`auditor.agent`选择该alias，绕开全局同名goal-auditor配置，不覆盖它；child加载fixture时只观察，不再登记agent或resolver。这是正常生产登记/启动协议，不是mock audit engine。副作用全部留在该测试runtime，没有文件级agent替换或新的生产导出。

实际CLI等价于：

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-mcp --approve --provider "$provider" --model "$model" --thinking off --session-id "$parentSessionId" --session-dir "$caseDir/sessions" -e "$repo/packages/pi-subagents/index.ts" -e "$repo/packages/pi-goal-x/extensions/goal.ts" -e "$repo/packages/pi-goal-x/tests/fixtures/goal-audit-e2e-fixture.ts"
```

cwd必须为caseDir。启动项只加载本地源树两个包和测试fixture，不能加载全局已发布旧版本、openspec、permission、BTW等无关扩展；信任的仅是测试临时project设置。临时 `.pi/pi-goal-x-settings.json` 明确 `auditor.disabled:false`、`auditor.agent`为上述唯一alias、`auditor.provider`/`model`与所选模型一致、`auditor.timeoutMs:180000`、`auditor.instructions`为该case监督问题的明确测试指令。agent定义只包含canonical progress扩展和同一个fixture绝对路径以记录child真实tool_result；不依赖仅对default agent有效的definition-tier设置去配置alias。预检正常监督能力必须可用；用户全局bridge关闭等原因导致没有contact_supervisor时报告前置阻塞，不改全局策略、不将零问答视为通过。不增加production强制ask开关；在现有operator_instructions中要求先执行一次真实contact_supervisor，收到答复才继续裁决。临时operator指令不能包含答案或批准代替，不能配置accept-without-audit。

正向case：driver先在真实parent TUI发用户消息“已决定本次交付标记为 ALPHA”，等待该turn真正idle；随后fixture准备`evidence.txt`精确内容`pong\n`，通过真实`/goal-direct`启动仅验证该文件的goal并让模型调用update_goal complete。审计指令要求原child询问“父用户此前已决定的交付标记是什么”（不向child传ALPHA答案）。旁路从completed父历史回答，child实际contact_supervisor tool_result包含ALPHA，再由同一child提交schema-valid批准；目标在真实deferred archive边界完成。若模型未问、问了不相干问题、未用原完成工具、未批准或未真正归档，case失败，不能把普通audit成功当此E2E成功。

负向case：独立会话/goal同样有有效pong文件，但审计明确请求“是否授权删除本测试的evidence.txt”，parent历史没有授权。旁路必须unresolved，原审计coordination_error精确取消并返回error+未解决记录，goal保持active/未归档且文件原字节不变。不得替模型或UI回答该授权，不自动重启audit；底层取消后没有被模型执行的删除工具。E2E不强行制造晚approval或Escape竞态，它们仍由D8可控测试覆盖。

fixture的observer部分只监听SDK `tool_call`/`tool_result`/`before_provider_request`和已有delegation request/started/update/response/cancel公共event；用真实sessionId、requestId、runId和toolCallId关联父窗口与child事件。仅写计数、身份、时间、已知测试问题/答复与结果码等白名单到caseDir，禁止序列化provider payload/headers/auth/raw thinking，禁止替换executor/responder、包装模型结果、提前发reply或发假terminal。每个完成窗口以父update_goal complete tool_call开始、对应tool_result结束；native contact的真实call/result、原structured verdict和最后tool result必须可关联，不仅靠TUI文字。

`assertLiveAuditEvidence` 自动检查两case：

- fixture启动自动证明runtime登记已ack、resolver对当前alias返回同一definition且foreign alias miss；失效后resolver miss。不能把仅preflight成功当child真实启动，后续启动/监督/terminal断言仍必须满足。
- 监督等待时父完成tool尚未结束；窗口内主session before_provider_request为0，最终父JSONL没有该scope的supervisor wake/custom请求消息。
- 同一request/child启动仅一次、detach status/exitCode -2/相关detach事件为0；正向child实际拿到ALPHA后才提交terminal，terminal和tool_result各1次，问答handoff各1次。
- 正向裁决批准且实际归档；负向错误/精确cancel、active不归档、未解决记录存在、没有新用户授权UI/side自动批准，也无artifact删除。
- parent assistant call/toolResult配对、record参考边界、真实side usage有生成token、原audit_usage与side usage各一次、父tool usage相加而目标parent-turn budget不变；取消/失败实际花费不丢。
- 启动capture确认本地extensions；每一步保存pane capture、parent/child白名单trace、session JSONL、goal/ledger文件、模型/命令/退出码/时长/SDK报告的usage与cost（不冒充账单）；仍无global settings/auth/models修改。

driver总墙钟600秒，每case审计180秒、smoke60秒；采用event文件/状态barrier加最长1秒的有限poll检查TUI，不用固定长sleep猜完成。超时需先保留failure证据，再仅清理自己启动的Pi/tmux，所有等待/IO有界；不重跑整case或静默切模型。保留权限0700证据目录，将路径和实际自动断言结果写入本change verification.md。现在只规划；真实API费用调用在本计划获批后实施的最后一步才发生，不建立持久token预算。

最终命令（其他D8 gate通过且代码边界检查通过之后执行）：

```bash
direnv exec . node ./packages/pi-goal-x/tests/e2e/goal-audit-supervisor-live.mjs
```

只接受真实model/TUI闭环与自动断言exit0；凭据/tmux缺失可报告blocked，但不可标记交付完成。`pnpm test:e2e`既有stub或禁用auditor路径不能作为替代。

## Risks / Trade-offs

- [最早请求竞态] → D2实际runId绑定在child prompt前；不靠progress推断。
- [旁路成为第二决策者] → 真实只读工具、内部结构化unresolved、错误取消优先，原auditor保持批准权。
- [上下文太大/敏感内容] → D4明确byte上限、拒绝而非自动压缩；不记录认证/rawthinking，回复不得复制凭据。只读工具不宣称目录沙箱。
- [原audit的Escape/副作用误用] → D5 park不释放route，独立coordination/lifecycle cancel；保留同一attempt的句柄与5秒确认守卫。
- [借用runtime为未文档化property] → 使用已有helper而不复制hack；真实SDK覆盖父runtime只读借用和缺失错误；不能不经证据扩大peer兼容声明。
- [超时/关闭期间晚结果] → generation在abort前失效；terminal freeze-once；late session创建后立即dispose；回复前再次校验。
- [多分支漏回流/usage重复] → D6单一外层wrapper、terminal可选handoff、message_end仅计生成消息，park不消费。
- [fork冲突扩大] → fork-only helpers/test/docs；真实上游seam先inventory、最小编辑、维护metadata，不格式化上游文件。
- [live E2E费用/非确定性/污染用户环境] → D9真实provider是用户指定；只有显式最后命令会调用，设置固定墙钟、不重跑/不fake fallback；临时cwd/session+关闭发现+只清理自建tmux，原配置/认证不改，真实路径没发生就失败。

## Migration Plan

没有goal文件格式迁移、公开工具参数变更或新增依赖。两个包一起交付上述API与consumer；Goal-X在audit开始时lazy import新版export并要求registration ack，缺API/旧owner时返回可操作审计错误，不在插件初始化时因静态新subpath import让整个goal扩展崩溃。正常未登记子代理和无问题审计保持原路径。

新增文档为 `packages/pi-goal-x/docs/audit-supervisor-sidechannel.md` 与 `packages/pi-subagents/docs/fork-supervisor-routing.md`；Goal-X package.json的files须显式加入新doc（不能把全部docs改为通配）；无版本提升。更新`tests/.test-manifest.json`使用现有runner的`--write-manifest`。按fork inventory仅为真实上游seam更新`subtrees/pi-goal-x.json`/`subtrees/pi-subagents.json::reapplyOnSync`，新自有fork-only文件不记维护条目；现有debt保留，新增噪声修复而非宣告接受。审计脚本exit0、checked>0、undeclared=0。

回滚为整体撤销本change的API+consumer+测试+文档/metadata差异，不单独撤销owner API后保留consumer；旧goal/ledger仍可读取，旁路usage新事件不授权生命周期；不重播已完成问答，不恢复跨进程旁路。实现获批后才执行上述步骤，规划期间只写`openspec/`。

## Gap analysis 对应处置

| Gap | 处置                                                             |
| --- | ---------------------------------------------------------------- |
| G1  | D2完整scope、canonical child、启动前hook与最早ask测试            |
| G2  | D1 bridge关闭不扩能力；D3接管独占、失败无fallback                |
| G3  | D5 coordination_error先锁定再cancel，不复用Escape signal         |
| G4  | D4完整工具组快照，D8 pending/compaction/孤立结果与真实SDKpayload |
| G5  | D5 terminal freeze、D6唯一wrapper与独立usage事件                 |
| G6  | D4借用父runtime、精确active tool set；D8默认工厂真实SDK测试      |
| G7  | D8明确unbundled SDK命令、不可skip、stub测试不能替代              |
| G8  | D8本次全部agent执行证据，不以人工确认验收                        |
