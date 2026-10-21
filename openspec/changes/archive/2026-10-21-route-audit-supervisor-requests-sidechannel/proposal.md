# Proposal

## Why

当前完成审计员发出需要回复的 supervisor 请求时，`pi-subagents` 会释放前台等待并返回 detached 回执，structured delegation 将其当作失败，使 `pi-goal-x` 提前结束 audit、丢失同一审计员的后续裁决。需要在不撤掉 `update_goal({status:"complete"})` 同步阻塞保证的前提下完成监督问答：参考 `pi-btw` 的独立只读会话，在旁路回答，再随正式审计终态将协调记录返回主会话。

## What Changes

- 给当前完成审计的精确 delegation attempt 注册限生命周期的 supervisor responder；注册与实际 child route 在启动前绑定。被接管的 `need_decision`、`interview_request` 不触发主模型 turn、不 detach，审计员收到回复后继续同一次运行。没有 responder 的普通子代理保持既有监督行为。
- 旁路使用父会话已完成的上下文快照、当前 goal/验证契约及问题；第一次监督请求才创建独立 SDK `AgentSession`，同一 audit 内复用且串行处理。只开放 `read`、`grep`、`find`、`ls` 及内部结构化答复工具，不继承可写工具、扩展、MCP、skills 或 goal 控制能力。
- `update_goal(complete)` 不返回 pending，不建立新的主模型执行屏障；只有原审计员的有效结构化裁决才能授权完成。旁路答案和父执行者声明均不是完成证据。
- 旁路无法确定事实、需要新用户决策、认证/模型/答复失败时，按用户选择结束本次审计并明确报错，goal 未完成；不猜测、不新增用户弹窗、不退回等待被阻塞主模型回复。
- 沿用原 audit 的 Escape park/继续/用户绕过、精确取消、焦点保护和统一 deadline；旁路的取消/清理与该 attempt 联动。结束后在原工具结果中一次性附加有界的问答/送达记录；记录不伪装成用户指令、不替代 verdict。
- 最终交付必须运行真实 Pi/TUI + tmux + 真实模型 provider 的 E2E（用户明确选择），不可用本地 scripted provider、stub 或现有禁用 auditor 的 E2E 代替。分别验证可回答监督问题后的原审计批准与需要新授权时的 fail-closed，保存工具消息、TUI、native reply、原裁决和 usage 证据。

## Capabilities

### New Capabilities

无。监督旁路属于既有完成审计能力，不新建重复的窄能力域。

### Modified Capabilities

- `goal-lifecycle`：明确本变更允许的 `pi-subagents` 最小监督路由接入，扩展完成审计基线，增加同步旁路监督、只读上下文隔离、失败收敛、生命周期、工具结果回流和最终真实模型 E2E 契约；保留既有批准、拒绝、错误、跳过、Escape 与 deferred archival 行为。

## Impact

### 实现依赖与修改边界

- `packages/pi-subagents/src/api/supervisor-routing.ts`（新增）：导出版本化的 `registerSupervisorResponderViaEvents`、scope/request/outcome 类型；`packages/pi-subagents/package.json` 增加 `./supervisor-routing` 导出，不改变版本或其他依赖。
- `packages/pi-subagents/src/intercom/fork-supervisor-routing.ts`（新增）：实现登记、精确绑定、独占接管、回复、防重与处置清理。最小接入点限定为 `src/extension/index.ts` 的 structured delegation executor/监督通道创建，`src/slash/prompt-template-bridge.ts` 的 request/终态生命周期、`src/runs/foreground/subagent-executor.ts::createSubagentExecutor` 的私有启动绑定回调，以及 `src/intercom/native-supervisor-channel.ts` 的 `poll`/回复路径。不改普通 subagent/workflow 的运行语义、终态枚举、detach 状态转换或模型可见工具 schema。
- `packages/pi-goal-x/extensions/goal-audit-sidechannel.ts`、`goal-audit-context-snapshot.ts`、`goal-audit-supervisor-handoff.ts`（新增）：分别持有旁路会话、合法已完成上下文快照、问答回流。接入 `goal-auditor-delegation.ts::runGoalCompletionAuditor`/`GoalAuditorResult` 与 `goal-completion.ts::runGoalCompletionFlow`/`withAuditorUsage`，保持 `commitGoalCompletion` 的唯一完成授权入口。`goal-state.ts`/`goal-events.ts` 增加 focus/session 失效的小接入点；`goal-ledger.ts::GoalLedgerEvent`/`isValidLedgerEvent` 增加独立旁路 usage 事件。`packages/pi-goal-x/package.json` 仅将新增文档加入 `files`，不改版本或依赖。
- 测试新增到 `packages/pi-subagents/test/unit/fork-supervisor-routing.test.ts`、`test/integration/fork-supervisor-routing.test.ts`，以及 `packages/pi-goal-x/tests/goal-audit-context-snapshot.test.ts`、`goal-audit-sidechannel.test.ts`、`goal-audit-supervisor-flow.test.ts` 以及 `tests/integration/goal-audit-sidechannel-sdk.test.ts`（不经 stub）；新增 `tests/fixtures/goal-audit-supervisor-owner.ts` 并仅对旧 `tests/goal-auditor.test.ts`/`goal-auditor-package.test.ts` 的假 owner setup 增加新版登记 ack，不改原断言或增加 production 测试绕过；对 `packages/pi-subagents/test/unit/package-manifest.test.ts` 的精确 expected exports map 仅同步已批准的 `./supervisor-routing` 一项，保留原严格断言；这是新增导出的必要直接测试适配。更新 Goal-X 的 `tests/.test-manifest.json` 以纳入新增自动发现测试。另新增独立显式执行的 `tests/e2e/goal-audit-supervisor-live.mjs` 和正常登记唯一测试auditor及同alias等价preflight resolver、只观察真实事件的 `tests/fixtures/goal-audit-e2e-fixture.ts`；live runner 不进入带 stub 的通用 runner，也不自动在 CI 消耗真实模型 token。
- 3.1必要测试适配：现有Goal-X stub不导出新增生产helper所需的`buildSessionContext`。允许仅在`packages/pi-goal-x/scripts/test-adapter-hooks.mjs`与`tests/stubs/pi-coding-agent.ts`将安装SDK公开入口的真实builder转出，不复制SDK实现或伪造工具结果；保留所有旧stub行为/断言、D8命令与6.1无stub真实会话验收。缺SDK必须失败，完整测试分层不降级。旧D-11 configured/shadowed临时project fixture在原preload也缺SDK信任字段而失败，因此允许仅对`tests/goal-auditor-package.test.ts`该ctx补`isProjectTrusted: () => true`，保留全部断言/其他ctx与生产trust逻辑，不用新增测试债务豁免。
- 4.1必要直接测试适配：强制supervisor owner ack使`packages/pi-goal-x/tests/goal-auditor-agent-resolver.test.ts`的两个正向dispatch用例缺失fixture而新增失败，允许仅这两例接入同一纯ack和SDK sessionId setup，保留所有原S2断言与负向用例、生产resolver只读；纳入累积focused回归，不新增测试债务。API保持首次使用时懒加载；纯ack fixture可显式await缓存加载helper以保留旧同步断言，但不跳过真实登记，另以隔离进程实测旧API缺失的fail-closed分支。上游`goal-completion.ts`只保留import及最小传参，thinking捕获helper放在fork-only runner。
- 5.2最小兼容补齐（用户已授权）：新增旁路计费event必须沿用既有主模型遥测边界，仅在`packages/pi-goal-x/extensions/goal-model-view.ts::projectGoalModelLedgerEvents`与`excludeGoalModelAuditUsage`中补同一新类型的排除；权威ledger/UI/宿主计费、独立审计输入和旧返回不变，不作遥测重构或增加配置。其回归放入既有`tests/goal-audit-supervisor-flow.test.ts`，任务顺序、数量和最终验收不变。
- 6.1真实SDK必要修复（用户已授权）：除新SDK测试外，仅允许修改现有fork-only `goal-audit-sidechannel.ts`，将SDK在execute前拒绝内部submit的结果锁定为该ask失败，不能由后来合法重试恢复；默认旁路内存SDK settings明确`cacheWarming:"off"`，防止隐式replay调用。新增真实SDK拒绝后合法重试与缓存模型回归，保留原能力/认证/read/seed断言与父设置，不扩大到其他生产模块或SDK实现。
- 3.2异常诊断安全实施补充（独立静态复审OKAY、issues=[]，用户已批准并启动agent实施）：见 `diagnostic-repair-plan.md`。新目标只读反例证实工厂/父getter异常正文可带出合成凭据；拟只改fork-only旁路模块及其unit文件，用固定阶段文本替代外部异常正文并安全处理snapshot诊断转发，保持错误code/失败关闭/生命周期。明确替换两个依赖原异常正文的unit断言，默认工厂实际创建证明保留为既有无stub真实SDK八例必跑，不以直接调用stub代替；其余有效断言不变。源码修复现已获用户单独启动授权，但仅限批准的两文件范围；新目标3.2仍未验收，不改变20项或豁免8.1/8.3。
- 7.1必要测试入口适配（用户已授权）：`packages/pi-goal-x/scripts/run-unit-tests.mjs`只增加最小seam，把执行分组放进新增fork-only `scripts/fork-test-runner.mjs`；新SDK测试精确路径进入独立无stub进程，其他发现测试保持既有adapter，所有非空组均执行且失败传播。`--selfcheck`只检查manifest，8.1完整unit/integration仍必跑；新增`tests/fork-test-runner.test.ts`为直接回归并进入manifest与累积focused命令，不修改旧断言或新增包命令/配置/依赖，不把stub通过当SDK证明。task数量/顺序/最终验收不变，7.2按真实inventory分类runner/helper，不加伪债务。
- 8.1验证环境草案（独立复审OKAY，待用户批准）：见 `baseline-repair-plan.md`。现场A/B已证明继承child身份会使部分宿主测试提前退出；拟仅在验证子命令局部清除 `PI_SUBAGENT_CHILD`/`PI_SUBAGENT_DEPTH`，不修改源码、runner、fixture、断言、并发或timeout，不新增债务。仍执行全部原D8命令，未覆盖失败或取消仍阻塞8.1；这不是完整基线已修好或8.1已通过的声明，也不授权后续源码修复。
- 文档新增到 `packages/pi-goal-x/docs/audit-supervisor-sidechannel.md`、`packages/pi-subagents/docs/fork-supervisor-routing.md`。实施时按 fork inventory 更新 `subtrees/pi-goal-x.json`、`subtrees/pi-subagents.json` 中真实上游接入的重放约束，禁止为新 fork-only 自有逻辑添加伪维护债务。

### 必须读取但不改写的依据

`openspec/specs/goal-lifecycle/spec.md`；`packages/pi-subagents/VISION.md`；`packages/pi-subagents/src/api/delegation.ts`、`src/slash/delegation-request.ts::parseSubagentDelegationRequest`、`src/slash/delegation-adapters.ts::toSubagentDelegationResponse`、`src/runs/foreground/execution.ts::runSync`、`src/agents/runtime-agent-events.ts::registerAgentViaEvents`；`packages/pi-goal-x/extensions/goal-service.ts::GoalService.apply`、`goal-state.ts::focusedOperationToken`/`isFocusedOperationCurrent`、`goal-session-safety.ts::GoalAuditMessages`/`filterGoalSessionContext`、`goal-auditor.ts::resolveAuditorSessionModelOptions`、`goal-auditor-registration.ts::DEFAULT_AUDITOR_DEFINITION`、`goal-auditor-agent-resolver.ts::registerAuditorAgentResolver`/`resolveExternalAuditorAgentDefinition`（E2E只复用，不改生产逻辑）；`packages/pi-btw/extensions/btw.ts::buildBtwSeedState`/`createBtwSubSession`/`createBtwModelRuntimeOptions`/`sendThreadToMain`（仅参考，不导入私有函数）；`packages/pi-goal-x/scripts/run-unit-tests.mjs`/`scripts/test-adapter-hooks.mjs`、`packages/pi-subagents/test/support/register-loader.mjs`/`fork-test-environment.mjs` 和 `.agents/skills/pi-fork-divergence/SKILL.md`。旁路借用既有父 runtime，不重新实现 provider/auth 配置；本次所有验收由 agent 执行，历史基线的人工验证措辞不能替代本次新增断言。

### Must-NOT-Have

不得实现 pending 完成工具、新 scheduler wait/goal 状态、跨进程审计恢复、旁路自动批准/执行代码修改、默认额外 LLM 调用、新模型设置或用户输入 UI、普通子代理监督策略重构、`pi-btw` 代码/依赖/线程复用、Pi core 修改、README 扩写、发布/版本提升、提交或推送。

### 可执行验收

`openspec validate route-audit-supervisor-requests-sidechannel --strict` 必须通过。实施后新增测试必须用 deferred promises/事件探针证明工具在监督问答期间未返回、父模型 turn 数为零、detach 数为零、child 启动一次、终态/回流一次，并覆盖跨 attempt 隔离、结构化 interview 答复、未解决/错误/超时、Escape park/继续/绕过、取消与迟到回复、焦点丢失、工具白名单、合法消息配对和独立 usage；两个包 typecheck、指定测试和 fork-divergence audit 必须 exit 0。最后执行 `direnv exec . node ./packages/pi-goal-x/tests/e2e/goal-audit-supervisor-live.mjs`，真实 Pi、原 native supervisor 通道和真实模型全部参与；缺 tmux/Pi/凭据或真实监督路径未发生必须报错而非 skip/降级。精确前置、隔离、超时和自动断言见 design D9 与 tasks 8.3；不得以人工确认或只有 SDK 单测通过代替 E2E。
