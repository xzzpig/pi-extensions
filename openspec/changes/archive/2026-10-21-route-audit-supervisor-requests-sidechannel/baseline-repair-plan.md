# 8.1 基线修复草案：有限的测试宿主身份隔离复验

状态：**独立复审 OKAY，待用户批准；不是执行授权**。当前 goal 保持 17/20，8.1 未勾选，8.2/8.3 未启动。本草案不修改不可变 objective、20 项任务树、原断言或历史失败的接受条件。

## 1. 动机与已验证事实

本草案只处理 `design.md::D8` 测试由原生 subagent worker 启动时可能继承执行方身份的问题，不扩大完成审计旁路能力。原验收要求仍以 `tasks.md::8.1` 为准。

- 原全套日志、退出态和逐项归属保存在 `/tmp/t81/SUMMARY.md`、`SUMMARY-v2.md`、`SUMMARY-v3.md`。四个 full suite 均 exit 1；focused 48/48、251/251、无 stub SDK 8/8、两包 typecheck 和 selfcheck 已通过，但不替代 full suite。
- Goal unit 当前 1449 tests / 1187 pass / 262 fail；纯 HEAD 源投影为 1263 / 1000 / 263。没有当前独有失败名，唯一 HEAD 独有 D-11 已由获批 fixture 修复。**262 项仍没有现有 knownDebt 覆盖**，不能因 HEAD 同样失败就豁免。
- Goal integration 的 34 个失败中仅九项精确符合既有 settings/profile debt，另外 25 项未被覆盖。子代理 unit 有七项未被覆盖的症状和两个未精确归属的取消；integration 当前 35 fail、HEAD 36 fail，19 共同、16 当前独有、17 HEAD 独有。16 项在两侧窄跑各 16/16 通过，不证明原并发 full 无回归。
- `/tmp/t81/C1-witness.md` 记录现场当前 shell 的 `PI_SUBAGENT_CHILD=1`、DEPTH 未设置。两个标记在所有见证命令前后不变；只在测试子命令局部清除，不是修改 worker 或全局环境。
- Goal 两文件见证：继承标记时 9 tests / 7 pass / 2 fail；只清 CHILD/DEPTH 后 9/9 pass。`goal-session-safety.test.ts` 显式设置 child 的安全断言两侧均通过。
- 子代理三文件见证：context trust 从 3 fail 变 5/5 pass，parent-wake 从 7 pass / 4 cancelled 变 11/11 pass，session-liveness 从 2 fail 变 4/4 pass。这里取消四项是本次单文件聚合结果，**不等于原 full 的两个取消已经归属**。
- 此结果只确认见证文件的可证伪因果链，不承诺全部 262、25 或 35 项会消失；过去 full 命令的完整身份快照未记录，不能倒推每个旧进程的现场值。
- HEAD 投影 `/tmp/t81/base` 是两包纯 HEAD 源码，依赖链接到 live install，不是历史依赖快照；保留这一比较限制。

## 2. 精确机制与不改的边界

`packages/pi-goal-x/extensions/goal.ts::goalExtension` 在 `isDelegatedGoalSession()` 为真时仅注册 context filter 后返回，不安装 core、tools、commands、session handlers。`goal-session-safety.ts::isDelegatedGoalSession` 检查 CHILD 等于 `1` 或有限正数 DEPTH。相关失败大多在读取未注册 handler/core 时发生。

`packages/pi-subagents/src/extension/index.ts::registerSubagentExtension` 也具有真实 child 的 early return。包脚本已有八个 PI 环境变量清理，但没有清 CHILD/DEPTH。生产 guard 是正确安全边界，**不可为测试修改或绕过它**。

只读 gap analysis 的 C2 指出两个 shared fake pi 缺少 `sendMessage`，但仅能解释两侧各 33 条诊断，没有对应失败 leaf 的因果见证；本阶段不修这个 fixture。C3 的启动等待、终态发布、严格 deadline/status/elapsed 断言、Git fsmonitor 前置，以及取消身份未明，均不在本阶段修复范围。

## 3. 决策：优先零源码改动，拒绝预先扩大补丁

使用已有 `env -u`，仅在每个待执行验证命令的子进程内删除两个继承标记：

```bash
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH <原程序及原参数>
```

这里不是要求 shell 直接解释占位符；下节给出完整命令。`direnv` 后应用清理，避免 shell hook 再引入身份。保持 repository root cwd、现有 Node/依赖、原 package script、loader/preload、测试发现集、默认并发和测试 timeout。父 worker 的两个标记必须前后相同，不调用 `unset`、`export` 或修改用户设置。

不改任何 source/test/helper/fixture/adapter/runner/package/manifest/metadata；不新增 wrapper 文件、生产开关或依赖。`fork-test-runner.test.ts` 的 adapter spawn `options.env === undefined` 及原 argv 断言原样保留：环境在调用整个验证命令之前局部隔离，不改 helper 的 spawn options。显式 child 测试自行设置的标记仍生效；不在每个 child launch 或 SDK session 中再次强制清理。

备选方案与取舍：

1. 在 preload 增加 helper：能持久化测试入口行为，但增加源码分歧，还可能擦除测试刻意设置的真实 child 身份。当前已有命令局部隔离足以形成更小的候选，先不做。
2. 给所有 harness 补注册 API 或逐文件改 setup：早于确认 guard 的失败边界，会把一个启动身份问题扩张到大量测试，拒绝。
3. 改生产 guard、恢复旧工具 profile/flat settings、放松断言、加 timeout、串行替代 full 或追加 debt：违反既有行为/验收合同，禁止。

**这是一轮有限复验，不是声称已完成全量基线修复的计划。** 若后续暴露 owner ack/trust fixture 或真实生产缺陷，先保留新的失败见证，再提出有精确文件范围的独立修订并复审；本次批准不授权这些修改。

## 4. 待批准后的执行顺序

只由 `opsx-worker` 执行；默认 writer 仍为 `axonhub/deepseek-v4-flash`。父代理不编辑源码。若再次出现模型只输出 DSML 而未调用工具，应上报，不自动换模型。

### A1：前半段原 D8 验证

在 repository root 执行下列完整命令，各自保存完整 stdout/stderr、真实 exit code、耗时和汇总。不得用 grep/head 管道代替原输出；日志统一追加到 `/tmp/t81/host-root-recheck/`，原 01–25 和 SUMMARY 文件不覆盖。

```bash
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH pnpm --filter @xzzpig/pi-subagents run typecheck
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH pnpm --filter @xzzpig/pi-goal-x run typecheck
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH node --experimental-strip-types --import ./packages/pi-subagents/test/support/register-loader.mjs --import ./packages/pi-subagents/test/support/fork-test-environment.mjs --test ./packages/pi-subagents/test/unit/fork-supervisor-routing.test.ts ./packages/pi-subagents/test/integration/fork-supervisor-routing.test.ts
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH node --import 'data:text/javascript,import {after} from "node:test";const h=setInterval(()=>{},1000);after(()=>clearInterval(h));' --import ./packages/pi-goal-x/scripts/test-adapter-hooks.mjs --experimental-strip-types --test ./packages/pi-goal-x/tests/goal-audit-context-snapshot.test.ts ./packages/pi-goal-x/tests/goal-audit-sidechannel.test.ts ./packages/pi-goal-x/tests/goal-audit-supervisor-flow.test.ts ./packages/pi-goal-x/tests/goal-auditor.test.ts ./packages/pi-goal-x/tests/goal-auditor-package.test.ts ./packages/pi-goal-x/tests/goal-auditor-agent-resolver.test.ts ./packages/pi-goal-x/tests/fork-test-runner.test.ts
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH -u NODE_OPTIONS node --experimental-strip-types --test ./packages/pi-goal-x/tests/integration/goal-audit-sidechannel-sdk.test.ts
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH node ./packages/pi-goal-x/scripts/run-unit-tests.mjs --selfcheck
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH pnpm --filter @xzzpig/pi-subagents run test:unit
```

无 stub 的 SDK 命令继续清除该命令的 `NODE_OPTIONS`，不修改父环境；其余命令仍用原 preload 分层。已有 48/251/8 是对照数字，不是对下一轮结果的预测或必须凑出的计数。

### A2：后半段原 full suite 与归属收口

A1 结果落盘后才执行 A2；可复用同一 session 的有界交班，不重跑已完成命令。两批都使用相同的命令局部身份隔离，按下面顺序各执行一次：

```bash
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH pnpm --filter @xzzpig/pi-subagents run test:integration
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH pnpm --filter @xzzpig/pi-goal-x run test:unit
direnv exec . env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH pnpm --filter @xzzpig/pi-goal-x run test:integration
```

即使前一个 suite exit 非零，也要收集余下已经批准的独立 suite 结果，不能跳过红组；若运行环境本身不再安全或发生不可恢复的启动错误，则明确报告哪条未运行，不记通过。不得自动重试 full、修改其并发/timeout，或为了报告绿色无限重跑。30 分钟 worker 上限是交班原因，不是测试通过；按原 session 恢复未完成的命令，不能同一条在后台仍活时重复启动。

随后读取已有 `subtrees/*.json::knownDebt`，逐 leaf 输出：原失败、本轮结果、原 debt 精确 reason 是否覆盖、残余 unknown。至少区分 Goal 262/25、原九项 settings/profile、子代理七项 unit、原两个取消、integration 19 共同/16 当前独有和17 HEAD独有；名字差集不当作源码因果证明。原两个取消若本轮消失，只能记本轮无取消，不替历史进程补造身份。若仍有未归属取消或未覆盖失败，**停止在8.1 RED，报告下一调查/修订需求，不勾选、不扩域修复**。

## 5. 可执行接受标准与证据边界

本草案执行完成的接受标准（不是8.1通过标准）：

1. A1/A2 十条原验证命令都有真实 exit/日志；对未运行项明确说明。测试子命令初始 CHILD/DEPTH 未设置，原 worker 两值前后不变。只记录这两个非凭据字段，不枚举 auth 或其余环境。
2. 原并发脚本、assert、timeout、discovery、SDK pin、原真实 child guard 全部不变。显式 child 安全场景仍由现有测试设置自己的 marker；C1 见证 9/9 只作已有机制证据，不冒充整套覆盖。
3. 新增/受影响断言必须 pass、零 skip/cancel；原 full 非零仍只能按已有精确 debt 加不相关基线接受。旧九项 profile 不恢复、旧 flat 配置不恢复、不增加 knownDebt。若不满足，8.1 仍 RED。
4. repo 源码、测试、scripts、manifest、metadata、版本、锁文件和现有已批准 dirty 内容前后逐文件 hash/status 不变；无 staged、HEAD 不变、`git diff --check` exit 0。规划文件和计划工具 ledger 的父方编辑单独列账，不谎称原 openspec hash完全未变。临时日志/测试自有临时目录不计源码修改；不能清理其他会话或真实 goal/config/auth。
5. `report_work` 使用真实结构化对象、`changedFiles=[]`，未满足8.1时 `verificationPassed=false`，不得因本阶段动作已跑完就标验收成功。父方复核真实日志和未变 diff 后才决定是否满足原8.1合同。
6. 本阶段不执行8.2的最终证据文件或8.3 live/provider/auth/tmux；不把本草案当成这些步骤已经通过。只有8.1实际满足原合同才可按原序推进。

## 6. 风险、剩余范围与回滚

- 身份隔离后可能露出被 early-return 遮蔽的 ack/trust/profile 或真实行为问题：不承诺全部 GREEN；新的精确失败成为下一份范围修订的输入，不自动修。
- full-only spawn/timing 并未因两侧 solo 通过被解释：原35失败及两个取消仍按证据单列。本草案不改并发、Git配置、process/wait策略或 sendMessage fixture。
- 该命令局部隔离只解决本轮测试宿主身份，不持久改变未来任意 caller 的环境；是否需要持久测试入口改动属于后续明确决定，不在这次授权内。
- 回滚无需恢复源码：停止使用两项 `env -u`，保留隔离前后两套日志，worker原环境一直未修改。不删除原红证据或当前已验收功能。

## 7. 规划/审批记录

用户已授权“先规划最小基线修复并复审”，没有授权实施。只读 gap run `3fc4c07a-fb11-41f0-b2a6-9543aa9026be` 的 C1/C1b、C2、C3、U1–U3 已在上文明确处置：只用现有命令局部隔离处理已见证部分；C2/C3及未归属取消留为非授权范围，禁止编造修复。C1见证 run `8801d17b-9a8d-4b3b-a30e-5aa565c307ae` 未写源码。

独立计划复审：fresh-context `opsx-plan-review` run `947431ce-a9e9-485f-993c-c785497a248b` 已提交 `report_plan_review`，verdict **OKAY**、`issues=[]`。实际结构化报告位于 `/tmp/pi-subagents-uid-1000/async-subagent-runs/947431ce-a9e9-485f-993c-c785497a248b/output-0.log`，父方另从该run的session JSONL读取工具实参核对。复审静态核验原十条程序/argv、命令局部隔离与父环境不变、显式child场景、SDK无stub、范围/停止条件及已有A/B日志；未运行测试、修改文件或读取真实auth。未发现 Valid blocker 或需修订的 Valid non-blocker。C2/C3与原两个取消仍未关闭，不能宣称整个8.1通过。

用户执行决定：待批准。复审通过只代表此有限方案可执行，不代表四个 full 已通过，也不替代用户批准。
