# 实施与验收记录

## 范围与实现

- 原生模型入口：`packages/pi-starline/extensions/starline/fork-model-selector-entry.ts`，通过当前编辑器的 `app.model.select` 动作打开，不提交命令或用户消息。
- 几何兼容边界：`fork-model-selector-geometry.ts`，验证必要状态并按真实子组件渲染高度映射候选行，不解析模型显示文本。
- 组件鼠标适配：`fork-model-selector-mouse.ts`，只包装模型选择器的 render/handleMouse，原生前驱优先、宿主 wheelDelta、首尾钳制、手势身份复核、弱引用实例状态及描述符所有权恢复。
- 仅 `index.ts` 与 `pill-actions.ts` 保留入口/生命周期最小接入点；原有 `test/model-picker.test.ts` 的点击气泡断言按新行为调整两行。其他行为测试与说明放 fork-only 文件。
- 不改 Pi 核心、Nix store、安装目录、共享鼠标 API、用户全局配置、依赖/版本或锁文件；未提交、推送、发布或归档。

## 自动化验证

命令均从仓库根目录通过 `direnv exec .` 执行。

| 检查                                                                                                                    | 实际结果                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @xzzpig/pi-starline run typecheck`                                                                       | 通过                                                                                                                                   |
| `pnpm --filter @xzzpig/pi-starline test`                                                                                | 110 文件、1614 测试通过，日志 `/tmp/starline-model-suite-final.log`                                                                    |
| 入口、几何、鼠标及原模型测试                                                                                            | 4 文件共 34 项，随最终全量执行通过                                                                                                     |
| `STARLINE_PI_ENTRY=<宿主公开 dist/index.js> ... vitest run test/fork-model-selector-{geometry,mouse,lifecycle}.test.ts` | 宿主 Pi 1.5.2 的真实类契约 3 文件、28 测试通过；仓库 Pi 1.1.0 也通过                                                                   |
| 新增 8 个 TS 文件的 `biome check`                                                                                       | 通过；仅现存配置 schema 2.6.3 与 CLI 2.6.4 的信息提示，未修改上游配置                                                                  |
| `pnpm run audit:fork-divergence`                                                                                        | 通过；Starline `checked=191 noise=4 deleted=0 declared=4 undeclared=0 stale=0`，均为已有声明噪音，日志 `/tmp/starline-model-audit.log` |
| `git diff --check`                                                                                                      | 通过                                                                                                                                   |
| `openspec validate enhance-native-model-selector-mouse --strict`                                                        | 通过                                                                                                                                   |

主动 changed-path LSP 探测未报告错误，但此环境 TypeScript 服务为 silent-on-clean，初次 10 个路径中仅 1 个确认 clean，9 个未确认（其中 2 个超时，其余 silent-on-clean），另有 3 条上游位置诊断沿用仓库既有规则豁免，未新增抑制；因此类型正确性的肯定证据是实际 `tsc --noEmit` 成功，不能把空诊断当作已确认干净。

首次全量测试曾出现 20 项失败，原因是旧测试上下文夹具没有会话 ID 方法；已在新入口明确探测该能力，缺失时不启用入口，不改写所有旧夹具。初次日志 `/tmp/starline-model-suite.log`、定向复测日志 `/tmp/starline-model-retry.log` 保留；最终全量已无失败。

### 规格与测试对应

- 药丸原生入口、非 UI、缺少动作、包装编辑器、焦点/浮层占用、旧会话清理、草稿不被替换：`test/fork-model-selector-entry.test.ts`；原命令循环回归在 `test/model-picker.test.ts`。
- 超一屏、名称/提供方换行、提示行、非法坐标、搜索空态、刷新、范围和 resize：`test/fork-model-selector-geometry.test.ts`，使用真实原生类而非复制选择器。
- 完整点击一次、拖动/右键不确认、宿主滚轮步长、空态/边界消费、手势之间目标变化、重复安装、继承属性恢复、后续拥有者及原生已处理事件：`test/fork-model-selector-mouse.test.ts`。
- 同一鼠标测试分别覆盖无共享包、旧版无指针方法、有指针方法三种状态；全部可点击和滚轮，仅最后一种会调用现有共享指针 API。

## 隔离真实 TUI 验收

环境：Pi 1.5.2，asciinema 3.2.1，现有 `/tmp` tmux 服务；从全新 `/tmp/pi-e2e-*` 目录启动，使用隔离 `PI_CODING_AGENT_DIR`、禁用所有自动资源发现，仅通过 `-e` 加载本地 Starline、模型夹具以及第二组中的本地共享鼠标扩展。模型夹具提供 30 个长名称模型，其中初始范围为前 10 项；不执行模型推理，provider 请求路径设置为禁止生成。

精确启动/录制命令在每个 run 的 `launch.sh`、`record.sh`；驱动脚本与事先定义的验收清单位于 `/tmp/starline-model-e2e/`。所有录像本地保留，不上传，不提交。`/tmp` 非持久存储，重启或清理前如需长期保存须另行安排。

| 运行           | 录像与关键时间（秒，按 steps.tsv 近似）                                                                                                                                                                                                  | 结果                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 无共享包       | `/tmp/pi-e2e-starline-model-native-a/recordings/run-f9Ys6R/session.cast`；31.9 启动，77.1 滚轮，95.2 换行点击，137.3 药丸和全目录搜索，224–228 首尾/空结果/取消，228.3 快捷键，229.2 右键与拖动，231–234 reload/草稿/设置界面            | 全部通过；Pi 与 recorder 退出均为 0                                                         |
| 有共享包       | `/tmp/pi-e2e-starline-model-shared-a/recordings/run-l5XkNT/session.cast`；52.8 原生命令，53.0 单次滚轮，53.6 全目录搜索，54.0 换行点击 model-29，54.6 药丸/草稿，55.0 快捷键，55.6 空结果，56.6 键鼠交替，59.0–59.4 resize/reload 后点击 | 全部通过；Pi 与 recorder 退出均为 0                                                         |
| 共享包补充录制 | `/tmp/pi-e2e-starline-model-shared-a/recordings/run-lGAcSK/session.cast`；23.9 记录 Ctrl+L → 滚轮一次 → Ctrl+S 的原生默认模型保存                                                                                                        | 通过，隔离 settings.json 的 defaultModel 为 model-01，UI 显示 Default model；两项退出均为 0 |

无共享包时滚轮从 model-00 高亮移到 model-01 而实际模型仍为 model-00；点击 model-03 的换行提供方行后，只出现一次 Model: model-03。all 范围搜索 model-2 得到 12 个原生模糊匹配项，可滚到 12/12，额外滚动后的整个 pane 文本不变；空结果滚动前后 pane 文本也相同。取消后原草稿保留，reload 后一次滚轮只移动一项，设置界面打开时模型药丸不覆盖它。

共享运行在 130×42 下验证主要交互，再改为 95×65，确认 resize 后点击换行行仍选择 model-04，且保留 resize draft。通过测试专用命令读取原生内存会话条目，证据 `/tmp/starline-model-e2e/agent-shared/selection-evidence.json` 显示模型为 model-04、仅 model_change/thinking_level_change 条目、messageCount=0。未发送首条对话消息，因此 Pi 延迟创建 session JSONL；通用 entries 脚本在原生运行报“无 session 文件”，不能伪称存在持久会话消息证据。

### 回放与观察范围

七个 cast 均验证非空、asciicast v2、具有输出事件和完整的成功退出标记；均在独立 tmux review pane 从头到尾播放成功（REPLAY_EXIT=0）。已检查启动、原生列表、全目录搜索、空态、选择反馈、reload 草稿和默认保存等关键终端帧，回放帧保存在 `/tmp/starline-model-e2e/replay-review/`。观察为终端回放和文本帧，不声称人工逐像素确认颜色/动画。

```bash
asciinema play /tmp/pi-e2e-starline-model-native-a/recordings/run-f9Ys6R/session.cast
asciinema play /tmp/pi-e2e-starline-model-shared-a/recordings/run-l5XkNT/session.cast
asciinema play /tmp/pi-e2e-starline-model-shared-a/recordings/run-lGAcSK/session.cast
```

每个 run 的 `steps.tsv` 与 `pane-*.txt` 提供动作时间及对应屏幕结果；原始录像保留原始时间，仅回放时采用 speed/idle-time-limit 加速。

## 限制

- tmux/终端可能不提供悬停或 OSC 22 指针显示；手形仅有 API 调用测试证据，不声称真实终端已显示。无手形不影响已实测的点击与滚轮。
- 真实 TUI 仅验证宿主 Pi 1.5.2，类契约另覆盖仓库 Pi 1.1.0；不宣称整个 peer 范围已验证。未来原生内部结构变化时由明确兼容探测与契约测试暴露。
- 不涉及发布、OpenSpec 归档或宿主升级。

## 独立审计反馈与清理顺序修复

首次完成审计拒绝了清理契约：实际安装是原生鼠标 render 在内、selector-border render 在外，cleanupUi 却先释放内层再释放外层，导致外层恢复出停用的内层包装，描述符未恢复。此前单独补丁测试与“一次滚轮只移动一次”的 TUI 验证无法识别这一残留，不足以证明卸载正确。

新增 `test/fork-model-selector-lifecycle.test.ts` 的真实 Starline session_start/session_shutdown 回归，在修复前稳定复现 render 身份不一致，日志 `/tmp/starline-model-lifecycle-before.log`。修复仅调整 index.ts 的清理调用顺序，先卸载外层边框再释放内层鼠标。回归分别覆盖真实 Starline 会话与实际两种补丁的组合，各重复 5 个周期，断言函数身份、自有/继承属性描述符完全恢复且不累积；仓库 Pi 1.1.0 与宿主 Pi 1.5.2 均通过。最终完整回归重新执行，110 文件、1609 项全部通过，typecheck 与分歧审计再次通过。修复后对 index.ts 与新增组合测试再次主动探测 LSP，均未报告错误但仍为 silent-on-clean 未确认，最终类型证据仍采用实际 tsc 成功。

另外补录两个真实 Pi 1.5.2 TUI 运行：

| 环境     | 新录像                                                                   | 退出与清理证据                                                                                                |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 无共享包 | `/tmp/pi-e2e-starline-model-native-a/recordings/run-iUM8PL/session.cast` | 3 次 reload 及最终 shutdown 共 4 份原型探针全部 renderRestored=true、mouseRestored=true；Pi/recorder 退出均 0 |
| 有共享包 | `/tmp/pi-e2e-starline-model-shared-a/recordings/run-DDW682/session.cast` | 同样 4/4 探针完全恢复；每次 reload 后原生选择器能打开且单次滚轮只移动一项；退出均 0                           |

测试专用 companion 在 session_start 前保存原型描述符、在 Starline shutdown 清理后比较并写出 `/tmp/starline-model-e2e/agent-{native,shared}/cleanup-*.json`，无需修改宿主或生产实现来收集证据。驱动脚本 `/tmp/starline-model-e2e/cleanup-cycles.py` 同时断言这些 JSON 与实际 TUI 行为，所有 8 份探针通过。

新录像已各自在独立 tmux review pane 完整回放（REPLAY_EXIT=0），关键列表帧位于 `/tmp/starline-model-e2e/replay-cleanup-review/`。其精确步骤时间与 pane 捕获仍保存在对应 run 的 steps.tsv、pane-\*.txt。

```bash
asciinema play /tmp/pi-e2e-starline-model-native-a/recordings/run-iUM8PL/session.cast
asciinema play /tmp/pi-e2e-starline-model-shared-a/recordings/run-DDW682/session.cast
```

## 第二轮审计反馈：几何失败必须明确告警

第二轮审计确认组合清理已修复，但复现了另一条兼容失败路径：selectorState 合法、selectorGeometry 因候选子组件不足或零高度返回 undefined 时，原先没有发出说明，事件会静默回到前驱。现已在有效宽度、未关闭的实际绘制中检查几何失败并调用会话去重告警；事件处理也先重新验证当前几何，失败时清除旧手势、告警后安全退出，不继续执行滚轮更新。未绘制、关闭和零宽度是正常不可交互状态，不误报告警。

新增 5 项真实类回归：两种几何失败分别从 render 与事件路径进入，均只告警一次且键盘原生确认仍可用；另验证正常未绘制/关闭/零宽场景不告警。修复前 4 项失败，日志 `/tmp/starline-model-geometry-warning-before.log`；修复后定向 5 文件 41 项、宿主真实类 3 文件 28 项通过。最终再次运行完整套件，110 文件、1614 项通过；类型、格式、分歧审计与 OpenSpec 严格验证通过。changed-path LSP 未报告错误，2 路径中 1 个确认 clean、1 个 silent-on-clean 未确认。

最新代码又分别在有、无共享包的真实 TUI 中验证 3 次 reload、单次滚轮和最终 shutdown，新增 8 份清理探针全部恢复；连同上一阶段保留的探针，当前 native/shared 各 8 份、合计 16 份均为 true。新驱动为 `/tmp/starline-model-e2e/geometry-warning-final-cycles.py`，新录像如下：

```bash
asciinema play /tmp/pi-e2e-starline-model-native-a/recordings/run-52QPBY/session.cast
asciinema play /tmp/pi-e2e-starline-model-shared-a/recordings/run-M7nzTr/session.cast
```

两份录像均为有效 v2、有输出事件、Pi/recorder 退出 0/0，并完整回放为 REPLAY_EXIT=0；检查的关键列表帧位于 `/tmp/starline-model-e2e/replay-warning-review/`。最新原生运行的驱动第一次启动断言早于初始化完成而失败，初始 capture 与步骤记录未删除、录像未重启或覆盖；等待同一运行完成初始化后继续全部验证，产品未发生异常。
