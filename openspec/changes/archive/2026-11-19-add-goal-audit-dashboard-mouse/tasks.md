# Tasks

## 1. 审计视口与几何

- [x] 1.1 在实现前读取 Pi TUI、插件维护、fork-divergence 和上一任务树变更的代码与规格；执行 `.agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory pi-goal-x`，记录共享文件基线和最小接缝，不覆盖未提交工作树。
- [x] 1.2 给 fork-only 审计视口增加按宿主有符号 delta 滚动的接口，并与原键盘 offset、clamp 和 attempt 生命周期统一；新增测试覆盖多行 delta、方向、首尾、空清单、内容变化、同一 attempt 更新与 park/resume、缺 ID 新尝试及目标切换。
- [x] 1.3 让审计 renderer 和 widget 根据最终可用高度产生正文区域及控件结构化几何；新增真实组件测试覆盖紧凑/展开、窄宽屏、中文长依据续行、缩放、超矮屏、截断与填充，验证头部/汇总/停止提示在可用空间内保留、不可见区域无命中。

## 2. 鼠标交互与兼容

- [x] 2.1 接入原生组件鼠标路由，审计正文滚轮复用视口 offset，其他区域和浮层透传；用组件测试验证首尾和空/短清单不穿透、滚轮步长不重复加速、键盘鼠标交替及无鼠标降级。
- [x] 2.2 增加可发现的展开/收起控件并接现有权威切换入口；用最终实际渲染行测试控件首尾、相邻空白、不可见与截断控件，验证鼠标与快捷键状态一致、没有单项详情折叠或停止控件。
- [x] 2.3 实现 press 透传、完整点击与身份/几何代次校验；测试拖选、复制、链接、右键、双击、过期布局/attempt/目标、前置浮层和普通任务/审计/结果卡互斥，不误操作隐藏视图。
- [x] 2.4 以审计协议与目标快照测试浏览不会修改检查项、attempt、verdict、目标文件、账本或模型消息；回归 Escape 挂起/继续、终态结果卡和原动态审计测试，更新 fork-only 用户说明与 fork changelog。

## 3. 真实运行与交付门禁

- [x] 3.1 按 `pi-plugin-e2e-test` 与 `pi-tmux-tmp-server` 技能，在隔离工作目录用真实 Pi/TUI、持久 tmux 与 asciinema 录制单独加载 Goal-X 的验收；自动断言长清单滚轮、首尾不穿透、紧凑/展开切换、鼠标与键盘交替、缩放、拖选复制和最终屏幕，回放录像并记录命令、路径、时间点及退出码。
- [x] 3.2 在同样隔离的真实 Pi/TUI 中合装 Starline 和 Mouse Events，验证一次点击只切换一次、滚轮不串区、覆盖浮层优先、审计结果卡和普通任务视图恢复；保留录屏、断言及回放证据。区分 SGR 注入与人工物理鼠标，fixture 进度与真实审计 verdict；缺必要环境或失败须如实报告，不以单测或截图替代。
- [x] 3.3 按实际接缝更新 `subtrees/pi-goal-x.json` 的同步及 accepted debt 记录，维持已有任务树变更条目；按需更新测试清单、fork-only 文档打包项和 `FORK-CHANGELOG.md`，验证没有无意义的 fork-only replay 记录。
- [x] 3.4 跑 `pnpm --filter @xzzpig/pi-goal-x run typecheck`、`pnpm --filter @xzzpig/pi-goal-x test`、`pnpm --filter @xzzpig/pi-goal-x run test:integration`、`pnpm run audit:fork-divergence`、`pnpm run audit:fork-changelogs`、`pnpm run test:release`、`openspec validate add-goal-audit-dashboard-mouse --strict` 和格式检查；记录退出码，修复失败，不格式化上游文件。
- [x] 3.5 交付规格场景到已执行测试/录像的追踪表，复核无目标/审计事务变化、无其他包代码变化且上一任务树变更仍通过；检查所有任务及必要验收证据后再报告完成，不提交、不发布、不自动归档。
