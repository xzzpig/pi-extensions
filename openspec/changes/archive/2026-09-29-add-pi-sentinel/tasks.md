# Tasks

## 1. 包脚手架与配置

- [x] 1.1 创建 `packages/pi-sentinel` 包骨架：`package.json`（npm 名 `@xzzpig/pi-sentinel`，`pi.extensions: ["./extensions"]`，peerDependencies 引 pi 核心包用 catalog 版本，scripts 对齐仓库惯例）、`tsconfig.json`、`extensions/index.ts` 空入口、README/CHANGELOG 骨架。验证：`pnpm install --frozen-lockfile` 成功且 `pnpm --filter @xzzpig/pi-sentinel run typecheck` 通过。
- [x] 1.2 实现 `extensions/config.ts`：全局 `<agentDir>/sentinel.json` + 项目 `<CONFIG_DIR_NAME>/sentinel.json`（受信任才读）加载，`defaults` 按键合并（含 `fleetKeybindings`）、`rules` 按 name 同名替换/异名追加，单条规则校验失败跳过并警告（含 `mode`×`trigger.type` 矩阵、审计员 `tools` 含扩展/MCP 工具名、未知字段），坏文件警告跳过，文件级未知键警告忽略，零规则静默。验证：vitest 覆盖"项目覆盖同名全局规则""非法规则不影响其余规则""非受信任项目忽略项目配置""文件级未知键警告忽略""审计员 tools 含扩展工具名校验失败"五个场景通过。

## 2. 审计引擎核心

- [x] 2.1 实现 `extensions/template.ts`：基于 `handlebars`（`pnpm add` 到本包 dependencies）的渲染适配——`compile(prompt, { noEscape: true })`、非 strict（缺失路径渲染空串）、`Handlebars.parse` AST 收集变量路径并与事件根键差集产出未解析路径诊断、注册内置 helper `json`/`truncate`/`now`（不开放自定义注册）。验证：vitest 覆盖"点路径引用命令内容""`{{json input}}` 整 JSON""未知路径渲染空串且进入诊断""含 `&&`/`<` 的命令文本不被转义""`{{#if isError}}` 条件拼接与 `{{#each}}` 循环""`truncate`/`now` helper"六场景。
- [x] 2.2 实现 `extensions/event-data.ts`：按 spec"事件数据与模板变量"需求的字段表构造各触发器的事件数据对象（模板变量根 + tool 触发器的范围段 JSON；字符串字段 8000 字符截断）与消息文本序列化，序列化器接受规则 `includeThinking` / `includeToolInputs` / `includeToolOutputs` 选项（thinking 并入/redacted 省略、toolCall 占位、图片占位，对齐 observational-memory）、其余触发器的转写文本范围段、按触发器默认 window 与规则 `window` 覆盖切片、`maxWindowTokens` 估算上限截断。验证：vitest 覆盖五种触发器的事件字段表与默认范围、window 覆盖、超长截断、thinking/redacted/toolCall 序列化、三个 include 开关的开/关两态。
- [x] 2.3 实现 `extensions/audit-loop.ts`：封装 `agentLoop`（pi 0.87.1 形态：审计系统提示作为 leading system message，`finishTurn` 计数实现 maxTurns，thinking 走 `config.reasoning`，streamFn 用 `ctx.modelRegistry.streamSimple`，挂 `getSteeringMessages` 队列 drain 供 fleet steer），固定 `audit_verdict` 工具（typebox schema），可选内置只读工具白名单（按白名单用对应内置工具工厂构造，如 `createReadTool`/`createGrepTool`/`createBashTool`；集合用 `createReadOnlyTools`），未调用裁决/字段非法/stopReason error|aborted/超时/模型解析失败判失败（replace 主动中止除外），live 详情句柄（开始时间、模型、prompt 概要、工具调用计数、流尾环形缓冲）。验证：vitest 用注入的 fake agentLoop 覆盖"裁决即结论""未产生裁决视为失败""开启只读工具""steer 消息在下一轮到达"四场景。
- [x] 2.4 实现 `extensions/cache.ts`：sha256 键（规则名 + 规则定义内容哈希 + 渲染后 prompt + 范围文本）、TTL、仅成功裁决入缓存。验证：vitest 覆盖"TTL 内复用""TTL 过期重审""失败不缓存""同名不同定义不命中旧缓存"。
- [x] 2.5 实现 `extensions/runner.ts`：每规则状态机（idle/queued/running）实现 overlap 四策略（parallel/serial/ignore/replace 含 AbortController 中止，replace 主动中止豁免失败分类与负冷却）、全局并发信号量（maxConcurrent，FIFO，饱和矩阵：parallel/serial 排队、ignore 丢弃、replace 先中止后排队）、超时与失败策略（默认 fail-open，规则 fail-closed）与 30 秒负冷却、裁决分流（pass/warn/fail，缓存命中走完整分流）。验证：vitest 覆盖四种 overlap 场景（含饱和矩阵）、全局上限、fail-open/fail-closed 两分支、负冷却期间排队项照常执行。
- [x] 2.6 实现 `extensions/injection.ts`：`sendMessage` 注入（customType `pi-sentinel-finding`，**双路径投递**：主循环流式中 `deliverAs: "steer"`、空闲时不带 deliverAs 直接发送立即持久化，禁用会滞留的 `nextTurn`）+ `registerMessageRenderer` 渲染（规则名、级别徽标、message）+ 规范化哈希判重与冷却窗口（默认 10 分钟，可配可关）。验证：vitest 覆盖"pass 静默""fail 注入""同类发现冷却去重""流式/空闲两路径选择"。

## 3. 触发器接线与生命周期

- [x] 3.1 `extensions/index.ts` 接线 `tool_call` blocking 门控：按 `trigger.tools` 数组模式过滤、同调用多规则并发、任一 fail 拦截并合并理由、审计失败走失败策略与 30 秒负冷却；warn 附着 `Map<toolCallId, warning>`，`tool_result` 返回**完整数组**（前缀行 + 原内容），warn 与 fail 并存以 fail 为准，拦截/中止时丢弃待附条目。验证：vitest 覆盖"fail 拦截并返回理由""审计失败默认放行与负冷却""多规则任一 fail 即拦截""warn 前置且原内容保留""拦截后无 tool_result 时警告条目清理"。
- [x] 3.2 接线 background 触发器：`tool_result`（按 `trigger.tools` 数组过滤）、`turn_end`（最近一轮范围）、`agent_end`（本次 agent 循环启动以来的消息范围）、`context_tokens`（倍数水位上穿触发、每次检查后水位跟随当前 level、每规则增量标记切片"上次触发 → 当前末尾"，会话恢复时标记初始化为恢复点末尾、屏蔽期间标记照常前移，`getContextUsage()` 不可用/tokens null 跳过检查，检查在 turn_end 触发器之后，压缩边界重置）。验证：vitest 覆盖"按工具名数组过滤（含 `edit|write` 与 `mcp__*` 模式）""每跨越倍数边界触发一次""压缩回落后重新上穿再触发""用量不可用时跳过""增量消息恰好覆盖两次触发之间""turn_end 触发"。
- [x] 3.3 生命周期处理：`session_before_switch`/fork 重置运行时状态（中止在跑、清缓存与冷却）、`session_shutdown` 中止全部审计与配置对话、`session_tree` 沿新活动分支重放会话级 op-log 并将指向非活动分支的增量标记以当前末尾重置；会话级配置不属于重置范围（切走再切回仍生效）。验证：vitest 覆盖"会话切换重置""全局并发上限""树导航后 op-log 重放与标记重置"。
- [x] 3.4 实现 `extensions/session-store.ts` 与 `/sentinel:list` 内联管理：`pi-sentinel-session-config` 会话条目 op-log（追加式、重放幂等，**沿活动分支 `getBranch()` 过滤 customType，不用 `getEntries()`**）、会话加载/恢复/切换回时重放重建会话级规则集与屏蔽表（fork 随条目复制自然继承）；`/sentinel:list` 列出全部哨兵（名称、触发器、模式、模型、enabled、实时状态、最近裁决、加载来源），交互模式下选择哨兵后 `ui.select` 执行启用/禁用（按名屏蔽/解除，任意来源规则）/移除（仅会话级新增规则，对继承规则拒绝并提示用禁用；移除遮蔽性会话规则后继承规则恢复），操作即追加会话条目并热加载（热加载语义：在跑审计按旧定义完成分流、队列清空、增量标记重建、该规则名下缓存与冷却失效）；三作用域合并链（defaults 项目覆盖全局；rules 全局 < 项目 < 会话同名覆盖）接入生效配置；TUI 以外模式打印文本总览。验证：vitest 覆盖"会话中新增并跨重启生效（重放恢复）""禁用屏蔽继承规则""fork 继承会话级配置""移除仅限会话级规则""同名替换后缓存失效、旧审计按旧定义分流"。
- [x] 3.5 实现 `extensions/configure-dialog.ts`：`/sentinel:configure` **后台**配置对话——命令立即返回（`ui.notify` 确认），旁路 `agentLoop` 逐轮推进（系统提示内嵌规则字段说明与配置示例，模型走解析链），不弹界面、不向主会话注入任何消息；同一时间至多一个对话实例（重复启动 `ui.confirm` 询问"取消当前并开始新的 / 保持现有"，即取消途径），会话切换/关闭随运行时状态中止；对话转录与待提交草稿登记进 Registry 供 fleet 查看；`submit_config` 工具（变更类型 add/update/remove，remove 支持文件级删除与会话级移除）提交草稿时挂起对话循环 → 主进程校验（同一校验器）→ fleet overlay 若开着先自动关闭 → 预览对话框三选：写入（`ui.select` 选作用域）/ 继续调整（附自然语言要求）/ 放弃，校验错误视同继续调整回传，结果作为工具结果恢复对话；session 写入走会话条目，global/project 读取-合并-写回，写入后热加载，新增同名规则遮蔽继承规则时提示遮蔽关系。验证：vitest 以 fake 循环与 UI stub 覆盖"草稿校验失败不写入且回传错误""继续调整回传要求""放弃不写入""remove 不存在的规则报错"；手动在交互式会话验证后台运行、fleet 可见、完整写入流程、热生效与主会话隔离。

## 4. 可观测性

- [x] 4.1 实现 `extensions/registry.ts`：SentinelRegistry 持有各 Runner 实时状态、最近 20 条审计记录（含缓存命中/跳过原因）与 running live 详情读取。验证：vitest 覆盖状态流转与历史滚动。
- [x] 4.2 实现 `extensions/commands.ts` 与 `extensions/fleet-view.ts`：`/sentinel:list` 命令（列出全部哨兵：名称、触发器、模式、模型、enabled、实时状态、最近裁决、加载来源；交互模式内联管理入口复用 3.4 的操作层）；`/sentinel:fleet` 交互式检查器（`ui.custom` 独占焦点 overlay，**模式守卫用 `ctx.mode === "tui"`**（RPC 的 hasUI 为 true 但 custom 不可用），参考 pi-subagents fleet inspector 缩小版：哨兵与运行中配置对话实时列表、键位移动选择、live 详情面板、约 1s 自动刷新、对执行中/排队中审计 steer（入其旁路循环 steering 队列 + 送达/已结束回执，空闲禁用）、最小键位集 up/down/steer/refresh/close 且经 `fleetKeybindings` 可配）；有 UI 时 `ui.setStatus` 常驻运行中数量、`ui.setWidget` 一行式执行列表。验证：vitest 覆盖 list 输出组装、fleet 数据源（Registry live 句柄）与 steer 入队/回执；手动在交互式会话确认打开/选择/steer 生效/自动刷新/关闭且审计不受影响。

- [x] 4.3 实现 `/sentinel:test <规则名> [模拟内容]` 试运行（dry-run）：构造模拟事件（tool_call/tool_result 规则以模拟工具输入、其余触发器以输入文本作为 window 内容），走完整审计管线（渲染 → 范围 → 旁路审计 → 裁决），输出 verdict/message/模型/耗时；零分流副作用（不 block/注入、不读写缓存与冷却/负冷却），历史记录标注 `kind: "test"`；TUI 以外模式打印到输出。验证：vitest 覆盖"试运行展示裁决""试运行无分流副作用（缓存/冷却不变、无注入）""规则名不存在报错""禁用/屏蔽规则可试运行"；手动验证两条规则各试运行一次。

## 5. 文档与全量验证

- [x] 5.1 完成 README：定位说明、规则配置全字段示例（含 overlap、onFailure、window、tools、model）、模型解析链、blocking 延迟与成本建议、与 permission-system 的互补关系、**隐私提示**（审计会把命令/文件内容发往审计模型的 provider，敏感项目建议使用可信/本地模型，`tools` 白名单控制审计员读能力）。验证：文档评审通过，示例配置能通过 1.2 的校验器（可用单测固定为样例夹具）。
- [x] 5.2 更新仓库根 `README.md` 包列表并核对 `pi-plugin-maintainer` 技能的清单要求（命名、manifest、keywords）。验证：`pnpm exec prettier --check .` 与维护技能校验脚本通过。
- [x] 5.3 全量门禁：`pnpm --filter @xzzpig/pi-sentinel run typecheck`、`pnpm --filter @xzzpig/pi-sentinel test`、`pnpm run verify`（fork 审计 + prettier）全部退出 0。验证：命令输出无失败。
- [x] 5.4 按 `pi-plugin-e2e-test` 技能在真实 pi 运行时验证：扩展加载、`/sentinel:list` 输出与内联禁用/启用、`/sentinel:test` 试运行输出与零副作用、`/sentinel:fleet` 打开/选择/steer/自动刷新/关闭、一条 blocking 规则拦截/放行、一条 background 规则注入发现、会话级规则退出后恢复会话仍生效、会话切换重置。验证：e2e 记录通过。
