# pi-sentinel Specification

## Purpose

定义 `@xzzpig/pi-sentinel` 旁路审计哨兵能力：以声明式规则在 pi 主循环的事件触发点上调用独立 LLM 循环执行自然语言审计，支持前台阻塞门控与后台发现注入两种模式、五种触发器、结构化裁决协议、重复触发策略、裁决缓存、会话级动态配置、自然语言配置生成与可观测性界面。

## Requirements

### Requirement: 哨兵规则配置与加载

插件 SHALL 从三个作用域加载哨兵配置：全局 `<pi 配置目录>/sentinel.json`、项目 `<项目>/.pi/sentinel.json`（仅受信任项目读取）、会话级（随会话持久化的动态配置，见"会话级动态管理与持久化"）。合并 SHALL 为：`defaults` 按键覆盖（项目 > 全局 > 内置默认；会话级仅管理规则与屏蔽，不提供 defaults），`rules` 按规则 `name` 覆盖（高级作用域同名规则整体替换，其余叠加追加）。加载时机 SHALL 为：会话启动（含恢复）时加载文件配置；插件自身写入配置（配置对话写入）后立即重载；外部对配置文件的手工编辑不热加载，重启会话后生效。配置文件顶层为 `{ "defaults"?, "rules"?, "fleetKeybindings"? }`（`fleetKeybindings` 见"交互式 fleet 检查器"）；文件级未知键 SHALL 警告忽略，不影响其余配置加载。

`defaults` 可用键及内置默认值（`fleetKeybindings` 的合并与 `defaults` 同法按键覆盖、项目优先）：

| 键                 | 类型    | 默认     | 语义                                                |
| ------------------ | ------- | -------- | --------------------------------------------------- |
| `model`            | string  | 无       | 全局默认审计模型（`provider/modelId` 或 `modelId`） |
| `thinking`         | string  | `"off"`  | 全局默认 thinking 级别（pi ThinkingLevel 枚举）     |
| `timeoutMs`        | 正整数  | 无       | 全局默认审计超时                                    |
| `cache`            | boolean | `true`   | 全局裁决缓存开关                                    |
| `cacheTtlMs`       | 正整数  | `600000` | 全局缓存 TTL                                        |
| `maxConcurrent`    | 正整数  | `3`      | 全局并发审计上限                                    |
| `dedupeCooldownMs` | 正整数  | `600000` | 全局发现注入判重冷却                                |
| `maxWindowTokens`  | 正整数  | `20000`  | 审计范围内容 token 估算上限                         |
| `configure.model`  | string  | 无       | 配置对话模型（解析链独立于 `defaults.model`）       |

规则对象字段（未列出的字段导致该规则校验失败并整体跳过）：

| 字段                 | 类型                                                                                    | 必填                    | 默认                                                               | 语义                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | 非空 string                                                                             | 是                      | —                                                                  | 会话内唯一，合并键                                                                                                                                                                                                                                             |
| `trigger`            | object                                                                                  | 是                      | —                                                                  | `{ type, tools?, threshold? }`                                                                                                                                                                                                                                 |
| `trigger.type`       | `"tool_call"` \| `"tool_result"` \| `"turn_end"` \| `"agent_end"` \| `"context_tokens"` | 是                      | —                                                                  | 触发器类型                                                                                                                                                                                                                                                     |
| `trigger.tools`      | string[]                                                                                | 否                      | 匹配全部                                                           | 工具名过滤模式数组，任一模式命中即触发（OR）；元素为 minimatch 模式，对事件上报的完整工具名全匹配（内置工具如 `bash`/`edit`/`write`，扩展注册工具、MCP 工具如 `mcp__*` 一视同仁）；空数组或缺省匹配全部；仅 tool_call/tool_result 有效，其他类型出现即校验失败 |
| `trigger.threshold`  | 正整数                                                                                  | `context_tokens` 时必填 | —                                                                  | 触发间隔：上下文用量每跨越该 token 数的一个整数倍边界触发一次；其他类型出现即校验失败                                                                                                                                                                          |
| `mode`               | `"blocking"` \| `"background"`                                                          | 是                      | —                                                                  | 执行模式。合法组合矩阵：`blocking` 仅可搭配 `tool_call`；`background` 可搭配全部五种触发器；其余组合校验失败                                                                                                                                                   |
| `prompt`             | 非空 string                                                                             | 是                      | —                                                                  | 检查指令，经模板渲染                                                                                                                                                                                                                                           |
| `model`              | string                                                                                  | 否                      | 解析链兜底                                                         | 审计模型                                                                                                                                                                                                                                                       |
| `thinking`           | string                                                                                  | 否                      | `defaults.thinking`                                                | pi ThinkingLevel 枚举                                                                                                                                                                                                                                          |
| `tools`              | string[]                                                                                | 否                      | `[]`                                                               | 审计员工具白名单，v1 限宿主**内置**工具名（read/grep 等，经宿主工具工厂构造；扩展注册/MCP 工具名仅可用于触发器匹配，不可作为审计员工具，配置了此类名称该元素按校验失败处理）                                                                                   |
| `maxTurns`           | 正整数                                                                                  | 否                      | `tools` 非空时 `4`，否则 `1`                                       | 旁路循环最大轮数                                                                                                                                                                                                                                               |
| `window`             | object                                                                                  | 否                      | 按触发器默认                                                       | `{ messages?: N }` \| `{ tokens?: N }` \| `{ full: true }`，多键并存校验失败                                                                                                                                                                                   |
| `overlap`            | `"parallel"` \| `"serial"` \| `"ignore"` \| `"replace"`                                 | 否                      | blocking→`parallel`，background→`ignore`                           | 重复触发策略                                                                                                                                                                                                                                                   |
| `onFailure`          | `"open"` \| `"closed"`                                                                  | 否                      | `"open"`                                                           | 审计失败策略                                                                                                                                                                                                                                                   |
| `cache`              | boolean                                                                                 | 否                      | `defaults.cache`                                                   | 裁决缓存开关（`true` 显式开启优先于全局默认关）                                                                                                                                                                                                                |
| `cacheTtlMs`         | 正整数                                                                                  | 否                      | `defaults.cacheTtlMs`                                              | 缓存 TTL                                                                                                                                                                                                                                                       |
| `timeoutMs`          | 正整数                                                                                  | 否                      | `defaults.timeoutMs`，未设时 blocking `30000` / background `60000` | 审计超时                                                                                                                                                                                                                                                       |
| `enabled`            | boolean                                                                                 | 否                      | `true`                                                             | 文件级启停（false 时加载但不触发）                                                                                                                                                                                                                             |
| `dedupe`             | boolean                                                                                 | 否                      | `true`                                                             | 发现注入判重开关（仅 background 有意义）                                                                                                                                                                                                                       |
| `includeThinking`    | boolean                                                                                 | 否                      | `true`                                                             | assistant 消息的 thinking 是否并入审计数据（`false` 时整体省略；redacted thinking 始终省略）                                                                                                                                                                   |
| `includeToolInputs`  | boolean                                                                                 | 否                      | `true`                                                             | 工具输入是否并入审计数据（toolCall 占位的参数与 `input` 字段）                                                                                                                                                                                                 |
| `includeToolOutputs` | boolean                                                                                 | 否                      | `true`                                                             | 工具输出是否并入审计数据（`content` 字段与 toolResults 元素）                                                                                                                                                                                                  |

不存在、不可读或非法 JSON 的文件 SHALL 跳过并以用户可见警告报告，不中断会话；单条规则校验失败 SHALL 只跳过该条并警告（含原因），其余规则照常加载。没有任何已加载规则时插件 SHALL 完全静默。

#### Scenario: 项目规则覆盖同名全局规则

- **WHEN** 全局配置定义名为 `bash-safety` 与 `edit-style` 的两条规则，项目配置定义同名 `bash-safety` 规则
- **THEN** 生效规则集为项目的 `bash-safety` 加上全局的 `edit-style`，共两条

#### Scenario: 非法规则不影响其余规则

- **WHEN** 项目配置含三条规则，其中一条 `mode` 为 `"blocking"` 但触发器为 `turn_end`
- **THEN** 该条被跳过并警告"blocking 仅支持 tool_call 触发器"，其余两条照常加载

#### Scenario: 非受信任项目忽略项目配置

- **WHEN** 项目目录存在 `.pi/sentinel.json` 但项目未受信任
- **THEN** 仅全局配置与会话级配置生效，且不做任何警告（静默跳过属预期安全行为）

### Requirement: 触发器语义

- `tool_call`：每次工具调用执行前触发（每调用恰一次）；`trigger.tools` 为工具名过滤模式数组（任一模式命中即触发），元素对事件上报的完整工具名全匹配——内置工具（`bash`、`edit`、`write`、`read` 等）、扩展注册工具与 MCP 工具（如 `mcp__<server>__<tool>`）均以其实际工具名参与匹配。
- `tool_result`：每次工具结果定稿后触发（每调用恰一次）；过滤同上。
- `turn_end`：主循环每轮结束（assistant 消息及其全部工具结果定稿）后触发；变量 `{{turnIndex}}` 可用。
- `agent_end`：agent 循环结束时触发一次。
- `context_tokens`：在 `turn_end` 与 `agent_end` 边界检查 `getContextUsage().tokens`，按**倍数水位**触发：维护已触发水位 `lastFiredLevel`（初始 0；规则加载、热加载或树导航重新锚定标记时，水位置为当前 `level`，避免加载即补触发一次），每次检查取 `level = floor(tokens / trigger.threshold)`，`level > lastFiredLevel` 时触发一次；**每次检查后水位置为当前 `level`**（用量回落使水位变小时不触发、仅下移水位）。单次增长跨越多个倍数只触发一次。用量因压缩等原因回落使水位变小后，再次上穿即自然重新触发。用量不可用（`getContextUsage()` 返回 undefined 或 `tokens` 为 null，如压缩后尚未有新的 LLM 响应）时 SHALL 跳过本次检查。检查 SHALL 在同一边界的 `turn_end` 触发器处理之后执行（增量包含刚定稿的该轮）。每条规则 SHALL 独立维护**增量标记**（上次触发时的会话条目位置）：首次标记为规则加载位置；会话恢复时标记初始化为恢复点末尾（恢复前历史不纳入增量）；规则被屏蔽期间标记照常前移（重新启用后从最新位置起算，不吞积压）；会话树导航后标记指向非活动分支条目时，以当前末尾为新起点。事件数据中的 `messages` 与默认审计范围均为标记到当前末尾的增量；标记属会话运行时状态（会话切换清空），上下文压缩导致位置失效时以压缩边界为新起点。变量 `{{tokens}}`、`{{threshold}}`、`{{level}}`、`{{messages.0.text}}` 等可用。

同一事件匹配的多条规则 SHALL 全部执行（blocking 规则并发审计后汇总，background 规则各自交由 Runner）。

#### Scenario: 按工具名数组过滤的 tool_call 规则

- **WHEN** 规则触发器为 `tool_call` 且 `trigger.tools` 为 `["bash"]`，主循环发起 `read` 工具调用
- **THEN** 该规则不被触发

#### Scenario: 多模式数组命中编辑与 MCP 工具

- **WHEN** 规则 `trigger.tools` 为 `["edit", "write", "mcp__*"]`；主循环依次发起 `edit` 调用、一个名为 `mcp__fs__read_file` 的 MCP 工具调用与一次 `read` 调用
- **THEN** 前两次调用触发该规则，`read` 调用不触发

#### Scenario: context_tokens 每跨越一个倍数边界触发一次

- **WHEN** 规则阈值 100000，用量 90000 → 105000（触发）→ 195000 → 205000
- **THEN** 105000 时触发一次（上穿 100000 水位），195000 时不触发，205000 时再触发一次（上穿 200000 水位）

#### Scenario: 压缩回落后重新上穿再触发

- **WHEN** 规则阈值 100000，已在上穿 100000 时触发过，随后压缩使用量降至 60000，后增长到 115000
- **THEN** 再次触发一次（水位回落到 0 后重新上穿 100000）

#### Scenario: context_tokens 引用两次触发之间的增量

- **WHEN** `context_tokens` 规则（阈值 100000）prompt 含 `{{messages.0.role}}`，第一次触发于会话早期，第二次触发（上穿 200000 水位）时
- **THEN** 事件数据中的 `messages` 恰为两次触发之间新增的消息（首次触发则为规则加载以来的消息），审计范围段默认亦为该增量

#### Scenario: 触发后增量标记前移

- **WHEN** 同一 `context_tokens` 规则连续两次触发，第二次触发完成后上下文又新增一条消息
- **THEN** 若随后再次越阈，`messages` 不再包含已审过的旧消息（标记已前移到上次触发末尾）

#### Scenario: thinking 并入而 redacted 省略

- **WHEN** 增量消息中某 assistant 消息含一个普通 thinking 块（"先检查配置文件"）与一个 redacted thinking 块
- **THEN** 该消息的文本含 `[thinking: 先检查配置文件]`，不含 redacted 块内容，toolCall 块显示为 `[工具名(参数)]` 占位

#### Scenario: include 开关关闭对应内容

- **WHEN** 规则配置 `includeThinking: false`、`includeToolInputs: false`、`includeToolOutputs: false`，触发时上下文含 assistant 的 thinking、bash 调用与其输出
- **THEN** 审计数据不含任何 `[thinking: ...]`，toolCall 占位显示为 `[bash]`、`input` 为 `{}`，`content` 为空字符串，触发与分流行为不受影响

#### Scenario: turn_end 触发

- **WHEN** 规则触发器为 `turn_end` 且主循环结束一轮（含工具结果）
- **THEN** 该规则以该轮为审计范围触发一次

### Requirement: 事件数据与模板变量

规则的 `prompt` SHALL 经模板变量渲染（Handlebars，能力边界见下）。每个触发器 SHALL 构造一个**事件数据对象**，作为模板变量的根。消息文本与工具数据的序列化规则（适用于所有事件对象中的文本字段与转写范围段），并受规则的 `includeThinking` / `includeToolInputs` / `includeToolOutputs`（默认均为 `true`）控制：

- assistant 消息的 thinking 块在 `includeThinking: true` 时以 `[thinking: ...]` 并入文本，`false` 时整体省略；**redacted thinking 始终省略**（对齐 observational-memory）；
- assistant 消息的 toolCall 块：`includeToolInputs: true` 时渲染为 `[工具名(参数 JSON)]`，`false` 时渲染为 `[工具名]`；
- 工具输入字段（`input`）：`includeToolInputs: false` 时渲染为 `{}`；
- 工具输出字段（`content` 及 toolResults 元素的 `content`）：`includeToolOutputs: false` 时渲染为空字符串（结构不变）；
- 图片等非文本内容以 `[图片 N 项]` 占位；所有字符串字段超 8000 字符截断并以 `"...[截断 N 字符]"` 标注。

各触发器字段清单如下：

**`tool_call`**

| 字段         | 类型   | 内容                                                                                                                        |
| ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `tool`       | string | 工具名（如 `bash`、`edit`、`mcp__fs__read_file`）                                                                           |
| `toolCallId` | string | 调用 id                                                                                                                     |
| `input`      | object | 工具原始输入参数（各工具自定义结构，如 bash 的 `{ command }`、edit 的 `{ path, oldText, newText }`，原样 JSON，逐字段截断） |

**`tool_result`**

| 字段         | 类型    | 内容                                                          |
| ------------ | ------- | ------------------------------------------------------------- |
| `tool`       | string  | 工具名                                                        |
| `toolCallId` | string  | 调用 id                                                       |
| `input`      | object  | 工具原始输入参数（同上）                                      |
| `content`    | string  | 结果文本内容（多段文本以换行连接；图片以 `[图片 N 项]` 占位） |
| `isError`    | boolean | 结果是否为错误                                                |

**`turn_end`**

| 字段          | 类型   | 内容                                                |
| ------------- | ------ | --------------------------------------------------- |
| `turnIndex`   | number | 轮次序号（0 起）                                    |
| `assistant`   | string | 该轮 assistant 消息文本                             |
| `toolResults` | array  | 该轮全部工具结果，元素 `{ tool, content, isError }` |

**`agent_end`**

| 字段           | 类型   | 内容                              |
| -------------- | ------ | --------------------------------- |
| `messageCount` | number | 本次 agent 循环启动以来的消息总数 |

**`context_tokens`**

| 字段        | 类型   | 内容                                                                                                                                                                                                                                             |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tokens`    | number | 当前上下文用量（footer 同源）                                                                                                                                                                                                                    |
| `threshold` | number | 规则配置的触发间隔                                                                                                                                                                                                                               |
| `level`     | number | 本次跨越到的倍数水位（`floor(tokens / threshold)`）                                                                                                                                                                                              |
| `messages`  | array  | **增量消息**：自该规则上次触发以来的全部消息（首次触发为规则加载以来），元素 `{ role, tool?, text }`（`role` 为 user/assistant/toolResult；`tool` 仅 toolResult 元素携带；assistant 元素按消息文本序列化规则含 `[thinking: ...]`，截断规则同上） |

模板渲染引擎 SHALL 为 Handlebars，配置钉死：`noEscape: true`（文本不转义 HTML 实体，命令串中 `&&`、`<` 等保持原样）、缺失路径渲染为空字符串（非 strict 模式）并在该次审计的诊断详情中记录未解析路径（`@root`/`@index` 等 data 引用与 `this` 相对路径由 Handlebars 自身解析，MUST NOT 记为未解析变量）。原生 `{{#if}}` / `{{#unless}}` / `{{#each}}` / `{{#with}}` section 可用；内置 helper 限定最小集：`json`（对象 JSON 序列化）、`truncate`（`{{truncate 文本 N}}` 截断至 N 字符并附截断标注）、`now`（本地时间 `YYYY-MM-DD HH:mm`），不开放自定义 helper 注册。模板变量以事件数据对象为根（`{{tool}}`、`{{input.command}}`、`{{content}}`、`{{turnIndex}}`、`{{tokens}}` 等）；整个 input 的 JSON 序列化 SHALL 使用 `{{json input}}`。渲染后的最终审计消息 SHALL 为两段式：渲染后 `prompt` + 固定分隔的审计范围段（`--- 审计范围 ---`），范围段总是附加、不经模板变量。`tool_call`/`tool_result` 的范围段内容为事件数据对象的 JSON 序列化；其余触发器的范围段为对话转写文本（role + 文本内容）。

#### Scenario: tool_call 事件字段引用命令内容

- **WHEN** `bash` 工具触发的规则 prompt 含 `{{input.command}}`
- **THEN** 渲染后的 prompt 中该占位符为实际命令字符串

#### Scenario: tool_result 事件字段引用结果与错误态

- **WHEN** `tool_result` 规则 prompt 含 `{{tool}}`、`{{content}}` 与 `{{isError}}`
- **THEN** 渲染后分别为工具名、结果文本与错误标志

#### Scenario: 未知变量渲染为空并记录

- **WHEN** prompt 含 `{{input.nonexistent}}`
- **THEN** 占位符渲染为空字符串，该次审计的诊断详情包含 `input.nonexistent` 未解析的记录

### Requirement: 旁路审计与结构化裁决协议

每次审计 SHALL 运行一个独立于主循环的 LLM 循环：固定内置系统提示（审计员角色 + 必须调用裁决工具 + 输出语言跟随规则 prompt）、上一条定义的两段式用户消息、`audit_verdict` 工具、规则 `tools` 白名单内的宿主**内置**工具（经宿主工具工厂构造；扩展注册/MCP 工具名仅可用于触发器匹配，作为审计员工具配置即校验失败；文档应提示审计员只宜配置只读类工具）、`maxTurns` 轮上限、输出 token 上限 min(8192, 模型上限)、thinking 级别按 `规则 thinking > defaults.thinking > "off"`。审计过程 MUST NOT 触发任何哨兵规则（无递归）、MUST NOT 修改主循环上下文或工具状态。

`audit_verdict` 工具参数 SHALL 为 `{ "verdict": "pass"|"warn"|"fail", "message": string }`，`message` 非空且不超过 2000 字符（超长截断）。循环结束仍未调用该工具、`verdict` 非枚举值、`message` 为空、流式 `stopReason` 为 `error`/`aborted`、超时、模型解析失败，或 `streamSimple` 同步抛出（此时 SHALL 立即以 `stopReason: "error"` 终止的流计入失败，MUST NOT 挂起等待 `timeoutMs`），SHALL 均视为审计失败（被 background `replace` 策略主动中止的审计除外——按取消处理，不计失败、不进负冷却、不写缓存）。

#### Scenario: 裁决工具调用即结论

- **WHEN** 旁路 LLM 调用 `audit_verdict` 且 `verdict` 为 `fail`、`message` 说明原因
- **THEN** 本次审计结论为 `fail`，`message` 作为发现内容

#### Scenario: 未产生裁决视为失败

- **WHEN** 旁路循环结束但从未调用 `audit_verdict`
- **THEN** 本次审计按审计失败处理（走失败策略），不产生裁决

#### Scenario: 开启调查工具

- **WHEN** 规则配置 `tools: ["read", "grep"]`
- **THEN** 旁路循环可调用 read/grep 自主核实（至多 `maxTurns` 轮），且不可调用白名单之外的任何工具

### Requirement: blocking 模式工具门控

`blocking` 规则 SHALL 在 `tool_call` 触发点同步等待其审计完成后汇总：

- 全部规则裁决非 `fail`：放行。
- 任一 `fail`：拦截执行，拒绝理由为多条按规则名排序逐行合并：`[pi-sentinel] 规则 "<name>" 拦截本次调用：<message>`。
- `warn`：放行，并记录该 `toolCallId` 的待附警告；当该调用的 `tool_result` 事件到达时，SHALL 以**完整数组**（前缀行 + 原内容全部条目）替换结果内容，使最前出现 `[pi-sentinel][warn] <规则名>: <message>`（多条规则同时 warn 时前缀行按规则名排序；主模型可见；不做 UI 提醒）。待附警告 SHALL 在以下任一情形丢弃：该调用的结果被任一方拦截（被拦截的调用不产生 `tool_result` 事件）、同一批已有 `fail` 裁决（以 fail 为准，不附 warn）、调用中止、或该调用在同一会话内始终未产生 `tool_result` 事件。
- 审计失败：`onFailure: "open"`（默认）放行，并由审计运行时 `ui.notify` 提示 `sentinel 审计失败（规则 "<name>"）：<原因>`（warning 级；TUI 以外模式仅记入历史）。同一次审计失败的通知 SHALL 恰好一次，门控侧 MUST NOT 重复提示；`onFailure: "closed"` 拦截，理由为 `[pi-sentinel] 规则 "<name>" 审计失败（fail-closed）：<原因>`。审计失败后该规则进入 30 秒**负冷却**：期间不再发起新的旁路审计（serial 队列中已入队的审计照常执行，不构成对故障模型的新重试），blocking 按其 `onFailure` 直接放行/拦截（拦截理由注明"审计持续失败"），background 触发按丢弃处理并记入历史——避免对故障中的模型逐次重试。

#### Scenario: fail 拦截并返回理由

- **WHEN** blocking 规则审计结论为 `fail`
- **THEN** 工具不执行，主模型收到的工具结果包含 `[pi-sentinel] 规则 "<name>" 拦截本次调用：<message>`

#### Scenario: warn 随工具结果对主模型可见

- **WHEN** blocking 规则裁决 `warn` 且工具放行执行完成
- **THEN** 该调用的工具结果内容最前出现 `[pi-sentinel][warn] <规则名>: <message>`，其余内容不变

#### Scenario: 审计失败默认放行

- **WHEN** blocking 规则的旁路 LLM 超时且规则未配置 fail-closed
- **THEN** 工具放行执行，用户收到审计失败的 UI 提示

#### Scenario: 多规则任一 fail 即拦截

- **WHEN** 同一 `bash` 调用匹配规则 A（结论 pass）与规则 B（结论 fail）
- **THEN** 该调用被拦截，拒绝理由包含规则 B 的 message

### Requirement: background 模式发现注入

`background` 规则 SHALL 异步执行审计，不阻塞主循环。结论为 `pass` 时 SHALL 静默（仅记入历史）。结论为 `warn` 或 `fail` 时 SHALL 注入会话：`pi.sendMessage`，`customType: "pi-sentinel-finding"`，文本内容为 `[pi-sentinel][<verdict>] 规则 "<name>"：<message>`，`details` 为 `{ rule, verdict, message, kind: "audit", at }`。注入可见性 SHALL 为：主 agent 循环仍在流式中时以 `deliverAs: "steer"` 注入（当前循环的下一个 LLM 调用边界生效）；主循环空闲时直接注入（立即持久化进会话并参与后续上下文）。不得使用 `deliverAs: "nextTurn"`（其仅在用户下一次提交时投递，空闲注入会滞留甚至丢失）。渲染 SHALL 经 `registerMessageRenderer` 输出紧凑块（warn/fail 级别徽标、规则名、message、审计耗时）。

判重 SHALL 以 `sha256(rule + "\n" + verdict + "\n" + normalize(message))` 为键（normalize = 转小写 + 连续空白折叠为单空格），冷却窗口 `dedupeCooldownMs`（默认 10 分钟）内相同键的发现不重复注入，仅记入历史（标注 deduped）；规则 `dedupe: false` 关闭判重。冷却状态属会话运行时状态，会话切换即清空。判重冷却按规则名归属：热加载时仅被替换/移除规则名下的冷却失效，未变更规则的冷却 MUST 保留（配置对话新增/禁用其他规则 MUST NOT 清空既有判重窗口）。

#### Scenario: pass 静默

- **WHEN** background 规则审计结论为 `pass`
- **THEN** 主循环上下文中不出现任何该次审计的消息

#### Scenario: fail 注入上下文

- **WHEN** background 规则在 `turn_end` 触发且结论为 `fail`，注入完成时主循环仍在流式
- **THEN** 注入消息以 steer 方式送达，主模型在该循环的下一个 LLM 调用边界可见 `[pi-sentinel][fail] 规则 "<name>"：<message>`；若注入时主循环空闲，则消息立即持久化进会话，随主模型下一次运行可见

#### Scenario: 同类发现冷却去重

- **WHEN** 同一规则在冷却窗口内产生内容实质相同（判重键一致）的 warn 发现两次
- **THEN** 仅第一次注入上下文，第二次只记入历史

### Requirement: 重复触发策略（overlap）

同一规则的 Runner SHALL 维护 `idle | queued | running` 状态机，`overlap` 定义在跑时新触发的处理：

- `parallel`：立即并发执行；全局信号量饱和时排队等待（获得配额后执行）。
- `serial`：入队 FIFO，无深度上限，在跑审计结束后按到达顺序逐个以各自触发时的数据执行（不丢触发）；全局信号量饱和时同样排队等待。
- `ignore`：丢弃新触发并记入历史（标注 skipped）。
- `replace`：以 AbortController 中止在跑审计（历史记 `replaced`，不产生裁决、不写缓存），以新触发数据立即开始；全局信号量饱和时先完成中止、再排队等待新配额。

信号量饱和时的处理矩阵 SHALL 为：`parallel` / `serial` → 排队等待，`ignore` → 丢弃，`replace` → 中止在跑者后排队。

blocking 规则与 overlap 的交互：`serial` 时同规则并发的 tool_call 门控排队等待（延迟叠加）；`ignore` 时在跑期间的新调用直接放行不审计（等同跳过）；`replace` 的规范行为为**先完成在跑者再执行新触发**（含信号量饱和时排队等待，不中止在跑者）——被中止审计的豁免路径（不计审计失败、不进负冷却）仅适用于 background 的 replace。策略按规则独立生效，不同规则互不影响。

#### Scenario: ignore 丢弃新触发

- **WHEN** 规则 overlap 为 `ignore`，上一次审计仍在执行且新触发到达
- **THEN** 新触发被丢弃，历史记录一次 skipped

#### Scenario: replace 取旧启新

- **WHEN** background 规则 overlap 为 `replace`，上一次审计仍在执行且新触发到达
- **THEN** 在跑审计被中止（历史记 `cancelled`，语义等同规范所称 replaced：不计审计失败、不进负冷却、不写缓存），以新触发数据重新开始审计

#### Scenario: serial 排队不丢触发

- **WHEN** 规则 overlap 为 `serial`，在跑期间到达两次触发
- **THEN** 两次触发先后入队，在跑审计结束后按到达顺序各执行一次审计

### Requirement: 裁决缓存

规则默认启用裁决缓存：键为 `sha256(ruleName + "\n" + 规则定义内容哈希 + "\n" + 渲染后 prompt + "\n" + 范围文本)`，值为 `{ verdict, message, at }`；TTL 内相同键触发直接复用裁决，**复用走完整分流逻辑**（blocking 对同一命令即时返回相同拦截理由、warn 附着与真实审计一致），不发起旁路 LLM 调用。`cacheTtlMs`（默认 10 分钟）与 `cache`（默认继承 `defaults.cache`，`defaults.cache: false` 为全局默认关，规则 `cache: true` 仍可显式开启）规则可配。仅产生合法裁决的审计才写入缓存（fail 裁决同样缓存）；审计失败不写缓存。会话切换或关闭 SHALL 清空缓存；规则热替换/移除 SHALL 失效该规则名下缓存。缓存命中与未命中 SHALL 记入审计历史。

#### Scenario: TTL 内相同命令复用裁决

- **WHEN** blocking 规则对同一命令串审计结论为 pass，TTL 内主模型再次发起相同命令
- **THEN** 第二次调用直接复用 pass 裁决，无旁路 LLM 请求

#### Scenario: TTL 过期重新审计

- **WHEN** 相同触发内容在缓存 TTL 过期后再次触发
- **THEN** 重新执行旁路审计

### Requirement: 审计模型与 thinking 解析链

审计模型 SHALL 按 `规则 model` > `defaults.model` > 会话当前模型解析；配置对话模型 SHALL 按 `defaults.configure.model` > `defaults.model` > 会话当前模型解析。审计 thinking SHALL 按 `规则 thinking` > `defaults.thinking` > `"off"`。配置的模型不可用（未注册、无凭据）SHALL 视为该次审计失败并走失败策略，同时 UI 提示模型解析失败。

#### Scenario: 规则指定独立模型

- **WHEN** 规则配置 `model` 为某个快速模型而会话模型为另一模型
- **THEN** 该规则的审计请求发往规则指定的模型

#### Scenario: 配置模型不可用时按失败处理

- **WHEN** 规则 `model` 指向未配置凭据的模型且触发 blocking 审计
- **THEN** 该次审计按审计失败处理（默认放行并提示），工具不被永久卡住

### Requirement: 审计范围窗口

范围默认值按触发器：`tool_call` 与 `tool_result` 为该次调用的白名单序列化事件；`turn_end` 为该轮 assistant 消息文本与其全部工具结果文本；`agent_end` 为本次 agent 循环启动以来的全部消息（role + 文本内容，按消息文本序列化规则含 thinking、toolCall 占位）；`context_tokens` 为**自该规则上次触发以来的增量消息**（首次为规则加载以来，与事件数据 `messages` 同源）。规则 `window` SHALL 可覆盖：`{ messages: N }` 最近 N 条消息、`{ tokens: N }` 最近约 N token（按字符数/4 估算）、`{ full: true }` 全上下文。范围内容超过 `maxWindowTokens`（按字符数/4 估算，默认 20000）时 SHALL 从头部丢弃保留尾部并附截断标注。

#### Scenario: tool_result 默认单结果审计

- **WHEN** `tool_result` 触发且规则未配置 `window`
- **THEN** 旁路 LLM 收到该次工具调用的序列化事件，不含更早对话

#### Scenario: window 覆盖默认范围

- **WHEN** `turn_end` 规则配置 `window: { "messages": 20 }`
- **THEN** 审计范围为最近 20 条消息而非默认的最近一轮

### Requirement: 哨兵清单与管理命令

插件 SHALL 注册 `/sentinel:list`：列出全部已加载哨兵，每条含规则名、触发器、模式、模型、启用状态（`enabled=false` 或被会话禁用均显示为禁用）、加载来源（global/project/session）、实时状态（空闲/排队/执行中/最近裁决/缓存命中与否/冷却状态）。交互模式下 SHALL 支持内联管理：选择哨兵后执行启用/禁用/移除（语义见"会话级动态管理与持久化"）；TUI 以外模式打印文本总览。运行中的哨兵数量 SHALL 通过状态条或底部组件持续可见。

#### Scenario: list 列出全部哨兵

- **WHEN** 用户执行 `/sentinel:list` 且配置加载了三条规则（其一执行中）
- **THEN** 输出列出三条规则的名称、触发器、模式与状态，执行中规则标注运行状态

#### Scenario: list 中内联禁用哨兵

- **WHEN** 用户在 `/sentinel:list` 中选择某条规则并执行禁用
- **THEN** 该规则立即停止触发，清单中其状态更新为已禁用

#### Scenario: 状态条感知运行

- **WHEN** 任一 background 审计在执行中
- **THEN** 状态条显示运行中哨兵（数量/名称），结束后恢复

### Requirement: 会话级动态管理与持久化

经 `/sentinel:list` 的内联管理操作，用户 SHALL 能：添加会话级规则（来自配置对话，见下）、对任意来源的规则禁用/启用（按名屏蔽，屏蔽与来源无关）、移除会话级新增的规则（对 global/project 来源的规则 SHALL 拒绝并提示改用禁用）。变更 SHALL 追加为会话条目（追加式操作日志：add-rule / disable / enable / remove），即时热生效，并以重放方式恢复——重启后恢复该会话时配置仍生效。fork 出的会话 SHALL 因条目复制继承会话级配置。会话级配置不属于运行时状态重置范围。

#### Scenario: 会话中新增并跨重启生效

- **WHEN** 用户在会话中添加一条会话级哨兵，退出后重新恢复该会话
- **THEN** 该哨兵在恢复后的会话中仍处于生效状态

#### Scenario: 禁用屏蔽继承规则

- **WHEN** `bash-safety` 来自全局配置，用户在 `/sentinel:list` 中对其执行禁用
- **THEN** 该规则在本会话内不再触发；对其执行启用后恢复

#### Scenario: fork 继承会话级配置

- **WHEN** 会话 A 含两条会话级规则，用户 fork 出会话 B
- **THEN** 会话 B 的生效规则集包含这两条

#### Scenario: 移除仅限会话级规则

- **WHEN** 用户对一条仅存在于项目配置的规则在 `/sentinel:list` 中执行移除
- **THEN** 操作被拒绝并提示原因，会话级配置不变

#### Scenario: 移除遮蔽性会话规则后继承规则恢复

- **WHEN** 会话级存在与全局规则同名的遮蔽性规则，用户对其执行移除
- **THEN** 该会话级规则删除，合并链恢复，全局同名规则重新生效

### Requirement: 规则热加载语义

配置变更（同名替换、新增、移除、启用/禁用）触发热加载时，各运行时状态的处置 SHALL 为：被替换或移除规则的**在跑审计照常完成并按旧规则身份分流**（注入与门控记录归属旧规则名）；其 serial 队列中的排队审计与正排在全局信号量等待队列中的审计 SHALL 丢弃并记入历史（标注 skipped）；其 `context_tokens` 增量标记以变更时刻位置重建；该规则名下的裁决缓存、判重冷却与审计失败负冷却 SHALL 立即失效（不继承给新规则）。未变更规则的运行时状态（缓存、判重冷却、负冷却、增量标记与水位）MUST NOT 被重置。`defaults.maxConcurrent` 变更 SHALL 立即作用于唯一的全局信号量（复用 runner MUST 共享同一实例与计数），运行中新增/替换规则 MUST NOT 拆分并发预算。新增规则从加载点开始。缓存键 SHALL 包含规则定义内容哈希，同名但内容变更的规则即使键的其余部分相同也不复用旧裁决。

#### Scenario: 同名替换后旧审计照常分流、缓存失效

- **WHEN** 规则 A 正在执行审计，用户经配置对话替换同名规则 A（修改 prompt），替换后旧审计完成
- **THEN** 旧审计按替换前的规则 A 定义完成并正常分流；规则 A 名下旧缓存条目与冷却状态全部失效，新触发按新定义重新审计

### Requirement: 自然语言配置生成与确认写入

插件 SHALL 提供 `/sentinel:configure [初始描述]` 启动**后台运行的独立配置对话**：旁路 LLM 与用户以自然语言多轮对话生成或修改哨兵配置。启动命令 SHALL 立即返回、不打开对话界面；同一时间至多一个配置对话在跑（重复启动时 SHALL 通过确认对话框询问"取消当前对话并开始新的 / 保持现有"）。对话运行期间 SHALL NOT 向主会话注入任何消息、MUST NOT 干扰主循环（哨兵触发照常执行）；对话的实时进展（当前轮次、最近交互、待提交草稿）SHALL 可在 fleet 检查器中查看。对话模型 SHALL 按 `defaults.configure.model` > `defaults.model` > 会话当前模型解析。TUI 以外模式下该命令 SHALL 提示不可用。会话切换或关闭时配置对话 SHALL 随运行时状态一并中止（与在跑审计同批）。

对话 LLM 提交草稿时，系统 SHALL 校验（同一校验器）后弹出预览（弹出前自动关闭 fleet overlay，避免焦点嵌套），用户三选：**写入**（选择作用域 global/project/session）、**继续调整**（附自然语言要求回传对话循环）、**放弃**。草稿变更类型 SHALL 涵盖新增规则、修改既有规则（同名替换）与删除规则（global/project 作用域为文件级删除，session 作用域走移除操作）；对 global/project 中不存在的规则执行删除 SHALL 报告该规则不存在。选择继续调整、放弃或草稿校验失败时 MUST NOT 写入；继续调整的要求与校验错误 SHALL 回传对话循环。写入后 SHALL 立即热生效并回传变更摘要；global/project 写入 MUST 读取-合并-写回（同名规则替换、新规则追加、显式删除，不破坏既有内容）；会话级写入 SHALL 走会话级操作日志，新增同名规则遮蔽继承规则时 SHALL 向用户提示遮蔽关系。

#### Scenario: 后台启动配置对话

- **WHEN** 用户执行 `/sentinel:configure 检查 rm 命令是否安全`
- **THEN** 命令立即返回且主会话无新增上下文内容，配置对话在后台开始运行，可在 fleet 检查器中查看其进展

#### Scenario: 配置对话生成并确认写入项目级

- **WHEN** 配置对话生成规则草稿并提交，用户在预览确认中选择写入且作用域为项目级
- **THEN** 该规则写入项目 `.pi/sentinel.json` 并立即生效

#### Scenario: 提交时要求继续调整

- **WHEN** 配置对话提交草稿，用户选择"继续调整"并附要求"阈值消息里不要包含命令全文"
- **THEN** 不发生任何写入，该要求回传到配置对话，LLM 按要求修改后重新提交

#### Scenario: 草稿校验失败迭代

- **WHEN** 对话 LLM 提交的草稿含非法枚举值
- **THEN** 系统不写入，指明字段的校验错误回传到配置对话供其修正后重新提交

### Requirement: 交互式 fleet 检查器

交互模式（有 UI）下，插件 SHALL 注册 `/sentinel:fleet` 打开实时检查器（参考 pi-subagents fleet inspector 形态）：展示全部哨兵与运行中配置对话的实时列表（状态与最近裁决），键位移动选择，内嵌详情面板显示选中条目的实时运行详情——已耗时、模型、渲染后 prompt 概要、范围摘要、（开启工具时的）工具调用进展、流式输出尾部（环形缓冲约 2KB）、缓存命中与否。运行中条目详情 SHALL 随刷新周期自动更新（约 1s）。检查器 SHALL 支持 steer：对执行中或排队中的审计追加用户消息（经其旁路循环的 steering 队列注入，下一个 LLM 调用边界生效，经输入对话框输入），并显示送达回执（已送达 / 已结束未能送达）；空闲哨兵不可 steer。键位（移动选择/steer/刷新/关闭）SHALL 可配置（`fleetKeybindings`）。关闭检查器 SHALL 不影响在跑审计与配置对话。已结束的配置对话 SHALL 从列表移除，会话切换/关闭 SHALL 清空对话列表。TUI 以外模式 SHALL 提示不可用并指向 `/sentinel:list`。

#### Scenario: 打开检查器总览

- **WHEN** 用户执行 `/sentinel:fleet` 且配置加载了三条规则（其一执行中）
- **THEN** 检查器列出三条哨兵及其状态，执行中的可被选中查看

#### Scenario: 选中运行中哨兵查看实时详情

- **WHEN** 用户在检查器中选中一个正在执行的哨兵
- **THEN** 详情面板显示已耗时、模型、prompt 概要、范围摘要与流式输出尾部，并随刷新周期展示新增进展

#### Scenario: 对执行中审计 steer

- **WHEN** 某开启工具的审计正在执行，用户在检查器中对其追加消息"重点核对配置文件的写入路径"
- **THEN** 该消息在审计的下一个 LLM 调用边界送达并影响其后续轮次，检查器显示送达回执

#### Scenario: 空闲哨兵不可 steer

- **WHEN** 用户尝试对处于空闲状态（无在跑且无排队审计）的哨兵 steer
- **THEN** 操作不可用或被拒绝，并提示无进行中的审计可引导

#### Scenario: 关闭不影响审计

- **WHEN** 检查器打开期间某审计结束，随后用户关闭检查器
- **THEN** 该审计结果照常分流（注入/门控记录），关闭后主界面恢复正常

#### Scenario: TUI 以外模式降级

- **WHEN** 在 print/RPC 等TUI 以外模式下执行 `/sentinel:fleet`
- **THEN** 命令提示该模式不可用并指向 `/sentinel:list`，不崩溃

### Requirement: 规则试运行（dry-run）

插件 SHALL 提供 `/sentinel:test <规则名> [模拟内容]`：以模拟事件对指定规则执行完整审计管线（模板渲染、范围窗口、旁路审计、结构化裁决），在命令输出中展示 verdict、message、模型与耗时。规则名不存在 SHALL 报错退出；`enabled: false` 或被会话禁用的规则 SHALL 仍可试运行（写规则即可验证，不必先启用）。模拟事件构造 SHALL 为：`tool_call`/`tool_result` 规则以模拟内容作为事件数据（模拟内容为合法 JSON 时解析为 `input` 对象，否则作为 `{ "text": 模拟内容 }`；`tool` 取 `trigger.tools` 中第一个不含通配符的元素，不存在时取 `"bash"`）；其余触发器以模拟内容作为范围文本。试运行 MUST NOT 产生任何分流副作用：不阻塞或放行真实工具调用、不注入上下文、不读写裁决缓存、不进入冷却与负冷却；历史记录标注 `kind: "test"`。TUI 以外模式结果打印到命令输出。

#### Scenario: 试运行展示裁决

- **WHEN** 用户执行 `/sentinel:test bash-safety rm -rf /tmp/build`
- **THEN** 输出显示该次审计的 verdict、message、模型与耗时

#### Scenario: 试运行无分流副作用

- **WHEN** 对一条 blocking 规则试运行且裁决为 fail
- **THEN** 没有真实工具调用被阻塞，裁决缓存与冷却状态不变，主会话上下文无任何注入

### Requirement: 生命周期与并发边界

哨兵运行时状态（执行中任务、serial 队列、缓存、冷却、判重表、增量标记）SHALL 在会话切换或 fork 时重置；会话关闭（`session_shutdown`）时 SHALL 中止所有在跑审计与配置对话。会话树导航（`session_tree`）SHALL 仅沿新活动分支重放会话级配置并重置非活动分支的增量标记，MUST NOT 中止在跑审计、清空缓存/冷却或中止配置对话。会话级配置不属于重置范围。全局并发审计数 SHALL 受 `maxConcurrent`（默认 3）上限约束（唯一的全局信号量实例，热加载仅更新其上限，复用 runner MUST NOT 各自持有独立预算），信号量获取按 FIFO 公平排序，饱和时按各规则的 overlap 策略处理（见"重复触发策略"的处理矩阵）。规则被禁用时已在跑的审计及其 serial 队列中已入队的审计 SHALL 照常执行并按旧定义分流。

#### Scenario: 会话切换重置

- **WHEN** 会话 A 有审计在跑，用户切换到会话 B
- **THEN** 会话 A 的在跑审计被中止，会话 B 从空运行时状态开始

#### Scenario: 全局并发上限

- **WHEN** 全局并发上限为 2 且三条不同规则同时触发 background 审计（三条 overlap 均为默认）
- **THEN** 两条开始执行，第三条按其 overlap 默认（ignore）丢弃并记入历史；若该规则配置为 serial/parallel 则排队等待配额
