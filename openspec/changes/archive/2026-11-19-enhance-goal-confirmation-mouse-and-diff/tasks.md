# 目标确认鼠标与共享 diff 实施任务

## 1. 基线与接缝

- [x] 1.1 阅读 Pi TUI 原生组件鼠标/选区与插件维护、fork-divergence、真实 TUI 验收技能；对 `pi-goal-x` 和 `pi-tool-display` 分别执行 fork inventory，记录上游文件、fork-only 文件及拟采用的最小接缝，并以 `git status` 记录和保留两项已完成但未归档的既有工作树。
- [x] 1.2 为 `pi-tool-display` 当前 diff 展示建立可重复基线：执行现有 diff 测试，记录 auto/split/unified、不同宽度、行号与 hashline、wrap、背景及折叠行为；标出包及 release 构建顺序和私有组件打包限制。

## 2. 共享差异排版与 tool-display 迁移

- [x] 2.1 在 `pi-components` 新增具类型的 diff 公共子路径，将 tool-display 现有通用配对和排版能力迁入单一共享实现；单测覆盖配对、单侧增删、跨列说明、上下布局及无颜色标识，并验证组件不触碰文件、目标或工具执行。
- [x] 2.2 完成共享宽度、换行与样式安全：用测试覆盖 119/120 邻近宽度、极窄屏、长行、中文、组合字符、emoji、空行、左右续行占位、缩放和 ANSI/OSC/CSI 不可信文本；断言每行可见宽度有界且内容、顺序和主题背景不泄漏。
- [x] 2.3 将 `pi-tool-display` 的 edit/write 渲染委托同一共享核心，保留文件解析、配置、语法高亮、行号、hashline、hunk、主题和展开策略；运行既有 diff 与展示提供者测试，对照 1.2 的基线且不以 Goal-X 的 120 列阈值覆盖显式配置。
- [x] 2.4 为公共 diff 子路径编写调用与输入安全说明，运行 `pi-components` 的 build、typecheck、测试及既有 transcript 消费者回归；验证新旧子路径的源码入口和生成声明均可解析。

## 3. Goal-X 语义差异与确认布局

- [x] 3.1 从权威 baseline 与有效候选的同一语义比较产生结构化展示行及原有纯文本 diff/full 投影；fork-only 测试覆盖正文、契约、任务 ID/移动/顺序/状态、预算、审计与生命周期字段、空变更及有界 coarse fallback，证明不会把视觉换行或移动误认为内容变更。
- [x] 3.2 将只读语义行接入共享 diff：按最终内容区 `>= 120` 并排、`<= 119` 上下排列；测试调整框实际宽度解除 80 列限制、边界与往返缩放、CJK/空行/长行、单侧变化及所有语义字段可见，全文视图仍完整可读。
- [x] 3.3 保持原 `diffText`、`fullText`、候选 revision、outcome 与 `details.tweakReview` 快照：自动测试比较旧文本与新展示、审计开关变化、确认/继续/取消、过期焦点与历史回看，证明 UI 专用行不泄漏到工具结果、存储或模型消息。
- [x] 3.4 改造创建确认和调整确认的最终可用高度布局：通常固定决策区并滚动完整正文，极矮屏可滚动整个框；组件测试覆盖原创建提案中段与空行、多级任务、长 diff/full、窄屏、逐行/分页、独立浏览位置、反馈草稿和每行/每帧边界。
- [x] 3.5 在 fork-only 文档说明并排阈值、两种滚动布局和键盘回退；运行创建问卷、tweak 确认与目标草拟回归，证明其他问卷和 Sisyphus 原有行为不回归。

## 4. 两个最终确认框的鼠标交互

- [x] 4.1 为创建最终确认添加 fork-only 原生鼠标适配及最小入口接缝：测试决策行点击仅选择、独立确认控件执行当前项（默认选中也有效）、审计开关、键鼠交替和其他问卷不被接管。
- [x] 4.2 为调整最终确认添加同样的两段式决策，并支持审计开关及 diff/全文只读切换；测试确认、继续讨论进入反馈编辑器、取消、Esc、反馈保留与审计值不变式，确保动作共用原有权威路径且不会重复执行。
- [x] 4.3 根据最终绘制、滚动裁切和换行生成命中图，处理框内有符号滚轮与编辑器局部坐标/焦点；测试可见控件首末单元格、续行、空白/边框、隐藏区域、短内容与首尾不穿透、框外路由及无鼠标回退。
- [x] 4.4 实现 press 透传、完整点击、拖选/复制/链接/右键/双击保护与动作清理；真实组件回归必须覆盖按下及延迟动作期间身份、宽高、滚动、选项、视图与可观察浮层变动后**恢复原值**，证明旧手势不会复活，同时同布局普通重绘和正常单击仍可用。

## 5. 独立打包与兼容门禁

- [x] 5.1 让 Goal-X 和 tool-display 各自按隔离 staging 方式携带已编译的 `pi-components` diff 入口及声明，更新必要 manifest、lockfile 与 fork-only 构建脚本；检查两个 tarball 的文件列表、导出与 bundled 依赖，拒绝工作区绝对路径、包外链接和 `node_modules` 内需直接剥离类型的入口。
- [x] 5.2 更新与该依赖直接相关的 release 构建顺序和测试：仅选择 tool-display 或 Goal-X 时均包含共享组件构建与验证；运行 release-core/身份检查测试并证明 `pi-components/transcript` 与 `pi-subagents` 现有导出、构建和打包保持可用。
- [x] 5.3 调整 Goal-X 旧包测试中对 `pi-components` 包名的全局禁止，使其允许 diff 的必要依赖但仍禁止恢复 auditor transcript runtime、overlay、`/goal-audit` 和最近 transcript 状态；运行包契约与既有审计事务回归。
- [x] 5.4 更新确需重放的 `subtrees/pi-goal-x.json`、`subtrees/pi-tool-display.json`、测试清单及 fork-only changelog/文档；执行两个 subtree 分歧与空白审计、manifest selfcheck，证明没有无意义 replay 记录或格式噪声。

## 6. 跨包与真实运行验收

- [x] 6.1 在隔离临时目录仅安装 Goal-X tarball及其必要运行依赖，不让仓库源码可见；使用真实 Pi、持久 tmux 和 asciinema 分别验证创建与调整最终确认的长正文、固定操作区、滚轮首尾、两段式点击、键鼠交替、反馈/取消、拖选复制和窄矮屏，记录屏幕断言、步骤、退出码并完整回放。
- [x] 6.2 真实 Pi/TUI 下以实际内容区 119/120 列及更宽终端验证调整确认的上下/并排、左右字段与多级任务对齐、长中文换行、缩放和 diff/full 切换；保留录屏和回放采样，区分 SGR 注入与物理鼠标、fixture 提案与真实模型输出。
- [x] 6.3 在独立临时目录仅安装 tool-display tarball，另进行 Goal-X 与 tool-display 合装，真实 Pi 启动并验证 edit/write 与目标差异各自调用共享实现、原配置与其他插件的鼠标路由不回归；检查产物不依赖工作区或另一插件的嵌套依赖，保留完整录像/启动证据。
- [x] 6.4 运行三个包的 typecheck 和相关完整测试、Goal-X integration、tool-display diff/provider 回归、两个 subtree fork-divergence、changelog/release 测试、OpenSpec strict、格式与 `git diff --check`；生成逐规格场景到已执行测试或录像的追踪表，报告失败与环境限制。此前工作树保持原样，不提交、不推送、不发布、不自动归档。
