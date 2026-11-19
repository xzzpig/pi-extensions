# 验收追踪

## 范围与证据说明

- `W`：`packages/pi-goal-x/tests/fork-audit-mouse-widget.test.ts`（17 项；真实 `GoalWidgetComponent` 与归一化事件）。`D`：`tests/fork-audit-dashboard.test.ts`。`L`：`tests/fork-audit-checklist.test.ts`、`tests/goal-audit-supervisor-flow.test.ts`、`tests/goal-delegation-completion.test.ts`。
- `S`：真实 Pi 单包 `/tmp/pi-e2e-audit-mouse-solo-02/recordings/run-OyP9B9`；`B`：单包双击 `/tmp/pi-e2e-audit-mouse-double-01/recordings/run-RvpWEl`；`M`：合装 `/tmp/pi-e2e-audit-mouse-multi-02/recordings/run-Z6wLko`（缩放补充为 `multi-01/run-kKqDfv`）；`T`：真实目标文件与 ledger 不变 `/tmp/pi-e2e-audit-mouse-transaction-03/recordings/run-dQ2XxF`；`C`：长聊天输出边界与快捷键 `/tmp/pi-e2e-audit-mouse-transcript-01/recordings/run-4wY5N8`。
- 每个目录含 `session.cast`、`steps.tsv`、启动脚本及退出码；S/M/B 含回放采样。执行 `asciinema play --idle-time-limit 1 <目录>/session.cast` 可复查。所有输入为注入 SGR，审计进度及结果卡为 fixture，不是物理鼠标或真实模型裁决。前置浮层显示存在宿主/fixture 视觉合成异常，输入隔离与关闭后恢复通过；未声称修复宿主显示。

## 逐场景对应

| 规格场景             | 已执行证据与范围                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 紧凑与展开互相切换   | W 的真实组件切换及边缘测试；S、B 和 M 真实控件单击。清单状态比较见 W。                                                                                                                                                                                                            |
| 鼠标和键盘交替       | W 混用鼠标与 `handleNavigationKey`；S 鼠标展开后 Home/End 导航；C 通过 Ctrl+Shift+T 展开后用鼠标收起。原展开快捷键共享 `toggleDashboardExpanded`，既有 `goal-widget.test.ts` 中快捷键测试通过。                                                                                   |
| 长清单与换行依据     | W 的 20/40/80/110 列长中文、首尾遍历；S 的 70×22 带汇总、头部、停止提示的真实屏幕。                                                                                                                                                                                               |
| 窗口边界与区域外     | W 空清单、首尾与标题/边框/控件区域事件；S 和 C End 后滚轮全屏前后 diff 相同；C 存在展开的长聊天输出并保存 before/after。                                                                                                                                                          |
| 进度刷新与尝试切换   | W 多行 delta、同 attempt、内容变短 clamp、不同 attempt 与 goal；S `/audit-refresh` 保留、`/audit-next` 重置。                                                                                                                                                                     |
| 控件边缘与分隔空白   | W 测试两模式、多个宽度下首末列与边框空白；S/M 单击右端。最终超矮区域无隐藏命中。                                                                                                                                                                                                  |
| 拖选和复制           | W press 透传及拖动取消；S 的 OSC52 解码为 `审计检查 0`；B 双击 OSC52 为 `展开` 且不切换。                                                                                                                                                                                         |
| 目标失效和浮层       | W 覆盖 resize、attempt、目标、模式、高度和生命周期往返改变对按下及延迟动作的不可逆失效，以及浮层在按下/延迟单击期间出现并消失的 update/render 往返和隐藏任务视图；M 浮层滚轮后底层位置不变。宿主处理 OSC 8 链接优先，W 模拟宿主消费链接释放而不发送组件 click；未做真实链接点击。 |
| 浏览时进度与裁决独立 | W 检查 progress 与 goal 快照不变；T 实际目标 Markdown 与 ledger 的非空前后哈希一致且未生成 session；L 的现有动态快照、verdict 和完成委派测试通过。fixture 不产生真实 verdict。                                                                                                    |
| 审计中断、终态与恢复 | W 模拟真实 null 进度、同 lifecycle 空快照及恢复；L 验证真实委派的同 attempt Escape park/resume；M 模拟终态结果卡消失后恢复任务树，并检验视图鼠标互斥。                                                                                                                            |
| 共享扩展缺失或合装   | S/B/T 单包，M 合装 Starline 与 Mouse Events；相同事件一次生效。既有任务树用例包含在全量单元测试中。                                                                                                                                                                               |
| 非全屏或不支持鼠标   | 既有 `fork-mouse-capability.test.ts` 校验普通模式每会话提示一次和未知模式不猜测；W 与既有 dashboard 键盘测试可不发送鼠标工作。没有使用真实 regular-mode 终端作额外录屏。                                                                                                          |

## 最终门禁

在仓库根以 `direnv exec .` 运行；完整日志保留 `/tmp/pi-audit-gates/`：

- `pnpm --filter @xzzpig/pi-goal-x run typecheck`：0。
- `pnpm --filter @xzzpig/pi-goal-x test`：0，1739 项通过，84 suites。
- `pnpm --filter @xzzpig/pi-goal-x run test:integration`：0，35 + 10 项通过。
- `pnpm run audit:fork-divergence`：0；pi-goal-x 757 文件，8 项声明，0 未声明、0 stale。
- `pnpm run audit:fork-changelogs`：0；10 插件。
- `pnpm run test:release`：0，48 项。
- `openspec validate add-goal-audit-dashboard-mouse --strict`：0。
- `pnpm exec prettier --check .`：0；fork-only 涉及文件另以 `--ignore-path /dev/null --check` 通过。`git diff --check` 和 `git diff --cached --check` 均为 0。

单包首次 `solo-01/run-VR3PHU` 在 70×22 丢失 footer，为失败证据；修复后 S 与 M 已验证。`transaction-01` 的文件哈希集合为空，不作事务证据，改由 T 的非空文件证明。完整操作步骤和局限另见 `implementation-notes.md`。
