# 验证追踪：目标确认鼠标与共享 diff

## 共同证据和边界

- `C`：`packages/pi-components/tests/diff.test.ts`，共享 diff 10 项及整个组件包 50 项。
- `T`：`packages/pi-tool-display/tests/`，全量 776 项，包括原 diff、编号、provider 与 `fork-shared-diff-parity.test.ts` 的上游快照。
- `S`：Goal-X `fork-goal-semantic-diff.test.ts`、`goal-tweak-diff.test.ts`、`goal-tweak-review.test.ts`，含旧文本快照、目标 ID 与并发失效。
- `L`：`fork-goal-confirmation-layout.test.ts`、`goal-tweak-confirmation.test.ts`、`goal-questionnaire.test.ts`、`goal-rpc-dialogs.test.ts` 和 `goal-drafting.test.ts`。
- `M`：`fork-goal-confirmation-mouse.test.ts`，19 项真实组件事件测试，含有非空种子 goal/ledger 的浏览不变性测试。
- `P`：`scripts/fork-stage-diff-consumer.test.mjs`、`scripts/release-core.test.mjs`、实际 tar 检查以及 `/tmp/goal-confirm-install-{goal-fixed,tool,multi}` 中的 JS 和声明解析；`goal-auditor-package.test.ts` 验证 D-08。
- `E3`：第二轮审计修复后的最终 tar，真实 Pi 在 bubblewrap 遮蔽工作区中录制 `/tmp/pi-e2e-goal-audit3-{goal,tool,multi}-01/recordings/run-*/session.cast`；实际模型 edit/write 与插件生产路由、安装版 mouse-events/starline 共存、最终 Goal-X 拖选复制/首尾/70×22/119–120 列均有录像，Pi、recorder 和完整重放均退出 0，抽帧 `/tmp/audit3-replay-{goal,tool,multi}`。
- `E2`：独立审计后重新打包，bubblewrap tmpfs 遮蔽工作区，`/tmp/pi-e2e-goal-isolated-{goal-01,tool-02,multi-01}/recordings/run-*/session.cast` 中进程内 `ISOLATION PASS`；tool/multi 是真实模型触发的 Pi edit/write 生产路由，multi 另加载安装版 mouse-events 和 starline。各 Pi、recorder、重放均退出 0。
- `E`：`/tmp/pi-e2e-goal-confirm-{solo-01,solo-02,solo-03,width-01,fields-01,long-01,multi-01,tool-solo-01}/recordings/run-*/session.cast`。每次真实 Pi 与 recorder 的退出状态均为 0，播放均完整退出 0；`solo-01` 是滚轮连发修复前的探索证据。关键重放帧位于 `/tmp/goal-confirm-replay-{solo-02,multi-01,tool-solo-01,width-01,fields,long}` 和 `/tmp/goal-confirm-replay03`。

`E` 使用从 npm tarball 安装的源码和各自嵌入的已编译共享库，Pi 从 Nix 环境运行，禁止自动加载扩展；鼠标输入是注入 SGR 而不是物理鼠标，确认提案和 edit/write 内容由 fixture 提供，不声称模型产生提案或在原 E 中实际执行文件工具；E2 另有真实模型执行工具的证据。单包 Goal-X 另安装必要的 subagents tarball。录屏及 session 位于 `/tmp`，未上传。禁止归档的要求与 release CLI 的现有活动 OpenSpec archive gate 相容方式是运行 `test:release` 和实际 `pack` 子门禁；未声称整个发布 CLI 已通过。

## shared-diff-rendering 逐场景

| 场景                   | 已执行证据                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| 新旧行与说明共同展示   | C 成对/metadata 测试，T 上游输出快照                                                       |
| 只有一侧的变化         | C 单侧与占位测试；S 新增删除 ID                                                            |
| 长行与宽字符           | C grapheme/空白测试；E `long-01`                                                           |
| 缩放与布局切换         | C 119/120；L 实际内容区；E `width-01`                                                      |
| 颜色不是唯一标识       | C 无颜色符号测试；E edit/write `+/-` 或 old/new 标识                                       |
| 内容包含控制序列       | C ANSI/OSC/CSI 测试；L 恶意 proposal 测试                                                  |
| 不同模式与边界         | T 全量、E3 真实 edit/write 生产路由及 12 组冻结上游输出，另有 2880 组预迁移比对            |
| 其他展示入口           | T provider/presentation 全量                                                               |
| 单独安装与合装         | P 实际包 gate、遮蔽 dist-pkg 的源码解析；E3 workspace tmpfs 遮蔽下的最终 goal、tool、multi |
| 既有 transcript 消费者 | pi-subagents transcript 6/6、pi-btw 40/40；隔离安装 subagents 实际导入 compiled transcript |

## goal-lifecycle 逐场景

| 场景                   | 已执行证据                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正文局部修改           | S 目标行 diff 与上下文                                                                                                                                                 |
| 重复行与中文正文       | S 逻辑行/重复/空行及真实换行对字面 `\n`，C 宽字符，E `long-01`                                                                                                         |
| 没有实际变更           | S 空比较与明确 no-change                                                                                                                                               |
| 宽屏并排及窄屏回退     | L 真实组件 119/120；E `width-01`                                                                                                                                       |
| 多种语义字段的对应展示 | S ID/字段/预算/审计；L 各字段；E `fields-01`                                                                                                                           |
| 选择后明确执行         | M 创建与调整继续/取消；E `solo-01` 创建反馈                                                                                                                            |
| 默认选项与键鼠交替     | M 默认确认；E `solo-02` 和 `long-01`                                                                                                                                   |
| 只读切换与审计选择     | M 同一候选重投影；E `solo-02`                                                                                                                                          |
| 长目标和任务           | L 中段、空行和多级任务；E `solo-03`                                                                                                                                    |
| 长差异与独立视图位置   | L 独立位置及 resize；E `solo-02` 全文切换                                                                                                                              |
| 短内容、边界及框外     | M 有符号步长、短内容、框外和首尾；E `solo-03` 末尾前后全屏无变化                                                                                                       |
| 极矮与窄屏             | L 1–2 行光标、M 1–3 列完整目标、真实主屏 7/43/80 行聊天重复重绘与 2/3/4 列中文完整回归、真实 fullscreen 10 行底栏；E `solo-03` 70×22                                   |
| 拖选和双击不执行       | M 双击/拖动；E `solo-03` 确认控件拖选且录像 OSC 52 解码为 `onfirm selecti`                                                                                             |
| 实际可见控件边界       | M 首末列、填充、边框、裁切、标签续行                                                                                                                                   |
| 布局或浮层往返         | M press/pending × 宽高、选项、滚动、审计、视图与 overlay；`fork-confirmation-alt-host.test.ts` 真实宿主 screen-origin 往返及阳性点击；未观察的瞬时外部变化不声称可检测 |
| 链接和编辑器           | M 编辑器局部坐标、焦点、press 透传和宿主消费点击后无动作；OSC 8 链接由 Pi 宿主优先路由，未单独录制外链激活                                                             |
| 浏览与反馈不写入       | M 非空种子 goal/ledger 前后字节相等；审计事务回归 69 项                                                                                                                |
| 宿主不提供鼠标         | L 键盘、RPC/basic、无 UI 测试                                                                                                                                          |
| 并发目标变化及历史回看 | S revision/预算 admission 过期拒绝、保存快照不随目标变化重算                                                                                                           |
| 其他交互保持不变       | L 创建/Sisyphus/问卷；Goal-X 单元及审计、任务树回归                                                                                                                    |

## 总门禁

- Goal-X：完整单元 1780/1780（首次 adapter stub 导出失败后改为真实 SDK 深路径并全量重跑通过），integration 35/35 + SDK 10/10；typecheck 通过。
- tool-display：完整 777/777；typecheck 通过。pi-components：50/50；typecheck/build 通过。
- release 53/53、fork identity/changelog、全仓 fork-divergence、全仓 Prettier、OpenSpec strict、frozen lockfile 和 staged/unstaged `git diff --check` 均通过；真实最终修复版两个 tar 条目与共享依赖门禁通过。
- 实施前和现在的暂存 patch SHA-256 均为 `cd16decbbe83cc0a672000cce943f2d9edf87ca87243f2087d2fbcd11db02e16`。不提交、不推送、不发布、不归档。相关命令及具体录像步骤见 `implementation-notes.md` 和各 `steps.tsv`。

### 第二轮审计回归附录

- `fork-confirmation-alt-host.test.ts` 的 4 个用例分别验证 10 行邻接区域的实际 fullscreen 布局、真实 SGR 单击阳性对照、press 阶段原点往返、延迟阶段原点往返。`fork-confirmation-host-frame.test.ts` 验证真实 main-screen 中 7/43/80 行聊天、两个确认框及 2/3/4 列中文。
- `fork-goal-semantic-diff.test.ts` 验证实际换行与字面反斜线的根/任务契约均不碰撞；`fork-huge-diff.test.ts` 验证 130,000 行 edit 的 split 折叠结果不发生参数溢出。
- 将两个生成 `dist-pkg` 挂载为空 tmpfs 后，真实从 pi-openspec-x 导入 `@xzzpig/pi-goal-x/extensions/goal-record.ts` 和从 pi-sandbox 导入 `@xzzpig/pi-tool-display/tool-display-api-consumer` 均通过；`linkDirectory: false` 及 workspace realpath 另受 release 测试保护。
- 最终 E3 安装文件 `goal-tweak-confirmation.ts` SHA-256 与源码均为 `16a5523922ca5a9c107be9c001e32303ecf06d3b5b7efa2dff0f732bf1b61548`；语义模型、host 几何文件和 tool-display renderer 的源码与安装文件逐一相等；四份嵌入 diff.js 均为 `2351152b04ea038983417fe43702299a33e0b33209af6a3ec5be037cba8ae2f6`。最后一次 bundle 与冻结源码对应的三个 Pi 录像完整回放和退出状态见上。

### 第三轮审计：最终 E4 证据（取代 E3 的最终产物声明）

- 生产组件层级和初始短编辑器切换：`tests/fork-production-viewport.test.ts` 启动真实 SDK 的子测试；`/tmp/audit4-growth-negative2.log` 记录撤销 post-commit 高度变化重绘后 5/5 失败，`/tmp/audit4-production-parent-final.log` 记录修复后通过。按下及延迟两种原点往返与真实 SGR 正常点击均覆盖。
- 长说明行、Tab 与反斜线：pi-components `tests/diff.test.ts` 测试 metadata 130,000 行的 119/120 列；Goal-X `fork-goal-semantic-diff.test.ts` 同时验证侧列、基础 select、完整视图消歧及冻结旧格式快照。
- E4 单包 cast `/tmp/pi-e2e-goal-audit6-goal-01/recordings/run-5H9q3g/session.cast`：`/tmp/audit6-tweak-top.txt`、`/tmp/audit6-fields.txt`、`/tmp/audit6-cancel-selected.txt`、`/tmp/audit6-119.txt`、`/tmp/audit6-120.txt`、`/tmp/audit6-feedback-small.txt` 分别记录长中文、根/父/子契约与预算并排、选中再取消、119/120、反馈与矮屏；`/tmp/audit6-fields.txt` 和 `/tmp/audit6-bottom.txt` 的 diff 为空。cast 中有 1 次 OSC52；输入为 SGR 注入，提案为 fixture。
- E4 合装 cast `/tmp/pi-e2e-goal-audit6-multi-01/recordings/run-HCTgCM/session.cast`：真实模型工具结果 `/tmp/audit6-multi-tools.txt`，SGR 三步滚轮 `/tmp/audit6-multi-wheel.txt`，键盘全文切换 `/tmp/audit6-multi-full.txt`。单 tool cast `/tmp/pi-e2e-goal-audit5-tool-01/recordings/run-38IhU8/session.cast` 的 tar 与最终 tool tar 哈希完全相同；三个运行的工作区均遮蔽，Pi/recorder/replay 退出码均 0。
- 最终测试为 Goal-X 1,783、tool-display 777、components 51、pi-btw 263、integration 10、release 53；三个包 typecheck 通过。实际随包 subagents 的 transcript JS 入口正常。原有暂存的未使用 transcript-presenter 子路径指向缺失 TS，该旧问题未修改、未声称通过；pi-btw 的源码 transcript-presenter 消费者 263 项测试通过。

### 第四轮审计：最终 E5 证据（取代 E4 最终产物声明）

- 真实 Pi SDK 组件树：`fork-production-viewport.test.ts` 以无 stub 子进程运行 15 场景，包括 0/10 行 footer 的两个框 45→10→45→60、反馈 Esc 后锚点、单行 viewport 可达性、独立浮层、边界滚轮反向、实际 OSC 8 打开及旧手势往返。`fork-goal-semantic-diff.test.ts` 覆盖新增/删除 ID 与标题的真实/字面转义，以及 `(none)` 与真实/字面换行 currentTaskId。
- 最终 tarball 单包 cast 路径见 `/tmp/pi-e2e-goal-audit8-goal-01/current-run`：`/tmp/audit8-create.txt` 包含空行和三级任务；`/tmp/audit8-create-grown45.txt`、`/tmp/audit8-create-grown60.txt`、`/tmp/audit8-tweak-grown.txt`、`/tmp/audit8-tweak-feedback-return.txt` 为缩放和反馈返回；`/tmp/audit8-one.txt` 展示 1 行翻页到子任务；`/tmp/audit8-width119.txt`、`/tmp/audit8-width120.txt`、`/tmp/audit8-fields.txt` 验证宽度阈值和语义对齐，底部屏幕与 `/tmp/audit8-fields-boundary.txt` 字节一致；`/tmp/audit8-wheel-before.txt` 与 `/tmp/audit8-wheel-after.txt` 的 ▲ 从 6 减至 5。`/tmp/audit8-cancel-select.txt` 和 `/tmp/audit8-cancel-result.txt` 证明先选择再取消。
- 实际 OSC 8 命中而非伪造消费：`/tmp/audit8-link-debug` 中 `OPEN https://example.test/goal-link` 来自 Pi `openUrl` 真实回调的测试包装，包装随后调用原函数；链接绘制在宿主 widget，点击后确认框未执行。录屏中 SGR 由 tmux 注入；系统浏览器本身是否启动不作为验收主张。单包录屏包含一次 OSC52。
- `/tmp/pi-e2e-goal-audit8-multi-01/current-run` 记录安装版 Goal-X、subagents、tool-display、mouse-events、starline 的合装；`/tmp/audit8-multi-wheel.txt`、`/tmp/audit8-multi-grown.txt`、`/tmp/audit8-multi-tools.txt` 为滚轮、缩放恢复和真实模型 edit/write。tool-display 单包沿用字节相同 tar 的 `/tmp/pi-e2e-goal-audit5-tool-01` 真实工具录屏。Pi/recorder/replay 退出码均为 0。
- Goal-X 源码与最终安装 `goal-tweak-confirmation.ts` SHA-256 `90e237df49229622fb363718843a6a135b18d0eb911a0a7fd2217bfed6f2f75e`、`goal-tweak-diff.ts` `45be69409a735b69be36d3408e7d83554c6aa3528dda7c019f77f02e34324c86`、`fork-confirmation-host.ts` `6256428209fec2bcc4ff85c25d48fdd308d5620df4cde9c4d1412206b9eacdbc`、`fork-confirmation-tiny-host.ts` `3b25fd02c58d2ff4b2dd4ce6f711ca35ce3447a320464d38dfd46f771286605c` 全部匹配；三个打包 diff.js 副本均为 `4fe6803d82bd4a5fa4291cab8d8749674ed52cdfa2bc3f54103d76ff07a459f0`，tar/manifest/shared-diff 检查通过。

### 第五轮审计：最终 E6 证据（取代 E5 最终产物声明）

- `fork-production-viewport.test.ts` 启动真实 SDK 子进程 19 项：创建/调整在鼠标关闭、130 列、45 或 5 行、10 行 footer 下使用 PgUp/PgDn 和 Ctrl+↑/↓ 访问正文及确认控件；另有 1 行、缩放、反馈、实际链接、外部浮层、滚轮和旧手势测试。`fork-goal-semantic-diff.test.ts` 经真实 task conversion/candidate projection 验证 `(none)` 父任务、跳过原因、currentTask 全文和 119/120 差异。
- 最终单包录屏 `/tmp/pi-e2e-goal-audit9-goal-01/recordings/run-XDLaWm/session.cast`：`/tmp/audit9-create.txt` 含空行和三级任务，`/tmp/audit9-create-paged.txt` 显示原生 PgDn 的 `▲ 21 more`，`/tmp/audit9-five-confirm.txt` 显示 5 行内仅键盘到达 `[Confirm selection]`；`/tmp/audit9-width119.txt` / `width120.txt` / `fields.txt` 显示语义差异；`/tmp/audit9-link-debug` 记录宿主真正调用 `openUrl`，cast 包含一次 OSC52。`run-AZikz3/session.cast` 及 `audit9-cancel-{selected,result}.txt` 验证先选择再确认取消；`run-Vi5kOD/session.cast` 及 `audit9-tweak-five-confirm.txt` / `feedback22.txt` / `tweak-return.txt` 覆盖调整框键盘、矮屏反馈与恢复。
- 最终合装 `/tmp/pi-e2e-goal-audit9-multi-01/recordings/run-sSw2gl/session.cast`：`/tmp/audit9-multi-keyboard.txt` / `multi-wheel.txt` 显示键盘和注入 SGR 从 `▲ 18` 到 `▲ 19`，`/tmp/audit9-multi-tools.txt` 显示真实模型 edit/write。工具单包为字节相同的 audit5 tar 录屏；所有 Pi、录制与重放退出 0。提案为 fixture，鼠标事件为注入，非物理鼠标。
- 源码与最终 Goal-X tar 安装文件的 `goal-tweak-confirmation.ts` SHA-256 `90e237df49229622fb363718843a6a135b18d0eb911a0a7fd2217bfed6f2f75e`、`goal-tweak-diff.ts` `c28a12d744eb9784e4a82c2eaff96bdf9a9f5e27c3dde6ccbe9d0eeef69219a6`、`fork-confirmation-host.ts` `6256428209fec2bcc4ff85c25d48fdd308d5620df4cde9c4d1412206b9eacdbc`、`fork-confirmation-tiny-host.ts` `1fb72f99be893c0cf7ae996969aa1a94a4134c06075fe49caee122ea6f431bc0` 逐一相等；三个 diff JS 副本 SHA-256 `4fe6803d82bd4a5fa4291cab8d8749674ed52cdfa2bc3f54103d76ff07a459f0`，tar/manifest/shared-diff 检查通过。

### 第六轮审计：最终 E7 证据（取代 E6 最终产物声明）

- 真实 Pi SDK 的 `fork-production-viewport.test.ts` 子进程共 24 场景，新增创建/调整的 45→5→45 阅读锚点、单侧长新值 130→122 列及极矮双宽度往返、两个框所有决策的独立动作标签。`pi-components/tests/diff.test.ts` 直接断言仅有右侧续行的来源为右侧 entry，119 列对应位置为 `NEW052`。
- 最终源隔离单包 cast `/tmp/pi-e2e-goal-audit11-goal-01/recordings/run-IfYLxN/session.cast`：`/tmp/audit11-height-before.txt` / `height-small.txt` 为 `CREATE body 14`，`height-small-browsed.txt` / `height-after.txt` 为 `CREATE body 17`；`wide.txt`、`narrow.txt`、`tiny-wide.txt`、`tiny-narrow.txt`、`wide-after.txt` 均包含 `NEW053`。`/tmp/audit11-action.txt` 在 5 行屏幕仅显示 `[Confirm selection] Cancel` 时明确其实际动作。`cancel-selected/result` 与 `default-before/result` 验证先选取消、默认创建直接确认。
- `/tmp/audit11-width119.txt` / `width120.txt` / `fields.txt` 验证精确阈值与多字段，`one.txt` 验证单行键盘翻页，`feedback.txt` 验证反馈与缩放；`/tmp/audit11-link-debug` 记录 Pi 原生 `openUrl` 被真实触发，cast 有一次 OSC52。多插件 `/tmp/pi-e2e-goal-audit11-multi-01/recordings/run-r4du0D/session.cast` 的 `multi-keys.txt`、`multi-wheel.txt`、`multi-tools.txt` 验证键鼠和真实模型工具路由。单 tool cast `/tmp/pi-e2e-goal-audit10-tool-01/recordings/run-3qWud0/session.cast` 的 tar 与 audit11 tool tar SHA-256 均为 `7b423b4179dd430a708c92a16c6166951909977cec90dcd10ecd4996decfe17f`。全部 Pi、recorder、replay 退出 0；fixture/SGR 非模型生成/物理鼠标。
- 最终源码与 Goal-X 安装文件逐一相等：`goal-tweak-confirmation.ts` SHA-256 `d5e80699eb46aef0b2538d435b2f8d6d68d3373f1ce1dcf8711c32675970cd07`、`goal-tweak-diff.ts` `c28a12d744eb9784e4a82c2eaff96bdf9a9f5e27c3dde6ccbe9d0eeef69219a6`、`fork-confirmation-host.ts` `6256428209fec2bcc4ff85c25d48fdd308d5620df4cde9c4d1412206b9eacdbc`、`fork-confirmation-tiny-host.ts` `1fb72f99be893c0cf7ae996969aa1a94a4134c06075fe49caee122ea6f431bc0`。四个私有 diff JS 副本 SHA-256 均为 `0d0d788ebc0bb346d6f4fd33a830f680fb624e3db76de56607cc75069f006042`；tar/manifest/shared-diff 检查通过。

### 第七轮审计：最终 E8 证据（取代 E7 最终产物声明）

- `fork-production-viewport.test.ts` 的真实 SDK 子进程 26 场景新增：`buildTweakComparison` 对单个无硬换行的 600 编号片段在 130↔122 列重复五次仍保留原阅读片段；生产构造的 60 行 diff/full 分别滚动后，缩到 5 行并反复切换时各自保持锚点。`pi-components/tests/diff.test.ts` 验证左右来源和消毒后 UTF-16 源起点；自然渲染输出及原有迁移对照保持不变。
- 最终 Pi 单包 `/tmp/pi-e2e-goal-audit12-goal-01/recordings/run-aGVZHL/session.cast`：`/tmp/audit12-long-wide.txt` 顶行为 `NEW249`，`long-narrow.txt` 中仍有 `NEW249`，`long-return.txt` 顶行再次为 `NEW249`；`views-diff-before.txt` / `views-diff-tiny.txt` 保持 `NEW011`，`views-full-before.txt` / `views-full-tiny.txt` / `views-full-return.txt` 保持 `NEW027`。提案由实际 `buildTweakComparison` 生成，并非手写视觉行。`create.txt`、`width119/120.txt`、`fields.txt`、`feedback.txt`、`one.txt`、`cancel-selected/result.txt` 与 `create-default/result.txt` 为其余场景；`audit12-link-debug` 记录 Pi 原生 `openUrl` 调用，录屏有一次 OSC52。
- 最终 tool 和多插件 cast 分别为 `/tmp/pi-e2e-goal-audit12-tool-01/recordings/run-a1G9fP/session.cast`、`/tmp/pi-e2e-goal-audit12-multi-01/recordings/run-9VG5au/session.cast`；`audit12-tool-tools.txt`、`audit12-multi-tools.txt` 为真实模型 edit/write，`multi-keyboard.txt` / `multi-wheel.txt` 为键盘和 SGR。三个进程都遮蔽工作区源码，Pi/recorder/replay 退出码均为 0。提案是 fixture，鼠标事件为注入，非物理鼠标。
- 最终源码与 Goal-X 安装的 `goal-tweak-confirmation.ts` SHA-256 `5bd2e546b368cc2daa483bd11c98559315f1d9c0aebf0ae2a96e2fd17bd1da63`、`goal-tweak-diff.ts` `c28a12d744eb9784e4a82c2eaff96bdf9a9f5e27c3dde6ccbe9d0eeef69219a6`、`fork-confirmation-host.ts` `6256428209fec2bcc4ff85c25d48fdd308d5620df4cde9c4d1412206b9eacdbc`、`fork-confirmation-tiny-host.ts` `1fb72f99be893c0cf7ae996969aa1a94a4134c06075fe49caee122ea6f431bc0` 全部匹配；四份打包 diff JS 均为 `ab1af4128e15a8603a291d735ad23262da9cd134c7a41fb88c47c16967b1c9d6`，tar/manifest/shared-diff 检查通过。

### 第八轮审计：E9 最终产物证据（取代 E8 的最终产物声明）

- 真实 Pi SDK `fork-production-viewport.test.ts` 子进程共 29 项。新增创建框、生产语义 diff/全文的 45→160→45 和 45→70→45 回归，断言回到原高度后首个正文标记完全相同，而非仅仍在屏幕上。另测已浏览到中段后主动滚回顶部，再经过 130→122→130，窄屏显示 `OLD000` 且无上方折叠提示，恢复并排后重新显示表头和 `NEW000`。
- 最终 Goal-X 单包 cast `/tmp/pi-e2e-goal-audit13-goal-01/recordings/run-ZBupCI/session.cast`：`/tmp/audit13-{create,diff,full}-before.txt` 对照同目录 `*-{160,70}-return.txt`，首个标记分别始终是 `CREATE body 13`、`NEW023`、`NEW034`。`/tmp/audit13-top-{before,narrow,return}.txt` 记录主动回顶与宽窄往返；`long-{before,narrow,return}.txt` 验证生产构造的长逻辑行未丢失 `NEW249`。该录像也有实际 OSC8 回调、一次 OSC52、反馈、119/120 与先选后取消。提案为 fixture，鼠标为 SGR 注入。
- 最终合装 cast `/tmp/pi-e2e-goal-audit13-multi-01/recordings/run-0p2j3i/session.cast` 记录键盘/滚轮（`▲ 21`→`▲ 22`）及真实模型 edit/write；tool 单包 cast `/tmp/pi-e2e-goal-audit12-tool-01/recordings/run-a1G9fP/session.cast` 使用与最终 audit13 字节相同的 tool tar（SHA-256 `850b2126e6e8e6e8ba1ea7a0d2d6d43316c305bed53347802b7bc152a7b6d345`）。三个进程均遮蔽工作区，Pi、recorder 和回放均退出 0。
- 最终 Goal-X 确认框源码及单包/合装安装文件 SHA-256 `3d2977866acf3c4fe00e9e8183a367e0a96f0557e616df45b4dd68d614338aa8`。两个 tar 的文件、清单和私有共享 diff 检查通过。Goal-X 完整测试 1,786/1,786、integration 10/10、release 53/53，Goal-X 最终 typecheck、分歧、changelog、identity 均通过；本轮未改 components/tool-display 源码，沿用 E8 两包完整测试及 typecheck。

### 第九轮审计：E10 组合布局迁移（取代 E9 最终产物声明）

- 真实 Pi SDK 子套件 33/33。新增四项：创建、生产 diff、全文分别经过 45→160（无需滚动）→5，断言正文起点来自原锚点；5 行中向下滚一行后恢复到 45 行，断言首行来自新锚点；另测 5 行并排 diff 滚至无源坐标表头，再恢复到 45 行时表头仍在，且没有上方折叠指示。
- 源码遮蔽的最终单包录像 `/tmp/pi-e2e-goal-audit14-goal-01/recordings/run-06frfS/session.cast`；驱动和断言见 `/tmp/audit14-drive-goal.sh`，屏幕见 `/tmp/audit14-{create,diff,full}-{before,all,tiny,tiny-next,return}.txt` 与 `audit14-header-{tiny,return}.txt`。创建起点 `CREATE body 12`，滚后/恢复后 `CREATE body 13`；diff、全文起点 `NEW023`，滚后/恢复后 `NEW024`。另有原生链接、三级任务、119/120、滚轮边界整屏字节一致、反馈、先选后取消、默认创建确认。目标内容是 fixture，鼠标为 SGR 注入。
- 最终合装录像 `/tmp/pi-e2e-goal-audit14-multi-01/recordings/run-kFM1Wb/session.cast`，键盘与 SGR 从 `▲ 21` 到 `▲ 22`，并有真实模型 edit/write。tool-only 产物与 audit12 的 tar 完全相同（SHA-256 `850b2126e6e8e6e8ba1ea7a0d2d6d43316c305bed53347802b7bc152a7b6d345`），沿用其源码遮蔽录像。三组 Pi、recorder 和 TTY replay 均退出 0。最终源码及两份安装确认框的 SHA-256 均为 `dc54cc1ccd8314579414fd6c26c53d037f58b9ba86a1ab4f023f2ac42131477f`；两包 tar/manifest/shared-diff 检查通过。
- 本轮 Goal-X 全量测试与 typecheck、integration 10/10、release 53/53、fork-divergence、changelog、identity 全部通过。未改 components/tool-display 源码，沿用 E8 的全量测试及 typecheck。

### E11：浮层与框内滚轮（最新安装验收）

- 真实 SDK 子套件 35/35，新增创建及生产 `buildTweakComparison` 调整框在 130×45、10 行 footer 下的滚轮路由。修复前两项均在“向上滚一步后聊天不得移动”的整屏断言失败（`/tmp/audit15-overlay-before.log`）。修复后，浮层未覆盖滚轮坐标时，向上滚不改变整屏，向下滚动正文且聊天仍显示 `chat 59`；浮层覆盖指针时，它独占该事件，对话框和聊天不动。组件回归还断言不相交浮层存在时，连续滚轮能跨两帧累计且不放行点击。
- 最新源码遮蔽单包录像：`/tmp/pi-e2e-goal-audit15-goal-01/recordings/run-9ej8UG/session.cast`。`/tmp/audit15-{create,tweak}-overlay-{top,up,down,covered}.txt` 分别验证顶部、向上边界、正文向下和覆盖命中；top/up 与 down/covered 分别字节相同，down 显示 `▲ 1 more`。`/tmp/audit15-overlay-wheel.log` 只记录覆盖坐标的两次事件。该录像也覆盖组合高度迁移；同安装的续录 `run-yuUJ9G/session.cast` 覆盖三级任务、119/120、边界、先选后取消、默认确认、反馈、原生链接及一次 OSC52。目标提案为 fixture，鼠标为 SGR 注入。
- 最新合装录像 `/tmp/pi-e2e-goal-audit15-multi-01/recordings/run-clDN7j/session.cast`：键鼠 `▲ 21`→`▲ 22`，真实模型 edit/write 渲染。tool-only 产物与 audit12 的 tar 字节相同（SHA-256 `850b2126e6e8e6e8ba1ea7a0d2d6d43316c305bed53347802b7bc152a7b6d345`），沿用其源码遮蔽录像。四份录像的 Pi、recorder 和完整 TTY replay 均退出 0。最终源码与两份安装确认框 SHA-256 均为 `65404a1e3067bb6067c3b0ea24edaf7144983a25ffdd9a0d007601d038267809`；两包 tar/manifest/shared-diff 校验通过。
- 最新 Goal-X 全量测试 1,786/1,786，typecheck、integration 10/10。components/tool-display 源码未变，沿用 E8 的全量测试及 typecheck。分歧、changelog、identity、release、OpenSpec strict、格式及 diff 检查通过。

### E12：非捕获浮层旁的单击及编辑器定位（最新安装验收）

- 真实 Pi SDK 子套件 37/37。新增 130×45、10 行 footer 下创建和生产语义调整两个场景：非捕获浮层与目标相离时，单击继续讨论只选择，确认控件随后进入反馈；点击 `uvwxyz` 首字符后输入 `A`，得到 `Auvwxyz`；返回决策后默认确认也能执行。覆盖确认控件的浮层独占点击。在另一浮层始终可见期间，按下、待执行两阶段各插入浮层显示/隐藏往返，旧确认均不执行。E11 滚轮与现有其他旧手势回归保留。
- 最新源码遮蔽单包 `/tmp/pi-e2e-goal-audit16-goal-01/recordings/run-PDHfN5/session.cast`，驱动 `/tmp/audit16-drive.sh`；`/tmp/audit16-{create,tweak}-{start,up,covered,selected,feedback,cursor,feedback-small,confirmed}.txt` 对照两框顶部滚轮、覆盖处滚轮、单击选择、光标与确认；`start/up/covered` 各自整屏一致，浮层日志只记录覆盖处两次滚轮。该录屏也有 119/120、任务字段、三级任务、反馈缩放和实际宿主链接。提案为 fixture，鼠标为 SGR 注入。
- 最新源码遮蔽合装 `/tmp/pi-e2e-goal-audit16-multi-01/recordings/run-euAduD/session.cast`：PageDown 和滚轮使 `▲ 21`→`▲ 22`，另有真实模型 edit/write。tool-only 沿用与最终产物字节相同的 audit12 tar 录像。三组 Pi、recorder、完整 TTY 回放均退出 0。确认框源码和两份安装文件 SHA-256 均为 `f8069e3ed4909c013485f2519932907499b6d35f424e5e5aad575c4cfcebe5ef`；两包 tar/manifest/shared-diff 校验通过。
- Goal-X 全量 1,786 项、integration 两组 35/10、typecheck 和发布门禁通过。本轮未改 components/tool-display 源码，沿用 E8 两包完整测试及 typecheck。

### E13：恢复框外聊天原生跨屏选区（最新安装验收）

- 真 SDK 子套件 39/39。两个框分别在 130×45、10 行 footer 下从 `chat 59` 按下并拖至聊天顶部边界，保持 375ms。断言聊天移动、宿主 `copySelection` 回调含至少三行（包括 `chat 58`）、框内正文不动，以及普通高度下 `hasOverlay()` 为假。同一套件覆盖无鼠标 PgUp/PgDn、Ctrl+方向键、单行极矮布局与上层浮层焦点恢复。测试使用 Pi 真实动态 TUI 引用。
- 最终源码遮蔽 Goal-X 单包 `/tmp/pi-e2e-goal-audit19-goal-01/recordings/run-ega9kl/session.cast`。`/tmp/audit19-{create,tweak}-copy-{before,after}.txt` 显示框外聊天首行分别从 `067`→`056`、`086`→`075`，且均显示 `Copied!`；解码录屏 OSC52 分别得到 34、15 行合成聊天标签（最后标签在按下坐标截断）。同次会话的 `*-key-page.txt`、`*-one.txt` 显示两框键盘翻页和单行正文浏览均实际生效。另见 `/tmp/audit19-drive.sh` 与 `*-cursor.txt`，验证外部非捕获浮层、滚轮不穿透、反馈定位、选择及确认，随后检查 119/120 和契约、任务、预算字段。目标/聊天为 fixture，鼠标事件为 SGR 注入。
- 最新源码遮蔽合装 `/tmp/pi-e2e-goal-audit19-multi-01/recordings/run-oYgM0i/session.cast` 记录键盘与滚轮 `▲ 21`→`▲ 22`、真实模型 edit/write。tool-only 沿用 audit12 完全相同的 tar。三组 Pi、recorder、完整 TTY 回放均退出 0，最终源码与单包/合装安装文件逐字节匹配，两个 tarball 的私有 diff 校验通过。验收之前曾录制 audit18，已保留为未通过键盘验证的诊断录像，不计作最终证据。
- Goal-X 1,786 项、integration 35/10、typecheck 通过。components/tool-display 本轮未改源码，沿用 E8 完整测试与 typecheck。

### E14：尺寸通知与原生快捷键优先级

- 真实 SDK 子套件 41/41。新增创建和生产语义调整场景：在原生终端 resize 回调同一轮内送入 130×45→122×40→130×45，不插入绘制，分别验证按下中与延迟确认中都不会执行旧确认；新单击仍能确认。Ctrl+Home/End 移动聊天，PageDown 只滚动正文。既有跨屏拖选、无鼠标导航及单行测试继续通过。
- 最新源码遮蔽单包装载录像 `/tmp/pi-e2e-goal-audit20-goal-01/recordings/run-axDoQV/session.cast`：`/tmp/audit20-{create,tweak}-{home,end,page,resize}.txt` 记录聊天跳转、对话框分页、按下后缩放往返仍保持对话框；tmux 可能合并实际 resize 通知，精确两次通知以 SDK 回归为准。`/tmp/audit20-drive.sh` 验证有浮层时的滚轮边界、原生反馈定位、选择与确认。提案为 fixture，鼠标为 SGR 注入。
- 最新合装录像 `/tmp/pi-e2e-goal-audit20-multi-01/recordings/run-RPeWu4/session.cast`：PageDown 与滚轮 `▲ 21`→`▲ 22`、真实模型 edit/write。tool 单包沿用与最新工具 tar 字节相同的 audit12 录像。三组 Pi、recorder 和完整 TTY 回放均退出 0。两个 tarball 的 shared-diff 校验通过，单包/合装安装的改动源码与工作区逐字节相同。Goal-X 测试 1,786 项、typecheck、integration 35/10 全过；components/tool-display 源码未变。

### E15：合并重绘期间的浮层手势失效

- 真实 SDK 子套件 45/45。创建及生产语义调整框各验证按下阶段和延迟执行阶段，在同一调用栈通过 Pi 原生 `showOverlay({nonCapturing:true})`、`hide()` 产生两次请求且中间不绘制，旧确认均不执行。修复前四项全部失败，见 `/tmp/audit21-before.log`。各例的新点击均在普通重绘后成功确认；稳定浮层、框外复制、键盘路由及尺寸通知等既有回归继续通过。
- 最新源码遮蔽单包 `/tmp/pi-e2e-goal-audit21-goal-01/recordings/run-4gjR0I/session.cast`。`/tmp/audit21-drive-overlay.sh` 使用测试 fixture 的快捷键在真实 Pi 进程内同步调用原生显示和隐藏；`/tmp/audit21-{create,tweak}-{pressed,pending,fresh}.txt` 分别记录旧手势后仍显示框与新单击确认结果，四次同步变动见 `/tmp/audit21-overlay-cycle.log` 的前四项。`/tmp/audit21-drive.sh` 另验滚轮、非捕获浮层、单击选择、确认及原生反馈光标；119/120 列和字段见 `audit21-width*.txt`、`audit21-fields.txt`。提案为 fixture，鼠标为 SGR 注入。
- 最新源码遮蔽合装 `/tmp/pi-e2e-goal-audit21-multi-01/recordings/run-fkxlsN/session.cast` 验证 PageDown、滚轮及真实模型 edit/write；tool-only 沿用字节相同的 audit12 录像。三组 Pi、recorder、完整 TTY 回放均退出 0；最终安装文件与源码逐字节匹配，两包共享 diff 打包校验通过。Goal-X 全量 1,786 项、typecheck、integration 35/10 均通过；components/tool-display 源码未变，沿用 E8 的完整测试及 typecheck。

### E16：验证契约字面值与缺省值的全文显示

- 真 SDK 子套件 46/46。新增生产投影场景：同一目标从缺省契约改为字面 `(none)`，并排差异显示 `- (none)` 与 `+ "(none)"`，切换全文显示 `Verification contract: "(none)"`。修复前全文断言失败，见 `/tmp/audit22-before.log`。模型回归同时断言有效候选 `verificationContract === "(none)"`、基线全文 UI 无引号、历史 `fullText` 字节仍维持原快照规则、`diffText` 仍区分该改变。
- 最新源码遮蔽单包 `/tmp/pi-e2e-goal-audit22-goal-01/recordings/run-OvDiN0/session.cast` 使用安装包里的 `projectTweakCandidate` 和 `buildTweakComparison`；`/tmp/audit22-contract-{diff,full}.txt` 保留两种视图的屏幕断言。另验收 119/120、字段、滚轮、非捕获浮层旁的选择确认、反馈光标和缩放。提案为 fixture，SGR 为注入。
- 最新合装 `/tmp/pi-e2e-goal-audit22-multi-01/recordings/run-wTvXuV/session.cast` 验证键鼠滚动和真实模型 edit/write；tool-only 沿用字节相同的 audit12 录像。三组 Pi、recorder、完整 TTY 回放均退出 0；两个 tarball 的私有共享 diff 校验通过，已安装的投影文件与源码字节相同。Goal-X 全量 1,787 项、typecheck、integration 35/10 通过；components/tool-display 未改，沿用 E8 的完整测试及 typecheck。

### E17：极窄终端的双宽反馈输入

- 真 SDK 子套件 48/48。创建和调整两框分别进入反馈、输入 `中`，在 7→6→5→4→3→2→1 列下缩放并在 1 列输入 `文`；2 列起可以显示双宽字，1 列不能显示该字但仍可编辑。恢复到 130 列并经 Esc 返回再进入，草稿均为 `中文`；光标左移插入 `A` 并提交后，回传 `中A文`。保留原生 Editor 数据与键盘事务。
- 最新源码遮蔽单包录像 `/tmp/pi-e2e-goal-audit23-goal-01/recordings/run-KG99Gh/session.cast` 与 `/tmp/audit23-narrow.sh`，`/tmp/audit23-{create,tweak}-{width-*,restored,reentered,sent}.txt` 为屏幕和结果证据。另验 119/120、任务字段、滚轮边界、浮层和指针定位，见 `/tmp/audit23-drive.sh`。目标为 fixture，鼠标为 SGR 注入。最新合装 `/tmp/pi-e2e-goal-audit23-multi-01/recordings/run-QGQES0/session.cast` 验证键鼠和真实模型 edit/write。tool-only 沿用字节相同的 audit12 工具 tar 录像。
- 三组 Pi、recorder、完整 TTY 回放均退出 0。更新文件与隔离安装逐字节匹配，两包共享 diff 打包校验通过。Goal-X 1,787 项、integration 35/10、typecheck 通过；components/tool-display 未改，沿用 E8 的完整测试及 typecheck。

### E18：超过两列的字素及原生粘贴

- 真 SDK 子套件 50/50。创建与调整反馈框用 bracketed paste 输入 `स्त्र`（Pi 测得 3 列），缩放 6→3→2→1 列，在 1 列将第二次粘贴与 Up 放在同一输入批次，再恢复宽度、Esc 返回并重新进入、光标移动插入 `A`，各自提交 `स्त्रAस्त्र`。覆盖粘贴后重绘之前的键盘导航和草稿恢复；E17 的双宽回归继续通过。
- 最新源码遮蔽单包录像 `/tmp/pi-e2e-goal-audit24-goal-01/recordings/run-eHNESo/session.cast` 以 `/tmp/audit24-narrow.sh` 执行同一路径，屏幕及结果保存在 `/tmp/audit24-{create,tweak}-{width-*,restored,reentered,sent}.txt`。另验证 119/120 分栏、任务字段、鼠标边界与浮层旁点击；提案为 fixture，鼠标是注入 SGR。合装录像 `/tmp/pi-e2e-goal-audit24-multi-01/recordings/run-MkbID8/session.cast` 验证键鼠滚动和真实模型 edit/write；tool-only 沿用字节相同的 audit12 tar。
- 三组 Pi、recorder、完整 TTY 回放退出 0。最新隔离安装确认框及 fork 编辑器与源码逐字节一致，两包共享 diff 校验通过。Goal-X 全量 1,787 项、integration 35/10、typecheck 通过；components/tool-display 未改，沿用 E8 完整测试及 typecheck。

### E19：宽字素 diff 与极窄反馈 IME

- 共享 diff 按实际字素宽度选择标记独行，以便内容宽度足够时不被标记占列遮蔽；3/4/5 列 `Aस्त्रB` 的显示、宽度和来源偏移均有回归。生产 `buildTweakComparison` 的真实 SDK 宿主在对话框 6/7/8 列滚动均可看到 `स्त्र`。
- 真实 SDK 的创建与调整反馈框中启用硬件光标，断言终端实际写出的显示/隐藏指令：`中` 后 3→2→3→1→2→130 列光标均显示，且可继续输入并提交；双宽及 3 列字素原生粘贴、缩放、草稿回归继续通过。真实生产 viewport 53 项。屏幕窄到字符与光标无法同列时，光标另占显示行，保留字符。
- 最新源码遮蔽单包 `/tmp/pi-e2e-goal-audit25-goal-01/recordings/run-aWgaO2/session.cast` 通过 `/tmp/audit25-narrow.sh` 对两框执行 3 列字素粘贴、6→1 列与恢复、Esc 重入及编辑提交。另验证 119/120 分栏、字段、键鼠与浮层；提案是 fixture，鼠标是 SGR 注入。合装 `/tmp/pi-e2e-goal-audit25-multi-01/recordings/run-u3RSKb/session.cast` 和工具单包 `/tmp/pi-e2e-goal-audit25-tool-01/recordings/run-twCAQw/session.cast` 运行真实模型 edit/write。三份录像的 Pi、recorder 及完整 TTY 回放均退出 0；目标与工具各自内嵌的 diff.js SHA-256 均为 `e29dd894cc66b9950a1bd5fa8a5787450b4440def37967faccb8488a18f55631`，subagents 独立副本未重新打包，不作同字节声明。最新源码与隔离安装文件逐字节一致。
- components 54 项和 build、tool-display 777 项和 typecheck、Goal-X 1,787 项、typecheck、integration 35/10、release 53 项、fork divergence/changelog/identity、格式均通过。源码/录屏断言及过程日志位于 `/tmp/audit25*`。

### E20：多行反馈实际宽度重排与原生点击

- 两框真实 SDK 新增生产 viewport 回归：原生 bracketed paste 两行 `स्त्र`、`ABCDEFG`，3 列点击 `ABC` 开头并插入 `X`；2 列逐行显示的 ASCII 拼合为 `XABCDEFG`，恢复宽度后提交值 `स्त्र\nXABCDEFG`。原生硬件 IME、双宽和三列字素缩放回归同时通过；完整生产 viewport 55 项，Goal-X 单元 1,787 项、typecheck、integration 35/10 通过。
- 最新源码遮蔽单包录像 `/tmp/pi-e2e-goal-audit27-goal-01/recordings/run-XGVKcA/session.cast`，命令 `/tmp/audit27-narrow.sh`，两个框均经 tmux bracketed paste、注入 SGR 点击和 3→2→130 列验证显示与最终提交；另验 119/120、字段、轮询和浮层旁点击。提案是 fixture、鼠标为 SGR 注入。早期 audit26 录屏是发现终端显示问题的不完整调试记录，不作为通过证据。
- 合装 `/tmp/pi-e2e-goal-audit27-multi-01/recordings/run-anzjVw/session.cast` 验证鼠标/键盘及真实模型 edit/write；工具单包沿用字节相同的 audit25 tar 与录像。三份 Pi/recorder 和完整 TTY 回放均退出 0，独立 tar 校验通过，隔离安装的编辑器文件与源码一致。Goal-X、components、tool-display 测试、typecheck 及 release 结果分别见 `/tmp/audit27-{unit,type,int,gate}.log` 和 E19；fork、格式门禁通过。

### E21：重排行的上下键与 RPC 自定义宿主

- 两框真实 SDK 生产 viewport 用 bracketed paste 输入 `स्त्र\nABCDEFG`；2 列点击 `G` 后 Up、输入 `X`，提交 `स्त्र\nABCDEXFG`，区别于修复前 `ABCXDEFG`（`/tmp/audit28-before.log`）。全部真实 SDK 58 项通过。另一回归在 mode=rpc 但具备真实 custom/TUI 的 22 行宿主逐行查看 70/70 行并确认；无 custom 或 custom 抛错时退回且不直接批准（`fork-confirmation-rpc.test.ts`）。测试模拟 RPC-capable 宿主，不宣称 Pi 官方 RPC 支持 custom。
- 最终源码遮蔽单包录像 `/tmp/pi-e2e-goal-audit28-goal-01/recordings/run-R40q0z/session.cast` 的 `/tmp/audit28-narrow.sh` 对两个框用 tmux bracketed paste 和注入 SGR 点击后按 Up 验证上述精确回传；同时验 119/120、任务字段、浮层旁鼠标。合装 `/tmp/pi-e2e-goal-audit28-multi-01/recordings/run-n4y2p3/session.cast` 验证键鼠与真实模型 edit/write；工具单包沿用与最新相同字节的 audit25 tar。两组最新录像与工具录像的 Pi/recorder/完整 TTY 回放均退出 0，tar 及安装源码校验通过。
- Goal-X 全量 1,787、typecheck、integration 35/10 通过；首次并发验证时无关 settings lock 测试超时，单独完整重跑通过（`/tmp/audit28b-unit.log`）。release 53、fork divergence/changelog/identity、格式、OpenSpec strict 通过。components/tool-display 未变，沿用 E19。

### E22：同帧键盘与用户重映射

- 真实 SDK 两框分别覆盖三种场景：点击 G 后不重绘连续 Left/Up/X 得 `स्त्र\nABCXDEFG`；重映射 `cursorRight=up` 时 Up/X 得 `स्त्र\nABCDEFGX`；重映射 `cursorUp=ctrl+p` 时 Ctrl+P/X 得 `स्त्र\nABCDEXFG`。修复前四项连续/重映射场景失败见 `/tmp/audit29-before.log`；完整生产 viewport 共 64 项通过。
- 源码遮蔽单包录像 `/tmp/pi-e2e-goal-audit29-goal-01/recordings/run-X5ueya/session.cast` 用 `/tmp/audit29-narrow.sh` 对两个框进行 bracketed paste、SGR 点击及同一批次 Left/Up/X，验证原样提交；另测 119/120、字段、鼠标及浮层。合装 `/tmp/pi-e2e-goal-audit29-multi-01/recordings/run-Jw8bH4/session.cast` 验证键鼠和真实模型 edit/write；工具单包沿用与最新同字节的 audit25 tar。三份录屏 Pi、recorder、完整 TTY 回放均退出 0。提案是 fixture、鼠标为注入 SGR。
- Goal-X 1,788、typecheck、integration 35/10、release 53、分歧/changelog/identity、格式及 strict 通过。components/tool-display 未变，沿用 E19。打包校验通过，安装确认框与源码逐字节一致，验证日志 `/tmp/audit29-gate-*.log`。

### E23：填充行导航和 E22 记录更正

- **更正 E22**：当时仓库 `rebound-up` 分支误发了 Up 而不是 Ctrl+P，E22 对该持久化回归的描述不正确。现已修正为实际发送 `\x10`（Ctrl+P）并断言 `स्त्र\nABCDEXFG`；两个框均通过。E22 审计的独立只读探针也实际验证了 Ctrl+P。
- 两框真实 SDK 输入 `स्त्र\nA\nBCDE`，2 列点击 A 后按四次 Down、每次重绘并输入 X，确认移动到下一逻辑行，修复前两框失败（`/tmp/audit30-before.log`）；实际源码遮蔽单包录屏两框均提交 `स्त्र\nA\nBCDXE`。按原生 Editor 的光标位置跳过物理重排的填充行，不改变文本。生产 viewport 共 66 项、Goal-X 1,788 项、typecheck、integration 35/10 通过。
- 最新隔离单包 `/tmp/pi-e2e-goal-audit30-goal-01/recordings/run-HpFip2/session.cast` 使用 `/tmp/audit30-narrow.sh` 执行该重现，另测 119/120、字段、浮层与鼠标；合装 `/tmp/pi-e2e-goal-audit30-multi-01/recordings/run-V2rmQw/session.cast` 验证键鼠与真实模型 edit/write；工具单包沿用同字节 audit25 tar。提案为 fixture，SGR 为注入，三份 Pi、recorder、TTY 完整回放均退出 0。
- 打包、最新源码与安装文件字节校验、fork divergence/changelog/identity、Prettier、release 53 项通过；components/tool-display 未变，沿用 E19。日志 `/tmp/audit30-gate-*.log`。

### E24：最终测试清单自检

- 独立审计指出新加的 `fork-confirmation-rpc.test.ts` 已被测试 runner 自动执行，但漏登 `tests/.test-manifest.json`，原先 E23 的单测通过不能替代 manifest 自检。现仅追加该条目，`direnv exec . pnpm --filter @xzzpig/pi-goal-x run test:selfcheck` 实际退出 0，输出 `150 unit + 4 integration + 12 e2e entries match`（`/tmp/audit31-gate-0.log`）。
- 重新执行 fork-divergence、fork-changelog、fork-identity 与 Prettier 检查均退出 0（`/tmp/audit31-gate-{1,2}.log`）；目标/工具源码及 tar 未改动，E23 测试和隔离录像证据仍适用。暂存补丁 SHA-256 仍为 `cd16decbbe83cc0a672000cce943f2d9edf87ca87243f2087d2fbcd11db02e16`。

### E25：删除 skipped 任务的旧快照兼容

- 从变更前 `HEAD:packages/pi-goal-x/extensions/goal-tweak-diff.ts` 生成含 skipped 任务删除及 `skipReason` 的固定基线（`tests/fixtures/fork-tweak-legacy-presentations.json`，生成值 `/tmp/audit32-baseline.json`）。修复前与基线逐字比较失败（`/tmp/audit32-before.log`），修复后 `diffText` 和 `fullText` 匹配原实现。UI 专用 `skip reason` 仍出现在 119/120 两种语义布局，工具文本与 `details.tweakReview` 则均不包含该 UI 行；实际有效候选和 review 工具结果覆盖见 `fork-goal-semantic-diff.test.ts`。
- 源码遮蔽单包 `/tmp/pi-e2e-goal-audit32-goal-01/recordings/run-eP4uOq/session.cast` 对独立安装生产比较器运行删除任务 fixture，终端 122/130 列均显示原因，确认后 fixture 报告的旧 diff 不含原因；同时验窄屏反馈、119/120、字段、浮层与鼠标。fixture 不声称是真实模型任务；鼠标为 SGR 注入。合装 `/tmp/pi-e2e-goal-audit32-multi-01/recordings/run-NVdRrM/session.cast` 验证键鼠与真实模型 edit/write；tool 单包沿用与最新同字节的 audit25 tar。三份 Pi/recorder/完整 TTY 回放均退出 0；tar 校验与目标源码和安装文件的字节对照通过。
- Goal-X 1,789、typecheck、integration 35/10、manifest selfcheck、release 53、fork divergence/changelog/identity 与 Prettier 均通过（`/tmp/audit32-gate-*.log`）。共享组件和 tool-display 未改，沿用 E19 完整测试。`diffTaskStructure` 环复杂度相对基线从 14 增至 18，作为维护信号记录而非声称未增加。

### E26：UI 消歧与旧文本投影分离

- 从改动前 HEAD 的比较器生成三个固定基线，候选经 `convertFlatTasks` 和生产 `projectTweakCandidate` 构造：移动到 ID 为 `(none)` 的父任务、删除 ID 为 `(none)` 的当前任务、根契约真实换行改为字面 `\n`。新回归经 `TweakReview.mutate` 再生成同一有效候选，断言完整 `presentation`、工具文本及 `details.tweakReview` 的 `diffText/fullText` 逐字匹配 HEAD；119/120 UI 则独立证明两侧可区分。固定数据在 `tests/fixtures/fork-tweak-legacy-presentations.json`，原始基线 `/tmp/audit33-baselines.json`。
- 源码遮蔽单包 `/tmp/pi-e2e-goal-audit33-goal-01/recordings/run-v77jgU/session.cast` 使用三个有效候选 fixture，经安装包生产比较器验证旧投影匹配后，在终端 122/123 列查看 UI 并确认。屏幕 `/tmp/audit33-{parent-id-collision,current-id-collision,contract-newline-collision}-{wide,narrow,result}.txt` 显示真实/缺省 `(none)` 与换行转义有区别；fixture 输出旧文本。另验证两个框的窄屏反馈、鼠标和浮层。提案是 fixture、SGR 为注入。
- 合装 `/tmp/pi-e2e-goal-audit33-multi-01/recordings/run-FNd6Jz/session.cast` 验证键鼠和真实模型 edit/write，工具单包沿用与最新字节相同的 audit25 tar；三份 Pi/recorder/完整 TTY 回放均退出 0，tar 和安装源码字节校验通过。Goal-X 1,790、typecheck、integration 35/10、manifest selfcheck、release 53、fork divergence/changelog/identity、Prettier 通过；components/tool-display 未变沿用 E19。日志 `/tmp/audit33-gate-*.log`。

### E27：正文反斜线与超宽字素降级

- 生产 `projectTweakCandidate` → `buildTweakComparison` 回归验证正则和路径 `Run \w+ from C:\tmp\new` 在 119/120 两种 diff 与全文 UI 均保持单个反斜线，并与最终候选、遗留全文一致；真实 tab/CR 使用明确 `⟦TAB⟧`/`⟦CR⟧` 标签避免与字面字符混淆。共享 diff 对无法物理容纳的单个字素改为可还原的 `<U+码点 …>` 表示并按实际列宽换行；1 列 `甲`/`乙` 与 3 列两个不同多码点字素分别可辨认，来源锚点仍指向原字素。components 55 项含上述回归，type build 通过。
- 源码遮蔽单包 `/tmp/pi-e2e-goal-audit34-goal-01/recordings/run-D7KwV0/session.cast` 使用有效候选 fixture 验证 122/123 列和全文展示原样路径；1 列滚动收集屏幕 `/tmp/audit34-one-col-all.txt` 分别出现 `U+7532` 与 `U+4E59`，并验证两框窄屏反馈、SGR 鼠标和浮层。fixture 非真实模型输出、鼠标为注入。
- 最新合装 `/tmp/pi-e2e-goal-audit34-multi-01/recordings/run-WA20HM/session.cast` 与工具单包 `/tmp/pi-e2e-goal-audit34-tool-01/recordings/run-LeBmYH/session.cast` 分别执行真实模型 edit/write；三份 Pi、recorder、完整 TTY 回放退出 0。两个消费者的共享 diff JS 字节一致，tar 和安装源码校验通过；subagents 私有副本不作同字节声明。
- Goal-X 全量 1,791、typecheck、integration 35/10、manifest selfcheck 通过（`/tmp/audit34b-*.log`）；第一次并发全量中的无关本地设置锁超时，串行重跑通过。tool-display 777、typecheck，release 53、fork divergence/changelog/identity、Prettier 通过（`/tmp/audit34-gate-*.log`）。

### E28：标签碰撞与降级片段锚点

- 正文控制字符标签采用可逆转义：原文中的 `⟦` 写成 `⟦⟦`，因此真实 Tab `a⟦TAB⟧b` 与字面 `a⟦⟦TAB⟧b` 在 119/120 及全文 UI 分别显示；普通反斜线路径保持 E27 的原样。超宽字素编码保留单个 `<U+...>`，原文中匹配该标记前缀的 `<` 写成 `<<`，因而一列 `甲` 的 `<U+7532>` 与字面 `<U+7532>` 的 `<<U+7532>` 可区分；替代片段各自保留源偏移及片内位置。
- 真 SDK 生产 viewport 回归验证一列滚到首个 `<`、扩至两列显示 `甲`、再缩回仍是首个 `<`，而非最后的 `>`；完整 viewport 67 项通过。components 56 项、构建，Goal-X 1,792、typecheck、integration 35/10、自检，tool-display 777/typecheck、release 53、fork divergence/changelog/identity、Prettier 通过（`/tmp/audit35-gate-*.log`）。
- 遮蔽源码的单包 Pi 录像 `/tmp/pi-e2e-goal-audit35-goal-01/recordings/run-vewLQ5/session.cast` 实测生产有效候选，`/tmp/audit35-tab-{122,123,full}.txt` 显示真实 Tab 与字面标签有区别，`/tmp/audit35-one-col-all.txt` 可读两种不同编码；同时验两框窄屏反馈、鼠标与浮层。合装 `/tmp/pi-e2e-goal-audit35-multi-01/recordings/run-meJnQV/session.cast` 和工具单包 `/tmp/pi-e2e-goal-audit35-tool-01/recordings/run-a50sIG/session.cast` 验真实模型 edit/write。fixture 不代表真实模型提案，SGR 是注入；三份 Pi/recorder/完整 TTY 回放均退出 0。tar 及安装源码校验通过，两消费者共享 diff JS SHA-256 为 `b67e0e3bd0d7195c80f83f32a98c21c8d10647df619ee5f1e1c2ec61e0cfd548`。

### E29：相邻 Unicode 前缀与行尾空格

- 共享 diff 一列回归覆盖 `<甲` 对字面 `<U+7532>`：分别显示可逆的 `<<<U+7532>` 和 `<<U+7532>`，不再仅增删符不同；既有无前缀 Unicode、片段锚点和终端序列安全回归仍通过。真实有效候选 `begin\na \nend` → `begin\na\nend` 的 119/120 diff 与全文 UI 将行尾空格显示为 `␠`，字面 `␠` 转义为 `␠␠`，不与补白混淆。修复前两个针对性测试均失败，见 `/tmp/audit36-before-{components,goal}.log`。
- 源码遮蔽单包 `/tmp/pi-e2e-goal-audit36-goal-01/recordings/run-gbGWe9/session.cast` 中，生产候选与比较器在 122/123 列显示 `- a␠`（`/tmp/audit36-space-{122,123}.txt`）；一列逐屏采集 `/tmp/audit36-one-col-all.txt` 分别检出 `<<<U+7532>` 与 `<<U+7532>`。另验证两框窄屏反馈、鼠标和浮层。目标为 fixture、鼠标为注入 SGR。
- 合装 `/tmp/pi-e2e-goal-audit36-multi-01/recordings/run-gCfqoA/session.cast` 与工具单包 `/tmp/pi-e2e-goal-audit36-tool-01/recordings/run-45OeST/session.cast` 验真实模型 edit/write；三份 Pi、recorder、完整 TTY 回放退出 0。tar 与安装源码字节校验通过，两消费者的 diff JS SHA-256 均为 `657fa21498106d2a2c8c154e7131c7337e8a689d32fac7e070067716aca8c286`。
- components 57 项及构建、Goal-X 1,793 项/typecheck/integration 35+10/manifest selfcheck、tool-display 777 项/typecheck、release 53、fork divergence/changelog/identity、Prettier 通过。并发 tool-display 首次执行超时，单独完整重跑退出 0（`/tmp/audit36b-tool.log`）；其余日志 `/tmp/audit36-gate-*.log`。

### E30：视觉折行边界的正文空格

- 共享文本排版在每个**视觉行末**将源空格标成 `␠`，布局填充仍是普通空格；字面 `␠` 用 `<U+2420>` 可逆表示，避免多个真实空格与字面标记碰撞。候选及遗留快照不变。生产候选回归覆盖 119 列/前缀 116、120 列/前缀 55 与 117 的 `P甲` → `P 甲`，分别断言 diff 或全文渲染帧不同；前两者的 diff 明确显示标记。修复前测试失败见 `/tmp/audit37-before.log`。
- 最新源码遮蔽单包 `/tmp/pi-e2e-goal-audit38-goal-01/recordings/run-Dy16tc/session.cast` 在安装包生产投影中验证三个有效候选：`/tmp/audit38-wrap-{116,55}-diff.txt` 与 `/tmp/audit38-wrap-117-full.txt` 显示折行尾的 `␠`。另验证两框窄屏反馈、SGR 点击和浮层；提案为 fixture，鼠标为注入 SGR。合装 `/tmp/pi-e2e-goal-audit38-multi-01/recordings/run-iqAlwg/session.cast` 及工具单包 `/tmp/pi-e2e-goal-audit38-tool-01/recordings/run-GKWrrj/session.cast` 验真实模型 edit/write；三份 Pi、recorder 和完整 TTY 回放均退出 0。
- components 58 项及构建，Goal-X 1,794 项/typecheck/integration 35+10/manifest selfcheck，tool-display 777 项/typecheck，release 53，fork divergence/changelog/identity 和 Prettier 均通过（`/tmp/audit38-gate-*.log`、`/tmp/audit38-tool.log`）。tar 与安装源码一致，两消费者内嵌 diff JS SHA-256 `2582cb8db1979905352937924bd3d07e243ae86d8a9a0e567f541232c6c4a64e`；subagents 独立副本不作同字节声明。

### E31：硬换行与 Unicode 空白的生产帧

- 全文 UI 在每个正文逻辑换行前显示 `⏎`（字面 `⏎` 与 `⟦` 均可逆转义），以区分软折行；正文非 ASCII Unicode 空白与控制字符显示为明确码点标签，字面标签仍转义，真实候选、旧 `diffText/fullText` 和事务不变。通用共享 diff 亦将非 ASCII 空白编码为可区分码点。修复前硬换行生产语义测试失败见 `/tmp/audit39-before.log`。
- 真实 SDK 的**实际确认组件**在物理 122/123 列（内容 119/120）对比有效候选 `P  甲` 与 `P\n甲` 的全文帧；另以 P 长 116/55/117 验证 NBSP 的 diff 与全文帧，均可见不同。全文路径使用生产组件自身 `mode: unified`，不再以默认 split 的辅助函数冒充生产行为。完整 viewport 68 项通过；相应生产文本测试、旧基线快照也通过。
- 遮蔽源码的独立安装单包录像 `/tmp/pi-e2e-goal-audit39-goal-01/recordings/run-eSO9Zv/session.cast` 使用生产候选 fixture 验证两个宽度的前后全文帧不同（`/tmp/audit39-hard-{122,123}-{old,new}.txt`）和三个 NBSP 宽度/前缀场景的 diff/全文（`/tmp/audit39-nbsp-*.txt`）；另验两框窄反馈、鼠标与浮层。提案为 fixture、SGR 为注入。
- 合装 `/tmp/pi-e2e-goal-audit39-multi-01/recordings/run-JvAKe7/session.cast` 和工具单包 `/tmp/pi-e2e-goal-audit39-tool-01/recordings/run-XWZBxc/session.cast` 验真实模型 edit/write；三份 Pi/recorder/完整 TTY 回放退出 0。两个消费者的已编译 diff JS 字节一致，SHA-256 `8a7ed3b59c2aa2065ec2e6423e564d92479b2dd9b33eeef4e6afd1ea67d77351`；tar 和安装源码检查通过。
- components 59 项及 build、Goal-X 1,795 项/typecheck/integration 35+10/selfcheck、tool-display 777 项/typecheck、release 53、fork divergence/changelog/identity、Prettier 通过。首次实现将每个换行标记放独立行，使两项阅读锚点回归失败；现采用行内标记并将行尾源空格用可逆 `⟦SPACE⟧` 显示，完整重跑通过，证据 `/tmp/audit39b-gate-*.log`、`/tmp/audit39b-tool.log`。

### E32：任务全文字段与长前缀性能

- 有效候选经 `convertFlatTasks`、`projectTweakCandidate` 构造：标题 `Write docs (lightweight subtasks)` 且关闭轻量子任务，与标题 `Write docs` 且开启轻量子任务的旧 `fullText` 保持原有相同格式，而只读 UI 对标题加可逆 JSON 引号，因此全文不同；修复前断言失败见 `/tmp/audit40-before.log`。真实 SDK 生产确认组件在内容 119/120 列比较两种全文帧，完整 viewport 69 项通过。
- 共享排版的长 `<` 前缀检测改为单次扫描，不再对每个位置重复扫描后缀。components 回归测 4k/32k 的普通 `<` 与 `<...U+` 输入并约束增长。最终安装包的独立测量在 `/tmp/audit40-prefix-benchmark.txt`：普通 `<` 的 4k/16k/32k 热运行约 0.16–0.62/0.63–0.85/0.76–0.86 ms；带保留标记及中英混合前缀也做测量。时长是本机证据，不是跨机器保证。
- 最新源码遮蔽单包 `/tmp/pi-e2e-goal-audit40-goal-01/recordings/run-MleXns/session.cast` 用生产候选 fixture 在 122/123 物理列查看两个全文（`/tmp/audit40-task-*.txt`），验证标题引号与轻量规则区别；32k `<` 确认框可打开并 PageDown（`/tmp/audit40-prefix-{before,after}.txt`）。提案为 fixture、鼠标为 SGR 注入。
- 合装 `/tmp/pi-e2e-goal-audit40-multi-01/recordings/run-LaD6Vb/session.cast` 与工具单包 `/tmp/pi-e2e-goal-audit40-tool-01/recordings/run-PUehO6/session.cast` 验真实模型 edit/write；三份 Pi、recorder、完整 TTY 回放均退出 0。tar 和目标安装源码检查通过，两消费者 diff JS SHA-256 为 `443163e50b885c0f4b7d8e3b4ed94af47134d825113fd290ee84e1bd7b31ecae`。
- components 60 项/build、Goal-X 1,796 项/typecheck/integration 35+10/selfcheck、tool-display 777 项/typecheck、release 53、fork divergence/changelog/identity 与 Prettier 通过，日志 `/tmp/audit40-gate-*.log`、`/tmp/audit40-tool.log`。

### E33：空正文与字面占位文本

- `projectTweakCandidate` 针对同一基线分别处理 `Verification contract: Run tests` 和 `(empty)\nVerification contract: Run tests`，断言有效正文分别为空串与字面 `(empty)`、契约相同；只读 UI 用可逆 `⟦EMPTY OBJECTIVE⟧` 表示空值，字面原文及字面标签通过原有转义区分。旧 `fullText` 的 `(empty)` 不变且两种旧快照仍相同。修复前回归失败见 `/tmp/audit41-before.log`。
- 真 SDK 生产确认组件在内容 119/120 列分别切换全文，断言空正文标记与字面 `(empty)` 均可见且帧不同；完整 viewport 70 项通过。源码遮蔽单包 `/tmp/pi-e2e-goal-audit41-goal-01/recordings/run-pz5J2y/session.cast` 对安装包生产投影重复验证，屏幕 `/tmp/audit41-empty-{122,123}-{empty,literal}.txt` 同时显示正确契约；另测两框窄反馈及鼠标/浮层。提案为 fixture，SGR 为注入。
- 合装 `/tmp/pi-e2e-goal-audit41-multi-01/recordings/run-XGUz7M/session.cast` 验真实模型 edit/write；工具单包沿用与最新字节相同的 audit40 tar。三份 Pi/recorder/完整 TTY 回放退出 0；tar 和安装源码字节校验通过。Goal-X 1,797 项/typecheck/integration 35+10/selfcheck、release 53、fork divergence/changelog/identity、Prettier 通过；components/tool-display 未改沿用 E32。`renderFullText` 复杂度相对基线 11→20，为维护信号而非忽略的验收结果。
