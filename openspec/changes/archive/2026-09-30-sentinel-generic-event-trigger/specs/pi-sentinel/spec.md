# Spec Delta

## MODIFIED Requirements

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

| 字段                 | 类型                                                                                                 | 必填                    | 默认                                                               | 语义                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | 非空 string                                                                                          | 是                      | —                                                                  | 会话内唯一，合并键                                                                                                                                                                                                                                             |
| `trigger`            | object                                                                                               | 是                      | —                                                                  | `{ type, tools?, threshold?, event? }`                                                                                                                                                                                                                         |
| `trigger.type`       | `"tool_call"` \| `"tool_result"` \| `"turn_end"` \| `"agent_end"` \| `"context_tokens"` \| `"event"` | 是                      | —                                                                  | 触发器类型                                                                                                                                                                                                                                                     |
| `trigger.event`      | 非空 string                                                                                          | `event` 时必填          | —                                                                  | 事件名：裸名订阅插件事件总线通道（开放命名，不做校验）；`core:` 前缀订阅 pi 核心扩展事件（前缀后的名字 SHALL 为宿主已知核心事件名，未知名字校验失败并警告列出合法值）。`core:` 为保留前缀；其他类型出现即校验失败                                              |
| `trigger.tools`      | string[]                                                                                             | 否                      | 匹配全部                                                           | 工具名过滤模式数组，任一模式命中即触发（OR）；元素为 minimatch 模式，对事件上报的完整工具名全匹配（内置工具如 `bash`/`edit`/`write`，扩展注册工具、MCP 工具如 `mcp__*` 一视同仁）；空数组或缺省匹配全部；仅 tool_call/tool_result 有效，其他类型出现即校验失败 |
| `trigger.threshold`  | 正整数                                                                                               | `context_tokens` 时必填 | —                                                                  | 触发间隔：上下文用量每跨越该 token 数的一个整数倍边界触发一次；其他类型出现即校验失败                                                                                                                                                                          |
| `mode`               | `"blocking"` \| `"background"`                                                                       | 是                      | —                                                                  | 执行模式。合法组合矩阵：`blocking` 仅可搭配 `tool_call`；`background` 可搭配全部六种触发器；其余组合校验失败                                                                                                                                                   |
| `prompt`             | 非空 string                                                                                          | 是                      | —                                                                  | 检查指令，经模板渲染                                                                                                                                                                                                                                           |
| `model`              | string                                                                                               | 否                      | 解析链兜底                                                         | 审计模型                                                                                                                                                                                                                                                       |
| `thinking`           | string                                                                                               | 否                      | `defaults.thinking`                                                | pi ThinkingLevel 枚举                                                                                                                                                                                                                                          |
| `tools`              | string[]                                                                                             | 否                      | `[]`                                                               | 审计员工具白名单，v1 限宿主**内置**工具名（read/grep 等，经宿主工具工厂构造；扩展注册/MCP 工具名仅可用于触发器匹配，不可作为审计员工具，配置了此类名称该元素按校验失败处理）                                                                                   |
| `maxTurns`           | 正整数                                                                                               | 否                      | `tools` 非空时 `4`，否则 `1`                                       | 旁路循环最大轮数                                                                                                                                                                                                                                               |
| `window`             | object                                                                                               | 否                      | 按触发器默认                                                       | `{ messages?: N }` \| `{ tokens?: N }` \| `{ full: true }`，多键并存校验失败                                                                                                                                                                                   |
| `overlap`            | `"parallel"` \| `"serial"` \| `"ignore"` \| `"replace"`                                              | 否                      | blocking→`parallel`，background→`ignore`                           | 重复触发策略                                                                                                                                                                                                                                                   |
| `onFailure`          | `"open"` \| `"closed"`                                                                               | 否                      | `"open"`                                                           | 审计失败策略                                                                                                                                                                                                                                                   |
| `cache`              | boolean                                                                                              | 否                      | `defaults.cache`                                                   | 裁决缓存开关（`true` 显式开启优先于全局默认关）                                                                                                                                                                                                                |
| `cacheTtlMs`         | 正整数                                                                                               | 否                      | `defaults.cacheTtlMs`                                              | 缓存 TTL                                                                                                                                                                                                                                                       |
| `timeoutMs`          | 正整数                                                                                               | 否                      | `defaults.timeoutMs`，未设时 blocking `30000` / background `60000` | 审计超时                                                                                                                                                                                                                                                       |
| `enabled`            | boolean                                                                                              | 否                      | `true`                                                             | 文件级启停（false 时加载但不触发）                                                                                                                                                                                                                             |
| `dedupe`             | boolean                                                                                              | 否                      | `true`                                                             | 发现注入判重开关（仅 background 有意义）                                                                                                                                                                                                                       |
| `includeThinking`    | boolean                                                                                              | 否                      | `true`                                                             | assistant 消息的 thinking 是否并入审计数据（`false` 时整体省略；redacted thinking 始终省略）                                                                                                                                                                   |
| `includeToolInputs`  | boolean                                                                                              | 否                      | `true`                                                             | 工具输入是否并入审计数据（toolCall 占位的参数与 `input` 字段）                                                                                                                                                                                                 |
| `includeToolOutputs` | boolean                                                                                              | 否                      | `true`                                                             | 工具输出是否并入审计数据（`content` 字段与 toolResults 元素）                                                                                                                                                                                                  |

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

#### Scenario: 未知核心事件名加载期拒绝

- **WHEN** 规则触发器为 `{ "type": "event", "event": "core:sesson_compact" }`（拼写错误）
- **THEN** 该条被跳过并警告 `core:` 前缀事件名不存在，警告内容列出宿主已知核心事件名供修正

#### Scenario: 总线通道名不做校验

- **WHEN** 规则触发器为 `{ "type": "event", "event": "pi-subagents:done" }`，该通道当前无任何插件发布
- **THEN** 规则照常加载并保持订阅，事件从未到达时仅表现为不触发（fleet/清单不报错）

### Requirement: 触发器语义

- `tool_call`：每次工具调用执行前触发（每调用恰一次）；`trigger.tools` 为工具名过滤模式数组（任一模式命中即触发），元素对事件上报的完整工具名全匹配——内置工具（`bash`、`edit`、`write`、`read` 等）、扩展注册工具与 MCP 工具（如 `mcp__<server>__<tool>`）均以其实际工具名参与匹配。
- `tool_result`：每次工具结果定稿后触发（每调用恰一次）；过滤同上。
- `turn_end`：主循环每轮结束（assistant 消息及其全部工具结果定稿）后触发；变量 `{{turnIndex}}` 可用。
- `agent_end`：agent 循环结束时触发一次。
- `event`：以 `trigger.event` 命名的事件为触发点。**裸名**订阅插件事件总线（`pi.events`）通道；**`core:` 前缀**订阅 pi 核心扩展事件。事件到达时，全部启用且 `trigger.event` 相同的 event 规则各自触发一次审计（互不排斥，规则级 `overlap` 默认 `ignore`、缓存、判重等既有 knobs 照常适用）。订阅按事件名共享并以引用计数管理：随规则加载建立，最后一条引用该事件名的规则被移除、改名或改用其他事件名后退订；订阅生命周期绑定配置而非会话（会话切换、树导航不退订、不重置）。事件到达不要求 agent 处于运行状态。核心事件允许订阅宿主全部已知事件名，包括逐 token 级高频事件（如 `core:message_update`）：系统 MUST NOT 依据事件频率或事件类别拒绝、限制或警告性改写订阅，高频事件逐次触发审计的代价由配置者承担（background 规则默认 `overlap: "ignore"` 提供基本的重复触发合并）。
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

#### Scenario: 总线通道事件触发审计

- **WHEN** 规则触发器为 `{ "type": "event", "event": "pi-subagents:done" }`，某插件经事件总线以该通道名 emit 一条载荷
- **THEN** 该规则触发一次 background 审计，事件数据根中 `name` 为 `"pi-subagents:done"`、`event` 为该载荷

#### Scenario: 核心事件触发审计

- **WHEN** 规则触发器为 `{ "type": "event", "event": "core:session_compact" }`，宿主完成一次上下文压缩并分发 `session_compact`
- **THEN** 该规则触发一次 background 审计，事件数据根中 `name` 为 `"core:session_compact"`

#### Scenario: 同名事件多规则全部触发

- **WHEN** 两条 event 规则的 `trigger.event` 均为 `"core:session_compact"`（规则名不同），压缩事件到达
- **THEN** 两条规则各自触发一次审计，彼此独立适用各自的 overlap 与缓存

#### Scenario: 事件到达不要求 agent 运行中

- **WHEN** agent 空闲时事件总线上一条已订阅通道被 emit
- **THEN** 该 event 规则照常触发审计（审计照常异步执行，发现按既有注入语义分流：主循环流式中以 steer 注入、空闲时直接注入）

#### Scenario: 最后一条规则移除后退订

- **WHEN** 唯一引用 `"core:session_compact"` 的 event 规则被热加载移除，之后宿主再次分发该事件
- **THEN** 运行时已退订该事件，不再产生任何审计或历史记录

#### Scenario: 会话切换不退订

- **WHEN** 存在 event 规则，用户切换到另一会话后切换回来，期间事件到达
- **THEN** 订阅保持有效，事件照常触发（运行时状态重置不涉及订阅）

#### Scenario: 高频核心事件不设防

- **WHEN** 规则触发器为 `{ "type": "event", "event": "core:message_update" }`（逐 token 级事件）
- **THEN** 订阅被接受并按事件到达逐次触发（受 overlap 默认 `ignore` 与全局并发上限约束），加载期不因事件频率拒绝该规则

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

**`event`**

| 字段    | 类型   | 内容                                                                                                                                                                                                                                                                        |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`  | string | 规则配置的事件名原文（含 `core:` 前缀，如有）                                                                                                                                                                                                                               |
| `event` | object | 事件载荷：`core:` 前缀核心事件为事件对象本身；裸名总线事件为 emit 的 `data`（纯对象直用；数组、原始值等其他值包为 `{ "value": <载荷> }`）。载荷经 JSON 安全投影（保留 null/布尔/数值/字符串/数组/纯对象，其余值以 `"[unserializable]"` 字符串占位）后逐字符串按截断规则截断 |

`event` 触发器的载荷为原始事件数据，`includeThinking` / `includeToolInputs` / `includeToolOutputs` 对其无作用；这三个开关仅在 `window` 覆盖默认范围、范围段切换为消息转写时照常生效。

**`context_tokens`**

| 字段        | 类型   | 内容                                                                                                                                                                                                                                             |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tokens`    | number | 当前上下文用量（footer 同源）                                                                                                                                                                                                                    |
| `threshold` | number | 规则配置的触发间隔                                                                                                                                                                                                                               |
| `level`     | number | 本次跨越到的倍数水位（`floor(tokens / threshold)`）                                                                                                                                                                                              |
| `messages`  | array  | **增量消息**：自该规则上次触发以来的全部消息（首次触发为规则加载以来），元素 `{ role, tool?, text }`（`role` 为 user/assistant/toolResult；`tool` 仅 toolResult 元素携带；assistant 元素按消息文本序列化规则含 `[thinking: ...]`，截断规则同上） |

模板渲染引擎 SHALL 为 Handlebars，配置钉死：`noEscape: true`（文本不转义 HTML 实体，命令串中 `&&`、`<` 等保持原样）、缺失路径渲染为空字符串（非 strict 模式）并在该次审计的诊断详情中记录未解析路径（`@root`/`@index` 等 data 引用与 `this` 相对路径由 Handlebars 自身解析，MUST NOT 记为未解析变量）。原生 `{{#if}}` / `{{#unless}}` / `{{#each}}` / `{{#with}}` section 可用；内置 helper 限定最小集：`json`（对象 JSON 序列化）、`truncate`（`{{truncate 文本 N}}` 截断至 N 字符并附截断标注）、`now`（本地时间 `YYYY-MM-DD HH:mm`），不开放自定义 helper 注册。模板变量以事件数据对象为根（`{{tool}}`、`{{input.command}}`、`{{content}}`、`{{turnIndex}}`、`{{tokens}}`、event 触发器的 `{{name}}`/`{{event.<字段>}}`/`{{json event}}` 等）；整个 input 的 JSON 序列化 SHALL 使用 `{{json input}}`。渲染后的最终审计消息 SHALL 为两段式：渲染后 `prompt` + 固定分隔的审计范围段（`--- 审计范围 ---`），范围段总是附加、不经模板变量。`tool_call`/`tool_result`/`event` 的范围段内容为事件数据对象的 JSON 序列化；其余触发器的范围段为对话转写文本（role + 文本内容）。

#### Scenario: tool_call 事件字段引用命令内容

- **WHEN** `bash` 工具触发的规则 prompt 含 `{{input.command}}`
- **THEN** 渲染后的 prompt 中该占位符为实际命令字符串

#### Scenario: tool_result 事件字段引用结果与错误态

- **WHEN** `tool_result` 规则 prompt 含 `{{tool}}`、`{{content}}` 与 `{{isError}}`
- **THEN** 渲染后分别为工具名、结果文本与错误标志

#### Scenario: 未知变量渲染为空并记录

- **WHEN** prompt 含 `{{input.nonexistent}}`
- **THEN** 占位符渲染为空字符串，该次审计的诊断详情包含 `input.nonexistent` 未解析的记录

#### Scenario: event 载荷字段引用

- **WHEN** event 规则 prompt 含 `{{event.summary}}`，总线通道 emit 的载荷为 `{ "summary": "任务完成" }`
- **THEN** 渲染后的 prompt 中该占位符为 `任务完成`

#### Scenario: 总线非对象载荷包裹

- **WHEN** 总线通道 emit 的 `data` 为字符串 `"finished"`
- **THEN** 事件数据对象中 `event` 为 `{ "value": "finished" }`，`{{json event}}` 输出该包裹结构

#### Scenario: 载荷 JSON 安全投影与截断

- **WHEN** 核心事件对象含一个函数/类实例字段与一个超 8000 字符的字符串字段
- **THEN** 事件数据对象中前者为 `"[unserializable]"`，后者按截断规则标注截断，模板渲染与范围段 JSON 均不含不可序列化值

#### Scenario: event 默认范围为载荷 JSON 而 window 覆盖为转写

- **WHEN** event 规则未配置 `window` 时触发，随后同规则配置 `window: { messages: 5 }` 后再触发
- **THEN** 前者范围段为事件数据对象 JSON，后者范围段为最近 5 条消息的转写文本（include 开关此时生效）

### Requirement: 规则试运行（dry-run）

插件 SHALL 提供 `/sentinel:test <规则名> [模拟内容]`：以模拟事件对指定规则执行完整审计管线（模板渲染、范围窗口、旁路审计、结构化裁决），在命令输出中展示 verdict、message、模型与耗时。规则名不存在 SHALL 报错退出；`enabled: false` 或被会话禁用的规则 SHALL 仍可试运行（写规则即可验证，不必先启用）。模拟事件构造 SHALL 为：`tool_call`/`tool_result` 规则以模拟内容作为事件数据（模拟内容为合法 JSON 时解析为 `input` 对象，否则作为 `{ "text": 模拟内容 }`；`tool` 取 `trigger.tools` 中第一个不含通配符的元素，不存在时取 `"bash"`）；`event` 规则以模拟内容作为事件载荷（模拟内容为合法 JSON 时解析为对象，否则作为 `{ "text": 模拟内容 }`），`name` 为配置的事件名原文；其余触发器以模拟内容作为范围文本。试运行 MUST NOT 产生任何分流副作用：不阻塞或放行真实工具调用、不注入上下文、不读写裁决缓存、不进入冷却与负冷却；历史记录标注 `kind: "test"`。TUI 以外模式结果打印到命令输出。

#### Scenario: 试运行展示裁决

- **WHEN** 用户执行 `/sentinel:test bash-safety rm -rf /tmp/build`
- **THEN** 输出显示该次审计的 verdict、message、模型与耗时

#### Scenario: 试运行无分流副作用

- **WHEN** 对一条 blocking 规则试运行且裁决为 fail
- **THEN** 没有真实工具调用被阻塞，裁决缓存与冷却状态不变，主会话上下文无任何注入

#### Scenario: 试运行 event 规则

- **WHEN** 用户对 `trigger.event` 为 `"core:session_compact"` 的规则执行 `/sentinel:test <规则名> {"reason":"手动压缩"}`
- **THEN** 模拟事件数据为 `{ name: "core:session_compact", event: { reason: "手动压缩" } }`，输出显示 verdict、message、模型与耗时，不产生分流副作用
