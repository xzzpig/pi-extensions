# Tasks

## 1. 可见树与跟随状态

- [x] 1.1 在实现前读取维护、fork-divergence 及相关 Pi 鼠标文档，执行 `.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory pi-goal-x`；记录待改上游文件和最小接缝，确认不修改其他包或原执行模型。
- [x] 1.2 在 fork-only 模块实现按 ID 的祖先索引、自动展开集合和可见行投影；新增 fork-only 测试覆盖后部任务、三级任务、当前父任务、同级顺序、已完成/跳过及空/禁用状态，断言不改变原树和进度。
- [x] 1.3 实现以目标身份和有效 currentTask ID 变化驱动的跟随状态、手动覆盖和双模式窗口；测试显式/推断任务切换、无完成时间变化、无关完成不抢回、手动收起当前路径、恢复跟随、任务移动/删除及目标切换。
- [x] 1.4 将自动规则、手动保持与回退规则写入 fork-only `docs/task-tree-navigation.md`，验证文档与投影/状态测试对应；不扩展 README。

## 2. 有界绘制与键盘接入

- [x] 2.1 用最小接缝把紧凑/展开 renderer 与两套键盘滚动入口接到同一可见投影；新增组件测试验证按可见行数分页、首尾 clamp、模式切换与现有快捷键配置继续有效。
- [x] 2.2 将实际终端/dock/sticky-height 预算用于任务窗口定位，保留稳定高度并处理极小终端降级；新增宽/中/窄、矮屏、中文长标题及深层路径测试，直接断言最终可见行包含当前任务，组件高度不超预算且不反复跳底。
- [x] 2.3 让绘制输出携带任务身份和控件命中元数据，最终裁切/填充后发布有效区域；测试续行、截断、缩放、隐藏行、填充行及任务重排后映射正确，不用固定偏移或文字猜测。
- [x] 2.4 增加可发现的面板展开/收起与“回到当前任务”控件，并接现有面板切换入口；组件测试验证两模式状态一致、无当前任务时恢复动作不可用、小屏控件可达，补充同一 fork-only 交互文档。

## 3. 原生鼠标与选择兼容

- [x] 3.1 在 fork-only 鼠标模块实现原生组件事件委托与任务区 wheel；测试宿主 delta 不重复加速、上下滚动、边界和少量任务不穿透、任务区外/浮层不拦截，且不抢编辑区焦点。
- [x] 3.2 实现父任务整行完整左键单击折叠和面板/恢复控件点击；测试一次点击只执行一次，叶子/边框无动作，press 透传，拖选/右击/链接不切换、双击后续点击不额外切换。
- [x] 3.3 实现手势目标/绘制代次校验及普通视图失效清理；测试按下到点击间任务删除/重排、滚动、缩放、目标/会话切换、审计与结果卡替换不会触发旧任务，reload 后无重复处理。
- [x] 3.4 验证未安装 pi-mouse-events 时原生鼠标正常，能力不可用时自动跟随/键盘继续工作且可检测告警按会话去重；测试只读交互前后目标、任务、ledger 和模型消息不变，文档说明鼠标上报前提与键盘回退。

## 4. 集成验收与分歧门禁

- [x] 4.1 执行新增 fork-only 测试及原 dashboard model/golden/widget/lifetime/audit 回归；仅对被新规格明确替代的旧展示断言做最小适配，并交付规格场景到测试/实际结果的追踪记录。
- [x] 4.2 按真实 Pi/TUI 与持久 tmux 技能，在隔离工作区运行长任务树验收并录制 asciinema：覆盖执行到后部、跨分支自动跟随、滚轮、父行点击、手动浏览后普通刷新、任务切换恢复、面板切换、拖选复制及尺寸变化；自动断言实际屏幕和路由，缺环境或失败如实报告 blocked，不以 handler 单测替代。
- [x] 4.3 在同一隔离真实 Pi 环境中分别单独加载 Goal-X、与 Starline/Mouse Events 同装，验证单击不重复、滚轮不串区、浮层优先、审计进度/结果卡及恢复普通任务视图无回归；记录事件来源，区分注入鼠标序列与人工真实鼠标观察。
- [x] 4.4 按实际上游接缝更新 `subtrees/pi-goal-x.json` 的分歧字段和已接受债务，增加 FORK-CHANGELOG 及必要的 docs 打包清单；验证只新增必要记录，fork-only 原创文件不虚列 reapply 项。
- [x] 4.5 从仓库根运行 `pnpm --filter @xzzpig/pi-goal-x run typecheck`、`pnpm --filter @xzzpig/pi-goal-x test`、`pnpm --filter @xzzpig/pi-goal-x run test:integration`、`pnpm run audit:fork-divergence`、`pnpm run audit:fork-changelogs`、`pnpm run test:release` 与 `openspec validate enhance-goal-task-tree-navigation --strict`；记录命令、退出码及问题解决结果。
- [x] 4.6 检查 OpenSpec 文档格式及 fork-only 新文件格式，不对上游文件跑自动格式化；审查最终 diff 确认无核心/其他包、工具 schema、存储版本、模型提示或未授权提交/发布变化，所有新增规格有已执行证据后才交付。
