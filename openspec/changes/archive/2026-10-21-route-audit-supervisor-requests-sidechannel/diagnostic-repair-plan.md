# 3.2 异常诊断安全最小修复计划

状态：独立静态复审 OKAY，issues=[]；用户已通过批准对话批准，随后已发出 agent 模式实施启动事件。源码实施仍仅由限定范围的 opsx-worker 执行。

## 背景与当前状态

新目标 `mv7u2wdg-f57vte` 为 6/20，当前 3.2 未验收。旧目标保持暂停且不操作；tasks.md 中 17 个历史勾选不等于新目标验收。20 项任务、顺序、不可变 objective 和最终 audit APPROVE 要求均不改变；本补充不提前执行 8.1、8.2、8.3。

父方已运行无源码写入、无真实凭据/网络的反例：向 sessionFactory 和 ctx.model getter 注入带合成 Authorization/Bearer、raw config apiKey 的 Error，分别得到 `session_error` / `config_error`，两者的 message 均保留合成标记。标识为 `PARENT_TASK32_BOUNDED_DIAGNOSTIC_AUTH_ECHO_COUNTEREXAMPLE_CONFIRMED_NO_REAL_CREDENTIALS`。这是已确认的生产边界缺陷，不是环境失败；未证明真实凭据曾泄漏。

基线为本新目标实际安装后的工作区：Goal-X D8 七文件 251/251、其中 sidechannel 61、snapshot 19；两个包 typecheck 已实跑通过，子代理 focused 48/48。Goal-X 新日志在 `/tmp/new-goal-mv7u2wdg-task31/保存真实日志/`；子代理日志在 `/tmp/new-goal-mv7u2wdg-task21/`。这些绿灯未覆盖内容级保密，不能替代下面的 RED/GREEN。

实施重建说明：先前6/20是原目标的历史核验状态。此次实施启动时API确认当前会话无目标，故按用户给定模板创建 `mve1hwcb-2izysu` 并确认20项任务；本目标从0/20按序建立证据，不操作旧未聚焦目标，不重写既有源码，也不将tasks.md历史勾选直接算作新目标完成。1.1先建立当前安装与inventory基线，诊断修复仍在3.2的两文件范围内执行。

## 根因及差距处置

- `goal-audit-sidechannel.ts:598–602::describeError` 读取 Error.message 或返回字符串异常；`sideError/boundedMessage` 只截断，不保证内容安全。调用点在序列化、父约束捕获、runtime 借用、工厂、prompt/idle、deadline getter、队列失败中。
- `captureSidechannelInputs` 还在约第 825 行直接转发 `captureCompletedAuditContext` 的 diagnostic；3.1 helper 的外部异常正文因此能进入旁路。只修 describeError 不足够。
- `goal-auditor-delegation.ts:538` 将 result.error.message 原样转发到监督失败链；源头不复制正文，才能使既有消费者无需新增清洗逻辑。
- 现有 unit 约第 709 行要求返回 `no API key for mock provider`，第 876 行要求返回 `Real agent sessions are disabled`。这两个正文依赖与安全模板不能同时满足，必须在审批中明确替换其正文断言，不能暗改或删除失败分类/创建证明。

## 实施范围（仅批准后）

仅允许 opsx-worker 修改两个已经存在、承载自有逻辑的 fork-only 文件：

1. `packages/pi-goal-x/extensions/goal-audit-sidechannel.ts`。
2. `packages/pi-goal-x/tests/goal-audit-sidechannel.test.ts`。

禁止改 SDK、stub、adapter、snapshot helper/测试、flow/真实SDK测试、pi-subagents、上游调用点、goal state/events/ledger/model-view、README、包 manifest、metadata、版本、依赖、锁文件或全局配置。若两文件不能实现本计划，先报告并修订复审，不扩大写域。

## 决策

### P1. 固定阶段文本，不检查或复制异常属性

移除原 describeError 的正文提取；使用不接收异常参数的 `omittedExternalErrorDetails()` 返回固定 `error details omitted`。现有 catch 的阶段前缀保留，不读取或字符串化 thrown value 的 message/name/stack/cause/toString，不用正则识别、截断或哈希秘密，也不把原异常移到 details、record、console 或 ledger。

保留所有现有错误 code 和原分类：config_error、context_error、context_capacity_exceeded、session_error、invalid_ask、deadline_missing 等不变。无 model/runtime 的固定可操作提示、合法容量的数字信息、无有效 submit 的固定提示、校验错误均保持；不新增 error 字段、公开 schema、设置或分支。SDK 工厂异常例如返回 `The audit supervisor side session could not be created: error details omitted`。

snapshot 的 context_error 在旁路边界转为固定 `The parent audit context could not be captured; error details omitted.`；context_capacity_exceeded 使用固定阶段/限制提示，可从既有 helper 导入 `AUDIT_CONTEXT_MAX_BYTES` 格式化内部限制，不能解析或插入原 diagnostic。3.1 helper 的独立 API、原诊断和既有断言不改。

### P2. 仅两个旧正文断言作显式语义适配

工厂拒绝用例继续断言 session_error、factory 调用恰一次、无 fallback，并改断言固定创建阶段提示且不含原 `no API key for mock provider` 文本。

默认工厂 unit 改名，准确表达“bundled 默认工厂返回安全创建失败，SDK stub 仍拒绝真实会话”。保留 session_error/失败结果/正常清理，增加固定阶段及不回显原异常的断言；可以在该 unit 通过原 SDK export 直接 assert.rejects 证明当前 bundled stub 仍拒绝 session，但不能将这个直接调用声称为默认工厂创建证明。

默认工厂实际创建/执行的证明继续且必须来自**既有、源码不改的无 stub 真实 SDK 文件**，其完整 8 例必须执行通过，尤其默认工厂实际 native-provider 调用、read、五工具、runtime-only key、父 runtime 不 dispose、seed 和真实 update_goal 闭环断言。禁止用直接调用 stub、读取源码字符串或 mock sessionFactory 代替这条证明。除此两处正文依赖外，现有 61 个 unit 用例及所有有效断言保持，不能减弱分类/次数/失败状态/只读/容量/时序断言。

### P3. 内容级 RED/GREEN，覆盖所有外部异常入口

在原 unit 文件追加一个带 Node 测试超时的表驱动组，各行独立 t.test，至少逐项覆盖以下 11 个入口，不能只让第一行失败后跳过其余行：

| 入口                                                               | 保持的错误分类   |
| ------------------------------------------------------------------ | ---------------- |
| 父 model/约束 getter 抛错                                          | config_error     |
| 已捕获 registry 的 runtime getter 抛错                             | config_error     |
| SDK snapshot 的 getEntries 抛错并经 3.1 diagnostic 转发            | context_error    |
| snapshot 的 getSystemPrompt 抛错并转发                             | context_error    |
| sessionFactory reject                                              | session_error    |
| session.prompt reject                                              | session_error    |
| waitForIdle reject                                                 | session_error    |
| getAuditDeadlineAt 抛错                                            | deadline_missing |
| ask payload JSON 序列化抛错                                        | invalid_ask      |
| reference JSON 序列化抛错（opaque interview 的第二次 toJSON 调用） | invalid_ask      |
| verifyLive 抛错，由原 queue catch 收口                             | session_error    |

用合成 Error/字符串异常包含短凭据标记、配置标记、200000 字符 payload、嵌套 cause；至少一个 getter 型异常属性观测器断言原异常属性未读取。仅日志安全计数/阶段/code，不打印模拟 payload 或真实凭据。错误渲染必须非空、至多 1024 字符；检查返回 result、listAsks、coordinationRecords、seal 后 frozenRecords 和受观察 console 中**均无**合成标记、Bearer、raw config、payload 前缀，而非只验证长度。存在 record 时断言 failed、无 answer；未开始模型的入口断言零 factory/prompt；调用后 seal/close 的 timer 为零、cleanup 幂等、父 runtime 不被 dispose。问题文本本身不含这些标记，避免把合法参考问答当作异常泄漏。

另保留无 ask 零 factory/无错误暴露，以及错误后迟到提交不转成成功；不得改变 first-cause、终态优先级、SDK-free seal、park/取消链、deadline/容量、usage 去重和借用父 runtime 的所有权。

新增 oracle 先在当前实现下真实 RED；保留 RED 日志、再改生产实现得 GREEN，不能用新模板迁就实现或把旧 251 绿灯当保密证明。

## 实施与验收顺序（不是新增 goal task）

批准前只写本 change 的规划文件并静态复审。批准后唯一 writer 按 3.2 的修复子阶段依次：保存前状态与文件 hash；先新增负向 oracle 运行 RED；修改生产边界和上述两个必要旧正文断言后运行 GREEN；运行下面回归；父方审查完整两文件 diff 和实际日志、重复无源码写安全探针后才决定 3.2。任务数量/顺序不变，不勾选后续项。

所有日志放 `/tmp/new-goal-mv7u2wdg-diagnostic-repair/`，按 RED/GREEN/final 命名、不覆盖旧日志，保留 stdout/stderr/真实 exit、逐入口名字与结果。预期 RED 非零只证明缺陷；所有 GREEN 新/受影响 case 必须零 fail/cancelled/skipped。不要预测新总数：逐行核对 11 个入口和原 61 case 的保留情况，并给真实新计数。

精确验证命令（仓库根、direnv）：

```bash
# RED 与 GREEN 各执行一次；原 adapter/keepalive 不变
 direnv exec . node --import 'data:text/javascript,import {after} from "node:test";const h=setInterval(()=>{},1000);after(()=>clearInterval(h));' --import ./packages/pi-goal-x/scripts/test-adapter-hooks.mjs --experimental-strip-types --test ./packages/pi-goal-x/tests/goal-audit-sidechannel.test.ts
# 最终完整七文件 focused
 direnv exec . node --import 'data:text/javascript,import {after} from "node:test";const h=setInterval(()=>{},1000);after(()=>clearInterval(h));' --import ./packages/pi-goal-x/scripts/test-adapter-hooks.mjs --experimental-strip-types --test ./packages/pi-goal-x/tests/goal-audit-context-snapshot.test.ts ./packages/pi-goal-x/tests/goal-audit-sidechannel.test.ts ./packages/pi-goal-x/tests/goal-audit-supervisor-flow.test.ts ./packages/pi-goal-x/tests/goal-auditor.test.ts ./packages/pi-goal-x/tests/goal-auditor-package.test.ts ./packages/pi-goal-x/tests/goal-auditor-agent-resolver.test.ts ./packages/pi-goal-x/tests/fork-test-runner.test.ts
# 默认工厂真实创建证明：不得加载 Goal-X adapter，清 NODE_OPTIONS 仅限此命令
 direnv exec . env -u NODE_OPTIONS node --experimental-strip-types --test ./packages/pi-goal-x/tests/integration/goal-audit-sidechannel-sdk.test.ts
 direnv exec . pnpm --filter @xzzpig/pi-goal-x run typecheck
 direnv exec . pnpm --filter @xzzpig/pi-subagents run typecheck
 direnv exec . bash .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh pi-goal-x
 direnv exec . bash .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh pi-subagents
 git diff --check
```

两包 audit 必须有 checked 非零/undeclared=0，参考基线 Goal-X `checked=555 noise=7 deleted=0 submodule=0 declared=7 undeclared=0 stale=0`，子代理 `989/9/0/0/9/0/0`；两自有 fork-only 文件不得新增债务。除明确两文件外与修复前 source/config hash 集相同、staged 空。完整 8.1 全套和最终 live 8.3 仍必跑但不在本次修复子阶段提前执行；不因本计划豁免原 full-suite RED。

## 非目标、风险、回滚

本计划只隔离旁路模块生成的外部异常诊断，不做通用 DLP，不改合法问题/答案、原审计报告或 native 原有日志，不改变任何权限；真实认证、网络、模型调用禁止用于本计划本地验证。固定文本牺牲第三方异常细节，保留 code/阶段/内部限制定位；不得把丢弃细节重新写到别处补偿。

回滚仅撤销批准后两个文件的诊断补丁及对应新增测试，保留其余现有变更；不得 reset 工作区或恢复泄漏后宣称交付完成。若真实 SDK gate 或任何原有效断言失败，保留日志并报告，不扩域修 SDK、增加 debt、skip 或 timeout。

## 审查与批准

fresh-context `opsx-plan-review` 已完成静态独立复审，实际 `report_plan_review` 返回 OKAY、issues=[]，工具确认 `Plan review recorded: verdict OKAY (0 issues, 0 blocking)`。首轮 `b5cd75aa-4e62-4e4c-b6a3-61445db8b58a` 因 1800000 ms 硬超时未产出 verdict；同一会话续跑 `e47491fc-c29b-4c71-ac4c-3cedd9b2f672` 完成，未换模型、未重做已完成阅读。父方已从保存的 session.jsonl 提取真实 toolCall arguments 和 toolResult 交叉核对，不仅采用最终文本声明。

证据：`/tmp/pi-subagents-uid-1000/async-subagent-runs/e47491fc-c29b-4c71-ac4c-3cedd9b2f672/output-0.log`；会话 `/home/xzzpig/.pi/agent/sessions/--home-xzzpig-.herdr-worktrees-pi-extensions-goal-x--/2026-10-10T13-31-03-089Z_01a12602-8a2c-7704-8924-a87d87b9b0ae/d4572cab-a813-4cb5-8e70-4e337d518068/run-0/session.jsonl`。

结论范围：两文件边界可执行，snapshot转发、11入口oracle、两处正文断言适配与独立无stub SDK八例要求一致；没有执行blocker。reviewer未写文件、未运行命令或测试、未操作goal。静态OKAY只是可执行性证据，不是用户批准、修复通过或3.2验收；原full/live gate保留。新目标仍6/20，旧目标及其绑定流程不操作，按用户决定忽略旧流程告警。上述静态复审之后，opsx_plan_verdict返回已获用户批准；其要求另行启动实施的门禁现已由新的 `[OPSX IMPLEMENT START change=route-audit-supervisor-requests-sidechannel mode=agent]` 满足。新目标按序执行，仅opsx-worker可写源码，诊断补丁实施前仍不得声称已修复。
