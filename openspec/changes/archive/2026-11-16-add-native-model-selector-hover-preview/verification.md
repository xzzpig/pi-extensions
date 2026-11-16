# 验证记录

## 阶段一：渲染与内容代次契约

阶段一记录对应 tasks 1.1–1.3。后续接入结果见阶段二；真实 TUI 验收尚未完成，不能据此宣称全部功能已验收。

新增 fork-only 背景装饰 `fork-model-selector-hover.ts` 与 `test/fork-model-selector-hover-render.test.ts`，复用真实选择器渲染输出，未复制列表或确认逻辑。验证内容包括：

- 普通重绘保留列表子组件身份；方向键、范围切换、同结果刷新与原生列表重建更换身份。同结果刷新保持几何签名不变，证明仅靠签名不足以清除旧提示。
- 原生深浅主题的箭头／前景样式与模型续行保留，装饰测试使用明确的深／浅背景色样本；实际运行时主题背景选取及视觉对比仍需后续接入和 TUI 验证。
- 背景装饰保持去样式文本、可见宽度、行数及非目标行字节不变，内部 ANSI 全重置／背景重置后恢复背景，行末关闭背景；覆盖中文、当前／默认标记及行尾留白。

实际命令及结果：

```bash
direnv exec . pnpm --filter @xzzpig/pi-starline exec vitest run test/fork-model-selector-{hover-render,geometry}.test.ts
# Pi 1.1.0：2 文件，10 项通过。

direnv exec . env STARLINE_PI_ENTRY=/nix/store/vdn4ax59di54mbhqh6kh3jkmp1p9hqn3-pi-1.5.2/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  pnpm --filter @xzzpig/pi-starline exec vitest run test/fork-model-selector-{hover-render,geometry}.test.ts
# Pi 1.5.2：2 文件，10 项通过。

direnv exec . pnpm --filter @xzzpig/pi-starline run typecheck
# 成功。
```

定向 Biome 通过；原有 schema 2.6.3 与 CLI 2.6.4 的信息级差异未修改。主动 LSP 对新增两个 TS 文件未报告错误，但均为 silent-on-clean 未确认，不当作 clean 证据；实际类型证据为成功的 tsc。定向说明格式、OpenSpec 严格校验和 git diff --check 通过。

最初测试假设 Pi 1.1.0 也显示完整模型名称，导致两项换行断言失败；源码核对表明该版本列表只显示 ID 和提供方。已将跨版本续行测试收窄到宽度 18，检查两版实际都有的 ID／箭头，中文另由显式装饰输入验证。没有改动宿主来迎合测试。

fork 说明已明确“仅视觉、Enter 不跟随、移出整个选择器可保留、无额外输入监听”的最终契约。tmux /tmp 服务预检成功，真实运行尚未开始。

## 当时待完成的验收（后续结果见阶段五）

- tasks 3.2–3.4 的全套门禁、隔离 Pi TUI 录屏／完整回放、证据映射和用户复验命令。
- 物理鼠标观察尚未取得；后续注入的 SGR 移动不得标作物理鼠标验证。

## 阶段二：组件事件接入与动态清理

已完成 tasks 2.1–2.5，组件鼠标适配保存独立 hover 索引和不可变列表子组件快照，render 根据实际行区间叠加背景。index.ts 的现有最小安装调用增加当前 UI 主题 selectedBg 的 ANSI 背景回调；不改变原生 selectedIndex，不调用列表更新来驱动悬停，也不拦截键盘确认。

`test/fork-model-selector-hover.test.ts` 新增 21 项真实类测试，覆盖：多行提示、模型切换、同目标不重复请求重绘、普通重绘及组件外无事件保留；Enter／Ctrl+S 与鼠标完整点击分离；视窗边缘不跳动；搜索／范围／同结果刷新／身份／键盘／滚轮边界／resize／空结果清理；前驱消费移动仍清理背景并保留焦点与目标；共享 API 三态；按下／拖拽／右键不建立提示；render 与事件发现几何失败均清理且只说明一次；零宽及关闭不误报。

首次 Ctrl+S 测试失败的原因是裸 pi-tui 默认键表不包含应用级 app.models.save。测试夹具现像实际交互宿主一样加载所测版本的真实 KeybindingsManager 与对应 pi-tui，不硬编码替代确认回调；私有路径只用于测试夹具，生产仍使用公开 API。修正后仓库与宿主版本均通过。

```bash
direnv exec . pnpm --filter @xzzpig/pi-starline exec vitest run test/fork-model-selector-{hover,mouse,geometry,hover-render,lifecycle}.test.ts
# Pi 1.1.0：5 文件、53 项通过。

direnv exec . env STARLINE_PI_ENTRY=/nix/store/vdn4ax59di54mbhqh6kh3jkmp1p9hqn3-pi-1.5.2/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  pnpm --filter @xzzpig/pi-starline exec vitest run test/fork-model-selector-{hover,mouse,geometry,hover-render}.test.ts
# Pi 1.5.2：4 文件、51 项通过。
```

本阶段 typecheck、定向 Biome 和 fork-divergence 通过；Starline checked=191、noise=4、declared=4、undeclared=0、stale=0。主动 LSP 对鼠标适配、新交互测试与夹具三路径未报告错误，1 个确认 clean、2 个 silent-on-clean 未确认。fork 说明与未发布日志已更新。组合生命周期需在下一阶段显式建立悬停后验证清理；现有生命周期测试通过不替代这一新增验证。

## 阶段三：建立悬停后的组合生命周期

已完成 task 3.1。真实 Starline session_start/session_shutdown 回归现在每个周期都实际创建选择器、建立悬停背景，再验证五次完整安装／清理后的 render／handleMouse 身份与自有／继承描述符恢复。实际宿主两补丁组合也每次先建立提示，按边框外层／鼠标内层逆序释放，随后旧实例不再产生背景，新周期无残留。另新增后续 render 拥有者回归，确认旧清理不覆盖后装包装，已停用适配不再装饰其输出。

仓库 Pi 1.1.0 与宿主 Pi 1.5.2 均执行五个文件（hover、mouse、geometry、hover-render、lifecycle），各 54 项通过。typecheck 及分歧审计通过，Starline checked=191、noise=4、declared=4、undeclared=0、stale=0。既有设置选择器隔离和后续鼠标处理器所有权回归也在这批测试中通过。

subtrees/pi-starline.json 只更新既有 index.ts 安装调用的主题回调同步义务和已有接入 debt 描述，补充行为禁止项与契约位置；没有为纯 fork-only 装饰模块添加虚假 reapply 项。direnv reload 首次刷新 Nix 缓存时打印 /dev/stderr 设备警告，随后单独重跑 direnv exec . true 及 node env/ensure-upstreams.mjs，退出均为 0，元数据已验证。

剩余 tasks 3.2–3.4：全量门禁与真实 TUI 录像验收、证据交付。当前仍不能宣称真实终端鼠标悬停已验证。

## 阶段四：门禁与进行中的 TUI 运行

Task 3.2 的仓库门禁已完成：完整 Starline 套件 112 文件、1640 项通过，日志 `/tmp/starline-hover-suite.log`；typecheck、7 个 fork TS 文件定向 Biome、fork 说明／日志及本变更定向 Prettier、OpenSpec strict、git diff --check 与全仓库分歧审计通过。最终对 8 个本次变更 TS 路径主动 LSP 探测均未报告错误，但全部 silent-on-clean 未确认，实际类型证据依然采用 tsc，不能说 LSP clean。

Task 3.3 尚在进行，不能勾选完成。测试前清单 `/tmp/starline-hover-e2e/checklist.md`，Pi 1.5.2、asciinema 3.2.1，宿主 /tmp tmux 可连接；新环境无用户配置／发现资源，使用30个本地假模型，禁止生成。两个正在录制的运行：

- 无共享包：`/tmp/pi-e2e-starline-hover-native-a/recordings/run-trLeL3/session.cast`，tmux `e2e-starline-hover-native-a`。
- 有共享包：`/tmp/pi-e2e-starline-hover-shared-a/recordings/run-s40HJa/session.cast`，tmux `e2e-starline-hover-shared-a`。

已确认两者启动加载正确，/model 显示原生列表且刷新完成。第一次注入 SGR35 坐标 x12/y18，实际命中 model-01 的续行，两个模型渲染行均出现真实主题背景 RGB(33,59,73)，原生箭头仍在 model-00；ANSI pane 证据分别为 `/tmp/starline-hover-e2e/native-first-hover.ansi` 与 `shared-first-hover.ansi`。这证明实际宿主渲染收到事件后的响应，不是物理鼠标观察。启动后最早的空白 capture 已保留，等待初始化后的实际资源列表已另行捕获，没有重启或覆盖录像。

录像尚未结束／回放，Enter／点击／主题等剩余场景和退出／清理证据仍待后续完成，不据文件存在宣称录像验收通过。

## 阶段五：原始 TUI 矩阵（高度单独变化遗漏见阶段六）

### 范围与实际结果

包入口为当前工作区 `packages/pi-starline/extensions/starline/index.ts`；有共享包运行额外显式加载本地 `packages/pi-mouse-events/extensions/index.ts`。测试伴随扩展 `/tmp/starline-hover-e2e/provider.ts` 只注册30个本地模型、证据命令及通过宿主公开 UI API 切换 light 的准备命令；不改生产代码或宿主来驱动高亮。所有会话、配置和日志位于 /tmp，发现资源关闭，生成被禁止。

| 验证项         | 实际结果与证据                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三种入口       | /model、Ctrl+L 和底部药丸均进入原生选择器，注入 move 后出现背景；药丸取消保留“保留草稿 hover draft”                                                             |
| 视觉／确认分离 | 原生候选00、悬停02后 Enter 仍确认00；Ctrl+S 仍保存00（隔离 settings.json）；完整点击02续行后实际会话模型为02                                                    |
| 视窗保持       | all 范围搜索 model-2 得到12项匹配；悬停可见边缘29前后纯文本 pane 完全一致，背景仅改变目标行                                                                     |
| 动态清理       | 方向键、滚轮、搜索空结果和95×65 resize 后背景清除；新 move 可重建；刷新内容代次另有真实类同结果刷新回归，TUI reload 后旧提示不残留                              |
| 组件边界       | 移出到屏幕第1行（组件外）保留最后提示；收到实际搜索行 move 后清除。没有新增输入监听或全移动模式切换                                                             |
| 两种主题       | 实际 dark 背景 RGB(33,59,73)，light 背景 RGB(223,231,236)；续行同色，原生箭头／当前／默认标记和文字保留，不污染相邻模型                                         |
| 共享包         | 无共享与有共享两组均通过同一矩阵；旧 API 无指针方法的状态由两版真实类回归覆盖                                                                                   |
| 清理／其他界面 | 每组 reload 与最终 shutdown 各一份探针，合计4份均 renderRestored=true、mouseRestored=true；原生设置页显示正常，组合／后续拥有者的重复周期由真实生命周期测试覆盖 |
| 消息与请求     | 两组 selection-evidence.json 均 model=model-02、messageCount=0，仅模型／思考设置条目；未调用生成，伴随扩展会拒绝生成请求                                        |

驱动脚本 `/tmp/starline-hover-e2e/drive.py`。native 因驱动预期问题分段完成，继续脚本为 `drive-tail.py` 和 `drive-finish.py`，没有重启或覆盖录像。两个保留的 FAIL 分别是：误把组件外第1行当成应清除提示的区域；误认为设置页必有 Settings 标题（实际为 Auto-compact 设置列表）。均在原运行后续 CONTINUE 标记中解释并按实际页面继续断言，没有为这些错误修改产品代码。shared 用修正驱动完整通过。native-result.json 的 steps=2 只计最后继续段，完整步骤以原录像 steps.tsv 和全部 native-\* 捕获为准。

### 录像、时间与回放

| 环境     | 录像                                                                     | 关键偏移（秒）                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无共享包 | `/tmp/pi-e2e-starline-hover-native-a/recordings/run-trLeL3/session.cast` | 395：悬停02但箭头00；396.9：Ctrl+S仍保存00；397.8后：点击02；399.8：药丸／草稿；401.5：边缘29不移动；403.6：resize清理；404：保留的组件外断言FAIL；438：真实搜索行清理；440.8：light背景；441.9：保留的设置标题断言FAIL；524：最终证据与退出 |
| 有共享包 | `/tmp/pi-e2e-starline-hover-shared-a/recordings/run-s40HJa/session.cast` | 521.2：悬停02；522.8：保存00；523.7后：点击02；525.7：药丸／草稿；527.4：边缘29；529.4：resize；529.9：搜索行清理；534.8：light；536.9：最终证据与退出                                                                                       |

偏移来自各 run 的 steps.tsv，为近似定位；完整 captures、launch.sh、record.sh 与退出标记均在对应 run 下。额外保存的纯文本与 ANSI pane 位于 `/tmp/starline-hover-e2e/`，例如 native-first-hover.ansi、native-tail-05.ansi 和 shared-\*.ansi，可复核真实背景颜色与原生箭头位置。

```bash
asciinema play /tmp/pi-e2e-starline-hover-native-a/recordings/run-trLeL3/session.cast
asciinema play /tmp/pi-e2e-starline-hover-shared-a/recordings/run-s40HJa/session.cast
```

两份均为有效 asciicast v2，分别有125／131个输出等事件；Pi 与 recorder 退出均为0／0。已在独立 tmux review pane 完整回放 startup→shutdown，REPLAY_EXIT=0；初次 native review 高度42会裁掉 resize 后的内容，因此又将两组在130×65 pane 完整回放，最终证据 `/tmp/starline-hover-e2e/replay-review-tall/summary.json`。native-060、shared-064 等完整列表帧与对应 .ansi 可核对 light 续行，dark 样式帧在原 review/native-016.ansi、shared-028.ansi；样式值及目标文字已检查。回放不改变原录像与时间，不以 JSON 完整性检查替代终端回放。

### 物理鼠标观察与用户复验

**物理鼠标悬停未观察，手形外观未观察。** 上述 TUI 悬停全部为注入 SGR button35 的无按键移动，证明实际组件派发与渲染收到事件后的响应，不证明当前复用器会自动上报物理移动。Pi 1.5.2 在 tmux／screen 等环境默认仅按键移动；本实现不修改这一策略。要人工确认，请在不经过这些复用器、支持无按键移动上报的直连终端运行（不通过清空 TMUX 等环境变量伪装环境）：

```bash
cd /tmp/pi-e2e-starline-hover-native-a &&
PI_CODING_AGENT_DIR=/tmp/starline-hover-e2e/agent-native \
/etc/profiles/per-user/xzzpig/bin/pi \
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
  --session-dir /tmp/pi-e2e-starline-hover-native-a/manual-sessions \
  -e /home/xzzpig/.herdr/worktrees/pi-extensions/starline/packages/pi-starline/extensions/starline/index.ts \
  -e /tmp/starline-hover-e2e/provider.ts
```

这仍是30个不能实际生成的假模型。打开 /model 或点击药丸，悬停其他模型应只出现背景而不移动箭头；Enter 仍确认箭头候选，点击确认鼠标候选。筛选、导航或调整尺寸后旧背景清除。/tmp 非持久存储，主机清理或重启后复验环境可能消失；未经授权不上传或提交录像／会话文件。

### 规格到证据映射与完成核对

| 增量要求       | 主要证据                                                                            |
| -------------- | ----------------------------------------------------------------------------------- |
| 独立视觉提示   | hover-render 的真实行／ANSI契约，hover 的多行／切换测试，两组实际深浅色 TUI 帧      |
| 不改变原生确认 | hover Enter／Ctrl+S／点击及视窗稳定回归；实际默认模型00文件、会话模型02和无消息证据 |
| 组件事件与布局 | hover 动态失效／前驱／外部无事件用例；真实搜索行、组件外保留、键盘滚轮与resize帧    |
| 兼容与生命周期 | 两版共享API三态／几何失败／正常状态测试，三项组合生命周期回归，真实4份退出探针      |
| 宿主上报边界   | 无强制模式或输入观察代码，注入步骤明确标注；本节列出物理观察缺口与人工命令          |

已重新核对12项任务和五项增量要求。本次只增加 fork-only 背景／状态逻辑、测试和说明，index.ts 仅在原安装调用提供主题回调；元数据记录这一已有接入成本，上一变更与其未提交内容保留，未动 Pi 核心、安装目录或用户全局设置，未提交、发布或归档。

## 阶段六：独立审计反馈与高度单独 resize 修复

首次完成审计拒绝了尺寸失效契约：原几何签名只有渲染宽度、组件行数等数据，组件高度并不是终端高度。同宽下终端增减行数时，列表与子组件身份可完全不变，所以旧提示保留。原阶段五同时改宽高的 resize 不能证明高度单独变化，首次12项完成结论不足；tasks 2.3、3.3、3.4 曾撤回勾选，取得以下新证据后再完成。

修复在现有组件几何边界中验证并读取其关联 TUI 的 terminal.rows，将该值加入签名；沿用现有 render 比较来失效提示和手势，不增加任何外部 resize／终端输入监听。兼容边界新增无效／缺失终端行数的拒绝测试。真实类新回归先建立背景，仅把 terminal.rows 从65改成70并调用原生 invalidate，保持绘制宽度、组件行数和子组件身份不变，确认旧提示消失、普通重绘不复活、新 move 才重建。

该回归修复前在 Pi1.1.0 与1.5.2均稳定失败，日志 `/tmp/starline-hover-height-before.log`、`/tmp/starline-hover-height-host-before.log`。修复后两版各五文件56项通过；最终 typecheck 与完整112文件1642项通过，日志 `/tmp/starline-hover-suite-height-final.log`。定向 Biome、格式、OpenSpec strict及分歧门禁再次通过，Starline checked=191、noise=4、undeclared=0、stale=0。修复四个 TS 路径主动 LSP 未报告错误，1个确认clean、3个silent-on-clean未确认。

### 新录制的同宽高度变化验收

复用原隔离环境，在新的真实 Pi1.5.2进程中继续录制，未覆盖原 cast。测试清单提前补在 `/tmp/starline-hover-e2e/checklist.md`。驱动 `drive-height.py` 与 native 的继续段 `drive-height-tail.py` 在有／无共享包两组都验证：

1. 在130×42下对模型03续行注入 move，出现浅色背景，原生候选仍为00。
2. **仅高度变化130×42→130×47**，不发送 move，背景消失；新 move 后重建。
3. **仅宽度变化130×47→125×47**，背景消失；新 move 后重建。
4. **仅高度变化125×47→125×42**，背景消失；新 move 后重建。
5. 取消、证据命令及正常退出；模型仍00，零消息，新增两份描述符恢复探针均为true。连同前阶段当前共6份探针、每环境3份全部通过。

| 环境     | 新录像                                                                   | 关键时间（秒）                                                                                                                                   |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 无共享包 | `/tmp/pi-e2e-starline-hover-native-a/recordings/run-E38xMo/session.cast` | 31.9高度增加并清理；32.3保留的驱动FAIL（错误假设继续进程仍选02，实际按默认00启动）；79.8解释并继续；80.4仅宽度清理；81.0仅高度收缩清理；82.2结束 |
| 有共享包 | `/tmp/pi-e2e-starline-hover-shared-a/recordings/run-Yp8iHj/session.cast` | 82.9高度增加并清理；86.4仅宽度清理；87.0仅高度收缩清理；88.2结束                                                                                 |

新增 native 驱动FAIL发生在背景已正确清除之后，是模型恢复预期错误，不是产品回归；原运行与捕获保留，后续按实际候选00继续验证，不修改产品去迎合假设。native-height-03/04、native-height-tail-\* 与 shared-height-03/04等 .txt/.ansi 是本次实际 pane 证据；32.3失败及79.8继续均保留在同一录像中。

```bash
asciinema play /tmp/pi-e2e-starline-hover-native-a/recordings/run-E38xMo/session.cast
asciinema play /tmp/pi-e2e-starline-hover-shared-a/recordings/run-Yp8iHj/session.cast
```

两份新 cast 均有效 v2、有输出事件、Pi／recorder退出0／0，并在65行独立 tmux review pane 从启动完整回放到退出、REPLAY_EXIT=0。回放脚本 `replay-height-review.py`，结果 `/tmp/starline-hover-e2e/replay-height-review/summary.json`，native-006→007与shared-010→012等 .ansi 显示背景→清理状态。原两份宽高共同变化的录像继续保留，但不再作为高度单独变化证明。

伴随扩展的 selection-evidence.json 是“最新一次命令”的快照，续跑后现为模型00／messageCount0；不能拿这一最新快照宣称旧阶段仍是02。旧阶段实际模型02及当时零消息由保存的 native-finish-02.txt、shared-29.txt（页脚model02与证据命令通知）和原录像／驱动断言证明。测试没有生成普通消息，因此原会话可能没有落地 JSONL；不以不存在的会话文件充当证据。

尺寸要求的证据映射补充为：真实类高度单独回归 + 无效终端行数契约 + 两份新TUI录像及其同宽 resize 步骤。其余阶段五的背景、Enter／保存／点击、视窗稳定等原始矩阵依然适用；再次核对五项要求与全部任务后，无实施验收阻碍。物理鼠标／手形仍未观察，所有悬停移动注入与 /tmp 非持久限制仍然有效。
