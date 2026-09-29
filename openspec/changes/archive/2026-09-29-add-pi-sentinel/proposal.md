# Proposal

## Why

pi 主循环目前缺少语义级的旁路审计能力。现有门控手段是确定性的（`pi-permission-system` 按路径/命令规则静态放行），无法回答"这条命令是否明智""这次编辑是否符合项目要求"这类需要理解的判断；`pi-observational-memory` 验证了旁路 LLM 循环在 pi 上的可行性，但它的裁决逻辑绑定在记忆域，无法复用。需要一个通用的、可配置的"自然语言哨兵"引擎：用声明式规则描述何时触发、检查什么，由独立 LLM 循环执行审计，并按需阻塞工具执行或将发现注入上下文。

## What Changes

- 新增原创插件包 `packages/pi-sentinel`（npm `@xzzpig/pi-sentinel`），不涉及任何 subtree/二开。
- **声明式哨兵规则**：每条规则声明触发器、执行模式、自然语言检查指令（模板变量引用事件数据）、可选独立模型、可选只读调查工具、审计范围窗口、重复触发策略、失败策略与裁决缓存。
- **五种触发器**：`tool_call`（工具执行前，可按 `trigger.tools` 数组过滤，含内置与扩展/MCP 工具名）、`tool_result`（工具结果产生后）、`turn_end` / `agent_end`（轮次边界）、`context_tokens`（上下文用量每跨越配置间隔的整数倍触发，审两次触发间的增量）。
- **两种执行模式**：`blocking`（在 `tool_call` 上返回 block + reason，门控工具执行）与 `background`（异步审计，仅将 warn/fail 发现注入上下文，pass 静默，同类发现冷却去重）。
- **结构化裁决协议**：旁路 LLM 必须通过 `audit_verdict` 工具调用表达结论（pass / warn / fail + message），不解析自由文本。
- **模型解析链**：规则 `model` > 全局默认审计模型 > 会话当前模型；模型与鉴权解析复用 pi 的 modelRegistry。
- **审计员能力**：默认无工具纯文本审计；规则可开只读工具（read/grep）允许自主调查。
- **失败策略**：旁路 LLM 超时/报错默认 fail-open（放行并 UI 提示），规则可配 fail-closed（拦截）。
- **裁决缓存**：相同触发内容（渲染后 prompt + 范围文本哈希）在 TTL 内复用上次裁决，默认开启、规则可关。
- **重复触发策略**：规则可配 `overlap`（parallel / serial / ignore / replace），控制同一哨兵已有审计在跑时新触发如何处理。
- **可观测性**：`/sentinel:list` 列出全部已加载哨兵及实时状态，并在其中内联管理（启用/禁用/移除）；`/sentinel:fleet` 交互式实时检查器（选中哨兵查看运行详情、对执行中审计 steer 追加消息）；UI 状态条同步展示运行中哨兵数量。
- **配置三作用域**：全局 `~/.pi/agent/sentinel.json` + 项目 `.pi/sentinel.json` 合并（项目优先），沿用 `pi-context-cap` 的加载惯例；另支持**会话级**动态配置——在会话中添加/禁用/删除哨兵，随会话文件持久化，重启后恢复会话仍生效。配置错误警告跳过而非中断会话。
- **会话级动态管理**：经 `/sentinel:list` 内联对哨兵执行启用/禁用/移除，即时生效并随会话持久化；`disable` 可屏蔽继承的全局/项目规则，fork 继承会话级配置。
- **自然语言配置生成**：`/sentinel:configure` 在**后台**运行独立的多轮配置对话（旁路 LLM，不占用、不污染主会话，进展可随时在 fleet 检查器查看）；草稿提交时用户可选**写入**（预览 + 作用域选择）、**继续调整（附进一步要求）**或放弃，写入即热生效。

## Capabilities

### New Capabilities

- `pi-sentinel`: 旁路 LLM 哨兵审计——声明式规则引擎、五种触发器、blocking/background 两种执行模式、结构化裁决协议、重复触发策略、裁决缓存、失败策略、会话级动态配置、自然语言配置生成与可观测性命令与 UI 状态。

### Modified Capabilities

（无 —— 本变更不修改任何既有能力的规格要求。）

## Impact

- 新增包 `packages/pi-sentinel`：extension 代码、规则配置校验器、单测、README；遵循 monorepo 惯例（peerDependencies 引 pi 核心包，`pi.extensions` 指向 `./extensions`）。
- 运行时依赖 pi 扩展 API：`tool_call`/`tool_result`/`turn_end`/`agent_end` 事件、`agentLoop`（`@earendil-works/pi-agent-core`）旁路循环、`sendMessage` 上下文注入、`getContextUsage`、`registerCommand`/`ui.setStatus`/`ui.setWidget` 可观测性接口。
- 对既有包零改动；不发布、不动锁文件以外的根配置。
- 风险：blocking 模式为每次匹配的工具调用增加一次 LLM 往返延迟（以快模型 + 短 prompt + 裁决缓存缓解）；background 注入以"仅 warn/fail + 冷却"控制上下文污染。
