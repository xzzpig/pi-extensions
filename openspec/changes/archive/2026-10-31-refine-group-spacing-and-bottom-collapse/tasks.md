# Tasks

本清单是待实施工作；只有真实执行并获得对应证据后才能勾选。不得把组件探针、旧版本录屏或规划完成视为本次最终 TUI 验收。

## 1. 基线与回归复现

- [x] 1.1 核对当前 Pi、`pi-group-collapse` 与同装插件版本、工作区改动和宿主组件契约；用真实 `AssistantMessageComponent`、通知入口及 `Container.render` 证明可观察到的组件顺序和行高，不读取或复制用户真实会话。（Pi 1.1.0、Node 24.18.1；`/tmp/pigc-layout-apply-baseline.jsonl` 记录真实组件与容器输出一致，33 段思考残留 33 行，10 条思考与通知残留 20 行。）
- [x] 1.2 添加真实组件回归，构造 38 次工具调用与多条助手消息中的 33 段思考，先确认旧实现出现可计数的摘要后空白，再断言修复后只有应有边距且组计数不变。（`test/group-layout.test.ts`：修复前 33 行、修复后 1 行；摘要计数 38/33。）
- [x] 1.3 添加普通通知 `info`、`warning`、`error` 的占位归属回归，覆盖多条入组、原地复用、尾部迁移、keep、核心覆写和来源不可证明；断言不误删常显项，并验证旧实现对已确认的多通知占位会失败。（`group-layout.test.ts` 与 `notification-adapter.test.ts`：修复前 11 行、修复后 1 行；复用、keep、核心覆写及不可证明归属分别验证。）
- [x] 1.4 添加组与前后正文紧邻、已有空白、相邻组、转录首尾以及同一助手消息内思考/正文交错的布局回归；精确断言新增边距、原正文和有意义的空白。（`group-layout.test.ts` 覆盖紧邻正文、已有空行、相邻组、首尾、思考与正文交错及五次展开/收起重复检查。）
- [x] 1.5 添加末尾控件的失败复现，覆盖组首尾由同一组件承载、末尾为独立可展开工具、思考 run、通知/自定义消息及末尾成员零行输出，断言头尾为同一组对象。（`group-layout.test.ts`、`summary-click.test.ts` 覆盖工具、思考、通知、自定义消息、单组件及零行末尾；初始红态缺少控件。）
- [x] 1.6 以实际宿主组件树和 Starline 显式目标消费者验证控件行的组件归属及局部坐标，覆盖原生组件派发和 Starline 两条路径；记录不满足的宿主契约并先修接入或安全降级，不能继续隐藏内容。（`starline-footer.test.ts` 使用真实 ScrollView 布局和 Starline 目标解析，工具、思考、通知三类组尾与标题均解析为同一组；原生路径另由 `summary-click.test.ts` 覆盖。）

## 2. 折叠占位与组外间距

- [x] 2.1 在助手投影中识别隐藏思考独占的前置/后置占位，保留载有标题、可见正文或诊断的行；运行 1.2、1.4 的真实组件用例并比较成员原展示。（隐藏思考仅移除可证明的专属占位；`group-layout.test.ts` 同时断言混合正文和截断诊断保留。）
- [x] 2.2 为已证明通知与其专属外层占位建立弱身份关联，分别处理新建、复用及 `warning`/`error` 追加；运行 1.3 并证明不改宿主通知构造器或共享正文。（定向 23 项通过；回归断言构造器引用及宿主共享正文未被改写。）
- [x] 2.3 让经受控补丁绑定的主转录占位仅在所属组确实可安全折叠时隐藏；覆盖其他 `Spacer` 实例、重复安装/卸载、宽度不足和不可确认归属均保持透传。（`notification-spacing.test.ts` 3 项及 `group-layout.test.ts` 定向用例通过；缺能力会话提示、错序卸载、位置变动均已覆盖。）
- [x] 2.4 在组与相邻可见内容之间按需补一行外部空白，对已有空白和相邻组边界去重；运行 1.4 并断言展开/收起与重复重绘不增加空行。（`group-layout.test.ts` 精确验证前后边距、相邻组去重以及反复重绘和展开/收起不累积空行。）
- [x] 2.5 将新增和移除的布局行纳入宿主行高、助手投影与原行坐标映射，保持宽度、原始内容及 OSC 133 锚定；用真实 `Container` 对比行号和正文/思考的鼠标回译。（`group-layout.test.ts` 以真实 Container 校验行号与 OSC 133；`summary-click.test.ts` 验证投影后的原行鼠标回译。）

## 3. 组末尾控件与点击归属

- [x] 3.1 为当前视图索引提供组末尾成员及助手思考 run 的可靠映射，覆盖单成员、同组件多组、零行末尾和视图重建；验证不扫描全组来解析每个成员。（当前视图的弱组件索引与思考 run 行映射覆盖单成员、同组件多组、零行末尾和重建；`scale.test.ts` 覆盖规模变化。）
- [x] 3.2 按实际组末尾绘制单行组级收起控件，仅显示于可安全定位的已展开组；验证成员字节、原始宽度、分组计数、可见顺序及活动轮原样透传。（工具、思考、通知及自定义消息承载的组尾各有测试；活动轮保持原样，成员内容和自身展开状态保留。）
- [x] 3.3 为标题、末尾控件和原正文建立不同局部行映射，复用现有 v1 显式目标和同一稳定组句柄；验证混合助手消息内多个组、相邻组及首尾同组件不串组。（`group-layout.test.ts`、`starline-footer.test.ts` 断言标题与组尾使用同一稳定目标，混合消息及相邻组不串组。）
- [x] 3.4 更新无 Starline 的原生鼠标路径，覆盖合成 click 与 press/release，断言按下不消费、完整单击只收起一次、拖动或目标变化不收起，且成员原点击坐标正确。（`summary-click.test.ts`、`group-layout.test.ts` 覆盖合成 click、press/release、按下透传、拖动和位置变化；双击跨 Starline 与原生回退的两条回归先红后绿。）
- [x] 3.5 验证 Starline 及 pi-mouse-events 同装时，真实组件树先解析末尾显式组目标而非承载工具；对通知承载和未命中正文验证原解析及选择、双击、链接、浮层行为。（`starline-footer.test.ts` 与最终 `interaction.cast` 覆盖 Starline 同装的组目标、通知承载、真实双击、链接和浮层；拖选见 solo/combo。）
- [x] 3.6 验证极窄列宽、无主题、主题切换与尺寸变化下控件不溢出；位置或能力不可证明时安全省略控件，组标题/现有命令及原成员仍可用。（`header-style.test.ts` 验证窄宽、无主题及主题变化；`group-layout.test.ts` 验证游离/位置失效时控件不认领，标题与命令保留。）

## 4. 生命周期、性能和组合回归

- [x] 4.1 覆盖通知由 group 变 keep、真实复用更新、组件移除以及 `/reload`、`/resume`、`/new`、树导航和压缩后的关联清理；断言旧占位或旧控件不作用于新视图。（`group-layout.test.ts` 经扩展的 session_tree/session_compact 处理器模拟视图替换，验证旧通知占位和组尾失效；真实 TUI 覆盖 reload/resume/new，树导航和压缩未单独录制。）
- [x] 4.2 对稳定重绘和单次状态变化记录成员、占位及组端点的操作次数；用不同规模断言扫描不因逐成员查询而平方增长，并验证无多余自触发帧或旧组件强引用。（`scale.test.ts` 的 20/40 组投影调用数为 155/315；`gc-reclamation.test.ts` 验证旧组件可回收。此为操作次数与回收证据，不宣称帧率改善。）
- [x] 4.3 在非 TUI、外部转录、不支持的宿主结构和扩展未加载时验证安全回退：现有组件与其他插件默认体验不变，不吞正文、通知、诊断或拖选。（`runtime.test.ts`、`host-contract.test.ts`、`host-adapter.test.ts`、`notification-spacing.test.ts` 覆盖非 TUI、外部转录、未绑定组件和能力缺失时的安全透传；拖选另有真实录屏。）
- [x] 4.4 运行 `pnpm --filter @xzzpig/pi-group-collapse run typecheck` 与包内完整测试套件，记录命令、工作目录和结果；必要时补跑受影响的 Starline/鼠标契约测试，只为新增组级行调整必要的行数预期，不放宽成员原展示、点击归属和安全降级断言。（仓库根执行 `direnv exec . pnpm --filter @xzzpig/pi-group-collapse run typecheck` 与包内 `vitest run --maxWorkers=2`；40 文件、337 测试全部通过。）
- [x] 4.5 更新 `packages/pi-group-collapse/README.md` 与未发布变更说明，写明组外间距、组末尾控件、窄宽/非鼠标回退及保留成员原展示；不擅自升级版本、安装或发布。（README 与 CHANGELOG 的 Unreleased 已说明边距、组尾、窄宽及命令回退；未升级版本。）
- [x] 4.6 运行仓库 `pnpm run verify` 和本变更严格校验；若实施确需修改上游派生包，先遵循 `pi-fork-divergence` 并核实对应声明、非零审计覆盖和无未声明分歧。（仓库根执行 `direnv exec . pnpm run verify` 和本变更 `openspec validate --strict --no-interactive` 均通过；fork 审计未声明及过期分歧均为 0。）

## 5. 隔离真实 TUI 验收与录屏

- [x] 5.1 按 `pi-plugin-e2e-test` 与 `pi-tmux-tmp-server` 技能核查可连接的宿主 tmux、Pi 和 asciinema；如 tmux 宿主不可用，依技能向用户说明并询问，不在工具沙箱中伪装通过。（确认宿主 tmux 可连接、Pi 1.1.0、asciinema 3.2.0；仅使用自己的临时会话，宿主会话保留。）
- [x] 5.2 在 `/tmp` 独立 cwd、agent 和 session 目录显式加载待验证源码，使用离线可控夹具生成 38 工具、33 思考和 10 条真实通知入口调用；从会话/断言记录核对数量，录制折叠单摘要、前后边距与缩放后的画面。（最终 solo/combo 的 session JSONL 分别独立核对 38 个调用与结果、33 段思考；夹具日志记录 10 条通知，画面显示单摘要及前后边距。）
- [x] 5.3 在真实 TUI 中录制长组从头部展开、滚动至实际末尾、点击控件收起并再次展开，分别验证末尾为工具、思考和通知的命中；不能用直接调用插件内部状态代替真实输入。（`scroll.cast` 实际上滚后回到组尾点击收起；solo 再展开；`thought.cast` 和 `notification.cast` 分别验证思考与通知承载末尾。）
- [x] 5.4 同装 Starline、pi-mouse-events、pi-tool-display 和 pi-thinking-collapse，并单独验证无 Starline 回退；录制真实 press→motion→release 拖选、普通完整单击、成员点击、链接/双击/浮层及窄宽行为，明确未覆盖项。（solo 为无 Starline 回退；combo 和 interaction 同装四插件，录制真实拖选、单击、成员行点击、链接、双击、浮层和 80 列。短工具输出的成员点击没有可区分的视觉变化，原行回译由组件测试验证。）
- [x] 5.5 在最终候选上验证既有主规格的活动轮常显、正常收尾、异常延期、配置选择与 reload、原生快捷键和会话替换；用实际会话/画面证据逐项标注通过或阻塞，不拿旧录屏代替。（`lifecycle.cast` 验证活动、实际中止与下轮正常收纳、keep/default 配置及 reload、Ctrl+O/Ctrl+T、new/resume 和恢复后组尾；最终录屏未单独覆盖 fork、树导航或压缩。）
- [x] 5.6 将本次独立录制、会话/断言、启动命令、版本、配置、场景时间索引及源码和夹具录前/录后 SHA-256 清单保存在 `artifacts/pi-group-collapse/e2e/<run-id>/`；检查不含用户会话或凭据，asciicast v3 时间按增量累加。（证据保存在 `artifacts/pi-group-collapse/e2e/spacing-bottom-20261030-verified/`；七个最终 cast、会话、配置、时间索引与录前/录后清单均已保存，凭据扫描无命中。）
- [x] 5.7 在真实 PTY 中回放每个最终 `.cast` 并记录退出码；逐场景核对原始录屏和断言、写明未覆盖或失败证据，缺少真实运行或有效录制时不得宣称最终验收完成。（七个最终 cast 经真实 PTY 回放均退出 0；逐项复算见 `final/evidence/parent-verification.json`，修复前失败件与未覆盖项保留在验收报告。）
