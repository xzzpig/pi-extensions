# Design

## Context

pi-sentinel 的触发层现状：`TRIGGER_TYPES` 封闭枚举（5 种），每类触发器一条专用链路（`index.ts` 中 `handleToolCall` 等专用 handler → `event-data.ts` 中白名单构造的事件数据对象 → 统一的 `buildRequest` / `RuleRunner` 管线）。宿主 0.87.1 的 `ExtensionAPI.on()` 提供 39 种核心事件的类型化订阅（运行时按字符串名存入 Map 路由，未知名静默惰性，已核对 `runner.js` 的 handlers Map），`ExtensionAPI.events` 提供开放的字符串事件总线（`emit(channel, data: unknown)` / `on(channel, handler)`，注意总线 handler 签名仅有 `(data)`、不传 ctx）。动机构见 proposal。

既有背景默认值对本设计有利：background 规则的 `overlap` 默认即为 `ignore`（`runner.ts` 的 `overlapFor`），通用 event 规则（仅 background）天然获得重复触发合并，无需新增节流机制。

## Goals / Non-Goals

**Goals:**

- 一条通用 `event` 触发器覆盖全部核心事件与任意总线通道，复用既有审计/分流/缓存/fleet 管线
- 订阅随配置热加载增减（引用计数），订阅生命周期与配置绑定、与会话无关
- 载荷安全进入模板与范围段（JSON 安全投影 + 既有截断规则）

**Non-Goals:**

- 不做事件频率防护（无安全清单、无强制节流、无 `throttleMs`）——用户已决策"完全开放不设防"，仅 README 警告
- 不为 event 触发器提供 blocking 门控（宿主仅 `tool_call` 可门控）
- 不改动既有 5 种触发器的任何语义、字段表与场景
- 不建立核心事件 → 语义事件的映射层（pi-notify 式封闭目录），也不复用其协议

## Decisions

### D1：第 6 种触发器类型，而非开放 `trigger.type` 枚举

`TriggerType` 联合类型贯穿 `validateRule`、`buildScopeText`、`defaultWindowKind` 与 dry-run 的 switch。开放枚举会把所有分支劣化为 default 并使 5 种既有触发器失去封闭校验；新增 `"event"` 是纯增量，既有 spec/测试/配置零影响。

### D2：命名语法——裸名 = 总线通道（默认），`core:` 前缀 = 核心事件

- 裸名走 `pi.events.on(channel, handler)`：开放集合无法校验，拼错仅静默不触发（spec 场景已明确"不报错"）。
- `core:` 前缀走 `pi.on(name, handler)`：`pi.on` 的 TS 签名是逐事件 overload，无字符串重载，实现以受控 cast（`on as (name: string, handler: ...) => () => void`）订阅；运行时按字符串名路由已核实，安全。前缀后名字对 `KNOWN_CORE_EVENTS` 常量表校验（从 0.87.1 的 `ExtensionEvent` union 枚举），未知名在 `validateRule` 拒绝并列出全部合法名。
- 备选"单一命名空间 + 运行时试探"被否：拼错的核心事件名会静默落到总线上，错误不可诊断。保留前缀的代价（插件刻意用 `core:` 命名通道时无法订阅）在 spec 与 README 注明。

### D3：新模块 `event-subscriptions.ts` —— 按事件名引用计数的订阅注册表

`SentinelRuntime.rebuild()` 末尾对比生效规则集中 event 规则的事件名集合，交注册表 reconcile：

```
rebuild() ──> EventSubscriptionRegistry.reconcile(names)
                ├── 新名字：core: 前缀 ──> pi.on(name, (event, ctx) => dispatch(name, event, ctx))
                │           裸名 ──> pi.events.on(channel, (data) => dispatch(name, data))
                └── 归零名字：调用订阅时保存的退订函数
dispatch(name, payload, ctx?) ──> runtime.handleEventTrigger(name, payload, ctx)
```

- `ctx` 来源分两路：`core:` 前缀的宿主 handler 签名为 `(event, ctx)`（`ExtensionHandler` 的第二参），ctx 由宿主在事件到达时传入；裸名总线 handler 签名仅有 `(data)`、不传 ctx——dispatch 落到运行时后使用其已跟踪的当前会话 ctx（`rebuild()` 时刷新的 `this.ctx`；订阅仅在 rebuild 之后建立，正常情况非空，为 null 时跳过本次触发即可）。注册表自身不持有 `ExtensionContext`。
- 会话切换/树导航不触碰注册表（订阅是配置级接线）；`session_shutdown` 时整体退订并清空——必须在 `session_shutdown` 处理器中调用，MUST NOT 放进与会话切换/树导航共用 `resetRuntimeState` 的路径（否则会话切换会连带退订，违反"会话切换不退订"）；下次会话启动按配置重建。
- 备选"每条规则独立订阅"被否：同一事件的多条规则会重复注册，退订时机难对齐，且 dispatch 到多条规则的扇出本来就该在一处。
- 已知窗口：会话切换离开后、新会话 `session_start` 重建 ctx 前（`session_before_switch` 不触发 rebuild），`this.ctx` 仍指向旧会话——该窗口内到达的裸名事件以最后已知 ctx 触发。选定此语义（ctx 仅被只读用于构造审计范围；`session_before_switch` 已中止旧会话在跑审计与运行时状态），不为该瞬态窗口引入额外的守卫或跳过语义；备选"切换离开时置空 ctx、窗口内跳过"被否：会给 spec 增加一条可观察的跳过行为，收益不成比例。

### D4：事件数据与载荷投影（`event-data.ts`）

- `EventEventData = { name: string; event: JsonValue }`，加入 `SentinelEventData` union；模板根即该对象（`{{name}}`、`{{event.x}}`、`{{json event}}`）。
- 载荷投影 `toJsonSafe(value)`：null/boolean/number/string 原样；数组与纯对象（原型为 `Object.prototype` 或 null）递归；其余（函数、类实例如 `ModelSelectEvent.model` 的 `Model`）替换为字符串 `"[unserializable]"`。核心事件对象整体投影；总线 `data` 为纯对象直用（仍投影），其他值包 `{ value: <投影> }`。
- 投影后复用既有 `truncateEventData`（逐字符串 8000 字符截断）。
- 范围段：`buildScopeText` 的 `tool_call`/`tool_result` 分支放宽为 `triggerType === "tool_call" || "tool_result" || "event"`（载荷 JSON）；`defaultWindowKind` 加 `"event" → "event"` case。`window` 覆盖走既有转写切片，include 开关在该路径照常生效。

### D5：已知核心事件表 `KNOWN_CORE_EVENTS`

表驱动常量（39 个名字，与 0.87.1 `ExtensionAPI.on` 的逐事件 overload 一一对应），校验错误消息列出全表。维护成本：pi 升级新增事件需人工补表——peer range 锁 `>=0.87.1 <0.88.0`，升级时以 tasks 中的核对项兜底。不做"d.ts 自动提取"（构建期复杂度不匹配收益）。

### D6：dry-run 复用 `parseSimulatedInput`

event 规则的模拟载荷：合法 JSON 解析为对象，否则 `{ text: 模拟内容 }`；`name` 取配置原文。在 `runDryRun` 的 switch 加一个 case，构造后走既有 `startAudit` 管线。

## Risks / Trade-offs

- [热事件滥用：订阅 `core:message_update` 等逐 token 事件导致每 token 一次 LLM 审计] → 用户显式决策不设防；结构性兜底已有两道：overlap 默认 `ignore`（在跑时丢弃新触发）与全局 `maxConcurrent` 信号量；README 显著警告。
- [核心事件表滞后：pi 升级后新事件被 `core:` 校验拒绝] → peer range 锁定 minor 版本；升级核对项写入 tasks；错误消息列出合法名便于发现。
- [早期事件与订阅时序：`project_trust` 在插件加载期即已分发完毕，当次 `session_start` 与订阅建立（rebuild）同批，订阅这些事件名只会错过当次分发、表现为不触发（良性，等同"事件从未到达"）] → dispatch 全程 try/catch，异常按规则走既有 `onAuditFailure` 警告路径记入历史，不影响宿主会话；不为此做事件白名单，也不保证订阅建立前已分发的事件会被补发。
- [`pi.on` 的受控 cast 绕过类型安全] → cast 集中在注册表一处，`KNOWN_CORE_EVENTS` 表与宿主 `ExtensionEvent` union 一一对应并由测试对照（表内每个名字在宿主类型中存在）。
- [`core:` 保留前缀侵占总线命名空间] → 实际冲突风险极低，spec/README 注明即可。

## Migration Plan

纯增量，无数据/配置迁移：旧配置文件不含 `type: "event"` 规则，行为不变。回滚 = 移除新规则或回退插件版本。

## Open Questions

（无——载荷投影占位文案、校验错误措辞等均为实现细节，不阻塞任务拆分。）
