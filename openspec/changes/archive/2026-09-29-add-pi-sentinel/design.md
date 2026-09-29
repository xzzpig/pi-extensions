# Design

## Context

技术事实（已对照 pi 0.87.1 类型定义与运行时源码逐条核实）：

- pi 扩展 API 提供 `tool_call`（可 `block` + 拒绝理由，可就地改写 `input`）、`tool_result`（返回 `content` 为**整体替换**）、`turn_end`（含 `turnIndex`/`messageEntryId`/`toolResultEntryIds`）、`agent_start`/`agent_end` 事件；handler 均为 async。**注意**：`tool_call` handler 串行执行且首个 block 即短路——被拦截的调用不产生 `tool_result` 事件，且晚于拦截者装载的扩展看不到该调用。
- `agentLoop(prompts, context, config, signal, streamFn)`（pi-agent-core 0.87.1）可独立起 LLM 循环。**0.87.1 要点**：system prompt 经 `prompts` 的 leading system message 携带（`AgentContext` 无 `systemPrompt` 字段）；无 `shouldStopAfterTurn`（用 `finishTurn` 计数实现轮上限）；thinking 参数名为 `reasoning`；streamFn 宜用 `ctx.modelRegistry.streamSimple`。注意 observational-memory 3.1.4 的 observer 代码锚定 pi 0.81，其 `context.systemPrompt`/`shouldStopAfterTurn` 写法在 0.87.1 已失效，只可借鉴范式不可照抄。
- `pi.sendMessage({customType, ...}, { deliverAs })` 注入的自定义消息参与 LLM 上下文（convertToLlm 转 `role: "user"`）；`pi.appendEntry` 只进会话不进 LLM，CustomEntry 文档明确支持"reload 时扫描 customType 重建状态"。
- `ctx.getContextUsage()` 返回 `{ tokens: number|null, contextWindow, percent }` 且整体可为 undefined（压缩后 tokens 为 null）——调用点必须判空。
- `ui.setStatus` / `ui.setWidget` / `registerCommand` / `registerMessageRenderer` 均可用；**`ui.custom` 仅 TUI 模式可用**（RPC 模式 `hasUI` 为 true 但 custom 不可用），模式守卫须用 `ctx.mode === "tui"`。
- `getAgentDir()` / `CONFIG_DIR_NAME`（== ".pi"）/ `ctx.isProjectTrusted()` 支撑双文件配置；`session_start`（reason: startup/reload/new/resume/fork）与 `session_shutdown` 支撑加载与清理时机。
- `pi-context-cap` 确立了"全局 `~/.pi/agent/<name>.json` + 项目 `.pi/<name>.json`（受信任项目才读）、按键合并、坏文件警告跳过"的配置惯例。
- `pi-permission-system` 确立了 tool 门控并行语义（同批多个工具调用各自独立过门）。

仓库约束：新包 `packages/pi-sentinel`，npm 名 `@xzzpig/pi-sentinel`，pi 核心包走 peerDependencies（catalog 版本）；本包为纯原创，不涉及 fork-divergence 纪律。产出物语言为简体中文（README 面向用户可中英混合，遵循仓库既有 README 风格）。

## Goals / Non-Goals

**Goals:**

- 单包实现 specs/pi-sentinel 全部行为；对既有包零改动。
- 旁路审计与主循环完全隔离：无递归触发、无上下文写入副作用（除注入消息）。
- blocking 延迟可控（快模型、短 prompt、缓存、并行门控）。
- 运行状态全程可观测（命令 + 状态条）。

**Non-Goals:**

- 不做定时器触发器（v1 五种触发器之外）。
- 不做可配置的裁决输出 schema（固定 `audit_verdict` 三态协议）。
- 不做审计后的自动修复动作（审计只裁决与提示，不代替主模型执行）。
- 不做多模态审计（图片输入）。
- 不做配置的 UI 编辑器。

## Decisions

### D1. 旁路循环复用 `agentLoop`，零工具规则退化为单轮

带只读调查工具的规则需要多轮工具循环，直接用 `agentLoop`（pi-agent-core 0.87.1：审计系统提示作为 `prompts` 的 leading system message，`audit_verdict` 与可选只读工具挂 `AgentContext.tools`，模型入 config；streamFn 用 `ctx.modelRegistry.streamSimple`——凭据由 model-runtime 内部解析，`getApiKeyAndHeaders`/`hasConfiguredAuth` 仅作可用性预检；`reasoning` 传 thinking 级别；`finishTurn` 计数实现 `maxTurns`；挂 `getSteeringMessages` 队列 drain 以支持 fleet steer），与 observational-memory 同范式（但按 0.87.1 API 重写，不照抄其 0.81 写法）。零工具规则不注册额外工具，循环自然单轮结束。

- 备选：直接用 `pi-ai` 的 `streamSimple` 单轮调用。更薄，但带工具规则要自己写循环，且放弃与主循环一致的停止原因/错误语义。不选。

### D2. 裁决协议为固定 `audit_verdict` 工具

schema（typebox，经 `@earendil-works/pi-ai` 的 `Type` 复用，不新增运行时依赖）：`{ verdict: "pass"|"warn"|"fail", message: string }`，message 非空、超 2000 字符截断。循环参数钉死：审计系统提示作为 leading system message（0.87.1 的 `AgentContext` 无 systemPrompt 字段）；用户消息两段式（渲染后 prompt + `--- 审计范围 ---` 段，见 spec）；输出 token 上限 min(8192, 模型上限)；thinking 经 `config.reasoning` 传（按 `规则 > defaults > "off"`）；`maxTurns` 用 `finishTurn` 计数实现（0.87.1 无 `shouldStopAfterTurn`），默认 tools 非空 ? 4 : 1；streamFn 用 `ctx.modelRegistry.streamSimple`。循环结束未调用、字段非法、`stopReason` 为 error/aborted、超时、模型解析失败均判审计失败（与 observational-memory 对 ObserverStreamError 的处理一致）。不解析自由文本，不提供自定义 schema。

### D3. 触发器接线与数据序列化

- `tool_call`：handler 内同步 await 审计后返回 `{ block?, reason? }`；同一调用的多条 blocking 规则并发执行（`Promise.all`），任一 fail 即拦截，理由合并。
- `tool_result` / `turn_end` / `agent_end`：handler 内 fire-and-forget 交给该规则的 Runner（受 overlap 策略约束），不阻塞主循环。
- `context_tokens`：在 `turn_end` / `agent_end` 检查 `getContextUsage().tokens`，按**倍数水位**触发（`level = floor(tokens / threshold)`，`level > lastFiredLevel` 时触发一次并更新水位；压缩回落后重新上穿自然再触发），不逐 token 轮询、不引入定时器。每条规则在 Runner 内独立维护**增量标记**（会话条目位置，初始为规则加载位置）：触发时切片"标记 → 当前末尾"作为事件 `messages` 与默认范围段，触发后标记前移；压缩导致位置失效时以压缩边界为新起点；标记属运行时状态，会话切换清空。
- **blocking warn 的实现**：tool_call 时审计已知 warn 结论但工具结果尚未产生——以 `Map<toolCallId, warning[]>` 暂存，在该调用后续的 `tool_result` 事件中把警告行前置到结果 content。**两个已核实的坑**：① `tool_result` 的返回 `content` 是**整体替换**，必须返回"前缀行 + 原内容全部条目"的完整数组，只返回前缀行会丢弃原结果；② 被拦截（任一方 block）的调用不产生 `tool_result` 事件——warn 与 fail 并存时以 fail 为准不附着，Map 条目在结果未到（拦截/中止）时即弃，防泄漏。
- **审计失败负冷却（30 秒，固定）**：失败后该规则短期内不再发起旁路调用（fail-open 放行 / fail-closed 直接拦截并注明持续失败，background 丢弃），避免对故障模型逐次重试拖垮门控延迟。
- 事件数据对象：每个触发器构造一个白名单字段的事件对象（作为模板变量根与 tool 触发器的范围段 JSON），字段清单以 spec"事件数据与模板变量"需求的字段表为实现基准；字符串字段超 8000 字符截断并附 `...[截断 N 字符]` 标记。消息文本序列化对齐 observational-memory `serialize.ts` 先例，并受规则三开关控制：`includeThinking`（thinking 以 `[thinking: ...]` 并入，redacted 始终省略）、`includeToolInputs`（toolCall 占位参数与 `input`）、`includeToolOutputs`（`content`）——序列化器接受这三个选项作为参数，事件构造与范围切片共用同一实现。

### D4. overlap 策略器：每规则一个 Runner 状态机

每条规则一个 Runner，状态 `idle | queued | running`：

- `parallel`：直接并发（blocking 默认；与 permission-system 的并行门控语义一致）。
- `serial`：入队 FIFO，**无深度上限**（用户决策：限深即退化成 ignore，无存在价值），在跑结束后按到达顺序以各自触发数据逐个执行。
- `ignore`：running 期间新触发丢弃并计数（background 默认，防雪崩与重复成本）；blocking+ignore 组合语义为在跑期间的新调用直接放行不审计。
- `replace`：AbortController 中止在跑审计（按取消处理，不计裁决、不缓存），以新触发重启。

blocking 规则与 overlap 的交互：`serial` 时同规则的并发 tool_call 门控会排队等待（延迟叠加，文档注明）；`replace` 在 blocking 场景意义有限（等待方各自 await 自己那次），等价实现为先完成在跑者再跑新者——文档注明，不阻止配置。

fail 拦截后的防循环：**不设 terminate 熔断**（用户决策）——依赖裁决 message 写清原因引导主模型调整；fail 裁决在缓存期内对同一命令即时重复拦截（返回相同理由）属预期行为，客观上压缩了空转成本。

### D5. 注入消息与去重

- 注入：`pi.sendMessage({ customType: "pi-sentinel-finding", content, display, details })`，**双路径投递**（0.87.1 实测语义）：主循环流式中 `deliverAs: "steer"`（当前 run 下一 LLM 边界生效）；空闲时**不带 deliverAs** 直接发送（立即持久化进会话并参与上下文）。禁用 `deliverAs: "nextTurn"`——实测其队列仅在用户下次 `prompt()` 时 flush，空闲注入会滞留到下次用户输入、会话切换即丢失；`registerMessageRenderer` 渲染为带规则名、级别徽标（warn/fail）与 message 的紧凑块。
- 判重键：`规则名 + verdict + 规范化 message`（小写、压缩空白）的哈希；冷却窗口默认 10 分钟、全局可配 `dedupeCooldownMs`、规则可配 `dedupe: false` 关闭。命中去重只更新状态条。

### D6. 配置三作用域：双文件沿用 context-cap 惯例 + 会话级 op-log

全局 `<getAgentDir()>/sentinel.json` + 项目 `<cwd>/<CONFIG_DIR_NAME>/sentinel.json`（受信任才读）。**加载时机**：会话启动/恢复时加载；插件自身写入（配置对话、文件写回）后立即重载；外部手工编辑不热加载，重启会话生效（用户决策，免去 mtime 轮询）。完整字段表、默认值与校验规则见 spec（"哨兵规则配置与加载"需求的字段表为实现基准），校验器手写（与 context-cap 同风格），不引 JSON schema 运行时。

**会话级**配置不走文件，用 pi 的会话条目（`appendEntry` 本就是"随会话持久化、不进 LLM 上下文"的状态存储；CustomEntry 文档明确支持 reload 时扫描 customType 重建状态）：自定义条目 `pi-sentinel-session-config` 记录操作日志（add-rule / enable / disable / remove），扩展在会话加载（含恢复、切换回）时重放条目重建会话级规则集与屏蔽表，fork 天然继承（条目随 fork 复制）。**重放必须沿活动分支，且只可用 `sessionManager.getBranch()`**——不能用 `getEntries()`（含被放弃分支的旧条目，树导航后会复活过期配置），也不能用 `buildContextEntries()`（压缩感知，会省略被压缩归纳的旧条目，op-log 条目落在压缩点之前即被静默丢掉）。**树导航（`session_tree`）不重建扩展运行时、不发 session_start/shutdown**——须监听该事件沿新活动分支重放 op-log，并把指向非活动分支条目的增量标记以当前末尾为新起点重置。生效规则集 = merge(全局, 项目, 会话级规则) 按 name 覆盖链，再减去会话级屏蔽表。运行时状态（缓存/冷却/在跑审计）仍按"生命周期"需求在切换时重置——配置属于会话，状态属于切换边界；热加载时的状态处置见 spec"规则热加载语义"。

规则字段全集（含 thinking、maxTurns、dedupe 等）以 spec"哨兵规则配置与加载"需求的字段表为实现基准，design 不再重复。

### D13. 会话级动态管理：`/sentinel:list` 内联操作 + op-log 即时回写

- 管理操作经 `/sentinel:list` 内联完成（选择哨兵 → `ui.select` 选启用/禁用/移除），不设独立的 enable/disable/remove 命令；操作执行即追加一条会话条目并立即重算生效规则集（热加载）。`禁用` 按名称屏蔽（屏蔽表与规则来源无关），`移除` 仅允许删除会话级新增的规则（对继承规则拒绝并提示用禁用）。
- 重放幂等：op-log 是追加式事实日志，重放即最终状态；恢复/切换回会话时重放，无需快照条目。
- `/sentinel:list` 与 fleet 检查器的"加载来源"枚举：global / project / session。

### D14. 自然语言配置生成：后台旁路配置对话（不进主会话、不弹界面）

- **入口与形态**：`/sentinel:configure [初始描述]` **立即返回**（`ui.notify` 确认已启动），在后台运行独立的多轮配置对话——旁路 LLM（复用 `agentLoop` 与审计同套基础设施）逐轮推进，主会话模型不参与，对话内容不进主会话消息、不触发主循环；不弹出任何对话界面。同一时间至多一个配置对话在跑：重复启动时 `ui.confirm` 询问"取消当前对话并开始新的 / 保持现有"——这同时也是用户**取消**在跑对话的途径。会话切换或关闭时对话随运行时状态一并中止。
- **可观测**：配置对话作为 Registry 中的一类条目出现在 fleet 检查器里（当前轮次、最近交互、待提交草稿、已耗时），用户随时打开 fleet 查看进展——对话界面即 fleet，不单独做 UI。
- **生成模型**：沿用审计模型解析链（可配 `defaults.configure.model`，缺省落到全局默认审计模型 > 会话模型）；系统提示内嵌完整规则字段说明与配置示例，模型具备生成合法草稿所需的全部知识。
- **草稿提交与三选确认流**：对话循环挂 `submit_config` 工具（参数为完整规则数组 + 变更类型 add/update/remove + 可选作用域；remove 支持 global/project 的文件级删除与会话级移除）。工具执行时对话循环**挂起**，主进程校验草稿（同一校验器）→ 若 fleet overlay 开着先自动关闭（避免焦点嵌套）→ 弹出变更预览对话框，用户三选：**写入**（`ui.select` 选作用域 global/project/session）/ **继续调整**（附自然语言进一步要求）/ **放弃**。校验错误视同"继续调整"回传。结果作为工具结果回传对话循环继续：写入 → 摘要 + 询问是否结束；继续调整 → 按新要求修改后重新提交；放弃 → 结束对话。确认对话框由主进程渲染，对话循环在挂起期间不持 UI 焦点，无嵌套冲突。
- **写入实现**：`session` 追加会话条目；`global`/`project` 读取-合并-写回对应 `sentinel.json`（同名规则替换、新规则追加、显式删除，绝不整文件重写丢弃既有键）；写入后广播配置重载，即时生效。
- **对话状态**：对话完成、放弃、会话切换或关闭时清除历史（配置本身按作用域持久化）；对话期间哨兵触发照常执行（旁路互不干扰）。TUI 以外模式（print/RPC）下 `/sentinel:configure` 不可用：提示并建议改在交互模式或直接编辑配置文件。

### D15. 已评估：不直接复用 pi-subagents 的执行器（用户提议后调查结论）

pi-subagents 的子代理是**完整 spawn 的 pi 子进程**（独立扩展装载、会话文件、spawn budget），其"按 agent 配置可用插件"作用于子进程的扩展装载层。对哨兵审计直接复用被否决：

- **延迟不匹配**：blocking 门控要求亚秒级启动，spawn 子 pi（进程 + 扩展装载 + 会话初始化）开销高一个量级。
- **无隐私收益**：审计外发的主体是 prompt 内容（序列化事件 + 渲染后规则），子进程插件过滤改变的是"子代理能用哪些工具"，对请求内容本身没有过滤作用。
- **依赖耦合**：pi-sentinel 将硬依赖一个大型包，违背独立可安装的仓库原则。

借鉴而非复用：规则级 `tools` 白名单从宿主工具注册表过滤（D8），达成"配置审计可用插件工具"的配置体验；隐私靠文档提示 + 白名单控制暴露面。未来若审计需要完整 agent 能力（profile、worktree、长生命周期会话）再评估接入 subagents 作为可选执行器。

### D7. 模板渲染基于 Handlebars（用户定案：最小 helper 集）

渲染解析交给现成库 `handlebars`（加入本包 `dependencies`），适配层只做胶水；选型过程：先定 mustache 无逻辑，用户要求评估函数调用能力，成本评估（依赖 +100KB、胶水等量、planning 期切换零返工）后定案 Handlebars。

- **钉死的引擎配置**：`noEscape: true`（渲染目标是 LLM prompt，`&&`/`<`/`>` 不得实体化）；非 strict 模式（缺失路径渲染空串，与 spec 一致）；`Handlebars.parse` AST 收集变量路径，与事件根键差集产出"未解析路径"诊断（同 mustache 方案的诊断面）。
- **能力边界**：原生 `{{#if}}`/`{{#unless}}`/`{{#each}}`/`{{#with}}` 可用；**仅预置三个 helper**——`json`（JSON 序列化）、`truncate`（按字符截断 + 标注）、`now`（本地时间）；不开放自定义 helper 注册，保持规则可预测与可校验。
- **`{{input}}` 双表示问题顺势消解**：不再做 mustache 时代的裸 token 重写，整个 input 的 JSON 序列化统一用 `{{json input}}` helper 表达。
- 否决项保留备查：自研渲染器（分词边界是坑）、lodash.template（eval 语义）、mustache（无带参 helper，条件拼接做不到）。

### D8. 模型与鉴权解析

复制 observational-memory `runtime.ts` 的解析思路：规则 `model`（`provider/modelId`）经 `ctx.modelRegistry` 解析；未配置时先取全局 `defaults.model`，再退 `ctx.model`；凭据经 `getApiKeyAndHeaders`（含 hasConfiguredAuth 的请求时签名类提供商特判）。解析失败按该次审计失败处理 + UI 提示。

**审计员工具白名单的取材**（0.87.1 API 约束下的现实收敛）：规则 `tools` v1 限宿主**内置**工具名——pi-coding-agent 导出 per-tool 工厂（`createReadTool`/`createGrepTool`/`createBashTool`/`createEditTool`/`createWriteTool`/`createLsTool`/`createFindTool` 及集合式 `createReadOnlyTools(cwd)`/`createCodingTools(cwd)`），白名单内任意内置工具名都有对应工厂，可直接构造旁路循环可执行的 `AgentTool`。扩展注册/MCP 工具**不可**作为审计员工具：`getAllTools()` 只给名称与 schema 不给可执行实例，`ToolDefinition.execute`（5 参）与 `AgentTool.execute`（4 参）签名也不兼容——名称仅可用于**触发器匹配**（事件携带工具名，匹配无障碍）。这是"配置审计可用插件能力"的 v1 边界，扩展工具支持留待后续变更。只读性不做强制校验，README 提示审计员只宜配置只读类工具。隐私面：审计会把命令/文件内容发往审计模型的 provider，README 明确提示并建议敏感项目使用可信模型；工具白名单是暴露面（审计员能读到什么）的主要控制手段。

### D9. 裁决缓存为进程内 Map

key = `sha256(ruleName + 规则定义内容哈希 + 渲染后 prompt + 范围文本)`（掺规则哈希，同名规则被替换后旧缓存自然失效），value = `{ verdict, message, at }`；TTL 默认 10 分钟（`cacheTtlMs`）；仅缓存成功裁决（失败不缓存，另以 30 秒负冷却防故障重试，见 D3）；会话切换/关闭清空，规则热替换/移除失效该规则名下条目。命中与否计入 Runner 诊断（可观测）。

### D10. 全局并发信号量

默认 `maxConcurrent: 3`，跨规则共享计数，获取按 **FIFO** 公平排序。饱和时的处理矩阵（与 spec overlap 定义一致）：`parallel`/`serial` → 排队 await（blocking 门控的等待时间相应延长，属配置选择）；`ignore` → 丢弃；`replace` → 先中止在跑者、再排队申请。防止多规则同时触发时的请求风暴。

### D11. 可观测性：Registry + `/sentinel:list` + 交互式 fleet 检查器（含 steer）+ 状态条

- `SentinelRegistry` 持有全部 Runner 的实时状态、最近 20 条审计记录（时间、规则、verdict、耗时、命中缓存与否、跳过原因）、每个 running 审计的 live 详情句柄（开始时间、模型、渲染后 prompt 概要、范围摘要、工具调用计数、流式输出尾部环形缓冲约 2KB），以及运行中配置对话的转录句柄。Registry 是 list、fleet、配置对话共用的唯一数据源。
- `/sentinel:list`：列出全部哨兵（名称、触发器、模式、模型、enabled、实时状态、最近裁决、加载来源）；交互模式下内联管理——选择哨兵后 `ui.select` 执行启用/禁用/移除（写入路径见 D13），TUI 以外模式打印文本总览。**不做聚合统计行**（用户决策）：只保留最近 20 条历史记录，不展示审计次数/命中率等聚合。
- `/sentinel:test <规则名> [模拟内容]`：规则试运行（dry-run）——以模拟事件走完整审计管线（渲染 → 范围 → 旁路审计 → 裁决），输出 verdict/message/模型/耗时；**零分流副作用**：不 block、不注入、不读写缓存与冷却；历史记录标注 `kind: "test"`。写规则即可验证，不必等真实触发。
- `/sentinel:fleet`：交互式实时检查器，参考 `pi-subagents` 的 fleet inspector（`src/tui/fleet.ts`：列表 + 详情面板 + 定时刷新 + 可配键位）做**缩小版**——`ui.custom` 打开独占焦点的 overlay：上方/左侧为全部哨兵与运行中配置对话的实时列表，键位移动选择后详情面板渲染选中条目的 Registry live 句柄；运行中内容按刷新周期自动更新（默认约 1s，沿 fleet 的 REFRESH_MS 定时器模式）。键位集合最小化（移动选择/steer/刷新/关闭），经配置文件 `fleetKeybindings` 可配（校验风格对齐 subagents 的 `FleetKeybindingsConfig`）。**不引入 `pi-components` 原生消息渲染**——审计流是纯文本，v1 保持轻量，需要富渲染时再立变更。
- **steer（追加消息）**：对执行中或排队中的审计，检查器内输入追加消息 → 入队该审计旁路循环的 **steering 队列**（audit-loop 挂 `AgentLoopConfig.getSteeringMessages` 的 drain 回调——实测 `agentLoop` 对传入消息数组做拷贝，外部 push 不可见，必须走该回调；轮询点在 runLoop 开头、prepareNextTurn 后与每轮 turn_end 后，下一个 LLM 调用边界生效）；发送后给回执（已送达 / 已结束未能送达，对齐 subagents 的 `delivered | queued` 语义）。空闲哨兵不可 steer（无可注入对象）；短审计可能在送达前结束（`finishTurn` 返回 end 后队列不再轮询），属固有语义。steer 消息计入审计的诊断详情。
- 有 UI 时：`ui.setStatus("sentinel", ...)` 常驻显示运行中数量（如 `▶2`）；`ui.setWidget` 渲染执行中哨兵的一行式列表。**模式守卫**：`ui.custom` 仅 TUI 可用（RPC 模式 `hasUI` 为 true 但 custom 会出问题），fleet/configure 的 UI 能力守卫一律判 `ctx.mode === "tui"`。

### D12. 包结构

```
packages/pi-sentinel/
  package.json            # pi.extensions: ["./extensions"], peerDeps: pi-coding-agent/pi-agent-core/pi-ai
  extensions/
    index.ts              # 入口：装配 config/rules/runner/observability，注册事件与命令
    config.ts             # 双文件加载、合并、校验（context-cap 风格）
    template.ts           # Handlebars 适配（noEscape、json/truncate/now helper、未解析路径诊断）
    event-data.ts         # 事件白名单序列化 + 截断 + window 切片
    audit-loop.ts         # agentLoop 封装 + audit_verdict 工具 + 失败判定
    runner.ts             # 每规则状态机：overlap/并发/冷却/缓存调用/裁决分流
    cache.ts              # 裁决缓存
    session-store.ts      # 会话级配置 op-log（appendEntry 重放、屏蔽表、热加载）
    configure-dialog.ts   # /sentinel:configure 后台配置对话（旁路循环+submit_config+三选确认写入）
    registry.ts           # SentinelRegistry（状态、历史、live 详情、配置对话转录）
    commands.ts           # /sentinel:list 列出 + 内联启用/禁用/移除；/sentinel:test 试运行
    fleet-view.ts         # /sentinel:fleet 交互式检查器（列表+详情+自动刷新+steer+可配键位）
    injection.ts          # sendMessage 注入 + registerMessageRenderer + 去重
  test/                   # vitest 单测（见 tasks）
  README.md / CHANGELOG.md
```

## Risks / Trade-offs

- [blocking 延迟（每次匹配调用 +1 次 LLM 往返）] → 文档建议快模型 + 精短 prompt；裁决缓存默认开；同批多规则并行；`/sentinel:list` 可见耗时分布。
- [旁路审计 token 成本失控] → background 默认 ignore + 冷却去重 + pass 静默 + 范围默认最小化 + 全局并发上限 + 缓存。
- [模型不支持工具调用导致裁决协议失败] → 按审计失败走 fail-open 并提示；README 注明审计模型需支持工具调用。
- [注入消息时机竞争（turn 中完成审计）] → 双路径投递：流式中 steer 下一边界生效、空闲时立即持久化（D5）；禁用会滞留的 `nextTurn`。
- [旧版 pi 缺少所用 API] → peerDependencies 下限对齐 pi 0.87（本仓库 catalog 版本）；缺失 API 的防御性降级与 observational-memory 同策略。
- [检查器与主循环流式渲染的焦点/渲染冲突] → `/sentinel:fleet` 沿用 `ui.custom` 的独占焦点机制（fleet inspector 同款），不自行接管 TUI；TUI 以外模式直接不可用并降级提示。
- [其他扩展先于哨兵拦截同一工具调用] → `tool_call` handler 串行且首 block 即短路，晚装载的哨兵看不到被拦调用（不审计，直接无事件）——语义上可接受（被拦截的调用无需审计），README 注明装载顺序的影响。
- [`maxWindowTokens` 的"字符数/4"估算对中文系统性偏低（CJK 约 1–1.5 字符/token）] → 实际范围可能超出估算数倍，README 声明误差并建议敏感场景调低该默认值。
- [配置错误静默失效] → 所有跳过均用户可见警告；`/sentinel:list` 展示每条规则的加载来源与 enabled 状态。
- [审计自触发/递归] → 旁路循环不接扩展事件总线、仅持只读工具，结构上不可能触发哨兵。
- [大工具结果撑爆审计 prompt] → 序列化层单字段截断 + window token 上限保护 + 截断标记。

## Audit-fix clarifications (2026-09-29)

Post-implementation audit findings were verified and fixed; these clarifications
pin the corrected semantics (the spec delta carries the normative wording):

- **Concurrency budget is one instance.** `Semaphore` gained `setLimit`; hot
  reload updates the limit of the existing instance instead of swapping it in,
  and `RuleRunner.updateContext` refreshes the reused runner's context. A rule
  added mid-session therefore shares the same budget and slot accounting, and a
  `defaults.maxConcurrent` change applies to already-loaded rules.
- **Dedupe cooldowns are per rule name.** `FindingInjector` is created once and
  survives rebuilds; `invalidateRule(name)` expires only the replaced/removed
  rule's entries. Session switch still clears all of them (session runtime state).
- **Shadow notice reads the unmerged file scope.** `ConfigureHost.getFileRules`
  exposes `fileConfig.rules`, because after the write the effective list already
  contains the session rule that shadows the inherited namesake.
- **Audit-failure notification is single-sourced.** The runner's
  `onAuditFailure` (which names the rule) is the only notification; the blocking
  gate no longer notifies for the fail-open branch.
- **Tree navigation is not a session switch.** `session_tree` only replays the
  op-log along the new branch and re-anchors markers; running audits, caches,
  cooldowns and a running configuration dialog are kept. Session switch/fork
  additionally clear each runner's negative cooldown.
- **Watermarks re-anchor at the current level.** `initializeMarkers` and the
  changed-rule path set `lastFiredLevel = floor(tokens / threshold)`, so a rule
  loaded or re-anchored mid-session does not fire one catch-up audit at the next
  boundary; it fires on the next multiple it actually crosses.
- **A removed rule drops its name mask.** The session op-log `remove` op also
  clears the `disabled` entry so a restored inherited namesake is live again.
- **Configuration dialogs are cleaned up.** A finished dialog removes its view
  from the registry; session switch/shutdown clears the dialog list.
- **`streamSimple` sync throws are terminal.** `guardedStreamFn` converts a
  synchronous throw into an error-terminated assistant stream so the audit fails
  immediately instead of hanging until `timeoutMs` (the upstream `agentLoop`
  promise chain has no `catch`; that upstream gap is not modified).
- **`writeFileConfig` is intentionally lossy.** Re-parsing drops entries the
  loader already rejects (invalid rules, unknown top-level keys); this is
  documented in the README rather than changed.

## Migration Plan

全新包，无数据/行为迁移。上线 = 安装 `@xzzpig/pi-sentinel` 并放置配置；无规则时插件完全静默，天然可灰度。回滚 = 移除包或清空 `rules`。发布走 `pi-publish` 流程（typecheck + test + prettier + 审计门）。

## Open Questions

无阻塞项。审计历史跨会话持久化、widget 交互式详情等留待使用反馈后再立变更。
