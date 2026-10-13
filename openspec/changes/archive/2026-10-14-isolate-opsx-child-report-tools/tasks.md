# Tasks

实施边界：仅修改 `design.md::文件与验证边界` 列出的 `packages/pi-openspec-x/` 文件，并读取其 Context 中协议依据。不得修改 peers、新增验收工具或 goal 参数、把报告塞进 evidence、保留父侧兼容上报，或提交/推送/发布。计划阶段保持全部未勾选；完成仍须最终独立审计。任务中的运行命令均从仓库根执行，路径 `src/`、`test/` 均相对本包。

## 1. 子工具资源隔离与 attempt 边界

- [x] 1.1 按设计 D1 新增三个 `src/child-report-extensions/{gap-analysis,plan-review,worker}.ts`，分别只注册自己的工具；在 `src/agents.ts` 配置绝对 subagentOnlyExtensions，删除主入口批量注册及 `registerReportTools`，保留纯定义/schema/原白名单/reviewer 资源。调整 `test/agents.test.ts`、`report-tools.test.ts`、`discover.test.ts`。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/agents.test.ts test/report-tools.test.ts test/discover.test.ts` 通过，主入口只注册原有两个父侧计划工具。
- [x] 1.2 在 `src/child-report-reader.ts` 实现 D1 的 beginChildReportAttempt/子工具包装：before_agent_start 写入 v1 attempt 元数据，结果 envelope 携带 nonce 与未改变的 report，失败写入不能上报；新 prompt/resume 不能用旧 nonce。新增/扩展 `test/child-report-reader.test.ts`，验证原参数 schema/确认文本不变、元数据非模型可填参数、后续 prompt 和 nonce、缺 marker、记录写入失败。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/child-report-reader.test.ts test/report-tools.test.ts` 通过。
- [x] 1.3 新增 `test/child-report-isolation.test.ts`，经真实 SDK 资源加载/原生 launch tool plan 验证主会话普通/plan/agent/direct/reload 都无三工具及规则，三个子角色各一个、其他角色与 reviewer 无三工具；覆盖前台/后台 provider 路径存在，不依赖 PI_SUBAGENT_CHILD。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/child-report-isolation.test.ts` 通过，主 pi.extensions 未改变，不只断言静态数组。

## 2. 规范报告读取及完整性

- [x] 2.1 实现 D2 的 readChildReportMessages/validateChildReport：限定真实 native 角色/run/index、本次 user 派发和最新 attempt，配对调用与成功 toolResult，使用真实 validateToolArguments 分别校验原参数和 envelope.report；按调用顺序处理覆盖/失败并幂等去重，拒绝仅参数、预览、自由文本、其他角色/任务。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/child-report-reader.test.ts` 通过，含后到旧结果不能覆盖新报告和成功后失败不能放行。
- [x] 2.2 实现 D2 的 readChildReportSession：从已归属 v3 status 的原生 step 定位受 sessionRoot 限定的 Pi v3 sessionFile，只读严格 JSON/父链/当前分支/latest attempt/实际 user 标记与正常结尾；原生日志不再作为报告权威。通过临时目录、实际 SessionManager 和确定性假模型产生规范记录，并测试缺尾部/断链/坏行/缺配对/旧 nonce/跨分支/越界路径。验证：对应 reader vitest 通过；删掉诊断日志中最后失败事件仍拒绝，删除规范记录中的行也不能用早先成功放行；无 SessionManager.open 或其他修复写入。

## 3. 焦点与流程恢复

- [x] 3.1 在 `src/goal-base.ts` 按 D6 实现独立只读 GoalXFocusFacet/readFocusedGoalSnapshot，使用已发布焦点/目标解析辅助函数及正确配置 root，返回 focused/unfocused/unknown 和代际 token；只读按 D6 的领域状态边界验收，允许 helper 自身既有缓存/外部 root 元数据目录/派生快照维护，不允许本包主动修改 peer 缓存或 goal/focus/task。任务前快照合并规范文件与主工具真实 v3 details，不用 summaries 当焦点，不使用过期零操作池缓存证明新状态。扩展 `test/goal-base.test.ts`，覆盖显式 null、多目标、单目标默认设置、root 不匹配、真实焦点条目、尚未 turn-flush 的状态及已知路径刷新。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/goal-base.test.ts` 通过，核对规范目标文件字节及实际 goal/focus/task 状态不变、不热扫描全部文件；不得错误要求 helper 所有 filesystem writes 为零。
- [x] 3.2 在 `src/implement-command.ts` 写入真实 goalId 的 flow-binding:v1，提供 rebindImplementFlow；在 `src/plan-command.ts` 提供计划绑定重建并经主入口 session 边界/首次调用兜底接线。按 D5 先重建当前分支 mode/目标与 gate Map，旧绑定不足进入明确拒绝态，不自动选焦点/恢复目标执行/切权限。扩展 `test/flow-recovery.test.ts`、`goal-base.test.ts`、`implement-command.test.ts`、`plan-command.test.ts`；验证：对应 vitest 通过，清空全部内存 Map 后仅保留规范目标文件和分支条目，opsx agent 无报告的 complete 仍被拦，合法绑定可继续使用后续 receipt，direct/ordinary 不受 worker 条件影响。

## 4. 自动摄取、持久化与有界刷新

- [x] 4.1 新增 `src/child-report-ingestion.ts::registerChildReportIngestion` 并在主入口接线，按 D3 在本包声明支持的 v3 最小结构/版本并校验实际字段，经公开 preflight::resolveSubagentLaunchContract 的 contract.protocol.lifecycleArtifactVersion 核对声明（不 import 私有 AsyncStatus/生命周期常量、不新增 peer export）；验证主 session/根回执/真实子身份/flowId/goalId/task，接收前台成功 messages 和后台规范证据；运行中仅 candidate，子成功终态才 ready。实现 refreshForCompletion 每申请一轮主动 status/会话刷新而非仅等已到事件。新增 `test/child-report-ingestion.test.ts`，验证直接/后台/工作流、启动不放行、未知关联屏障、其他来源隔离、真实公开 preflight 边界/缺字段/未知版本的诊断，以及先唤醒通知后延迟 complete 的顺序；确认 preflight 不启动子运行、不在热路径反复调用。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/child-report-ingestion.test.ts` 通过，已完整成功时无手动 status/bg_wait 即可摄取；仍运行则明确阻塞。
- [x] 4.2 按 D5 实现所属主分支 run/receipt 条目、直接 append 成功确认、当前分支幂等重建和最新派发失效；前台失败且 Details 不可取得时不 ready，后台独立成功子项按其证据判断。用真实 subagent 工具 execute/finalizeToolResult 包装及受控 executor 测一成功 worker 加失败兄弟、证明外层抛错后不会假装取得部分 messages。验证：ingestion vitest 通过；冷恢复/压缩/树切换/重复投递/新 resume/迟到结果/append 抛错（包括内存已追加但落盘失败）均不能复活旧成功或自动完成任务。
- [x] 4.3 按 D4 实现完成前 1,000 ms 截止与取消代际，并实现并测试 32 活跃子项、32 MiB 文件、4 MiB 行、512 KiB 报告、128 次上报及 32,768 节点上限；只缓存索引/摘要/最新报告。**范围收敛（用户 2026-10-13 决策）**：共享 fs.watch 与串行增量读取已明确 descope 并从实现中移除——完成前刷新按需重读，增量读取对正确性非必需；相应 I/O 计数证明一并取消。验证：reader/ingestion vitest 通过；预算拒绝且超时迟到不写新上下文；terminal/退出/session_shutdown 释放句柄与缓冲。
- [x] 4.4 将 `src/progress-observer.ts` 改为 recordChildReportProgress 回调，复用 progress-projection，移除主会话 report\_\* 生产监听；更新 `test/progress-projection.test.ts`。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/progress-projection.test.ts test/child-report-ingestion.test.ts` 通过，两个本次真实 progress 依次投影、重复不追加、失败/旧 nonce 不投影，报告与进度都不改变任务或审批。

## 5. 现有任务接口的完成门

- [x] 5.1 在 `src/implement-command.ts` 删除主 report_work/workReportFrom 分支，新增 rememberWorkerReportReceipt；在 `src/dispatch-gate.ts` 用当前 goal/task 的最新运行和持久化 ready receipt 门控。保持 verificationPassed 优先级、窗口 delta/原噪声过滤、虚报阻塞与未声明文件警告；错误指引不再要求父模型补子报告。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/dispatch-gate.test.ts test/implement-command.test.ts` 通过，旧成功不能放行新派发，失败/缺验证/虚报仍拦截，未声明文件仍警告。
- [x] 5.2 按 D6/D7 调整 createImplementTickGateHandler：恢复绑定、取得权威焦点和前状态、主动刷新、复验 token，统一处理单项与 updates[] 所有 complete 项；任一不满足就整批 block，不先改变 tracker/目标。验证：implement-command vitest 覆盖无父转录的合法完成、全通过批量、一失败全不变、unknown、初始普通目标、flush 期间换目标/分支及切走再切回；direct/ordinary 不加 worker 条件，参数契约不变。
- [x] 5.3 按 D7 以真实 goal-x v3 状态转换而非 !isError 判定工具结果：匹配 captured goal/焦点及全部 complete 项的新 completedAt，再逐项 noteTick/发布完成并去重。使用实际 goal-x 任务工具和临时目标存储做成功单项/批量、缺 evidence、子任务未完成、任务禁用、已完成任务、混合批量拒绝的集成测试。验证：implement-command vitest 通过，所有无 isError 的逻辑拒绝都不发 task_completed/不写 taskTicked，不把普通目标完成算到 opsx；不修改 goal-x。

## 6. 指引与整体验证

- [x] 6.1 按 D8 更新 `src/objective.ts`、`src/agent-prompts.ts`、`README.md`：Task 段独立编码任务标记覆盖新派发/resume；worker 只交自己的报告，父模型审查/验证后 complete 加短 evidence；说明版本/证据/预算诊断，不再要求父侧转录或新增验收工具。验证：`pnpm --filter @xzzpig/pi-openspec-x exec vitest run test/objective.test.ts test/agents.test.ts` 通过；六段、真实验证、不改 openspec/不勾选及最终独立审计仍保留。
- [x] 6.2 完成 D8 三个真实 peer 边界集成及同步/后台/工作流完整接线：实际资源加载、子 report/规范会话、自动摄取、主 complete、真实 goal 状态与事件。验证：`pnpm --filter @xzzpig/pi-openspec-x test`、`pnpm --filter @xzzpig/pi-openspec-x run typecheck` 全通过；正常路径无第二次 report_work，失败/未知/旧报告不完成，只有报告不自行完成，本确定性集成层无真实模型/网络/人工确认前提；不能替代新增第 7 组真实 E2E。
- [x] 6.3 执行 `pnpm exec prettier --check packages/pi-openspec-x openspec/changes/isolate-opsx-child-report-tools`、`pnpm --filter @xzzpig/pi-openspec-x exec npm pack --dry-run --json --ignore-scripts`、`pnpm run audit:fork-divergence`、`openspec validate isolate-opsx-child-report-tools --strict`；核对 pack 包含子入口及两个辅助模块、pi.extensions 仍只主入口，`git diff --name-only` 无本包及本 change 外的新改动。验证：命令退出 0 并记录真实输出；不升版本、发布、提交、推送或自动归档。

## 7. 完整真实运行时 E2E

用户已选择完整 live 范围；依据 design D9 与本 change `e2e.md`，仅在实现后执行。真实模型需要凭据，TUI 需要 host tmux；不具备则保持任务未勾并报告 BLOCKED，不以 static/mock 绿代替。

- [x] 7.1 保留 `test/e2e/probe.ts`（只观测：session_start/before_agent_start/turn_end 写入 `pi-openspec-x-e2e/surface:v1`，不注册上报工具、不改业务状态）；按用户 2026-10-10 裁决删除 `run-live.mjs`/`assert-live.mjs`，live 验收改为手工 tmux 驱动。验证：`node --check packages/pi-openspec-x/test/e2e/probe.ts` 通过，`npm pack --dry-run` 不含 `test/e2e`，全包 vitest 通过。
- [x] 7.2 手工 tmux 驱动真实 Pi 验证主会话工具面：隔离环境启动（五扩展 + `probe.ts`），普通、`/opsx:plan`、`/reload` 三相位各取 surface 条目。验证：`/tmp/e2e-man` 与 `/tmp/e2e-reload` 的会话 JSONL 中 `reportSurface.registered/active/promptMentions` 全空、`opsx_plan_gap_analysis`/`opsx_plan_verdict` 在册、`systemPromptHasReportRules` 为 false；证据见 `e2e.md` 的 E1/E1b 行。
- [x] 7.3 手工 tmux 驱动真实前台 worker 全链路。验证：`/tmp/e2e-man` 会话 JSONL 中 `child-report-dispatch`→`child-report-run`→`child-report-receipt`（verificationPassed=true）→`task-ticked` 的顺序可核验，主会话零 `report_*` 调用，失败验证（vp=false）不被勾选；证据见 `e2e.md` 的 E3 行。
- [x] 7.4 按 E4–E5 执行实际缺报告完成申请、真实验证失败报告、新 resume 失败不能复用旧成功、批量一失败全不变/全有效原子成功，以及缺 evidence/父子任务约束的原生拒绝。验证：对应 case CLI 退出 0，确有真实工具调用而非模型口头拒绝；阻塞前后 goal/tasks.md 未完成，无虚假 task_completed，真实 v3 状态/新 nonce/验证退出码均记录。模型未产生预期调用算未覆盖或失败，不算通过。
- [x] 7.5 按 E6–E8 驱动真实 pause/停止进程/同会话重启/resume、冷 gate 缺报告阻塞后合法报告完成、goal-focus 到 ordinary 及独立 direct 回归，最后实际 opsx-reviewer/普通默认 auditor 审计。验证：对应 case CLI 退出 0，PID 改变且未手造 metadata；先恢复 flow/gate 再 receipt、ordinary 不要求 worker 且无 opsx 完成投影；opsx direct 不要求 worker receipt，但真实转换保留其自身 taskTicked 与 mode=direct、goal/flow 归属正确的 task_completed，不误计到其他 agent flow、最终完成确由执行底座审计批准。无真实重启/只有任务全勾不能算通过。
- [x] 按 `e2e.md` 在 `direnv exec` 下执行真实 E0–E8 并保留脱敏证据：**唯一路径是手工 tmux 驱动真实 `pi` 并逐步观测 pane**（用户 2026-10-06 与 2026-10-10 两次决策；`run-live.mjs` 与 `assert-live.mjs` 已按 7.1 删除，仓库内不再有 live 驱动脚本，故不存在次要辅助脚本）。证据含 E0–E8 的 PASS/FAIL/BLOCKED、启动命令/版本/父子 session/flow/run/attempt/goal/task/工具表面/状态转换/节点验证/审计的脱敏 manifest，并逐条给出机器可核对的会话条目与目标状态。验证：全部必做 case PASS 且每条结论都有真实产物支撑（静态检查、单元结果或假模型结果不得替代 live 验收）；保留并报告 `/tmp` 绝对证据路径；本次 pane/子进程及临时凭据清理，host 其他会话存活，真实 repo 与用户 settings/trust/安装无 E2E 额外差异、pack 不含 `test/e2e`。
      验收方式变更（经用户确认）：不使用 run-live.mjs 套件，改为 tmux 手工驱动真实 Pi 并观测 pane；证据见 /tmp/e2e-man/evidence/E0-E8-manifest.md（索引各 case 的会话 JSONL）与 /tmp/e2e-man/evidence/ 目录。
