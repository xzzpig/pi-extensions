# 验收记录

## 仓库检查

- 目标包类型检查、测试入口清单自检、fork 测试清单自检、OpenSpec 严格校验及全仓 fork 分歧审计均通过。Goal-X 检查 757 个上游文件，`undeclared=0`、`stale=0`。日志目录：`/tmp/goal-footer-final-gates/`。
- 最终 `pnpm --filter @xzzpig/pi-goal-x test`：1,901 项通过、0 失败，退出码 `0`，见 `unit-dock.log` 与 `unit-dock-exit`。较早一次重验还遇到测试适配器导出缺失、旧接线断言和真实确认框测试子进程超时；前两项已修正测试接入，未改子进程原有时限，最终全量重跑通过。
- 最终定向回归 162 项通过，见 `dock-targeted.log`。真实 `syncTerminalInputPause` 与 `GoalWidgetComponent` 共同覆盖鼠标和键盘双向切换、宿主 `app.interrupt` 覆盖切换键、审计中断占用 `↑`、滚动键禁用时只显示范围。
- 终端编码冲突回归覆盖传统 ESC + 字母与四个方向键别名（例如 `Alt+P` 与 `Alt+↑`），并验证 Kitty 可区分时恢复显示。CSI-u 的移位字符和基础布局字符直接交给 Pi 解码器判断重叠，不假定美式配对：回归包含 `Shift+7` 产生 `/`、`Shift+6` 产生 `&` 以及基础布局数字别名。实际输入仍由高优先级中断接管，非冲突的 `F8` 保持可见且能展开；见 `layout-edge.log`。
- 最新回归还覆盖 Pi 解码器不支持但配置语法接受的 `Shift+Esc`、`Ctrl+F8`：不再提示无效按键，有效备选仍显示并可用。80×11 模拟终端给待办 5 行时，保留基线的 `Current` 摘要，底边框不占用最后一行且无残留点击；增加一行后，摘要和底边框同时显示。
- 使用实际 `GoalCore` 和终端输入分派，在完全不重绘的情况下先展开再收起：待办旧按压、审计旧按压以及审计已经排队的延迟单击均失效；同一位置的新手势仍可用。另验证组件卸载取消审计延迟单击，不影响其后的面板状态。
- 已注册组件使用实际 `core.setGoal` 测试目标 A→B→A、显式当前任务 a→b→a 和推断任务顺序往返，中间不重绘，最终底边框位于原坐标。旧点击拒绝，新点击有效；普通用量刷新保留有效手势。同样覆盖审计 attempt 和结果卡来源往返，普通审计进度不取消有效的延迟单击。
- `fork-dashboard-host-frame.test.ts` 使用 Pi 的真实 `TuiAltScreen` 与 SGR 输入，复现 80×24 按下后缩至 80×10 或 8×24、在新帧前释放，并检查无旧点击且恢复后的新点击有效。另验证同帧尺寸往返及待执行审计单击、销毁组件后恢复宿主的重绘入口。真实宿主也覆盖待办按钮被完全遮挡并重绘、浮层关闭后旧按压不复活，以及审计浮层开关在两次绘制之间被合并时，旧按压和已被宿主接受的延迟单击均取消。每个场景都确认新帧上的新点击有效；另用 Pi 的真实 `createInteractiveTuiReference` 将同一组件从普通 renderer 迁移到全屏 renderer；即使遮挡浮层开关合帧，也会取消已排队的审计点击，新手势仍可用，切回普通模式后还原旧全屏 renderer 的重绘入口。这 8 项见 `remount-focus.log`。
- 真实 `TuiAltScreen` 输入顺序回归证明，宿主搜索和视口跳转会先拦截配置给 Goal-X 的 `Ctrl+Shift+F`、`Ctrl+Home`；两个底边框均不提示这些键，`F8` 正常切换。禁用宿主搜索并重绑顶部跳转后，被释放的按键重新显示并由真实监听器处理。搜索或阻塞提示获焦期间，两个底边框都不再宣传不能分派的快捷键；保留控件和无按键的滚动范围。焦点返回编辑器后，显示和键盘操作一并恢复。
- 标准 `createChatViewport` 的原生 SGR 回归：100×36，编辑器从三行长到五行时实际绘制的底边框上移两行。待办和审计的按压往返后不复活；审计已经接收的延迟单击，即使不做位置往返也会取消。三种场景都验证了未移动时的普通重绘不影响新点击。`dock-before.log` 复现三项失败，`dock-after.log` 三项通过。该组也由完整测试中的生产 SDK 子进程执行。

## 真实 Pi TUI

Pi 1.5.2 全屏模式。通过 `pi-e2e-env.sh` 分别加载 `packages/pi-goal-x/tests/e2e/fork-task-tree-fixture.ts` 与 `packages/pi-goal-x/tests/e2e/fork-audit-mouse-fixture.ts`，各自在独立临时目录运行，使用临时 Pi 用户目录，禁用自动发现。两个夹具都加载实际 Goal-X 代码；任务与审计进度是确定性测试数据，未发起模型调用。键盘和 SGR 鼠标事件进入 Pi，不直接调用组件的输入方法。

下表时间取自最终 `session.cast` 输出事件，经逐帧回放核对；`steps.tsv` 是独立的现场操作相对时间，不等同于录制时间轴。

| 场景                    | 录制时间（约）        | 观察结果                                                                                                                                                          |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 待办宽屏与恢复跟随      | 5.19 s、39.47–40.02 s | 底边框上只有一个展开按钮；`Ctrl+Shift+Home` 把视口移至首项，点击 `[回到当前]` 后恢复高亮子任务。                                                                  |
| 待办鼠标/键盘及尺寸变化 | 41.00–44.59 s         | 鼠标展开、`Ctrl+Shift+T` 收起；23×18 保留主控件、隐藏 `[回到当前]`；80×10 不显示被裁掉的控件，恢复 130×42 后可再次点击。                                          |
| 审计中断提示与正文滚轮  | 5.01 s、45.31–45.79 s | 展开按钮不重复；`Ctrl+Shift+T` 展开，独立显示 `Esc: stop audit`；Pi 将正文滚轮映射为有符号步长，范围从 `1–14/27` 移到 `4–17/27`；随后在底边框滚动不改变清单位置。 |
| 审计鼠标/键盘及尺寸变化 | 47.27–51.82 s         | 鼠标收起再展开后仍为 `4–17/27`，键盘也可收起；14×18 的短标签仍可点击；80×9 不显示被裁掉的控件，恢复后可点击且停止提示仍正确。                                     |

补充证据：上一轮 `-08` 录制的 `steps.tsv` 步骤 `05` 把连续两次模式切换和旧鼠标手势作为同一批输入交给真实 Pi，旧手势不产生额外切换，新点击仍能展开。旧手势可按步骤标记与 `coalesced.frame` 定位；新点击画面在待办约 40.30 s、审计约 42.36 s。缩放通知与释放同帧、待办浮层遮挡及审计浮层开关合帧的反例由上面的真实 `TuiAltScreen` 回归单独验证。

额外的 `audit-mouse-footers-keys-13` 实机录制验证定制键冲突和焦点：39.24 s，`Ctrl+Shift+F` 打开 Pi 的 `Find in transcript`，底边框保留按钮但隐藏 `F8`，此时按 `F8` 不展开（见 `search-f8.frame`）。40.54 s 关闭搜索后提示恢复；`Ctrl+Home` 不启动审计中断（见 `host-top.frame`）；41.49 s，`F8` 正常展开。默认全屏待办也不再提示宿主占用的 Ctrl+Shift+方向键滚动。

额外的 `audit-mouse-footers-dock-13` 在 130×42 中，通过原生单击与同批的两次软换行使编辑器增高。38.79 s，审计底边框从屏幕第 37 行移至第 35 行并保持收起；超过延迟窗口后仍收起（`dock-moved.frame`）。新的完整点击在 40.42 s 展开清单。

最终四份录制均为可解析的 asciicast v2；Pi、录制进程和 `asciinema play` 回放进程退出码均为 `0`。在独立 tmux 窗口从启动回放至退出，核对关键画面；另外使用终端模拟器按录制的 resize 事件逐帧核对精确宽高。各录制目录包含 `steps.tsv`、现场 `pane-*.txt`、tmux 回放 `visual-replay.txt` 与按录制时间标记的 `exact-size-replay.txt`。

```bash
asciinema play /tmp/pi-e2e-goal-tree-footers-13/recordings/run-hx2kFn/session.cast
asciinema play /tmp/pi-e2e-audit-mouse-footers-13/recordings/run-K1zX8y/session.cast
asciinema play /tmp/pi-e2e-audit-mouse-footers-keys-13/recordings/run-MCg1NK/session.cast
asciinema play /tmp/pi-e2e-audit-mouse-footers-dock-13/recordings/run-6emFqB/session.cast
```

历史录制保留在 `/tmp/pi-e2e-goal-tree-footers-{01,02,03,04,05,06,07,08,09,10,11,12}/recordings/` 和 `/tmp/pi-e2e-audit-mouse-footers-{01,02,03,04,05,06,07,08,09,10,11,12}/recordings/`；最终视觉验收采用上面四份 `-13` 录制。
