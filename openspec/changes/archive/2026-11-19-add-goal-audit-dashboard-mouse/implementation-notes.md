# 实施记录

## 起始基线与接缝

- `enhance-goal-task-tree-navigation` 的既有实现及其已暂存工作树作为基线保留；本变更不回退、覆盖或重新暂存它。
- 开始前执行 `.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory pi-goal-x`，退出码 0：`fork-audit-viewport.ts` 与 `fork-auditor-dashboard-renderer.ts` 属 fork-only；`extensions/widgets/goal-widget.ts` 属已修改的上游文件。新交互与视图计算优先放 fork-only 文件，主组件仅增加派发及最终高度几何接缝。
- Pi TUI 文档确认原生组件事件在 fullscreen 模式派发；未消费的按下保留选区和链接行为，普通模式依赖键盘。验证复用现有共享鼠标框架及已记录的 boxLine 偏移边界，不增加全局监听。
- `TMUX_TMPDIR=/tmp tmux ls` 已确认现有 host server 可连接；真实 TUI 工作仍须另行执行插件 E2E 技能及录制。

## 审计视口与几何

- 在 fork-only 审计 viewport 复用键盘 offset 增加多行滚动，按 attempt、goal 与离开审计后的新生命周期隔离；根据最终可用 cap 产生正文与控件区域。保留原非交互 renderer 输出路径。
- `fork-audit-mouse-widget.test.ts` 当前 7/7 通过，覆盖多行滚动、刷新与模拟 park/resume、缺 ID 新生命周期、目标切换、短清单 clamp、20/40/80/110 列中文长依据、缩放与最终屏幕命中；既有 dashboard/widget/任务树聚焦回归 116/116 通过。模拟挂起只是组件状态测试，不代表真实子代理审计验证。
- 初步 `pnpm --filter @xzzpig/pi-goal-x run typecheck` 通过；完整测试、真实 TUI 与 fork 门禁尚未完成。

## 真实 TUI 验收清单（运行前）

隔离 `/tmp/pi-e2e-audit-mouse-*`，fixture 安装真实 Goal-X 并仅模拟只读审计进度，不模拟真实 verdict 的可信性。单包和与 Starline/Mouse Events 合装均录制完整 asciicast：检查启动扩展清单、紧凑摘要与展开控件；注入完整单击展开/收起；正文滚轮方向及首尾不穿透；同一审计刷新不跳位置；键鼠交替；终端尺寸变化；控件/正文拖选及 OSC52；覆盖层优先；结果卡及任务视图恢复。逐步记录捕获屏幕、命令、期望与实际、退出码和回放；不把 SGR 注入称为物理鼠标，不将 fixture APPROVED 称为真实审计。

## TUI 发现与修复

- 首次单包录像 `/tmp/pi-e2e-audit-mouse-solo-01/recordings/run-VR3PHU/session.cast` 在 70×22 裁掉停止提示；保留为失败证据。将审计 cap 留出宿主裁切余量后，`solo-02/run-OyP9B9` 与多插件 `multi-01/run-kKqDfv` 均在该尺寸保留停止提示。
- 核实 Escape 实现会暂时把 `auditProgress` 设为 null，恢复时先返回空快照；因此以 `activeAudit` 对象引用识别同一次真实 lifecycle，挂起时保留期望位置，空快照实际显示仍受 clamp 限制，收到检查项后恢复并再次 clamp。新的生命周期、目标或不同非空 attempt ID 重置。真实组件测试覆盖空进度恢复；这不是完整模型审计验收。
- `/tmp/pi-e2e-audit-mouse-transaction-01/recordings/run-SW1AxP/session.cast` 的标记称对目标文件和 session JSONL 比较哈希，但核查发现两组 `find` 结果均为空：该比较仅证明没有新文件出现，**不能**证明现有文件或 ledger 未修改。以内存目标快照与生命周期回归测试为补充，不将空哈希比较作为完整持久事务证据。

## 交互与事务验证

- 审计鼠标复用任务鼠标的完整手势校验；单击等待宿主双击选词窗口约 520ms 后才执行，第二次按下取消待执行动作，执行前重新校验目标、attempt、layout、终端和浮层，未消费 press。链接优先级由宿主处理；测试模拟宿主消费 release 未发出 click，不等同于真实点击 OSC 8 链接。
- 单包真实运行 `double-01/run-RvpWEl` 的 OSC52 解码为“展开”，双击未切换，随后单击正确展开；合装 `multi-02/run-Z6wLko` 重复了双击、单击、滚轮、浮层与结果卡/任务视图恢复。所有输入为注入 SGR、进度和 verdict 为 fixture 模拟。
- 非空实际目标 Markdown 与 ledger 在 `transaction-03/run-dQ2XxF` 点击和滚轮前后 SHA-256 完全相同，快照文件位于该录像目录；会话文件为空，未产生新模型消息。原 `transaction-01` 的空哈希比较无效，见上文。
- 执行审计鼠标组件和既有清单、真实委派 park/resume、完成 gate 回归共 44/44，包 typecheck 通过。鼠标当前能否使用仍取决于宿主全屏能力；不引入共享包依赖。

## TUI 回放与边界说明

- `asciinema play --idle-time-limit 1 /tmp/pi-e2e-audit-mouse-solo-02/recordings/run-OyP9B9/session.cast`、`.../multi-02/recordings/run-Z6wLko/session.cast` 和 `.../double-01/recordings/run-RvpWEl/session.cast` 在持久 tmux 130×42 审阅窗口播放；窗口采样 `replay-*.txt` 保存在各录像目录。多插件与双击播放显示 `REPLAY_EXIT=0`；单包曾完整播放并显示 0，第二次回放采样核验了 70×22 滚动和停止提示、浮层与返回。录像的 Pi 和 recorder 退出均为 0。
- 单包 steps 约 32–40 秒覆盖缩放、滚轮、刷新、键盘与末尾；约 69.58 秒的 OSC52 解码是 `审计检查 0`；约 89–91 秒覆盖浮层与模拟结果卡。双击录像 OSC52 解码为 `展开`，且状态未切换。多插件录像步骤见其 `steps.tsv`。
- 基础宿主/fixture 的覆盖层在审计行上显示 `审计检查 OVERLAY AUDIT` 的视觉合成现象（先前任务树验收也观察到），浮层输入未穿透、关闭后内容恢复；本变更不修改 Pi core，也不把该视觉合成声称为本项目已修复。

## 独立审计后的手势往返修复

独立审计复现：控件单击后 80→40→80 列，或按下后 attempt A→B→A，旧手势在身份/几何恢复后仍会生效。现由 fork-only `AuditDashboardMouse.observe` 在每次最终绘制及可观察更新时比较身份、生命周期和几何；任何变化立即清除 press 与等待的单击计时器，后续恢复原值不会复活。普通 elapsed 刷新不变更该签名，不会取消有效单击。

新增真实组件测试覆盖 press 与待确认单击阶段的宽度、attempt、goal、展开模式、高度、生命周期往返共 12 组，以及不重绘的状态更新往返和普通刷新保持；16/16 通过。修改后的全量单元 1738/1738、类型检查、集成、fork/changelog 审计、release、OpenSpec 和格式门禁重新通过，日志 `/tmp/pi-audit-gates/*-final.log`。真实多插件修复后复测为 `/tmp/pi-e2e-audit-mouse-final-04/recordings/run-honmdd`，双击、单击、滚轮通过，Pi/recorder/replay 退出均 0；输入仍是 SGR 注入。

## 独立审计后的浮层往返修复

第二次独立审计发现浮层出现、消失后旧 press 或待确认单击可能复活。`AuditDashboardMouse.observe` 现在将宿主 `hasOverlay()` 的可观察值计入签名：widget update 或 render 观察到浮层变化即清除 press 与定时器，浮层关闭不会恢复旧动作。新的真实组件用例分别覆盖 press/pending × update/render 四种浮层往返；17/17 审计组件用例通过。没有收到 update、render 或事件的完全不可观察瞬时变化无法由组件感知；本实现不拦截宿主的全局浮层行为。

修复后最终门禁再次通过：1739 全量单测、35 + 10 集成、48 release、typecheck、fork-divergence、changelog、OpenSpec 和格式检查均退出 0，日志见 `/tmp/pi-audit-gates/*-overlay-final.log` 与 `unit-overlay-retry.log`。首次全量运行 `unit-overlay-final.log` 在并发 settings lock 测试出现 2 秒锁超时（1738/1739），未修改该测试或锁语义；整套重跑 1739/1739 通过。`/tmp/pi-e2e-audit-mouse-final-05/recordings/run-yZckjI` 为修复后的真实多插件单击、滚轮与浮层优先补测，Pi/recorder/replay 均退出 0；浮层往返时序由组件测试验证，不声称此录像覆盖该时序。
