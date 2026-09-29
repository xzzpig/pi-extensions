# Proposal

## Why

pi-sentinel 目前只有 5 种策划触发器（tool_call / tool_result / turn_end / agent_end / context_tokens），每种的字段表与语义都在 spec 中逐条钉死；用户无法让哨兵响应这 5 类之外的事件（如上下文压缩、用户输入、模型切换、其他插件经事件总线发布的事件）。而 pi 宿主实际暴露 39 种核心扩展事件，另有开放的字符串事件总线（`pi.events`）供插件间通信——为每一种潜在触发点都写一套策划触发器的成本过高且不可扩展，需要一条"直接订阅某一事件"的通用通道。

## What Changes

- 新增第 6 种触发器类型 `event`：规则的 `trigger` 为 `{ type: "event", event: "<事件名>" }`。
- 事件命名语法：**裸名 = 插件事件总线通道**（经 `pi.events.on` 订阅，名字开放不校验）；**`core:` 前缀 = pi 核心事件**（经 `pi.on` 订阅，名字按宿主已知事件表做存在性校验，拼错加载期即拒绝并列出合法值）。`core:` 为 sentinel 保留前缀。
- 通用 event 规则仅支持 `background` 模式（宿主仅 `tool_call` 可门控，blocking 组合在校验期拒绝）；`trigger.tools` / `trigger.threshold` 对该类型非法。
- 热事件完全开放不设防：不设安全清单、不强制节流（逐 token 级核心事件如 `core:message_update` 允许订阅，逐次触发审计的代价由配置者自担，文档警告）；不加节流参数，需要合并爆发时由用户显式配置 `overlap: "ignore"`。
- 事件数据：模板根为 `{ name: "<配置的事件名原文>", event: <载荷> }`，载荷经 JSON 安全投影与逐字符串截断；默认审计范围段为载荷 JSON 序列化，`window` 覆盖语义不变。
- 订阅生命周期绑定配置而非会话：按事件名引用计数，随规则热加载建立/退订（最后一条同名规则移除后退订）；会话切换不退订。
- `/sentinel:test` 支持对 event 规则试运行（模拟载荷构造）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pi-sentinel`：
  - 「哨兵规则配置与加载」：规则字段表新增 `trigger.type: "event"` 与 `trigger.event` 字段及其校验规则；
  - 「触发器语义」：新增 event 触发器的订阅、分发与生命周期语义及场景；
  - 「事件数据与模板变量」：新增 event 触发器的事件数据字段表、载荷投影与截断规则；
  - 「规则试运行（dry-run）」：新增 event 规则的模拟事件构造规则。

## Impact

- **代码**：`packages/pi-sentinel/extensions/` —— `config.ts`（TRIGGER_TYPES、validateRule、触发器字段校验）、`event-data.ts`（新事件数据构造与载荷投影）、`index.ts`（通用订阅注册表、rebuild 接线、dry-run 分支）、`fleet-view.ts`/`commands.ts`（触发器展示文案）、`configure-dialog.ts`（配置对话的规则字段速查表）；新增订阅注册表模块；测试补齐。
- **spec**：`openspec/specs/pi-sentinel` 四条需求整块替换（既有场景全部保留）。
- **依赖**：无新第三方依赖；仅使用宿主 `ExtensionAPI.on` / `ExtensionAPI.events` 既有 API（0.87.1 已具备）。
- **兼容性**：纯增量，既有 5 种触发器与既有配置文件不受影响；`core:` 成为 sentinel 保留前缀（插件若刻意以 `core:` 命名总线通道将无法被 sentinel 订阅，实际冲突风险极低）。
