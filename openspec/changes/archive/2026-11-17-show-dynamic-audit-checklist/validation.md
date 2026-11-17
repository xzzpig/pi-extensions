# 实施与验证记录

## 最终范围

完成实际清单快照、提示词共享、逐项进度协议、动态模型/紧凑汇总/展开与滚动、同 attempt 挂起继续、终态冻结及真实报告结果卡。逐项状态不参与完成 gate，目标工具及 verdict schema、账本版本、主模型自动提示保持不变。没有修改 pi-subagents 源码、升级版本、提交、推送、发布或归档 OpenSpec change。

业务逻辑在 fork-only 模块中；上游文件保留类型/调用/共享 box 导出接缝。新增文档已列入 package files，新增四个单测入口已列入测试清单及 fork runner，真实模型入口为显式 `.mjs`，不参与自动发现。见 `scenario-trace.md` 的 43 个增量场景及 38 个 D/I 条目追踪。

## 最终验证结果

命令从仓库根目录经 direnv/Nix 执行，包内命令先进入 `packages/pi-goal-x`。

| 验证                                                                              | 实际结果                                                                                 | 原始记录                                                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @xzzpig/pi-goal-x run typecheck`                                   | 退出 0                                                                                   | `/tmp/dynamic-checklist-final-types.log`                                                                 |
| `node scripts/run-unit-tests.mjs all` 的 unit 组                                  | 1691/1691 通过，0 取消/跳过                                                              | `/tmp/dynamic-checklist-final-tests.log`                                                                 |
| 同一命令的真实 SDK 组（不加载 stub adapter）                                      | 10/10 通过                                                                               | 同上                                                                                                     |
| 同一命令的回归 e2e 组                                                             | 39/39 通过，0 取消/跳过；此组不替代真实模型 E2E                                          | 同上                                                                                                     |
| 同一命令的普通 integration 组                                                     | 26/35 通过，9 个既有失败，聚合退出码为 1，**不是全绿**                                   | 同上                                                                                                     |
| HEAD 独立快照的 `tests/integration/extension.test.ts`                             | 相同 9 个设置/工具配置失败，23/32 通过                                                   | `/tmp/dynamic-checklist-integration-baseline.log`；快照目录见 `/tmp/dynamic-checklist-baseline-root.txt` |
| `node scripts/fork-test-runner.mjs`                                               | 207/207 通过，17 套件，真实模型入口排除                                                  | `/tmp/dynamic-checklist-fork-tests.log`                                                                  |
| 完成事务、旧生命周期及变更清单定向回归                                            | 35/35 通过                                                                               | `/tmp/dynamic-checklist-completion.log`                                                                  |
| 修正旧五阶段断言后的生命周期/gate 定向回归                                        | 9/9 通过                                                                                 | `/tmp/dynamic-checklist-lifecycle.log`                                                                   |
| 新动态 UI 与原 widget/dashboard 套件                                              | 104/104 通过                                                                             | `/tmp/dynamic-checklist-legacy-ui.log`                                                                   |
| `node scripts/run-unit-tests.mjs --selfcheck`                                     | 131 unit + 4 integration + 12 e2e 条目匹配                                               | 已执行，退出 0                                                                                           |
| `node scripts/fork-test-runner.mjs --selfcheck`                                   | 17 个套件，排除 live 入口                                                                | 已执行，退出 0                                                                                           |
| `node scripts/check-fork-identity.mjs`                                            | 11 个包，0 失败                                                                          | 已执行，退出 0                                                                                           |
| `pnpm run audit:fork-divergence`                                                  | 全仓退出 0；Goal-X 为 checked=757、noise=7、deleted=1、declared=8、undeclared=0、stale=0 | `/tmp/dynamic-checklist-audit-all.log`                                                                   |
| 格式、`git diff --check`、OpenSpec 校验                                           | 退出 0；新 fork-only 文件显式绕过 prettierignore 检查，不格式化上游文件                  | 见收尾命令                                                                                               |
| `pnpm --filter @xzzpig/pi-goal-x pack --pack-destination /tmp/dynamic-audit-pack` | 退出 0；tarball 含新文档和所有生产 fork 模块，不含测试 fixture                           | `/tmp/dynamic-checklist-pack.log`                                                                        |

### 既有失败不伪报通过

9 项失败均位于既有设置菜单/旧工具配置集成测试：tasks-disabled three-core profile、disabled 开关菜单、编辑持久化、设置行列表、布尔行切换、provider/model 文本、thinking level、反复切换任务开关、环境覆盖配置重装。没有修改该集成测试或生产设置/配置逻辑来隐藏它们。

使用 `git archive HEAD packages/pi-goal-x` 构造独立临时源码快照，并链接同一份依赖，以其自身 adapter 运行原集成文件，得到相同 9 个失败；这些已有债务也已记录在 subtree 元数据中。修复本次新增的两类旧断言不匹配（五阶段展示及默认清单条件项新增 ID），未删除其他生命周期断言。最终聚合命令仍如实返回非零；本次相关单元、委派/完成事务、真实 SDK、回归 E2E 和真实模型验收均通过。

## 真实 Pi / 模型 / TUI

### 环境与方法

- 真实 Pi 1.5.2，用户现有 `axonhub/deepseek-v4-flash`，`pi auth check --provider axonhub` 返回 ready。
- `/tmp` 下既有持久 tmux 可连接；asciinema 3.2.1。
- Level 1：仅加载本地 subagents 和 Goal-X，隔离目录及 session dir，真实模型回复 PONG，退出 0。目录见 `/tmp/dynamic-checklist-smoke-root.txt`，输出为 `/tmp/dynamic-checklist-smoke.log`。
- Level 2：通过技能提供的 `pi-e2e-env.sh` 启动并全程录制，仅加载本地 subagents、Goal-X 和 fork-only 观察 fixture；没有 scripted provider、mock SDK、注入 verdict 或禁用 auditor。
- fixture 仅在专用 `/tmp/pi-e2e-dynamic-audit-*` 环境创建活动目标、证据文件和配置；观察原生事件。`audit_review_barrier` 是只读测试同步工具，只等待观察结束，不提交/更改状态或裁决。生产包不包含它。
- native thinking 快捷键只改变测试会话；核对实际 Pi SDK 的默认非持久化行为，并确认用户全局 settings 的 defaultThinkingLevel 仍为 max、mtime 早于测试。没有更改用户真实项目或配置，也没有复制/记录凭据。

### 首次运行：保留的失败证据

- 目录：`/tmp/pi-e2e-dynamic-audit-20261117-045109`
- 录制：`recordings/run-3c2ot8/session.cast`
- 动态清单、11 项真实上报、同 child 的 Escape/Continue、展开和 End 已显示，但观察屏障未及时释放，审计超时，没有真实 approved，目标保持 active。本次 **FAIL，不作为最终通过**。
- Pi 与 recorder 均正常退出 0，原始录制未覆盖；该录制已完整回放，play 退出 0。

### 自动化重跑：通过

- 可重跑命令：`direnv exec . node packages/pi-goal-x/tests/e2e/fork-dynamic-audit-live.mjs`
- 目录：`/tmp/pi-e2e-dynamic-audit-1794863064090`
- 录制：`recordings/run-gqdYnj/session.cast`
- 自动断言结果：`acceptance.json`；原生事件：`audit-trace.jsonl`；完整驱动输出：`/tmp/dynamic-checklist-real-live.log`。
- 11 个真实检查项均由实际 child 上报，UI 显示 11/11；实际读取 evidence.txt 的 marker 和十行内容，展示逐项依据。
- Escape 弹窗显示 Continue audit 默认项；选择后仍只有一个 request、一个 started、一个 response，0 cancel；父/子 session ID 不同。
- 展开后 End 到达 CHECK-10 和末尾依据；Home 回到开头；72×28 窄屏重排并滚动可达，恢复 130×42 后折叠正常。自动断言所有被检查的 dashboard 可见行宽不超过 72。
- 观察屏障释放后，原审计模型独立提交真实 `approved`；只有一个 audit_result，没有 audit_skipped，实际归档一个目标，父会话到达 idle。
- 额外直接解析临时目录中的原生 child session.jsonl：实际 read evidence.txt，22 次 report_auditor_progress，且仅一次 structured_output（原生工具以 arguments.value 承载 approved）。child transcript 路径及核验结果已写入 acceptance.json，不只信任 observer 摘要。
- Pi exit=0、recorder exit=0；asciicast v2，2768 个事件，输出事件存在。

### 录制定位与回放

`steps.tsv` 时间仅作近似索引，不用于严格延迟断言：

| 自动化步骤 | steps.tsv 近似秒 | 观察                                  |
| ---------- | ---------------- | ------------------------------------- |
| 01         | 3.17             | 本地扩展加载及隔离目标                |
| 02         | 52.91            | 紧凑动态计数，真实逐项进度后 Escape   |
| 03         | 53.76            | Continue audit 默认选择、恢复同一审计 |
| 04         | 126.23           | 展开依据、End 到最后附加项            |
| 05         | 127.14           | 窄屏/Home/折叠后立即释放观察屏障      |
| 06         | 141.66           | 真实批准、归档及父会话 idle           |

两份原始录制均在独立 tmux review 窗口完整回放，退出均为 0；成功目录的 `replay/` 保存轮询截图和回放退出码。检查了启动、动态清单、计数、依据/末项以及最终归档结果的回放画面，弹窗与尺寸变化另有实际运行时捕获并自动断言。没有逐帧人工审查全部动画，不将这种未执行的审查伪报为完成。

```bash
asciinema play /tmp/pi-e2e-dynamic-audit-20261117-045109/recordings/run-3c2ot8/session.cast
asciinema play /tmp/pi-e2e-dynamic-audit-1794863064090/recordings/run-gqdYnj/session.cast
```

录制、会话和临时包只保留本机 `/tmp`，未上传或加入仓库；系统清理或重启可能删除它们。

## 实施里程碑及修复

1. 快照/提示词阶段：45 项定向测试通过；显式空数组、重复文本、条件 ID、转义、默认值相等及首次回调共用快照均有测试。
2. 协议阶段：71 项定向测试通过。发现 response 后旁路异步收尾窗口仍可接受迟到进度，已使用既有 settleStarted/settled 状态冻结；保留先失败后通过的测试，没有弱化断言。修复过新增工具联合结果与测试泛型捕获的真实编译错误。
3. 动态 UI：104 项相关测试通过，覆盖中文长内容、控制字符、完整滚动与缩放；SDK 自动添加的安全 SGR reset 明确允许，但其他终端转义与 BEL 仍禁止。详细文档、未发布变更记录和文件打包清单已更新。
4. 完成兼容：新增 7 个真实完成事务/账本组合，覆盖 approved 加 pending/running/failed，及全项 passed 加拒绝/错误/非法 verdict；状态不新增门槛。共用完成测试 harness 抽至 fork-only fixture，原回归仍全部执行。
5. 原有 ModelRegistry 双重断言最初被保留为 baseline；自动检查持续阻塞后，将其原样可选查找移到有明确 SAFETY 说明的 fork-only helper，上游只保留调用。旧 lint 债务已移除，改为记录必要接缝的同步成本；不在上游原始行插入 lint 注释。
6. 依赖 dist-pkg 最初缺失，使用 pi-subagents 现有 prepack 构建（未改源码）。旧 LSP missing-module 缓存经项目刷新及直接 semanticDiagnosticsSync 核验为空，最终包 typecheck 退出 0。最新活动 LSP 探测无 error，但部分服务为 push-only/超时，不能将它们说成逐文件全 clean。

## 收尾

`scenario-trace.md` 给出完整追踪。所有任务的勾选仅在对应行为和验证完成后更新；OpenSpec change 保持未归档。聚合测试的 9 个既有失败保留且如实披露，没有以跳过、伪 provider、覆盖用户配置或修改旧断言来掩盖它们。
