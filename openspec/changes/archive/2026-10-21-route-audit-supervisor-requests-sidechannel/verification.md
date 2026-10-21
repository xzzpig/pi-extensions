# verification.md — route-audit-supervisor-requests-sidechannel

本文件是**实际执行**的验收证据索引，不是计划或声明。所有命令均在仓库根目录的 direnv/Nix 环境中运行；日志保留在 `/tmp/8.1-logs/`，逐任务证据在 `evidence/`。

## 1. 命令与结果（任务 8.1 实跑）

| 记号 | 命令                                                                                                                                                                           | 结果                                                                                                                                                                   | 日志                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| U    | `pnpm --filter @xzzpig/pi-goal-x run test:unit`                                                                                                                                | exit 0；\***\*1335 tests / 1335 pass\*\*** / 0 fail / 0 cancelled / 0 skipped（最终有序复跑，仅 unit 组）                                                              | /tmp/8.7-logs/unit-final.txt            |
| I    | `pnpm --filter @xzzpig/pi-goal-x run test:integration`                                                                                                                         | exit 1；分组执行：integration 组 35 项 / 26 pass / **9 fail 全为已声明的用户批准 settings-profile 债务**；sdk 组 1 项 / 1 pass（真实 SDK、无 stub、清空 NODE_OPTIONS） | /tmp/8.7-logs/int-final.txt             |
| SU   | `pi-subagents` unit，`--test-concurrency=1`                                                                                                                                    | exit 0；4132 / 4116 pass / 0 fail / 0 cancelled / 16 skipped                                                                                                           | /tmp/8.7-logs/subagents-unit.txt        |
| SI   | `pi-subagents` integration，`--test-concurrency=1`                                                                                                                             | exit 0；1218 / 1211 pass / 0 fail / 0 cancelled / 7 skipped                                                                                                            | /tmp/8.7-logs/subagents-integration.txt |
| F    | fork runner（获批入口，8 个 fork suite，排除 live E2E）                                                                                                                        | exit 0；**81 tests / 81 pass** / 0 fail / 0 cancelled                                                                                                                  | `node scripts/fork-test-runner.mjs`     |
| SDK  | `direnv exec . env -u NODE_OPTIONS node --experimental-strip-types --test ./packages/pi-goal-x/tests/integration/goal-audit-sidechannel-sdk.test.ts`（**不加载** Goal-X stub） | exit 0；1/1（子进程内 4 个无 stub 真实 SDK 用例）                                                                                                                      | sdk-command.txt                         |
| TC   | `pnpm --filter <pkg> run typecheck`（两个包）                                                                                                                                  | 均 exit 0，0 个 `error TS`                                                                                                                                             | —                                       |
| SC   | `node ./packages/pi-goal-x/scripts/run-unit-tests.mjs --selfcheck`                                                                                                             | 检查后即退出：`Runner self-check OK: 100 unit + 3 integration + 7 e2e entries match`                                                                                   | —                                       |

## 2. 规范与边界门禁

- `openspec validate route-audit-supervisor-requests-sidechannel --strict` → `Change 'route-audit-supervisor-requests-sidechannel' is valid`（exit 0）。
- **fork 债务批准**:为 `prompt-template-bridge.ts`(上游文件)新增内部第六参数导致 10 行上游原代码缩进变化,
  在 `subtrees/pi-subagents.json::knownDebt` 新增 1 条 `noise`(diff-alignment)声明;**用户已明确批准保留**
  (原话:「批准:保留该条 noise 声明」)。未新增其他债务,未删除或弱化既有条目。
- `pnpm run audit:fork-divergence` → exit 0；`pi-goal-x: checked=555 noise=7 deleted=0 declared=7 undeclared=0 stale=0`，`pi-subagents: checked=989 noise=10 deleted=0 declared=10 undeclared=0 stale=0`；`node env/ensure-upstreams.mjs` → exit 0（schema + ref 校验）。
- `git diff --check` → clean（exit 0）。
- `.pi/pi-goal-x-settings.json`：mtime **2026-10-19 02:13:35**，即 goal `mve57x7e-0xnn4n` 创建（02:12:36）后由
  goal 创建流程写入的 auditor provider/model/thinking，早于本变更任何实现写入；实现过程从未修改该文件，工作区内容原样保留。
  它不属于本变更的 diff 范围，也不是实现改动。
- 只读基线未被修改（`git status` 对这些路径为空）：`pi-subagents/src/api/delegation.ts`、`slash/delegation-request.ts`、`slash/delegation-adapters.ts`、`runs/foreground/execution.ts`、`runs/shared/child-launch.ts`、`runs/shared/child-runtime-config.ts`、`shared/types.ts`；`pi-goal-x/extensions/goal-auditor.ts`、`goal-service.ts`、`goal-session-safety.ts`、`goal-scheduler.ts`；整个 `packages/pi-btw/`。
- 两个 package.json 的全部差异只有两项获批新增：`docs/audit-supervisor-sidechannel.md`（files）与 `./supervisor-routing`（exports）。**没有** version、dependencies、peerDependencies、lockfile 改动；未提交凭据、未改全局认证配置。
- 修改面：7 个新文件（3 个 Goal-X 扩展、1 个 fixture、3 个测试）+ 6 个 pi-subagents 接入文件（其中 4 个最小上游 seam）+ 文档/清单/subtree 记录。

## 3. D-01…D-15 与 I-01…I-21 逐项追踪

| ID   | 契约（摘要）                                                                                                                     | 证据位置（文件:行 · 用例名）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 命令         | 实际结果                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------- |
| D-01 | 审计由 pi-subagents 管理的 fresh-context 前台子进程执行                                                                          | tests/goal-auditor.test.ts:377 · D-01/D-05/I-12: subscribes before request and projects progress…；:822 · D-01/I-16: wrong identity and duplicate terminal events…；tests/goal-delegation-completion.test.ts:124 · D-01/D-07/I-05/I-07                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | U, I         | pass                                                          |
| D-02 | 审计依赖兼容的 pi-subagents extension；缺失即 fail closed                                                                        | tests/goal-auditor.test.ts:648 · D-02/I-16: missing delegation bridge times out and cleans up listeners                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | U            | pass                                                          |
| D-03 | 审计使用独立内存 settings（compaction/retry/cacheWarming 显式）                                                                  | tests/goal-auditor.test.ts:108 · D-03/D-07/D-12: default agent and request overrides are explicit；tests/goal-auditor-package.test.ts:259 · D-03/D-11: missing configured model fails before dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | U            | pass                                                          |
| D-04 | 资源能力由 auditor agent 的 extensions/subagentOnlyExtensions/skills 决定，默认隔离                                              | tests/goal-auditor-package.test.ts:191 · D-04/D-12: registration is skipped when a configured goal-auditor exists；:229 · D-04: packaged goal auditor discovery follows the installed pi-subagents resource policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | U            | pass                                                          |
| D-05 | 普通工具由 auditor agent 严格 allowlist 决定，进度/结构化输出工具由 package 注入                                                 | tests/goal-auditor-package.test.ts:106 · D-05/D-12: default auditor definition keeps the audit wiring code-owned；:122 · D-05/D-12: auditor definition settings merge by tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | U            | pass                                                          |
| D-06 | 可用 mcp:/mcp:<server>/<tool> 精确选择 MCP direct 工具                                                                           | packages/pi-subagents/test/unit/agent-overrides.test.ts · agent-frontmatter.test.ts · subagent-prompt-runtime.test.ts（mcpDirectTools 解析与传播）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | SU           | pass                                                          |
| D-07 | 裁决为 schema-validated {verdict, report, findings} 结构化结果                                                                   | tests/goal-auditor.test.ts:90 · D-07: structured auditor result parser rejects marker-only and malformed values；:604 · D-07/I-05: text that claims approval cannot complete the goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | U            | pass                                                          |
| D-08 | goal-owned transcript overlay 与 /goal-audit 已移除                                                                              | tests/goal-auditor-package.test.ts:49 · D-08: goal package removes its transcript runtime and shared transcript dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | U            | pass                                                          |
| D-09 | 子 Pi 使用自身认证与 provider 发现，不序列化父 runtime-only 状态                                                                 | tests/goal-auditor.test.ts:347 · D-09: delegation requests do not serialize runtime-only parent provider state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | U            | pass                                                          |
| D-10 | Esc 发送带完整 identity 的精确 cancellation 并等待其终态                                                                         | tests/goal-auditor.test.ts:661 · D-10/I-09/I-16: abort emits exact cancellation and waits for its terminal response；:688；:715                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | U            | pass                                                          |
| D-11 | preflight 提供缺失 agent/tool/provider、timeout、budget 分类错误                                                                 | tests/goal-auditor-package.test.ts:259/287/343（D-11系列）；tests/goal-auditor.test.ts:512 · D-11/I-16: auditorTimeoutMs drives the local terminal timer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | U            | pass                                                          |
| D-12 | 默认 goal-auditor 由 pi-goal-x 在 session_start 注册，代码拥有协议                                                               | tests/goal-auditor-package.test.ts:106/122/157/168（D-05/D-12、D-12 系列）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | U            | pass                                                          |
| D-13 | 内容定制走 auditor.\* 设置；/goal-subagent-eject 已移除                                                                          | tests/goal-command-palette.test.ts（eject 命令缺席）；tests/goal-auditor-override.test.ts:54/64/97/125/156（override 合并与校验）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | U            | pass                                                          |
| D-14 | 提示注入层：checklist / checklistExtra / evidenceRequests                                                                        | tests/goal-auditor-override.test.ts（checklist 与 definition-tier 校验）；tests/goal-auditor.test.ts、tests/goal-features.test.ts（prompt 注入内容）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | U            | pass                                                          |
| D-15 | 本次新增：精确 audit 的监督问题由隔离只读旁路答复，完成工具保持阻塞，审计员不 detach，真正终态与协调记录在原工具结果中一次性返回 | tests/goal-audit-supervisor-flow.test.ts（登记先于请求、协调错误先锁定再取消、迟到批准仅作 ack、park/resume/bypass、timeout 保持协调错误）；tests/goal-audit-supervisor-completion.test.ts（真实 update_goal handler + 真实 delegation 链：held promise、唯一 child/terminal、一次回流、拆分计费、fail closed 保持 active、取消不提交）；tests/goal-audit-sidechannel.test.ts（只读工具集、容量/字节边界、deadline=min(native,audit)、取消与清理、usage 去重、诊断不泄露）；tests/goal-audit-context-snapshot.test.ts（完整工具组、orphan/duplicate/out-of-order→context_error、不可变、256 KiB±1）；tests/goal-audit-supervisor-handoff.test.ts（零问答同 reference、一次附录、不伪造用户消息）；tests/goal-audit-supervisor-usage.test.ts（独立 audit_supervisor_usage、非法计数不入账、两处 model-view 排除）；tests/goal-audit-sidechannel-sdk-worker.ts（无 stub 真实 SDK：五工具/真实 read/bash 被拒/seed 历史能力不回放/runtime-only key/父 runtime 未 dispose/unresolved fail closed/重复 submit 失败/cache warming off） | F, SDK, U, I | pass（live E2E 由 8.3 追加）                                  |
| I-01 | 只有 active 目标通过生命周期/运行归属/任务 gate 后才启动审计                                                                     | tests/goal-core-tools.test.ts（create_goal/update_goal gate 系列）；tests/integration/extension.test.ts（五工具 handler 集成）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | U, I         | pass（I 中 9 项为已声明 settings/profile 债务，与 I-01 无关） |
| I-02 | 全局 disabled 与 per-goal skipAuditor 跳过审计并记录原因                                                                         | tests/goal-core-tools.test.ts:576 · update_goal(complete) honors a legacy persisted skipAuditor:true record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | U            | pass                                                          |
| I-03 | 审计输入含目标/任务树/验证契约/摘要/近期 ledger；completion_summary 仅 untrusted                                                 | tests/goal-auditor.test.ts:185 · I-03/I-04/D-07: explicit task keeps the claim untrusted and requires structured output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | U            | pass                                                          |
| I-04 | 审计默认不继承项目 context/skills/扩展                                                                                           | tests/goal-auditor.test.ts:185 · I-03/I-04/D-07                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | U            | pass                                                          |
| I-05 | 只有审计明确批准才进入完成事务                                                                                                   | tests/goal-auditor.test.ts:604/688；tests/goal-delegation-completion.test.ts:124                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | U            | pass                                                          |
| I-06 | 拒绝或运行错误保持 active 并回传反馈                                                                                             | tests/goal-auditor.test.ts:620 · D-11/I-06: every non-success terminal status fails closed；tests/goal-delegation-completion.test.ts:251 · D-07/I-06/I-10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | U            | pass                                                          |
| I-07 | ledger 记录 completion_requested / audit_started / 唯一 audit_result 或 audit_skipped                                            | tests/goal-delegation-completion.test.ts:124（前三条事件序 + approved verdict）；tests/goal-audit-supervisor-completion.test.ts（1×audit_usage + 1×audit_supervisor_usage + 1×audit_result + 0×audit_skipped）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | U, F         | pass                                                          |
| I-08 | focus token、stale 检查、单一完成事务、stop marker、deferred archival                                                            | tests/goal-deferred-archival.test.ts:61 · deferred archival lifecycle；:117 · approval path: buildCompletionReport includes auditor report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | U            | pass                                                          |
| I-09 | Esc 后可选择无审计完成或继续；取消本身不批准                                                                                     | tests/goal-auditor.test.ts:661/688；tests/goal-delegation-completion.test.ts:177 · D-10/I-09: Escape parks the audit and continue reuses the SAME subagent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | U            | pass                                                          |
| I-10 | 错误/拒绝后不会自动重发起整个 review                                                                                             | tests/goal-delegation-completion.test.ts:251 · D-07/I-06/I-10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | U            | pass                                                          |
| I-11 | provider/model/thinkingLevel 可选择审计模型与 thinking                                                                           | tests/goal-auditor.test.ts:108 · D-03/D-07/D-12（请求 override）；tests/goal-settings-race.test.ts（settings 优先级与原子性）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | U            | pass                                                          |
| I-12 | 用户看到审计开始/进度/结果与 auditor label；显示型参数不能推进进度                                                               | tests/goal-auditor.test.ts:377/545/573（I-12 系列）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | U            | pass                                                          |
| I-13 | 默认不暴露 edit/write/goal 管理工具；bash 不是强制只读沙箱                                                                       | tests/goal-auditor-package.test.ts:106/122（默认 auditor 定义 allowlist 与协议工具）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | U            | pass                                                          |
| I-14 | observer 异常不改变控制流或 verdict                                                                                              | tests/goal-auditor.test.ts:845 · I-14: progress observer errors cannot change a structured verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | U            | pass                                                          |
| I-15 | 批准报告进入完成输出；拒绝报告成为执行者可见反馈                                                                                 | tests/goal-deferred-archival.test.ts:117（批准报告）；tests/goal-core-tools.test.ts、tests/goal-model-view.test.ts（拒绝反馈）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | U            | pass                                                          |
| I-16 | 中止/结束不留 AbortSignal listener、动画 timer 或可继续发事件的订阅                                                              | tests/goal-auditor.test.ts:512/648/661/822（I-16 系列）；tests/integration/extension.test.ts:296 · D-11/I-06/I-07/I-16                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | U, I         | pass                                                          |
| I-17 | 五阶段 dashboard 按序 pending→running→passed/failed                                                                              | tests/goal-audit-dashboard.test.ts:41 · objective: pending → running → passed；:58 · all five stages advance in order through percentage bands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | U            | pass                                                          |
| I-18 | 结束后显示 APPROVED/CHANGES REQUIRED/ERROR result card 后恢复 dashboard                                                          | tests/goal-audit-dashboard.test.ts:73 · decision passes on approval and fails on disapproval/error；:86 · auditor identity is shown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | U            | pass                                                          |
| I-19 | 未配置 auditor.\* 注入字段时的审计 prompt 内容                                                                                   | tests/goal-prompts.test.ts（prompt 基线）；tests/goal-auditor-override.test.ts:54 · no override merges to the exact global settings object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | U            | pass                                                          |
| I-20 | 审计协议尾：report_auditor_progress 与 structured_output 约定                                                                    | tests/goal-auditor-package.test.ts:364 · D-11/I-20: runtime fallback enforcement retains the protocol progress tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | U            | pass                                                          |
| I-21 | 此前 eject 产出的 user/project goal-auditor.md 仍被发现与使用                                                                    | tests/goal-auditor-package.test.ts:287 · D-11/I-21: runtime-registered default auditor passes the audit preflight through the local registration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | U            | pass                                                          |

## 4. 诚实披露（偏差与已知债务）

1. **两处真实回归由 8.1 发现并修复（仅测试 fixture，未改任何断言）**：
   - `tests/goal-delegation-completion.test.ts` 未应答 `SUPERVISOR_RESPONDER_REGISTER_EVENT`，导致强制“先登记后请求”在请求发出前就 finish，`request?.context` 为 undefined 且后续 Escape/park 用例挂起 >300 s；补 `installSupervisorResponderAck(events)` 后 14/14 通过（与 HEAD 一致）。
   - `tests/goal-auditor.test.ts` D-09 用例的 ctx 覆盖缺少 `sessionManager`，新的 `scope.sessionId` 读取抛 TypeError；该 ctx 现提供 `getSessionId()`（真实 ExtensionContext 必有），断言未改。
   - 回归性质由 HEAD 干净 worktree（`git worktree add` + `pnpm install --frozen-lockfile`，bf461ad3ec）实测 14/14 证明；worktree 已删除、未修改。
   - 范围偏差（**已获用户批准**）：获批的 4.1 supplement 原先只点名 `goal-auditor.test.ts` 与 `goal-auditor-package.test.ts`。
     本会话末尾用户就 `tests/goal-delegation-completion.test.ts` 明确批复：「批准：同一 ack fixture 扩展到该文件」。
     改动仍是同一纯 fake fixture（只应答登记事件，无模型调用、不改任何断言），因此该扩域现已具备用户批准证据。
2. **`pi-subagents` 并行测试的失败按既有债务串行复核**：并行 unit 仅 `subagent extension child mode` 失败（<1200 ms 计时断言，solo 30/30 通过）；并行 integration 5 项超时失败，串行全绿。`subtrees/pi-subagents.json` 的 `test` knownDebt 明确要求“用串行验证发布，不要用并行”，未新增债务。
3. **`pi-goal-x` integration 的 9 项失败** 是 `subtrees/pi-goal-x.json` 中既有的、用户批准的 settings/profile 债务，失败集合与本变更修改面不重叠；本变更新增的集成用例在同一次运行中通过。
4. **D-15 的 live E2E 已实际执行并通过**：`direnv exec . node ./packages/pi-goal-x/tests/e2e/goal-audit-supervisor-live.mjs` → **exit 0，BOTH LIVE CASES PASSED**。真实 pi TUI + 宿主 tmux + 用户现有真实 provider(axonhub/deepseek-v4-flash)，两个 case 各自独立的 0700 目录/cwd/session-dir/tmux 会话：
   - 正向(14/14)：别名登记 ack、resolver 命中同一定义且对陌生别名 miss、恰好一个 child、问答期间父模型 provider 请求为 0、child 真实 `contact_supervisor` 的 tool_result 含 ALPHA、恰好一个终态且无取消、同一 child 批准、goal 真实归档、1×`audit_result`(approved)、1×`audit_usage` + 1×`audit_supervisor_usage`(turns>0)。
   - 负向(13/13)：1 个 child、父模型 0 请求、恰好一次取消、无批准、唯一 `audit_result` 为 error、goal 保持 active 未归档、无 `goal_completed`、evidence.txt 字节不变、child 未执行任何删除工具、未解决记录回传、旁路实际花费仍记一行。
   - 证据：`evidence/8.3-live-e2e.json`(逐项断言) 与 `evidence/8.3-live-e2e.txt`(命令/退出码/迭代史)。每个 case 目录保留 final-pane.txt、trace.jsonl(白名单事件)、result.json、真实 session JSONL、goal/ledger 文件。
   - 三次真实运行的迭代史已在 `evidence/8.3-live-e2e.txt` 记录：前两次失败分别是"克隆定义丢失进度子扩展"与"ALPHA 消息被当作 steering 投递"，**修复只发生在新加的 E2E fixture 与 E2E driver**，未为通过 E2E 改动任何生产文件。

4b. **审计拒绝后的整改（全部为生产缺陷，已修并有回归测试）**：父上下文改为创建时冻结、`goalPayload` 进入参考块、
非法 submit 锁定（非法后合法仍失败）、invalidate 后拒答迟到答复、旁路失效改为 **owner 作用域**（focus 只撤销原焦点 goal，
active→非 active 也撤销）、两处 `session.cancel()` 结果回流并按**原 audit target** 记账、handoff 正文不再包含任何计费字段、
usage 按 id/responseId 去重且 `tokens` 含 cache；另外修掉一个真实 D4 偏差——**任何授权/许可类问题必须返回 `unresolved`，连拒绝也不行**。
证据：`evidence/8.4-auditor-rejection-remediation.md`（逐条对照）、侧信道单测 30/30（含 6 条新回归用例）。

4c. **获批 runner 入口已落实**：新增 `scripts/fork-test-runner.mjs` + `tests/fork-test-runner.test.ts`（5/5），
live E2E 被显式排除；`run-unit-tests.mjs --selfcheck` 改为**检查后退出**；manifest 刷新为 100 unit。

## 5. live E2E（8.3/8.5，已完成）

- 命令：`direnv exec . node ./packages/pi-goal-x/tests/e2e/goal-audit-supervisor-live.mjs`
- **最终有序复跑（gates 全绿之后最后执行）**：exit 0，BOTH LIVE CASES PASSED，50 条断言全绿；
  证据 `evidence/8.7-final-run.txt`。此前一轮整改中的 live 证据（`8.5-*`）已**过期**，不再作为通过依据。
- 整改后再次全绿：exit 0，BOTH LIVE CASES PASSED，断言已按 D9 收紧（toolCallId 窗口、detach/exitCode -2 为 0、
  唯一 handoff、窗口内父 provider 请求 0、started/request 各 1、usage 行自洽、tool totalTokens = auditor+side 账本、
  真实消息配对、dispose 后 resolver miss、ALPHA 经 `contact_supervisor` 且早于 child 终态、unresolved→精确取消）。
  证据：`evidence/8.5-live-e2e-after-remediation.{json,txt}`（含两 case 逐项 PASS）；整改前那次见 `8.3-*`。
- 该入口刻意不加入 `run-unit-tests.mjs`、不加入 `tests/.test-manifest.json`、不新增 package script，因此 stub runner 无法冒充它。

## 最终有序复跑（第三轮审计整改后）

证据 `evidence/8.9-final-run.txt`（日志 `/tmp/8.9-logs/`）。顺序：两包 typecheck → goal-x unit
(1332/1332) → goal-x integration（integration 组 26 pass + 9 项已声明债务；sdk 组 1/1 真实 SDK）→
fork runner (78/78) → selfcheck OK → fork-divergence gate exit 0 (555/7、989/10，undeclared 0) →
strict validate valid → git diff --check clean → **最后** live E2E exit 0，两例全绿 54 条断言
（含 piVersion=1.1.0、piExit=0、全局 settings/auth/models 前后一致、父自身用量口径的预算证明）。

第三轮审计 6 项意见的闭合方式见 `evidence/8.9-final-run.txt` 顶部清单：SDK 层拒绝在 message_end
观测并锁错（真实 SDK 6/6，含 null/[]/string）、goalPayload structuredClone 冻结、会话创建后再次校验
deadline、bypass 先 invalidate 再 cancel、driver 完整性/超时/总预算/版本/退出码落实、预算断言改为
父自身用量上界且 tool usage 相等无条件断言。

## 第四轮审计整改后最终有序复跑

证据 `evidence/8.10-final-run.txt`（日志 `/tmp/8.10-logs/`）。顺序：两包 typecheck → goal-x unit
(1335/1335) → integration（26 pass + 9 已声明债务；sdk 组 1/1）→ fork runner (81/81) → selfcheck OK →
fork gate exit 0 (555/7、989/10、undeclared 0) → strict validate → diff --check clean → **最后** live E2E
exit 0，两例 55 条断言全绿（父 getter 优先的 thinking、缺 runtime fail-closed、usage 有限性与取消计费、
models.json 仅内存比对且不写 hash、600s 有界、completion_summary/提问不含标记、growth<side 的预算证明）。

## 第五轮审计整改后最终有序复跑

证据 `evidence/8.11-final-run.txt`（日志 `/tmp/8.11-logs/`）。顺序：两包 typecheck → pi-subagents
focused unit 27/27 + integration 3/3（本轮该包只改了 fork-supervisor-routing.ts）→ goal-x unit
1335/1335 → integration（26 pass + 9 已声明债务；sdk 1/1）→ fork runner 81/81 → selfcheck OK →
fork gate exit 0（555/7、989/10、undeclared 0）→ strict validate → diff --check clean → **最后** live
E2E exit 0，两例 55 条断言全绿。本轮关闭：生产侧 getThinkingLevel 转发、dispose 先 await abort 再释放
监听（取消/终态用量不再丢失）、deadline timer 仅在同步校验之后武装（错误路径无残留）、
markDeliveryFailed（未写成功不得记 delivered）、fork 路由不再复制外部异常正文、完整性快照在启动前采集。

## 第六轮审计整改后最终有序复跑（含 FULL 全套）

证据 `evidence/8.12-final-run.txt`（日志 `/tmp/8.12-logs/`）。顺序：两包 typecheck → **pi-subagents
完整串行 unit（4132/4116/0 fail）与完整串行 integration（1218/1211/0 fail）** → goal-x unit
1335/1335 → integration（26 pass + 9 已声明债务；sdk 1/1）→ fork runner 81/81 → selfcheck OK →
fork gate exit 0（555/7、989/10、undeclared 0）→ strict validate → diff --check clean → **最后** live
E2E exit 0（两例 55 条断言）。本轮关闭：取消计费与 seal 解耦（usageFrozen 在 abort 计费后置位）、
invalidate/dispose 共用 settlePromise 严格按 abort→dispose→冻结→释放顺序、ensureSession 与
创建后过期路径也 stopDeadline、送达降级按 pendingDelivery 精确关联单一 ask、fork 路由固定文本、
live 完整性快照先于启动采集。本轮 pi-subagents 完整套件是在 `fork-supervisor-routing.ts` 最后一次
修改之后运行的（日志时间戳晚于文件改动）。

## 第七轮审计整改后最终有序复跑

证据 `evidence/8.13-final-run.txt`（日志 `/tmp/8.13-logs/`）。本轮 pi-subagents 未改动，其完整串行
套件（8.12：unit 4132/4116/0、integration 1218/1211/0，均在最后一次源码修改之后运行）继续有效。
本轮 gate：goal-x typecheck 0 error、unit 1335/1335、integration（26 pass + 9 已声明债务；sdk 1/1）、
fork runner 81/81、selfcheck OK、fork gate exit 0（555/7、989/10、undeclared 0）、strict validate、
diff --check clean，最后 live E2E exit 0（两例 55 条断言）。本轮关闭：终态在 settle 之后才冻结
（finish 包装 await dispose→settlePromise）、晚创建会话的订阅释放、以及错误分支保留有界失败记录使
问题身份仍能一次性回流。

## 第八轮审计整改后最终有序复跑

证据 `evidence/8.14-final-run.txt`（日志 `/tmp/8.14-logs/`）。pi-subagents 本轮未改动，8.12 的完整串行
套件继续有效（unit 4132/4116/0、integration 1218/1211/0，均在最后一次源码修改后运行）。
本轮 gate：goal-x typecheck 0 error、unit **1336/1336**、integration（26 pass + 9 已声明债务；sdk 1/1）、
fork runner 81/81、selfcheck OK、fork gate exit 0（555/7、989/10、undeclared 0）、diff --check clean，
最后 live E2E exit 0（两例 55 条断言）。本轮关闭：settle 全程有界（dispose 与 invalidate 链都用
SETTLE_TIMEOUT_MS 5s race，abort 不收敛也会释放监听并收敛终态）、以及 sealed 只冻结 delivered 记录，
运行中被取消的 ask 仍保留 question/supervisorRequestId/cancelled 记录（新增回归测试）。

## 第九轮审计整改后最终有序复跑

证据 `evidence/8.16-final-run.txt`（日志 `/tmp/8.16-logs/`、`/tmp/8.15-logs/`）。pi-subagents 本轮未改动，
8.12 的完整串行套件继续有效。gate：goal-x typecheck 0 error、unit **1336/1336**、integration（26 pass +
9 已声明债务；sdk 1/1）、fork runner **82/82**、selfcheck OK、fork gate exit 0（555/7、989/10、
undeclared 0）、strict validate、diff --check clean；最后 live E2E exit 0（两例 55 条断言）。
本轮关闭：dispose 单条有序 settle 链（先有界等待在途 ask 记下 cancelled，再 seal，再有界 abort 计费，
最后冻结 usage 并释放监听）、晚创建会话 abort 也有界并释放订阅、watchdog timer 在 finally 清理、
以及 finish 异步化引入的重复取消回归（settleStarted 同步置位，cancelAttempt 尊重它）。

## 第十轮审计整改后最终有序复跑

证据 `evidence/8.17-final-run.txt`（日志 `/tmp/8.17-logs/`、`/tmp/8.17-logs-unit.txt`）。
gate：两包 typecheck 0 error、goal-x unit **1336/1336**、integration（26 pass + 9 已声明债务；sdk 1/1）、
fork runner **82/82**、selfcheck OK、fork gate exit 0（555/7、989/10、undeclared 0）、strict validate、
diff --check clean；最后 live E2E exit 0（两例 55 条断言）。本轮关闭：dispose 顺序改为
abort → 有界等待在途 ask → 强制 stopDeadline → seal → dispose SDK → 冻结 usage/释放监听（取消记录必然
进入 handoff）；边界差异按本子树真实模块路径恢复 import 并还原 `count` 名称。

## 第十一轮审计整改后最终有序复跑

证据 `evidence/8.18-final-run.txt`（日志 `/tmp/8.18-logs/`）。gate：两包 typecheck 0 error、goal-x unit
**1336/1336**、integration（26 pass + 9 已声明债务；sdk 1/1）、fork runner **82/82**、selfcheck OK、
fork gate exit 0（555/7、989/10、undeclared 0）、strict validate、diff --check clean；**最后** live E2E
exit 0（两例 55 条断言）。本轮关闭：invalidate 与 dispose 共用单条 settle 链（abort→有界等待 ask→
终态确定性写入 cancelled 记录→强制 stopDeadline→seal→dispose→冻结 usage/释放监听）、取消回归改为在
**生产冻结边界**断言记录、边界 import 按基线成员与路径还原（删除我先前新增的 index.ts 整行 imports）。

## 第十二轮审计整改后最终有序复跑

证据 `evidence/8.19-final-run.txt`（日志 `/tmp/8.19-logs/`）。gate：两包 typecheck 0 error、subagents
focused unit 27/27、goal-x unit **1336/1336**、integration（26 pass + 9 已声明债务；sdk 1/1）、
fork runner **82/82**、selfcheck OK、fork gate exit 0（555/7、989/10、undeclared 0）、diff --check clean，
**最后** live E2E exit 0（两例 55 条断言）。本轮关闭：无 live owner 时登记直接失败（fail closed）、
所有已 claim 的排队 ask 在终态各写入一条有界 cancelled 记录、以及 import 位置按基线还原。
live 前两次失败（空闲屏障超时、模型把标记写进 completion_summary）也如实记录在同一证据文件中。

## 第十三轮审计整改后最终有序复跑（FULL 全套）

证据 `evidence/8.20-final-run.txt`（日志 `/tmp/8.20-logs/`）。顺序：两包 typecheck → **pi-subagents
完整串行 unit 4132/4116/0 与完整串行 integration 1218/1211/0（均在最后一次源码修改之后）** →
goal-x unit 1336/1336 → integration（26 pass + 9 已声明债务；sdk 1/1）→ fork runner 82/82 →
selfcheck OK → fork gate exit 0（555/7、989/10、undeclared 0）→ strict validate → diff --check clean →
**最后** live E2E exit 0（两例 55 条断言）。本轮关闭：登记后 owner 丢失/改变的启动期 fail-closed
（`createSupervisorLaunchHooks` 抛错而非返回 undefined）、完整套件在最终代码上复跑、以及 import
顺序按基线还原（这两个文件相对基线的 import 差异只剩新增的 `SupervisorLaunchHooks`）。

## 第十四轮审计整改后最终有序复跑（FULL 全套）

证据 `evidence/8.21-final-run.txt`（日志 `/tmp/8.21-logs/`）。顺序：两包 typecheck → **pi-subagents
完整串行 unit（4132/4116/0）与完整串行 integration（1218/1210，1 项为已声明的 spawn-family 负载抖动，
单文件复跑 44/44 通过）** → goal-x unit 1336/1336 → integration（26 pass + 9 已声明债务；sdk 1/1）→
router 单测 20/20 → fork runner 82/82 → selfcheck OK → fork gate exit 0（555/7、989/10、undeclared 0）→
diff --check clean → **最后** live E2E exit 0（两例 55 条断言）。本轮关闭：生命周期失效接入独立取消链
（`cancelAttempt("lifecycle_revoked")`，迟到批准只能被当作取消确认）、以及终态删除引用该登记的
`registry.asks` 记录（respond/onFailure 闭包不再随 session 累积）。

## 第十五轮审计整改后最终有序复跑（FULL 绿）

证据 `evidence/8.22-final-run.txt`（日志 `/tmp/8.22-logs/`）。顺序：两包 typecheck → **pi-subagents
完整串行 unit 4133/4117/0 与完整串行 integration 1218/1211/0（均 exit 0，未使用任何豁免）** →
router 单测 21/21（含 journal 内容 oracle）→ goal-x unit 1336/1336 → integration（26 pass + 9 已声明
债务；sdk 1/1）→ fork runner 82/82 → selfcheck OK → fork gate exit 0（555/7、989/10、undeclared 0）→
strict validate → diff --check clean → **最后** live E2E exit 0（两例 55 条断言）。本轮关闭：完整
subagents integration 在最终候选上真绿、以及 managed native 回复路径的 journal catch 改为固定文案并
用真实边界 oracle 断言无外部异常正文与 stack。

## 第十六轮审计整改后最终有序复跑

证据 `evidence/8.23-final-run.txt`（日志 `/tmp/8.23-logs/`）。gate：两包 typecheck 0 error、goal-x unit
**1339/1339**（新增 3 项容量精确边界）、integration（26 pass + 9 已声明债务；sdk 1/1）、
fork runner **85/85**、selfcheck OK、fork gate exit 0（555/7、989/10、undeclared 0）、strict validate、
diff --check clean；**最后** live E2E 首跑即 exit 0（两例 55 条断言）。本轮关闭：注册失败改为固定文案
（不再回显外部异常正文）、协调失败在终态锁之后不再产生任何副作用、以及 ask/reply/96 KiB 记录的精确
边界与“超限时尚未送达”的真实验证。live 重跑策略按用户裁定：同一代码最多重跑一次。

## 第十七轮审计整改后最终有序复跑

证据 `evidence/8.27-final-run.txt`（日志 `/tmp/8.27-logs/`）。gate：两包 typecheck 0 error、goal-x unit
**1341/1341（42.6 s）**、integration（26 pass + 9 已声明债务；sdk 1/1）、fork runner **87/87**、
fork 门 exit 0、diff --check clean；**最后** live E2E exit 0（两例 55 条断言）。本轮生产修复：
协调失败**先** `invalidate` 再 cancel、cancel 失败固定文案、session scope 捕获 fail closed（零 child）、
以及“会话创建期间被取消则不再发起 prompt”。诚实披露：我写的两条流程 oracle 会让套件进程挂住
（unit 曾 900 s 超时只跑 113 项），已移除以免交付挂死的套件，因此这两项行为目前由生产代码路径与既有
协调/注册测试覆盖，没有独立新断言。

## 第十八轮审计整改后最终有序复跑

证据 `evidence/8.28-final-run.txt`（日志 `/tmp/8.28-logs/`）。gate：两包 typecheck 0 error、goal-x unit
**1343/1343**（flow 文件 9/9、2.2 s）、integration（26 pass + 9 已声明债务；sdk 1/1）、fork runner
**89/89**、selfcheck OK、fork gate exit 0（555/7、989/10、undeclared 0）、strict validate、diff --check
clean；**最后** live E2E exit 0（两例 55 条断言）。本轮关闭：scope 捕获分支在 Promise executor 内
**改为 resolve**（有界收敛，正是上一轮挂死的根因）、request emit 失败固定文案、preflight 与两处
snapshot 诊断同样固定文案，并补回 3 条 oracle。

## 第十九轮审计整改后最终有序复跑

证据 `evidence/8.29-final-run.txt`（日志 `/tmp/8.29-logs/`）。gate：两包 typecheck 0 error、goal-x unit
**1344/1344**、integration（26 pass + 9 已声明债务；sdk 1/1）、fork runner **90/90**、fork 门 exit 0、
strict validate、diff --check clean；live 首跑 54/55（仅“批准对用户可见”一项），按用户批准的“同代码
最多重跑一次”策略重跑一次即 **exit 0（55/55）**。本轮关闭：回复前 liveness 重检接通生产
（`isGoalLive` → sidechannel `verifyLive`，每次送达前调用，抛错即拒绝）、以及同 ID 状态变化
（active→paused/blocked）经 `updateFocusedGoal` 撤销该 goal 的在途审计。

未闭合（如实记录，不声称已覆盖）：① 未实现“独立无 stub Node 进程验证 supervisor-routing 子路径缺失时
延迟加载、首次审计 fail closed、child request=0”的专门测试；② 焦点切走/切回、同 ID 移除、
branch/session、shutdown/reload 与迟到回复的端到端生命周期测试仍为间接覆盖。

## 第二十轮审计整改后最终有序复跑

证据 `evidence/8.31-final-run.txt`。gate（自 8.30 起生产与测试代码未再变）：两包 typecheck 0 error、
goal-x unit **1346/1346**、integration（26 pass + 9 已声明债务；sdk 1/1）、fork runner **90/90**、
selfcheck OK（101/3/7）、fork 门 exit 0、diff --check clean；**live exit 0，两例 55/55**。
本轮关闭：回复前 focus token（`isFocusedOperationCurrent(completionFocus)`）重检、隔离 Node 进程的
lazy-import 兼容性测试（缺 subpath → extension 不崩、首次审计 fail closed、child=0）、真实生命周期接缝
（focus/pause 与 session_shutdown 撤销后旧 ask 不答复、新 audit 可独立登记），以及把负向 live 断言从
pane 文本改为**工具结果内的协调记录**（要求 `deliveryStatus: failed`）。

## 第二十三轮整改后最终有序复跑

证据 `evidence/8.35-final-run.txt`。gate：goal-x typecheck 0 error、unit **1348/1348**、
integration（26 pass + 9 已声明债务；sdk 1/1）、fork runner **90/90**、fork gate exit 0（555/7、989/10、
undeclared 0）、diff --check clean；**live exit 0，两例 56 项断言**。本轮关闭：① 真实在途 ask +
真实 GoalCore 暂停接缝 + **迟到合法答复不得送达**，并以“健康 attempt 能正常 reply”作正对照；
② live 负向断言改为 `failed + 非空 unresolvedReason + 非空 question` 的具名谓词，并在驱动内自带
负对照（弱形状必须被拒绝），pane 兜底已移除。

## 第二十五轮整改后最终有序复跑

证据 `evidence/8.37-final-run.txt`。gate：goal-x typecheck 0 error、unit **1349/1349**、
fork runner **90/90**、fork gate exit 0、diff --check clean；**live exit 0，两例 57 项断言**。
本轮关闭：① live 负向断言的 attempt 身份改为从 `update`/`response` 行取非空 `runId`，并新增
“identity 已从 trace 推导”断言（缺失即失败）；记录遍历限定为本次 `update_goal` 的 `toolCallId`；
② 新增**真实 `session_shutdown` handler**（按其真实 `(event, ctx)` 签名调用）下的在途 ask 测试，
迟到合法 submit 被丢弃；老的 helper 型用例补上 `getAuditDeadlineAt`，其对照不再是 deadline_missing。
**仍未覆盖**（如实记录，不声称 4.2 全量完成）：focus 切走再切回、reload handler 的在途测试。

## 第二十六轮:成功标准 6(生命周期在途覆盖)全部满足

新增 `tests/goal-audit-lifecycle-inflight.test.ts`(7 例、4.7 s 全绿),每条都用**真实在途 ask**
(deferred sessionFactory 挂住 prompt)+ 真实接缝 + **迟到但合法**的 submit,断言答复不被送达且无
`delivered` 记录:focus 切走再切回、同 ID 移除(archived)、session_start、session_tree、
session_shutdown、reload(tree+start),外加“未被撤销的另一个 goal 仍能正常 reply”的隔离对照。
`tasks.md` 的 4.2 据此重新勾选;证据 `evidence/8.39-lifecycle-inflight.txt`。
gate:typecheck 0 error、unit **1356/1356**、selfcheck OK(102)、fork runner 90/90、integration
(26 pass + 9 已声明债务;sdk 1/1)、fork 门 exit 0、strict validate、diff clean;**live exit 0,57 项断言**。

## 第二十七轮:成功标准 6 补齐「真实取消链 + 隔离 + 幂等清理」

- 新增 `tests/goal-audit-lifecycle-cancel-chain.test.ts`:驱动**真实** `runGoalCompletionAuditor`,
  经生产回调(`cancelAttempt("lifecycle_revoked")`)发出**恰好一次**精确 cancel,断言 identity
  (requestId/ownerRunId/nodeId)与原请求一致;**迟到且 schema 合法的 approved 响应不授权完成**
  (结果 cancelled/disapproved),且终态不再发第二次 cancel;重复撤销为 no-op。
- `tests/goal-audit-lifecycle-inflight.test.ts` 扩到 8 例:六类接缝(focus 往返、同 ID 移除、
  session_start/tree/shutdown、reload)均用**在途** ask + 迟到合法答复被拒;新增**并行隔离 + 幂等清理**
  用例(两 goal 同时 in-flight,仅撤销其一,另一个仍 reply;重复 release/dispose 不抛错、不重复记账)。
- `tasks.md` 4.2 据此重新勾选;证据 `evidence/8.41-lifecycle-full-chain.txt`。
- gate:typecheck 0 error、unit **1358/1358**、fork runner 90/90、fork 门 exit 0、diff clean、
  integration(26 pass + 9 已声明债务;sdk 1/1);**live exit 0,57 项断言**。

## 第二十八轮:成功标准 6 的「每条接缝一条组合测试」

新增 `tests/goal-audit-lifecycle-full-chain.test.ts`(6 例,对应六类接缝,3.3 s 全绿)。每条用例在**同一次运行**内完成:
真实接缝 → 三条**在途** ask(受害 attempt、同 session 的另一个 goal、另一个 session)→
**恰好一次**精确 cancel 且 `requestId/ownerRunId/nodeId` 与原 delegation request 一致 →
迟到合法答复被丢弃 → **迟到 approved 不授权**且无第二次 cancel →
作用域断言(goal 级撤销不波及兄弟 goal;session 级撤销覆盖兄弟 goal,但**另一个 session 永不受影响**)→
重复 `releaseLifecycle`/`dispose` 幂等。取消由**生产** `cancelAttempt("lifecycle_revoked")` 触发。
`tasks.md` 4.2 据此勾选;证据 `evidence/8.42-lifecycle-full-chain-per-seam.txt`。
gate:typecheck 0 error、unit **1364/1364**、fork 90/90、fork 门 exit 0、diff clean、integration
(26 pass + 9 已声明债务;sdk 1/1);**live exit 0,57 项断言**。

## 第二十九轮:标准 6 的 ask 真正落在**原 attempt**内

新增生产侧**测试注入 seam**(`GoalCompletionAuditorArgs.auditSidechannelSessionFactory`,仅注入
session factory,不改变模型可见 schema),使测试能挂住**同一个 attempt** 的 prompt。
`tests/goal-audit-lifecycle-full-chain.test.ts`(6 例 = 六类接缝,6.1 s 全绿)每条都:
三条真实审计(受害 g1/session-1、兄弟 g2/session-1、异物 g1/session-2)各自通过
`bus.registration.respond(ask)` 发起**在途** ask → 触发真实接缝 → 断言:恰好一次 cancel 且
requestId/ownerRunId/nodeId 与原 request 一致;同一 attempt 的**迟到合法答复不被送达**且监听只释放一次
(subscribe 1/unsubscribe 1);作用域(goal 级不波及兄弟、session 级覆盖兄弟、**另一 session 永不受影响**);
**迟到 approved 不授权**且无第二次 cancel;session **abort 1 / dispose 1**(真实计数,非空实现)。
`tasks.md` 4.2 据此勾选;证据 `evidence/8.43-lifecycle-same-attempt.txt`。
gate:typecheck 0 error、unit **1364/1364**、fork 90/90、fork 门 exit 0、diff clean、integration
(26 pass + 9 已声明债务;sdk 1/1);**live exit 0,57 项断言**。

## 第三十轮:迟到答复/批准进入**撤销窗口内**

修复审计复现的两处时序空洞:① mock 的 `abort()` 不再释放 prompt gate,ask 在接缝触发时**仍在运行**;
测试改为等待显式 **prompt-entered barrier** → 触发接缝 → **在 prompt 仍被挂住时**提交迟到的合法答复 →
再放行。② 迟到的 schema 合法 approved 响应改为在接缝触发后**立即**发出(仍处于 50ms 取消确认窗口、
attempt 尚未终结),而不是等 handler 返回后再发。
`tests/goal-audit-lifecycle-full-chain.test.ts`(6 类接缝,3.8 s 全绿)每条同时断言:原 attempt 内的在途 ask、
恰好一次精确 cancel(identity 一致)、窗口内迟到答复不被送达且监听只释放一次、窗口内迟到 approval 不授权
且无第二次 cancel、作用域(focus/移除不波及兄弟;session 级覆盖兄弟;另一 session 永不受影响)、
abort 1 / dispose 1(等待后断言)。
`tasks.md` 4.2 据此勾选;证据 `evidence/8.44-lifecycle-in-window.txt`。
gate:typecheck 0 error、unit **1364/1364**、fork 90/90、fork 门 exit 0、diff clean、integration
(26 pass + 9 已声明债务;sdk 1/1);**live exit 0,57 项断言**。

## 第三十一轮:迟到 approval 进入**确定性窗口**(不再靠 50ms 计时)

此前测试在 await 完整个 session handler(实测 260–444 ms)后才发 approval,而 `cancellationMs` 只有 50 ms,
取消计时器早已锁定终态,断言因此无意义。修复:

- `cancellationMs` 放宽到 **5000 ms**,取消确认窗口不可能在测试期间关闭;
- 接缝**不 await 启动**(handler 尾部并发执行),测试改用硬 barrier 等"取消已发出"
  (`waitFor(cancels.length === 1)`);
- 在该点断言 attempt **仍未结算**(由 `victim.pending.then` 翻转的 settled 标志),然后才
  ①在 prompt 仍被挂住时提交迟到合法答复、②发出迟到 schema 合法 approval,最后才 await handler 尾部。
  `tests/goal-audit-lifecycle-full-chain.test.ts`(6 类接缝,2.6 s 全绿)每条都断言:原 attempt 内在途 ask、
  恰好一次精确 cancel(identity 一致)、窗口内迟到答复不送达、窗口内迟到 approval 不授权且无第二次 cancel、
  作用域(goal 级不波及兄弟;session 级覆盖兄弟;另一 session 永不受影响)、abort 1 / dispose 1。
  `tasks.md` 4.2 据此勾选;证据 `evidence/8.45-lifecycle-approval-barrier.txt`。
  gate:typecheck 0 error、unit **1364/1364**、fork 90/90、fork 门 exit 0、diff clean、integration
  (26 pass + 9 已声明债务;sdk 1/1);**live exit 0,57 项断言**。
