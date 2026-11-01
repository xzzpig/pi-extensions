# 技术设计

## Context

动机与范围见 `proposal.md`。本变更扩展已有 `pill-rendering`，不改变四项既有颜色契约。

已核对的接口与事实：

- `footer.ts` 从 `footerData.getExtensionStatuses()` 获取文本，`collectPillInputs()` 保留 status 原 key；`mcp` 可直接命中现有外部 action 表。
- `pill-api.ts` 暴露注册、查询与身份校验式 disposer；`pillActionFor()` 对非内置 key 查询该表。`/starline <key>` 也走同一动作。
- adapter 7.0.0 的 `utils.ts` 已支持 `settings.mcpFooterStatus = "compact"`，其正常输出为 `MCP connected/enabled`；用户报告已完成外部配置。
- adapter 的 `index.ts` 自己通过 `pi.sendUserMessage("/mcp-adapter", { expandPromptTemplates: true })` 实现面板快捷键，命令负责初始化、打开面板、保存后的工具同步和 reload。
- 当前 Pi 的 `getCommands()` 提供带 `source` 的命令元数据，不提供 handler；命令扩展分发先于流式排队与模型请求。必须确认 `source === "extension"`，不能只匹配名称。
- `ExtensionAPI.sendUserMessage()` 返回 `void`，不是面板关闭后 resolve 的 Promise。不能通过 `await pi.sendUserMessage()` 或其返回值可靠追踪面板生命期。
- Starline 已有共享鼠标 API 访问器和结构能力探测，可选取得实时 renderer 的 `hasOverlay()`；该能力不可作为新的强制依赖。

## Goals / Non-Goals

**Goals：**

- 内置一项轻量、可卸载的 MCP 默认 action，保留现有 status 显示、几何及注册协议。
- 在公开命令入口完成原面板操作，不接触 adapter 的 manager、配置、认证状态或面板实现。
- 以明确的短时去重和可选浮层探测防止常见重复触发，不建立虚假的面板完成状态机。

**Non-Goals：**

- 不修改 Nix 配置、用户配置、adapter 源码、版本号或依赖锁文件。
- 不把 `MCP 0/1` 改为 `🔌 1`，不使用 `formats.value` 截取首个数字，也不订阅 MCP 状态快照另算计数。
- 不提供 Starline 气泡替代原 MCP 面板，不实现再次点击同 pill 关闭外部面板。
- 不改变原面板本身在 SDK/programmatic 配置、无服务器等情况下的原有分支行为。

## Decisions

### 1. fork 专属模块加最小入口接缝

新增 `extensions/starline/fork-mcp-pill.ts`，由 Starline 入口加载适配器，模块内部注册自己的 `session_start` / `session_shutdown` 处理并管理 disposer。入口原则上仅保留 import 与一次安装调用；独立模块不修改现有 `PILL_ACTIONS` 内置表，不改 footer 的鼠标协议。

复用 `registerExternalPillAction("mcp", action)`；默认动作安装前检查 `externalPillAction("mcp")`。若已有拥有者则跳过，若后来被替换则利用现有 disposer 的身份检查避免误删新动作。不同扩展加载顺序下也不强制夺回 key。

备选：单独安装桥接扩展会增加用户部署项；扩充内置 segment 会把第三方状态误变成 Starline 自建状态。均不采用。

### 2. 源插件负责简短显示

Starline 不增加 MCP 文本转换。以用户已设置 compact 且保留默认全文显示为正常验收前提，继续允许用户自行配置 `extensionStatuses` 和 `pill.segments`。错误、连接中和任务文案不经过 MCP 专属裁剪。

备选：正则解析 `server enabled` 会依赖文案、丢失连接分母和特殊提示；状态事件另建计数会引入重复数据源和初始化顺序问题。均不采用。

### 3. 每次检查再分发明确的扩展命令

会话启动后，仅交互式 TUI 且 `getCommands()` 存在来源为扩展的 `mcp-adapter` 时安装默认 action。动作以本次传入的上下文判定 UI 与模式，并再次查询命令。查询失败或不可用时不发送文本；需要时仅通过通知提示不可用。

使用完整 `/mcp-adapter` 和 `{ expandPromptTemplates: true }`，不用编辑器注入，不触发工具调用，不动态 import adapter。命令存在检查与同步发送之间不插入异步等待，减少检查与使用之间的竞态。异步失败由 Pi 原有扩展错误通道报告；同步异常由适配器防御处理。

仅支持已验证具备此命令分发语义的 Pi 宿主；测试不能以普通消息调用成功冒充命令成功。

### 4. 有界去重而非伪造面板 Promise

沿用 footer 已有的 press / 合成 click 去重。适配器另外记录上次发送时间，使用单调时钟合并不足 300 毫秒的再次触发，鼠标和 `/starline mcp` 共用该状态；不启用轮询定时器。

通过既有共享鼠标 API 的实时 receiver 可选探测 `hasOverlay()`。动作先通过命令与模式检查，再判断冷却，然后关闭活动 Starline 气泡，**关闭之后再探测**是否仍有可见浮层；存在则不发送。顺序如此是因为 Pi 的覆盖层关闭是同步的：`showExtensionCustom` 的 `close()` 在 resolve 之前就调用 `overlayHandle.hide()`，所以关闭之后探到的浮层必然不是 Starline 自己的。访问器缺失或探测抛错时降级为仅短时去重，不影响基本命令入口，不增加依赖。

这里不承诺识别任意长时间的面板初始化中状态：300 毫秒后尚未出现任何可检测浮层时，新的显式触发允许再次分发。这是公开 `void` 命令入口的边界，不以永久锁、猜测式“面板关闭回调”或无限等待掩盖它。若未来 adapter 提供可等待的面板 API，再单独评估更强的生命期锁。

备选：直接导入 `openMcpPanel()` 既需要私有 state，又绕开命令的 reload 上下文；等待 `sendUserMessage()` 返回会立刻解锁；固定长时间禁用会损害再次打开体验。均不采用。

### 5. 清理与旧状态隔离

每个会话开始前释放自己的旧注册并重置时间状态，结束时幂等清理，不排队延迟发送命令。动作携带安装代际或失效标记，清理后即使旧回调仍被调用也不再发送。新会话不复用旧 `ctx`、renderer 或冷却状态。

### 6. fork 验证与维护

测试放在拟新增 `test/fork-mcp-pill.test.ts`，必要的渲染与鼠标整合断言也放在 fork 专属文件，不重写上游测试。覆盖命令元数据检查、无 adapter、模式、去重、气泡切换、可选能力缺失、注册所有权及会话失效。

文档放在 fork 专属说明或 `FORK-CHANGELOG.md`，说明 compact 前提、命令入口和有界去重限制。实施时运行 fork inventory，并为实际修改的上游入口接缝维护 `subtrees/pi-starline.json` 的 `reapplyOnSync` 与接受的分歧；不为纯 fork 新文件添加虚构维护债务。

## Risks / Trade-offs

- [未知斜杠命令可能退化成模型提示] → 注册与每次发送前双重检查命令名称和扩展来源；真实运行验证没有新增用户提示、模型请求或消息排队。
- [可选浮层 API 与宿主版本变化] → 防御式结构探测，不引入强制鼠标依赖；缺失时只保留 300 毫秒去重，并明确测试降级边界。
- [关闭失败时把外部浮层误放行] → 关闭在探测之前执行，且 `bubbleOpen` 探测失败按“无气泡”处理；气泡未真正关闭时探测仍会看到覆盖层并拒绝发送，宁可少开一次也不叠加。
- [初始化慢于去重窗口] → 不宣称全生命期单飞；录制快速点击与已打开面板的实测，保留将来扩展正式面板 API 的空间。
- [其他扩展也注册 mcp action] → 仅在无拥有者时提供默认值，尊重后续替换，旧清理不误删新注册。
- [原面板有保存和 reload 副作用] → 全部交给原命令执行，不直接调用内部面板函数；实测关闭、保存与 reload 后重新打开。
- [上游同步冲突] → fork-only 逻辑、测试和文档，入口最小接缝及分歧审计。

## Migration Plan

1. 实施和验证只修改本仓库中的 pi-starline 与必要维护元数据；用户已完成的 compact 设置作为验收前提，不再改写。
2. 通过包级测试、类型检查、fork 审计后，在隔离真实 Pi TUI 中加载本地 Starline、共享鼠标层与 adapter，录制点击路径。
3. 不在此变更自动发布、提交或安装替换用户环境；发布另行授权。
4. 回滚时移除 fork 适配器及入口接缝，`mcp` 状态仍由原有通用路径显示；无需回滚 MCP 服务器或认证配置。
