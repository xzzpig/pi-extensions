# 实施记录

## 接缝盘点

实施前运行 `.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory pi-goal-x`，退出码 0。盘点显示 `extensions/widgets/goal-widget.ts`、`extensions/widgets/goal-dashboard-renderer.ts` 和 `extensions/goal-widget.ts` 是已修改的上游文件；计划仅在必要位置增加对 fork-only 投影、鼠标处理及面板切换回调的委托，不改执行模型或其他包。新投影、交互模块、测试和说明文档均放在 fork-only 文件；实际接缝完成后再更新 subtree 分歧记录。

Pi TUI 文档说明只有 fullscreen 模式向组件派发鼠标；普通模式由终端处理。当前运行时 `tui-alt-screen.js` 的选区路径在未消费 press 后，能在无拖动释放时向组件派发 click，因此不能通过消费 press 实现点击，否则会破坏选区。

## 当前进展（尚未完成验收）

- 新增 fork-only 投影及状态控制器，6 项单测通过；初步接入双视图、键盘窗口和原生鼠标，组件测试当前 6 项通过，typecheck 通过。
- 旧任务视口测试中以最近完成任务为锚点的 5 项断言已按新契约调整，`goal-widget.test.ts` 和 `goal-widget-lifetime.test.ts` 合计 90 项通过。尚需完整包回归和逐场景追踪。
- 初步真实运行：Goal-X 源码和临时 fixture 共同加载，隔离路径 `/tmp/pi-e2e-goal-tree-dev-01`，录制 `/tmp/pi-e2e-goal-tree-dev-01/recordings/run-5u36or/session.cast`。通过 tmux 注入 SGR 鼠标单击父行后看到子任务收起；向上滚轮使任务窗口上移；执行 `/fixture-next` 后 t23 可见。此实验使用临时 fixture，并非真实 goal 生命周期或完整单包/多插件验收；未进行视觉回放，不得当作最终 E2E 通过。
- 待完成：最终可用高度与控件裁切边界、手势/浮层/选区和审计隔离的全面自动化、共享插件合装与完整 TUI 录像验收、上游接缝收敛及分歧记录和全部门禁。

## 有界绘制与初步鼠标验证

- 经 10、12、14、16、18 行等尺寸探测后，零任务行场景增加“任务区空间不足”提示；仅能容纳一行时压缩范围提示并优先显示当前任务。`fork-task-widget.test.ts` 覆盖紧凑/展开、40/70/110 宽、深层长中文、矮屏、缩放后旧手势、控件及最终视图。
- 增加普通模式的能力提示，按会话去重；`fork-mouse-capability.test.ts` 验证未知/全屏不提示、同会话不重复。
- 源码 Goal-X 与 Mouse Events、Starline 合装的初步临时 fixture 实验，录制 `/tmp/pi-e2e-goal-tree-dev-multi-01/recordings/run-grRwK2/session.cast`：注入单击后 t17 分支收起。此实验只验证单次基本点击，不等于完整合装验收。
- 最近一次全包单测：`pnpm --filter @xzzpig/pi-goal-x test`，1715/1715 通过（在最终几处后续修改之前）；焦点相关 148 项通过。仍须在最终代码上重跑全套门禁。

## 原生交互与真实 TUI 实验

- `fork-task-mouse.test.ts` 验证 wheel delta、边界消费、press 透传、拖动、右键、双击、坐标和布局失效；`fork-task-widget.test.ts` 验证目标数据不变、任务与审计视图切换不执行旧手势。
- `tests/e2e/fork-task-tree-fixture.ts` 在隔离目录安装真正的 Goal-X 扩展并通过测试专用命令驱动内存 goal；不调用模型或声称经过真实审计。首次 `/tmp/pi-e2e-goal-tree-real-01/recordings/run-nQ5Wzz/session.cast` 因缺少 `.pi` 目录触发 ledger checkpoint 日志，属于失败尝试，保留录像；修复 fixture 创建隔离目录后重试。
- 单包重试 `/tmp/pi-e2e-goal-tree-real-02/recordings/run-27zvSd/session.cast`：注入鼠标验证父行折叠、滚轮、当前任务切换、面板展开和恢复、审计视图切换及 80×24 调整；父行拖选后分支未折叠，录制中的 OSC52 payload 解码为 `17  任务 17`，两个退出码为 0。鼠标事件由 tmux 注入，不是人工真实鼠标。
- 合装 `/tmp/pi-e2e-goal-tree-real-multi-02/recordings/run-9Hx5ZV/session.cast`：同时加载 Mouse Events 和 Starline，注入单次父行点击只折叠一次，滚轮、任务切换及模拟审计显示/返回符合预期；仍需检查录制完整性和回放，补充浮层、结果卡及规格追踪。两次均为 fixture 控制内存状态，不能宣称实际模型审计或真实人工鼠标验证。

## 真实 TUI 回放与验收范围

- 已使用 `asciinema play -i 0.6 /tmp/pi-e2e-goal-tree-real-02/recordings/run-27zvSd/session.cast` 在 `/tmp` tmux 回放，观察 t23 当前行与 child 分支展开后的布局，回放退出 0；两个进程退出码均为 0。原始事件序列有效，原始 cast 未压缩修改。自动屏幕断言与步骤索引分别覆盖 26.9s 父行折叠、28.4s 滚轮、29.8–32.2s 切换焦点及展开、33.6–36.0s 模拟审计显示/返回、59.6s 拖选、82.9s 回到当前。OSC52 解码验证拖选复制为 `17  任务 17`。
- 使用 `asciinema play -i 0.5 /tmp/pi-e2e-goal-tree-real-multi-02/recordings/run-9Hx5ZV/session.cast` 回放完成退出 0；步骤索引 26.2–35.8s 覆盖合装单击、滚轮、切换与模拟审计返回。进程和录制退出均为 0。
- 使用 `asciinema play -i 1 /tmp/pi-e2e-goal-tree-real-multi-03/recordings/run-HBncjq/session.cast` 回放退出 0，观察覆盖层确实遮住任务区域；42.4–44.7s 的自动屏幕断言证明点击浮层后父行仍展开，45.1–53.9s 验证模拟 APPROVED 结果卡及返回。进程和录制退出均为 0。
- 所有事件由 tmux 发送的 SGR 序列注入，鼠标实物及人工选区观察未声称完成；模拟审计通过 fixture 设置进度/结果卡，不等于真实 auditor 模型结果。每个环境的 `launch.sh`、`record.sh`、`steps.tsv`、原始 cast 与状态文件均留在对应 `/tmp` 目录。
- 实验启动经 `direnv exec . .agents/skills/pi-plugin-e2e-test/scripts/pi-e2e-env.sh start`，单包加载 `packages/pi-goal-x/tests/e2e/fork-task-tree-fixture.ts`（该 fixture 安装真实扩展），合装额外加载 `packages/pi-mouse-events/extensions/index.ts` 与 `packages/pi-starline/extensions/starline/index.ts`；各目标路径均为隔离 `/tmp/pi-e2e-goal-tree-*`。步骤中以 `tmux send-keys -l` 注入 SGR 序列，以 `capture-pane | grep` 或否定 grep 断言实际屏幕行，再由 wrapper `stop` 正常退出。
- `pnpm --filter @xzzpig/pi-goal-x run test:integration`：integration 35/35、真实 SDK 10/10 通过，退出 0。
- 额外边界验收 `/tmp/pi-e2e-goal-tree-boundary-01/recordings/run-tomHjt/session.cast`：先用 `! seq 1 120` 产生长聊天内容，再注入滚轮至 t0，继续在任务区上滚一次；`gx-boundary-before.txt` 与 `gx-boundary-after.txt` 完整屏幕 diff 为 0，证实本次测试没有穿透滚动会话。原 cast 已用 `asciinema play -i 0.25 .../run-tomHjt/session.cast` 在 tmux 回放并观察顶部任务行，回放退出 0。该检查只涵盖实际测试的首部边界。

## 最终门禁

所有命令从仓库根目录执行，退出码均为 0；并行运行时日志保存在本机 `/tmp/gx-final-*.log`：

- `pnpm --filter @xzzpig/pi-goal-x run typecheck`：通过。
- `pnpm --filter @xzzpig/pi-goal-x test`：1721/1721 通过，0 skip；142 个 unit 文件。
- `pnpm --filter @xzzpig/pi-goal-x run test:integration`：35/35 integration、10/10 真实 SDK 通过。
- `pnpm run audit:fork-divergence`：通过；`pi-goal-x: checked=757 noise=7 deleted=1 submodule=0 declared=8 undeclared=0 stale=0`。
- `pnpm run audit:fork-changelogs`：10 个 fork 包通过；`pnpm run test:release`：48/48 通过。
- `openspec validate enhance-goal-task-tree-navigation --strict`、`git diff --check`、测试清单 `--selfcheck`、仓库 Prettier 检查及显式 fork-only 文件 Prettier 检查均通过。首次仓库 Prettier 检查发现 `verification.md` 未格式化，已格式化后重新通过。
- 最终布局 helper 抽出后再次用完整 Goal-X 核心运行 `goal-tree-final-01`：`/tmp/pi-e2e-goal-tree-final-01/recordings/run-uokFpP/session.cast`，注入单击父任务并核验子分支收起；Pi/recorder 退出均为 0，`asciinema play -i 0.8` 经 tmux 回放观察收起界面并退出 0。此为最终代码烟测，不代替前述完整场景录像。

未发布、未提交、未修改宿主或其他插件代码。旧 `goal-widget.test.ts` 的锚定断言只对本规格替代的最近完成定位语义作调整；原键盘/生命周期断言继续执行。

## 独立审计反馈及修复

独立完成审计发现控制行的实际内容由 `boxLine` 在边框之后再缩进一列，而鼠标目标原本从 x=1 开始：左填充被误识别、两按钮间空格被识别、两个按钮的最右方括号不可点击。已在 fork-only 鼠标适配器按实际绘制的 x=2 内容起点和 `width - 3` 内容容量计算完整控件区间；若窄屏截断整个按钮，只允许完整可见的按钮命中。

新增 `fork-task-widget.test.ts` 的“控件可见首尾列命中”测试，在紧凑/展开、宽 10/19/20/80 下逐项检查 x=0、1、2、7、8、9、18、19：边框/填充/分隔空格不消费，完整按钮首尾可点击，不完整控件不响应。测试经真实 `GoalWidgetComponent` 渲染与事件入口执行，而非只测坐标公式。

修复后追加真实 Pi/TUI 录像并用 tmux 回放，Pi 与录制退出均为 0：

- 单包 `/tmp/pi-e2e-goal-tree-boundaries-fix-01/recordings/run-7OVMr4/session.cast`：终端列 2 的左填充不触发；列 8（展开右括号）触发；手动滚动至 t0 后列 9（控件间空格）不恢复，列 19（返回当前右括号）恢复 child 行。回放：`asciinema play -i 0.6 /tmp/pi-e2e-goal-tree-boundaries-fix-01/recordings/run-7OVMr4/session.cast`。
- 合装 `/tmp/pi-e2e-goal-tree-boundaries-multi-01/recordings/run-ZyGC12/session.cast`：Starline 与 Mouse Events 同装时列 8 点击展开一次。回放：`asciinema play -i 0.6 /tmp/pi-e2e-goal-tree-boundaries-multi-01/recordings/run-ZyGC12/session.cast`。

两次事件均由 tmux 注入 SGR 序列，录制及回放未冒充物理鼠标验证。修复后重跑全部门禁：typecheck、1722/1722 单元测试、35/35 integration 与 10/10 SDK、fork-divergence、fork-changelogs、48/48 release、OpenSpec strict、仓库及本次 fork-only 文件 Prettier，均退出 0；日志为 `/tmp/gx-reaudit-*.log`。前述 1721 单元结果是修复前快照，最终以 1722 为准。
