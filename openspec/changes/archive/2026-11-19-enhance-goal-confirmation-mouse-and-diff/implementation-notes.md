# 实施记录

## 起始基线（OpenSpec 1.1–1.2）

- 启动时 `git status --porcelain=v1 -uall` 为 45 行，状态、未暂存/已暂存补丁和未跟踪文件的 SHA-256 清单分别保存在 `/tmp/goal-confirm-baseline-status.txt`、`/tmp/goal-confirm-baseline-worktree.patch`、`/tmp/goal-confirm-baseline-index.patch` 和 `/tmp/goal-confirm-baseline-untracked.sha256`。这些文件是对照证据，不用作覆盖或重置用户工作树的来源。
- 已阅读 Pi TUI/扩展、插件维护、fork-divergence、真实 Pi/TUI 与持久 tmux 约定；`TMUX_TMPDIR=/tmp tmux ls` 可连接已有宿主服务器，`asciinema` 3.2.1 和 `pi` 可执行。正式录屏前仍须按技能检查服务器，不能在沙箱内创建替代。
- `direnv exec . .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory pi-goal-x` 退出 0：757 个上游文件，7 noise、1 deleted，8 项已声明，0 undeclared/stale；`--inventory pi-tool-display` 退出 0：73 个上游文件，0 noise/deleted。完整输出 `/tmp/goal-confirm-baseline-{goal,tool}-inventory.log`。
- Goal-X 的 `goal-tweak-confirmation.ts`、`goal-tweak-diff.ts`、`goal-tweak-review.ts` 为 fork-only，`goal-questionnaire.ts`、`goal-drafting.ts` 和 package manifest 为既有上游接缝；创建确认优先仅在 `showProposalDialog` 接入 fork-only 实现。tool-display 的 `src/diff-renderer.ts` 在起点与上游记录 commit 字节相同（SHA-256 `48c70d93aedc00624f6741f674b4449d3333814c4b1fa577c4865e629769c658`），迁移必须将增量限制到必要接缝；其 package manifest 已有 fork 修改。
- `direnv exec . bash -c 'cd packages/pi-tool-display && pnpm exec tsx --test tests/diff-renderer*.test.ts'` 退出 0，80/80；日志 `/tmp/goal-confirm-baseline-tool-diff-tests.log`。该基线覆盖宽度、ANSI/背景、标号、中文换行与并排对齐；当前 `diffViewMode=auto`，`diffSplitMinWidth=120`，`diffWordWrap=true`，折叠 24 行、展开 4000 行，显式 split 仍受最小可用宽度约束。
- `pi-components` 为 private，其当前源码导出指向 `.ts`；`pi-subagents` 通过 prepack 构建并 stage 编译产物后作为 bundled dependency 交付。Goal-X 当前直接依赖 subagents，tool-display 自己不依赖 components；两个消费者的独立包均不能依赖工作区解析或另一个插件的嵌套依赖。Goal-X 现有包测试按包名全局禁止 pi-components，需按规格仅解除新 diff 必需部分，保留审计 transcript 移除契约。

## 共享 diff 与 tool-display（OpenSpec 2.1–2.4）

- 在 `pi-components/src/diff.ts` 新增公开 `./diff`：共享 `pairDiffEntries`、`measureDiffColumns`、`renderPairedDiffRows`，并提供安全文本 `renderDiffEntries`。文本包装按 grapheme/可见列切分，保留空格与宽字符；单列无法物理容纳双列字符时显式显示省略标志。未改变 transcript 子路径。
- `pi-tool-display/src/diff-renderer.ts` 把原配对、列宽和行合成委托到共享实现；文件解析、背景、标号、inline highlight 与 tool 配置仍由原适配负责。原始上游版本和迁移版曾对 2880 组 edit/write、auto/split/unified、不同宽度、主题、折叠和 wrap 参数逐字节比较通过；另以独立 fork-only 快照测试固定 12 组 upstream 原始输出。
- `pi-components` build/typecheck 与全部 48 项测试通过（含 9 个新增共享 diff 测试）；`pi-tool-display` typecheck、80 个原 diff 测试、23 个 provider 测试和 1 个快照测试合计 104/104 通过。既有消费者 `pi-subagents` fleet native transcript 6/6、`pi-btw` transcript-display 40/40 通过。
- 工作区 `@xzzpig/pi-components/diff` 源入口、编译后的 `dist/src/diff.js` 和 `diff.d.ts` 均已解析；独立包 staging 和真实 tarball 验证属于后续 OpenSpec 第 5–6 组，尚未完成。`pnpm add --offline` 造成的无关锁文件重新解析被消除，仅保留 tool-display 对 workspace 组件的必要 importer，随后 frozen lockfile 检查通过。
- 两包的非源码格式和 `git diff --check` 通过，tool-display subtree audit 为 0 undeclared/stale；共享渲染 seam 及依赖的同步成本已记录到 `subtrees/pi-tool-display.json`。详细输出 `/tmp/goal-confirm-{components-tests-final,tool-shared-tests-final,transcript-subagents,transcript-btw}.log`。

## Goal-X 语义投影与高度布局（OpenSpec 3.1–3.5）

- fork-only `goal-tweak-diff.ts` 的 `buildTweakComparison` 在一次 baseline/candidate 比较中同时产生原 `presentation` 与临时 `entries`；正文沿用有界 LCS/coarse fallback，任务按 ID 比较字段并为不同 ID 的增删隔开成组，契约、任务完成策略及设置从各自的真实旧/新值生成行，绝不解析箭头文案。`TweakReview.attach()` 仍仅保存原字段。旧实现来自起始 HEAD，四组输入（含任务移动、增删、全部设置、无变化和 coarse）生成的快照逐字段相等。
- 创建与调整最终确认复用 fork-only 视图：内容区 119/120 实测分别上下/左右展示，读取目标正文、契约、任务和设置；扩展共享 renderer 以输出源行/续行锚点，调整视图 resize 后按语义行恢复，diff/full 保持独立位置。高度足够时固定操作区，至少留一个正文行；不足时可滚动整个框，1–2 行终端的反馈编辑器保留 Pi 原生焦点/光标标记。创建提案显示层保留原始空行和完整中段；普通问卷和 RPC/basic host 仍走原路径。
- 已运行 174 项 Goal-X 目标草拟、创建问卷/RPC、调整语义/历史快照和双模式布局测试，全数通过；追加宽屏字段与长中文完整浏览用例也通过（目标布局套件 5/5）。`pi-components` build/typecheck 和新增锚点测试 10/10 通过，Goal-X typecheck 单独重试通过；首次与其他大型检查并发执行的 typecheck 在 180 秒外部超时，没有产出诊断，随后独立执行成功。测试日志 `/tmp/goal-group3-final-tests.log`、`/tmp/goal-layout-final-focused.log`、`/tmp/goal-group3-typecheck-retry.log`。
- 新建 fork-only `fork-confirmation-viewport.ts` 和 `fork-goal-confirmation-format.ts`；`goal-draft.ts` 与 `goal-questionnaire.ts` 仅接入显示格式/创建最终确认 seam。`docs/goal-tweak-diff.md` 说明 120 列内容阈值、双高度模式、键盘回退与结果快照。鼠标、独立打包与真实 TUI 均属于后续任务，尚未完成。

## 最终确认框鼠标交互（OpenSpec 4.1–4.4）

- 两个最终确认复用 fork-only `ConfirmationMouse`，由最终窗口行与真实可见文本列发布命中图。决策行完整点击只选中；独立确认控件执行当前选项；审计和 diff/full 通过同一权威状态路径切换。终端不足以显示完整标签时提供 `[OK]`、`[A+]`/`[A-]`，1–3 列退化为单列可见控件，不让被截断的标签生成隐藏命中区。
- 有符号滚轮在框内消费且限制视口，包括首尾和短内容；框外、按下、释放、拖选与未处理的事件交给宿主。编辑器按最终裁切行和偏移转换局部坐标并调用原生 `Editor.handleMouse`；不读取或修改宿主选区、链接或全局鼠标输入。
- 确认、审计与只读视图单击延迟 520ms；第二次 press 取消首击。按下/待定动作由不可逆代次失效，覆盖宽高、选项、视图、正文滚动、审计、可观察浮层、组件关闭及事件上观察到的尺寸往返；相同布局重绘及单击后的普通指针移动不会取消合法动作。完全无事件、无重绘的外部瞬时变化无法被组件观测，不声称拦截。
- 真实组件测试 17/17，包括一次真实计时器、创建/调整的确认与反馈、可见首末列/邻接空白、续行、1–3 列、短内容、编辑器本地坐标、双击/拖选、七种往返及浮层事件。创建/调整/语义/原问卷回归合计 191/191，Goal-X typecheck 通过；共享组件测试 10/10，tool-display 编号/换行及快照 8/8（首次误用 vitest 执行 node:test 文件报无 suite，改用 `tsx --test` 通过）。日志 `/tmp/goal-confirm-mouse-dev5.log`、`/tmp/goal-mouse-regression.log`、`/tmp/goal-mouse-typecheck.log`、`/tmp/tool-after-mouse-retry.log`。
- 共享 diff 对纯 ASCII 行使用等价定宽快速路径，130,000 行布局回归由该环境约 13 秒降至约 2 秒，空格与非 ASCII 仍按既有安全/grapheme 语义处理。此前工作树的 git index patch SHA-256 仍为 `cd16decbbe83cc0a672000cce943f2d9edf87ca87243f2087d2fbcd11db02e16`，与实施前完全相同。真实 Pi 验收仍待第 6 组，不能把组件测试当作录屏验收。

## 独立打包与兼容门禁（OpenSpec 5.1–5.4）

- 两个消费者各自经 `scripts/fork-stage-diff-consumer.mjs` 生成独立 `dist-pkg`，仅在自身包内携带私有组件的编译 `diff.js` 和 `diff.d.ts`，导出不指向 TypeScript，不包含 transcript 子路径；workspace 范围在 staging 解析为具体版本。打包前构建组件，tool-display 同时保留原类型构建和 postinstall。root release gate 现对两种单包选择均先构建组件，并验证真实 tar 中 bundle 身份、JS/类型入口与无 transcript 约束。
- 两个真实 tarball 经 `scripts/release.mjs` 导出的 `pack` 完整门禁（安全路径、packed manifest、嵌入依赖、fork changelog）通过：`/tmp/goal-confirm-release-gates/{goal,tool}`，详细输出 `/tmp/goal-confirm-real-pack-gate.log`。独立 npm 安装 `/tmp/goal-confirm-install-goal`（另安装真实 subagents tarball）与 `/tmp/goal-confirm-install-tool` 均成功；各自 `createRequire` 解析到自身嵌入的 diff.js，Node 动态 import 成功，独立 TypeScript 类型探针通过。subagents 自身嵌入的 compiled transcript 也独立导入成功。真实 Pi/TUI 启动和合装录屏仍属第 6 组。
- D-08 定向调整为允许必要的 diff 依赖而禁止任何 Goal-X transcript 导入，并保留 `/goal-audit`、运行态等原断言；包/审计测试 17/17、既有审计事务及任务树 69/69、release 脚本 52/52 通过。两个 subtree 审计分别为 goal 757 检查、8 declared、0 undeclared/stale；tool 73 检查、0 undeclared/stale。fork identity/changelog、146+4+12 测试清单 selfcheck、frozen 离线安装均通过。
- 本变更的上下文记录保留在各自 subtree 元数据及 fork changelog；原暂存 patch SHA-256 未变。完整 release CLI 的 archive gate 会按现有规则拒绝仍活跃的 OpenSpec 变更；用户明确禁止归档，因此这里只报告真实 pack 子门禁与 release 测试，不声称跳过该 gate 后完整发布检查已通过，也没有提交或发布。

## 真实 Pi 验收进行中（尚未完成 6.1–6.3）

- 宿主持久 tmux 默认 socket 可连接；第一次错误地检查 `-L host`（该命名 socket 不存在），随后以 `TMUX_TMPDIR=/tmp tmux ls` 确认实际 `host` 会话可用。asciinema 3.2.1；从独立 npm 安装的包路径显式加载真实 Pi 1.5.2，禁用自动发现，不依赖工作区源码。四次录像 Pi 与 recorder 退出均为 0，均有无害的 one-dark 缺失主题回退警告。
- `/tmp/pi-e2e-goal-confirm-solo-01/recordings/run-OOFyQt` 是修复前的探索录像：SGR 注入点击继续行仅选中，再点击确认进入编辑器并返回 `tighten tests`；123 列框/120 内容列实际左右排列、122/119 列上下排列。发现连续三个滚轮事件仅滚动一步，属于失败证据，不作为最终通过。
- 修复为绘制前无命中图时连续滚轮安全累积；真实组件 17/17 通过并新增 burst 回归。以重新打包并离线独立安装的修复版运行 `/tmp/pi-e2e-goal-confirm-solo-02/recordings/run-23tIlZ`，三次 SGR 连发精确滚动三行；默认确认、差异/全文切换和审计开关验证通过。fixture 提案不是真实模型生成，SGR 事件不声称来自物理鼠标。
- `/tmp/pi-e2e-goal-confirm-tool-solo-01/recordings/run-qYql8z` 仅安装 tool-display 并在真实 Pi 显示 fixture edit/write 的原生产渲染器左右差异；`/tmp/pi-e2e-goal-confirm-multi-01/recordings/run-oJ9qfV` 独立合装后显示同一 fixture edit/write 和目标差异，并以 SGR 切换全文。这些是 fixture 驱动显示，不冒充真实工具执行或模型回合。
- 四个录像已在 tmux 中完整 replay，命令 `asciinema play --idle-time-limit 0.2 <session.cast>` 均 exit 0；目前仅保存了播放结束后的 pane 历史，关键中间帧的视觉重放检查仍须执行。还需修复版验证选择/反馈、拖选、视口首尾不穿透、极窄矮屏及 119/120 resize 的完整断言，真实目标生命周期和事件证据、工具实际执行及逐场景追踪均未完成；不得勾选 6.1–6.3。

### 补充真实 TUI 与当前回归

- 修复版 `/tmp/pi-e2e-goal-confirm-solo-03/recordings/run-nQ8Ijr`：SGR 滚轮直达末尾含多级子任务，继续滚轮前后全屏 `diff -u` 为零；拖选确认控件后对话框仍在，录像的 OSC 52 解码为 `onfirm selecti`，证实宿主选择复制路径。70×22 缩放后通过键盘选择继续、输入 `resize feedback` 并获得 fixture 返回值。真实 Pi/recorder 与完整重放退出均为 0；重放中间帧 `/tmp/goal-confirm-replay03/{07,15,23}.txt` 已检查。
- 修复版 `/tmp/pi-e2e-goal-confirm-width-01/recordings/run-fWvPvb` 在实际框宽 123/122（正文 120/119）分别显示左右/上下；`/tmp/pi-e2e-goal-confirm-fields-01/recordings/run-nNSn6p` 滚至底部，实际显示契约旧/新、parent/child 按 ID 变更及预算 100/200。`/tmp/pi-e2e-goal-confirm-long-01/recordings/run-izXBNH` 实际显示左右各多行中文续行与末尾标记，鼠标选中取消后 Enter 返回 cancel。各录像及重放退出均 0；复播帧 `/tmp/goal-confirm-replay-{width-01,fields,long}`。
- 修复版 Goal-X 全量单元 1766/1766、integration 通过（含 SDK 10 项），tool-display 全量 776/776，pi-components 49/49；三包 typecheck、全仓 prettier、fork divergence、release 52 项、OpenSpec strict、两个 tar 的文件/manifest/嵌入组件检查均通过。以上 fixture 不调用真实模型，也不声称真实 edit/write 工具执行；渲染使用已安装 tarball 的生产函数。此前拒绝活动 OpenSpec 的 release archive gate 保持原样。

## 独立审计驳回后的修复与补验

- 首次独立审计因缓存的 `axonhub/gpt-6.1-sol` 不存在而无法启动。经用户明确同意，将被 git 忽略的项目本地审计模型改为 `axonhub/gpt-6.2-sol`；随后审计实际运行并驳回：主屏反复重绘高度振荡、3/4 列中文丢失、共享标题可注入换行，以及工作区隔离和生产工具路由证明不足。此前 2.2、3.4、6.1–6.4 已重新置为未完成。
- `goal-tweak-confirmation.ts` 现在将旧对话框行数从主屏 `previousLines` 中扣除，并将最终可用行限制在实际背景之外。新增 `fork-confirmation-host-frame.test.ts` 用真实 `TuiMainScreen`、内存终端、7 行聊天、35 行提案连续重绘八次：高度不振荡、确认控件始终存在且整个帧不超过 45 行。初次修复发现 46 行（上游预算的 +1），已修正并重新通过。
- 实际终端宽度小于 5 列时去掉外框和填充，保留至少两个可用单元：实际组件从 2 到 3、4 列均完整显示 `甲乙中文`；共享 diff 双栏标题将换行转换为空格，新增 old/new 恶意标题测试保证每个输出元素仅一物理行。相关组件和 host 回归 `/tmp/goal-audit-fix-tests2.log`（41/41）、`/tmp/goal-audit-header-tests.log`（11/11）。
- 重打包并在 `/tmp/goal-audit2-installed-{goal,tool,multi}` 离线安装；真实 Pi 由 `/tmp/pi-goal-masked-run` 在 bubblewrap 中运行，根只读、仅 `/tmp` 可写、仓库前缀被 tmpfs 覆盖。进程内 fixture 检查 `package.json` 不可见并在各录像显示 `ISOLATION PASS: workspace masked`；测试结束后删除了临时认证材料。
- 独立 tool 录像 `/tmp/pi-e2e-goal-isolated-tool-02/recordings/run-jIRFai` 中，真实模型（非 fixture）调用 Pi 内置 edit/write，插件生产结果路由显示 `old text` / `new text` 并排及创建文件；验证 `sample.txt` 和 `generated.txt` 实际字节。合装录像 `/tmp/pi-e2e-goal-isolated-multi-01/recordings/run-LnZwvt` 同样运行真实 edit/write，另加载安装版 pi-mouse-events 与 pi-starline 后以 SGR 操作 Goal-X 差异/全文和滚轮（3 行）；重放帧 `/tmp/goal-audit2-replay-multi-visual/{33,35,36}.txt`。单 Goal-X `/tmp/pi-e2e-goal-isolated-goal-01/recordings/run-vgwxTb` 在隔离进程内验证创建选中/确认/反馈及 120/119 内容区。
- 以上三次 Pi/recorder 都为 0，asciinema 全程重放均为 0；key frames `/tmp/goal-audit2-replay-{tool-02,goal-01}`。第一次隔离 tool 尝试因只读原 agent 目录无法创建认证锁而无可用模型（`tool-01/run-tCaG02`），保留失败证据；随后用权限 0700 的临时 agent 目录运行，销毁副本。录像不包含凭据。
- 修复后重新运行：Goal-X 单元 1770/1770（并发运行首次 1769/1770，既有 settings lock 两秒超时；单独重跑全量通过），integration 35+10，tool-display 776，pi-components 50，三包 typecheck、release 52、全仓 fork-divergence 和 Prettier 均通过。日志 `/tmp/audit2-{goal-unit,goal-unit-retry,goal-integration,tool-unit,components-unit,types,release,fork,prettier}.log`。源码与原暂存 patch 保持隔离，index hash 仍为 `cd16decbbe83cc0a672000cce943f2d9edf87ca87243f2087d2fbcd11db02e16`。

## 第二轮独立审计后的修复与最终产物补验

- 独立审计真实复现：fullscreen 中宿主改变组件屏幕原点再恢复时，press 或待执行点击可能复活。新增 fork-only `fork-confirmation-host.ts` 只读观察已提交 host 布局的实际矩形、clip、行偏移及可分配高度；下一次组件绘制与提交后的微任务均不可逆地失效旧手势，定时器执行时再检查当前几何。`fork-confirmation-alt-host.test.ts` 使用真实 `TuiAltScreen`、真实 SGR 分发验证 press/pending 两种位置往返，并有真实完整点击成功的阳性对照及 10 行底部组件场景（4/4）。
- 普通屏幕的历史聊天是 scrollback，不应全部占用弹窗；可见背景预算上限为屏幕的四分之一，并从上一帧扣除旧对话框。真实 `TuiMainScreen` 以 7/43/80 行聊天分别对创建与调整反复重绘，六种情况确认控件保持可见；fullscreen 按宿主 committed layout 扣除相邻组件并重新绘制，防止被裁切。回归见 `/tmp/audit3-host-tests.log` 与 `/tmp/audit3-focused-all.log`。
- `sanitizeInline` 先区分字面反斜线与实际换行、回车、tab，再做安全转义；根契约与同 ID 任务契约的真实空行与字面 `\\n` 均显示不同且被判为变更，全文亦不同。`fork-goal-semantic-diff.test.ts` 覆盖此复现，同时保留旧常规快照和历史结果不被重算。
- tool-display split 委托输出不再将整个数组展开为 `push` 参数；`fork-huge-diff.test.ts` 以真实 130,000 行 edit payload、120 列 split 和折叠视图通过（`/tmp/audit3-huge.log`）。
- 两消费者在 `publishConfig.directory` 保留独立 staging，同时设置 pnpm 原生 `linkDirectory: false`，工作区依赖恢复指向源码。使用 bubblewrap 分别遮蔽两个 `dist-pkg` 目录后，pi-openspec-x 的 Goal-X 模块与 pi-sandbox 的 tool-display provider 真实导入成功；`scripts/release-core.test.mjs` 也检查工作区 realpath，frozen lockfile 安装通过，打包产物仍各自包含 compiled diff。
- 最终 tarball `/tmp/goal-audit3-packs/{goal,tool}` 分别独立或合装到 `/tmp/goal-audit3-installed-{goal,tool,multi}`，在 bubblewrap tmpfs 遮蔽工作区运行真实 Pi。`/tmp/pi-e2e-goal-audit3-goal-01/recordings/run-tfCO2E` 证明工作区不可见、滚轮底边前后全屏无差异、确认控件拖选的 OSC 52 解码为 `onfirm selecti`、70×22 降级、反馈及 120/119 内容列。`/tmp/pi-e2e-goal-audit3-tool-01/recordings/run-ETp1gU` 与 `/tmp/pi-e2e-goal-audit3-multi-01/recordings/run-5H79BV` 均由真实模型触发内置 edit/write、生产展示路径及实际磁盘内容；合装加载安装版 mouse-events/starline 并验证 SGR 切换和滚动。三个 Pi/recorder/完整重放退出均 0，抽帧 `/tmp/audit3-replay-{goal,tool,multi}`；fixture 提案与真实模型工具操作、SGR 与物理鼠标明确区分。临时 0700 认证目录已销毁。
- 最终工作树与独立安装确认组件 SHA-256 均为 `16a5523922ca5a9c107be9c001e32303ecf06d3b5b7efa2dff0f732bf1b61548`；语义模型、宿主几何与 tool-display 入口的源码和安装包摘要也逐一相等。所有消费者的 compiled diff 使用同一字节；原暂存 index SHA-256 仍为 `cd16decbbe83cc0a672000cce943f2d9edf87ca87243f2087d2fbcd11db02e16`。
- 最新 Goal-X 完整单元 1780/1780（首次全套因测试 adapter stub 不导出 TuiAltScreen 失败，改用真实 SDK 深路径后完整重跑通过）、integration 35+10，tool-display 777，pi-components 50，三包 typecheck、release 53、两个 subtree 及全仓分歧、fork changelog/identity、Prettier、OpenSpec strict、白空检查均通过。日志 `/tmp/audit3-{goal-unit,goal-unit-retry,goal-integration,tool-full,types,release,fork,prettier}.log`；组件包完整结果 `/tmp/audit2-components-unit.log`。

### 第三轮审计后的修复与最终产物复验

- `hostDialogGeometry` 现在通过 `Container.mouseLayout` 的缓存子项找到实际 Pi `editorContainer` 的对话框，并计算宿主屏幕原点及可用区域。由于初始提交可能仍是旧编辑器的 3 行布局，提交后的可用高度变化也会请求重绘；先前只在裁切时重绘的版本会卡在 3 行。`fork-production-viewport.test.ts` 在无 SDK stub 的子进程中使用真实 `createChatViewport`、`Container`、`TuiAltScreen` 和 SGR，覆盖原有短编辑器切换、10 行 footer、两个框、正常点击、pressed/pending 原点往返。去掉可用高度变化重绘时，5/5 用例失败；修复后 5/5 通过。
- 语义 diff 的 UI 和 legacy 持久化文本分离：制表符及字面反斜线在 UI 可区分，比较使用真实原始值；普通反斜线路径的历史纯文本格式由从旧实现生成的冻结样例保障，只有原显示完全碰撞时例外修复。基础 select 回退同样使用已消歧的语义行。共享 diff 的 metadata 行改为逐项追加，119/120 列各 130,000 行测试通过。
- 最终 Goal-X 单包 `/tmp/pi-e2e-goal-audit6-goal-01`：工作区被 bwrap 遮蔽，进程内 `ISOLATION PASS`；120 列左右长中文续行、根及父子任务契约、预算旧/新对齐，滚轮到末端后屏幕逐字相同；SGR 点击只选中取消，再单击确认返回 fixture cancel；119/120 切换、创建反馈、70×22、SGR 拖选产生一次 OSC52 复制均有录屏。候选由 fixture 提供，不是模型生成；SGR 注入不代表物理鼠标。
- 合装 `/tmp/pi-e2e-goal-audit6-multi-01`：同样遮蔽工作区，加载安装版 Goal-X/subagents/tool-display、mouse-events、starline；真实 deepseek-v4-flash 调用 edit/write 生产工具，SGR 滚轮及键盘全文切换可用。tool-display 单包使用 `/tmp/pi-e2e-goal-audit5-tool-01`（其 tar SHA-256 `f0f7353aee75857b9d6f4ff80327013bf41d2ccc7646c4b55e373dbd9bd45495` 与最终 audit6 tool tar 一致），真实模型调用 edit/write。三个 Pi、asciinema 和 tty 回放退出码均为 0。
- 最终源码与 goal 安装版 `goal-tweak-confirmation.ts` SHA-256 均为 `e65c8448bab004ca803fe2908e8a256a8f23790587fc9dd2b2635ceaba01915c`；`goal-tweak-diff.ts`、`fork-confirmation-host.ts` 源码与安装文件逐一相等。两插件内三个共享 diff JS 副本 SHA-256 均为 `4fe6803d82bd4a5fa4291cab8d8749674ed52cdfa2bc3f54103d76ff07a459f0`；tar/manifest/shared-diff 校验均通过。最终录屏替代上述 E3（E3 仍是历史证据，不再代表最终代码）。
- 最终完整测试：Goal-X 1,783，tool-display 777，pi-components 51，pi-btw 263，Goal-X integration 10，release 53；三个包 typecheck 通过。Goal-X 子代理随包的既有 `transcript` 入口可从编译 JS 导入；pi-btw 的 transcript-presenter 源码消费者测试通过。未声称 subagents 随包中未使用的 `transcript-presenter` 子路径可导入：其既有暂存清单仍指向不存在的 TS 源，此问题不由本次改动引入，且用户边界不授权修改 subagents。

### 第四轮审计后的修复与隔离补验

- 宿主容量改以 root 视口和各层固定兄弟占用计算；可增长 transcript 只保留最小行数，不再把对话框自身上一帧的 dock 裁切当作下一帧容量。实际 Pi `createChatViewport` + `Container` 的 45→10→45→60 恢复、0/10 行 footer、两个确认框、反馈 Esc 返回及正文锚点保持在 15 项真实 SDK 子测试中覆盖。对仅 1 行的 Pi viewport，原生 dock 同时要求 transcript 至少 1 行而不给 editor 任何行；仅在该高度启用原生、非捕获 overlay，复用对话框自身渲染和焦点，使正文、决策和滚轮仍可达，恢复高度后自动隐藏。另测真实更高优先级浮层覆盖、关闭与焦点恢复；不注册全局鼠标拦截。
- 每个滚轮步长即时在当前视口边界钳制，而非等下一次绘制；实际 fullscreen SGR 末尾先下后上在同一帧恢复上移一步。新增/删除任务的 UI 使用独立消歧转义；currentTaskId 与缺省值比较原始身份，包括合法 `(none)` 和真实换行/字面反斜线，常规旧文本快照维持不变。
- 最终 E5 录屏：`/tmp/pi-e2e-goal-audit8-goal-01` 和 `/tmp/pi-e2e-goal-audit8-multi-01`；两者 bwrap 遮蔽工作区，最终 tarball 文件与当前源码哈希相等。创建 fixture 包含空行及三级任务，实际 Pi 缩放 45→10→45→60 与 1 行翻页后恢复；调整框同样缩放恢复、反馈 Esc 返回、119/120、中文续行、契约/父子任务/预算左右对齐、SGR 点击先选再取消、末端下再上由 `▲ 6` 到 `▲ 5`。单包和合装均有 SGR 滚轮，合装真实 deepseek-v4-flash 调用 edit/write；选择复制 cast 有一次 OSC52。所有 Pi、recorder、tty replay 退出 0。fixture 是测试提案而非模型生成，SGR 是注入而非物理鼠标。
- OSC 8：goal fixture 在宿主 widget 绘制真实链接，并对真实 Pi `openUrl` 回调加只记录后调用原函数的测试包装；SGR 点按由宿主实际激活 `https://example.test/goal-link`，见 `/tmp/audit8-link-debug` 的 `OPEN`，对话框仍保持打开。独立 SDK 子测试另用真实 fullscreen link dispatcher 和 `openUrl` 回调验证同一行为；不是模拟“宿主已消费”的单元测试。
- 最终测试：Goal-X 1,785/1,785（15 个真实 SDK 子场景由父测试启动），typecheck 通过；其他未变的 tool-display 777、components 51、pi-btw 263、integration 10 和 release 53 见先前记录。最终两个 tar 检查通过；tool tar 与 audit5 单包真实模型工具录屏的 tar SHA-256 均为 `f0f7353aee75857b9d6f4ff80327013bf41d2ccc7646c4b55e373dbd9bd45495`。E5 取代上述 E4 的最终产物声明。
- 维护信号：新增的 host 几何遍历与现有确认框渲染/鼠标分支复杂度仍高；后续重构应保留生产组件树、焦点和逐步钳制回归，不得仅凭直接挂载的测试简化。

### 第五轮审计后的键盘与语义回归

- Fullscreen Pi 会先于普通编辑器处理 PgUp/PgDn 与 Ctrl+↑/↓。不新增全局输入监听器：在现有尺寸门控单行原生浮层旁注册一个零高度的 Pi 原生焦点组件，焦点在确认框时将键盘输入交还确认框；宿主因此按自己的 overlay 焦点规则让出翻页键。组件不绘制内容，不接管鼠标，在单行时把焦点交回原来的单行显示浮层，并在缩放恢复和关闭时还原；实际外部浮层仍优先。由于 Pi 将此原生焦点组件视为可见 overlay，确认框自身只忽略其两个自有焦点/单行表面，其他 overlay 仍触发手势失效。真实 SDK 子进程关闭鼠标并测试创建/调整 × 45/5 行 × 10 行 footer 的 PgUp/PgDn、Ctrl+↑/↓、正文和确认控件可达；还测试单行、真实链接、原点往返和外部浮层。
- 父任务现在比较真实 ID，未设置与合法 `(none)` 在 diff 和 UI 中分别显示 `(none)` / `"(none)"`；完整 UI 的 currentTaskId 同样区分两者。新增/删除已跳过任务时包括 skip reason。使用真实 `convertFlatTasks` 与 `projectTweakCandidate` 构建移动及删除候选，119/120 渲染和普通历史快照均受测试。
- E6 最终遮蔽工作区录屏：`/tmp/pi-e2e-goal-audit9-goal-01/recordings/run-XDLaWm/session.cast` 记录创建框三级任务、无鼠标 PgDn、5 行翻页、119/120、真实 OSC8 激活和 OSC52；`run-AZikz3/session.cast` 验证鼠标先选中再确认取消；`run-Vi5kOD/session.cast` 记录调整框 5 行无鼠标翻页到独立确认控件、反馈与 70×22 后恢复。合装 `/tmp/pi-e2e-goal-audit9-multi-01/recordings/run-sSw2gl/session.cast` 同时验证 PgDn、SGR 滚轮及真实模型 edit/write。工具单包沿用字节相同的 audit5 tool tar 录像。所有 Pi、recorder、重放退出 0；SGR 为注入，目标提案为 fixture。
- 最终 Goal-X 完整测试 1,786/1,786，真实 SDK 子测试 19/19，Goal-X integration 10/10，typecheck 通过；release 53/53、两 subtree 分歧、changelog 和 identity 门禁均通过。最终 Goal-X tar 源码与安装文件逐项哈希相同，两个插件的打包 diff JS 字节一致。E6 取代 E5 的最终产物声明。

### 第六轮审计后的阅读锚点与动作标签

- 固定正文和极矮整框之间切换时同步正文语义锚点；极矮模式继续浏览后切回固定模式时使用最新锚点，而不是复用旧的固定视口位置。极矮模式下再次改变宽度也重排同一语义位置。真实 `createChatViewport`/`editorContainer` 的创建与调整两种框、鼠标关闭及 10 行 footer 场景均覆盖。
- `pi-components` 的 split 行锚点只包含在该行真正有文本的左右来源，不再把已结束的短侧标记到另一侧续行。真实宿主测试用 `OLD-SHORT` 对 90 行长新值，在 130→122→130 列、45→5 行及极矮模式再次变宽时保持同一个 `NEW053`。原有 tool-display 的 2,880 组合迁移回归仍随完整 777 测试通过。
- 独立确认控件现在根据高亮项显示 Create、Apply、Refine、Cancel 或 Full/Diff view；较窄空间采用对应短标签/不同符号。正常及 5 行屏幕下每个动作均由真实宿主测试，保留先选再确认及默认项直接确认语义。
- 最终 E7 `/tmp/pi-e2e-goal-audit11-goal-01/recordings/run-IfYLxN/session.cast` 在 bwrap 遮蔽源码运行最终 tar：固定/极矮切换前后分别保留 `CREATE body 14` 和浏览后的 `CREATE body 17`；split 单侧续行在宽、窄、极矮及恢复中均为 `NEW053`；5 行中独立控件显示 `[Confirm selection] Cancel`。录屏同时包含 119/120、父子契约和预算、OSC8 实际激活、OSC52 拖选、反馈、默认确认和选择取消。提案/非对称差异是 fixture，SGR 由 tmux 注入。
- 最终合装 `/tmp/pi-e2e-goal-audit11-multi-01/recordings/run-r4du0D/session.cast` 包含键盘、SGR 和真实模型 edit/write；工具单包 `/tmp/pi-e2e-goal-audit10-tool-01/recordings/run-3qWud0/session.cast` 使用与最终 audit11 字节相同的 tool tar。三次 Pi、recorder 和 tty replay 退出均为 0，工作区均被遮蔽。
- 最终 Goal-X 1,786/1,786（其中宿主子套件 24/24）、pi-components 52/52、pi-tool-display 777/777、integration 10/10、release 53/53；三个包 typecheck、两 subtree 分歧、changelog 和 identity 检查通过。根格式、OpenSpec strict 和 whitespace 检查见最终门禁。E7 取代 E6 的最终产物声明。
- 维护信号：`TweakProposalDialog.render` 圈复杂度相对基线 21→71，应在后续独立重构中保留锚点、不同高度/宽度与逐动作命中行为，不在本交付中扩大重构范围。

### 第七轮审计后的源位置锚定与逐视图布局

- 共享 diff 的每个可见来源现在提供消毒后 UTF-16 源文本起始位置；每次重排查找包含该位置的可见行，而不是把旧视觉续行序号套到新的列宽。锚点仅在用户实际滚动时更新，普通重排不会反复向前漂移；继续保留 grapheme 和硬换行，极窄不可容纳字符的显式占位仍能推进正确的源位置。
- 固定/极矮布局状态按 diff/full 分别维护。未显示的视图在缩小后第一次切入极矮布局时，从自己的阅读锚点初始化，而不是沿用另一个视图的全局布局状态。真实 Pi SDK 的生产 `buildTweakComparison` 测试涵盖无硬换行 600 片段、130↔122 列重复五次，以及 diff/full 各自滚动、缩到 5 行后反复切换。
- 最终 E8 `/tmp/pi-e2e-goal-audit12-goal-01/recordings/run-aGVZHL/session.cast`：生产语义构造器的单个长逻辑行宽屏顶行 `NEW249`，窄屏仍可见 `NEW249`，回宽屏顶行回到 `NEW249`；同一生产构造器的 diff `NEW011` 与全文 `NEW027` 在缩到 5 行并往返切换后各自保留。另记录真实 OSC8 回调、OSC52、空行/三级任务、119/120、语义字段、反馈、1 行、先选再取消和默认直接确认。提案为 fixture；鼠标是 SGR 注入，不声称物理鼠标。
- 工具单包 `/tmp/pi-e2e-goal-audit12-tool-01/recordings/run-a1G9fP/session.cast` 和合装 `/tmp/pi-e2e-goal-audit12-multi-01/recordings/run-9VG5au/session.cast` 均在 bwrap 遮蔽源码下运行最终打包产物，真实 deepseek-v4-flash 调用 edit/write；合装键盘和 SGR 滚轮从 `▲ 21` 到 `▲ 22`。三个 Pi、recorder、TTY replay 均退出 0。E8 取代 E7 的最终产物声明。
- 完整测试：Goal-X 1,786/1,786（真实 SDK 子测试 26/26），components 53/53、tool-display 777/777、integration 10/10、release 53/53；两个 subtree 分歧门禁通过。首次并行 Goal-X typecheck 使用旧 components 声明而失败；先构建更新后的 components，再运行 Goal-X typecheck 已通过。最终 tar、源码与私有共享 JS 哈希核对见 verification.md。

### 第八轮审计后的高度与明确回顶锚点

- 高度变化按各视图重新应用语义锚点，临时可见起点受容量钳制不改写阅读位置。全部可见或部分扩高再恢复，创建、diff 和全文均回到相同首行。
- 用户实际滚回顶部时显式存储顶部锚点，避免无源坐标的并排表头保留旧中段锚点。真实 SDK 回归及最终独立包的高度、宽度往返证据见 `verification.md` E9。

### 第九轮：可全显布局进入极矮布局

迁移至整框滚动时从保存的正文锚点计算起点，不再沿用可全显布局临时归零的显示偏移。同宽、同内容也必须重新定位。用户滚至极矮布局的正文首行时显式记录顶部锚点，涵盖无源坐标的并排表头。四项真实 SDK 回归以及 E10 最终安装验收见 `verification.md`。

### 框内滚轮与不相交浮层

确认框继续按浮层可见性使旧点击失效，但处理 Pi 已派发给它的滚轮；Pi 负责优先向覆盖指针的浮层派发。这样无覆盖的浮层不会让框内滚轮穿透聊天，也不引入全局事件监听。真实 SDK 回归和最终包录屏见 `verification.md` E11。

### 非捕获浮层旁的有效新手势

尊重 Pi 对覆盖坐标的优先路由；稳定、非捕获的外部浮层不再否决 Pi 已派发给确认框的新单击。手势签名仍包含外部浮层身份、顺序、可见几何及捕获策略，编辑器的原生定位也要求同一可观察状态下的按下/单击。未知宿主或捕获浮层继续保守屏蔽底层点击；滚轮语义不变。证据见 `verification.md` E12。

### 框外原生聊天拖选与键盘焦点

移除大于一行时可见的零高键盘代理，否则会触发 Pi 的 `hasOverlay()` 与屏幕式选区。较新 Pi 由组件声明 `capturesViewportInput`；仅对没有该协议的旧版 fullscreen SDK，使用可清理、仅当该对话框持焦点时生效的单渲染器键盘优先级兼容接缝，不注册输入监听或接管原生鼠标派发。单行时才显示原生浮层。真实 SDK 及最终 tar 的边缘拖选、多行复制与键盘同验见 `verification.md` E13。

### 合并重绘与分离键盘路由

在每次宿主请求绘制时同步观察尺寸变化，尺寸尚未绘制也能令旧按下、待执行确认及编辑器手势失效。确认框只对其配置中实际处理的四种正文滚动键申请宿主优先级；其余键及全部鼠标由原生宿主照常派发。接缝限定在活跃对话框及当时的渲染器，关闭时清理。不改 Pi 源码、不新增全局监听。回归及录屏见 E14。

### 合并重绘时的原生浮层显示及隐藏

现有 per-renderer 绘制通知接缝同时同步观察可见外部浮层身份、顺序和捕获策略。绘制尚未发生时也能作废旧手势，不使用绘制期间暂态的浮层边界判断通知变化；正常绘制后仍按几何验证。稳定浮层旁的新手势和普通重绘保持有效。真实 SDK 与源码遮蔽安装证据见 E15。

### 根验证契约的全文消歧

只读全文 UI 使用与语义 diff 一致的契约值格式，将未设置的 `(none)` 与实际值 `"(none)"` 区分。候选、事务及历史 `fullText` 快照格式不变。SDK 和源码隔离验证见 E16。

### 极窄反馈编辑器

反馈模式在 7 列以下去边框，原生 Editor 始终至少获得 3 个逻辑列（双宽字符加光标预留）。物理终端不足时仅裁剪绘制，不截断草稿；虚拟宽度与显示宽度不符时不发布指针命中。真实 SDK 与源码遮蔽的两框缩放、草稿恢复及提交证据见 E17。

### 反馈按实际字素测量

`fork-confirmation-feedback-editor.ts` 按 `Intl.Segmenter` 字素及 Pi 的 `visibleWidth` 计算原生编辑器最小安全宽度，预留光标列；粘贴后同批次导航在首次重绘前也会刷新编辑器布局。物理窄屏仍裁剪显示，保持草稿、原生编辑和事件处理，避免假设所有字素至多两列。SDK 与源码隔离验收见 E18。

### 窄屏字素和硬件光标

共享 diff 仅在标记占用的宽度会遮挡本可容纳的字素时将标记移至单行，源偏移跟随同一布局。反馈编辑器的硬件光标需要独立于裁切保留：光标与字素不能同时容纳时额外显示光标行，既保留字素又向 Pi 发布光标标记。真实生产宿主测试与隔离验证见 E19。

### 反馈虚拟行的窄屏映射

`fork-confirmation-editor-reflow.ts` 将原生 Editor 的虚拟行按物理宽度以字素边界重新分行，同时保存物理行到原生虚拟行/列的反向映射，交还原生鼠标定位；过宽字素使用占位，不丢失其后可显示的普通文本。焦点标记与虚拟光标重新生成，避免终端假光标转义在分行时吞字。E20 的真实 SDK 和独立安装录屏覆盖该交互。

### 物理换行键盘导航与 RPC 能力探测

窄屏反馈的上下键使用与绘制、原生鼠标一致的物理行映射，再交由原生编辑器定位；不再只依据虚拟宽度移动。创建确认仅依据 custom TUI 实际能力选择富界面，不因 RPC 标签直接禁用；无法渲染或抛错仍安全回退。见 E21。

### 可见光标的同帧同步与键位

重排行方向导航使用 Pi 当前的 editor cursorUp/cursorDown 键位定义，而非硬编码物理箭头；每次原生输入后立即刷新窄屏映射和可见光标，使后续同批输入不依赖宿主重绘。真实 SDK 对连续输入、重映射方向键及 Ctrl+P 的覆盖和隔离验收见 E22。

### 跳过虚拟填充行

物理导航遇到原生 Editor 将目标夹回相同逻辑光标的填充片段时继续查找，避免困在行尾；空的下一逻辑行仍可由不同的逻辑行索引识别。E23 记录真实 SDK、隔离 Pi 复现及 E22 测试记录更正。

### skipped 删除的旧文本隔离

新增/删除任务的遗留文本与 UI 行分别生成：跳过原因仍可在 UI 的旧值看到，但不会进入旧 `diffText` 或后续结果快照。来自改动前 HEAD 的基线和 review 结果双重回归，以及隔离 Pi 验收见 E25。

### 消歧 UI 与遗留快照独立

任务字段和设置分别决定旧文本变更与 UI 语义变更；根契约旧文本维持原始转义，即使旧表示本身有歧义，UI 仍独立显示真实差异。遗留 summary/changedSections 与文本均不被 UI 独有行污染；真实有效候选、HEAD 固定基线、工具快照和隔离 Pi 验收见 E26。

### 正文与无法容纳的字素

正文投影原样保留普通反斜线，实际控制字符用明确可见标签表达；其他身份字段仍保留必要消歧。共享 diff 对大于物理宽度的字素输出可还原 Unicode 码点表示，跨行保留同一来源偏移。真实有效候选、1 列 Pi 录屏与回归见 E27。

### 降级编码可逆和片段锚点

正文控制标签及 Unicode 降级前缀对潜在同形原文做可逆转义，不把不同内容伪装成相同文字。共享布局行增加可选 `fragment`，确认框按源偏移及片内偏移定位，以免超宽字素缩放后从首字符跳到末尾。生产 viewport、隔离 Pi 和回归证据见 E28。

### 前缀与行尾补白消歧

字面 `<` 紧邻不能容纳的字素时也按可逆前缀规则转义，避免拼接后的字面符号与生成的 Unicode 码点标记碰撞。正文 UI 明确标记行尾空格并转义字面空格标记，避免差异和全文视图的实际尾空格被布局补白掩盖；遗留文本与候选不变。回归和隔离 Pi 验收见 E29。

### 视觉行边界空格

共享文本布局在实际换行后标记每个视觉行尾的源空格，而非仅标记逻辑行末；字面 `␠` 使用码点表示避免与多空格混淆。119/120 差异及全文有效候选、源码遮蔽 Pi 屏幕和测试见 E30。

### 硬换行与 Unicode 空白

全文 UI 在逻辑行末标记硬换行，标记前的源尾空格显式显示，字面标记可逆转义，从而与软折行和布局补白区别；非 ASCII 空白和不可打印控制符以码点标签显示，保证可辨认且不执行。共享 diff 同样编码非 ASCII 空白。有效候选的真实确认组件帧与隔离 Pi 验收见 E31。

### 任务标题/规则消歧与前缀扫描

全文只读 UI 对任务标题使用可逆 JSON 引号，使标题字面后缀与轻量子任务规则分开；遗留 `fullText` 不变。共享布局一次遍历标记危险 `<` 前缀，不再对长后缀反复正则扫描。有效候选、真实宿主帧、性能对照及隔离 Pi 证据见 E32。

### 空正文 UI 占位符

全文 UI 的空正文采用可逆 `⟦EMPTY OBJECTIVE⟧`，避免与合法字面 `(empty)` 混淆；历史 `fullText` 占位符完全不变。真实有效候选、生产确认帧与隔离 Pi 验收见 E33。
