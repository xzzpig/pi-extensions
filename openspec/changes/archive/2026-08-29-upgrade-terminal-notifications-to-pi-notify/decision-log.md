# Pi Notify 需求对齐决策日志

> Change: `upgrade-terminal-notifications-to-pi-notify`
>
> 状态：需求访谈已完成。本文与 proposal/design/specs/tasks 已同步；后续若修改产品决策，应先更新本文并重新校验 OpenSpec。

## 1. 包身份与迁移

- 新目录：`packages/pi-notify`。
- 新 npm 包名：`@xzzpig/pi-notify`。
- 新包首次版本：`0.1.0`。
- 旧包 `@xzzpig/pi-terminal-notifications@0.1.1` 不保留兼容实现，也不读取旧配置路径。
- 新包发布后，将旧 npm 包标记 deprecated，并在提示中指向 `@xzzpig/pi-notify`。
- 不自动发布、commit 或 push；发布操作需要另行明确授权。

## 2. 配置文件与作用域

- 全局配置：Pi agent 目录下 `extensions/pi-notify/config.json`。
- 项目配置：`<cwd>/.pi/pi-notify.json`。
- 项目配置仅在 `ctx.isProjectTrusted()` 为真时读取。
- 项目配置可覆盖全部配置，包括远程服务、topic、token 和事件策略。
- 配置只在 `session_start`（startup/reload/new/resume/fork）重新读取；修改后使用 Pi `/reload`，不使用 watcher，不提供专用 reload 命令。
- 不自动创建全局或项目配置文件。
- 配置顶层 `version` 可选，省略视为 `1`；未知版本整份不应用并告警。
- JSON Schema 使用 `additionalProperties: false`；运行时忽略未知字段、显示警告，并继续应用已知字段。
- 无效配置按字段/渠道实例隔离；无效实例禁用，有效实例继续工作。

## 3. 配置结构与合并

- `channels` 使用渠道实例数组，支持同一渠道类型配置多个实例。
- 每个实例包含通用字段 `id`、`type`、`enabled`、`events`，渠道专属字段按 type 嵌套，例如 `osc: {...}`、`ntfy: {...}`。
- 渠道 `id` 必填且在单份配置中唯一；重复 ID 的冲突实例禁用并告警。
- 显式渠道实例省略 `enabled` 时视为 `true`。
- 渠道省略 `events` 时使用默认事件集合；显式 `events: []` 表示不订阅任何事件。
- `events` 只接受明确事件 ID，不支持 `*`、include/exclude 或模式匹配。
- 全局与项目配置递归合并；渠道数组按 `id` 合并：同 ID 项目实例覆盖全局实例，新 ID 追加。
- 普通对象递归合并，事件等普通数组整体替换。
- 项目配置允许同 ID 实例改变 `type`；type 改变时 MUST 丢弃继承的旧 type 专属对象，只保留 id/enabled/events 等通用字段，再合并项目提供的新 type 专属对象并做完整校验。
- 项目只能用同 ID `enabled: false` 禁用全局渠道，不提供 `$remove` 或整表替换语法。
- 内置 `{id: "terminal", type: "osc"}` 是固定合并基础实例；关闭它必须同 ID 配置 `enabled: false`。
- 顶层 `enabled` 只控制通知路由；Herdr 使用独立 `herdr.enabled`。
- `herdr.enabled` 默认 `true`。

## 4. 环境变量插值

- 使用主流库 `dotenv-expand@13.0.0`，必须精确锁版。
- 禁止升级到 npm latest/v1000：该版本加入 `$(...)` 命令替换，会把用户配置变成 shell 执行入口。
- 使用薄适配器遍历合并后配置中的字符串叶子；只引用真实 `process.env`，不允许配置字段互相引用，也不提供 `variables` 段。
- 采用 `dotenv-expand@13.0.0` 默认语义：支持 `$VAR`、`${VAR}`、`${VAR:-default}`、递归展开和 `\$` 转义。
- 缺失环境变量展开为空字符串；之后由字段自身的必填/可选校验决定实例是否有效。
- 适配器使用隔离环境对象，不污染 `process.env`，并避开 `__proto__`、`constructor` 等危险键。
- 先前讨论的 `$$` 转义已被库默认的 `\$` 规则覆盖。
- 子代理研究报告：`.pi-subagents/artifacts/outputs/a93b42fd/research.md`。

## 5. 预定义语义事件

### 5.1 首版支持事件

- `agent-completed`
- `agent-error`
- `input-required`
- `permission-required`
- `context-compacted`
- `task-completed`
- `integration-error`

### 5.2 默认订阅事件

省略渠道 `events` 时默认订阅以下六项：

- `agent-completed`
- `agent-error`
- `input-required`
- `permission-required`
- `task-completed`
- `integration-error`

`context-compacted` 支持但默认关闭。

### 5.3 明确不支持/不通知

- 不支持 `tool-failed`；Pi 自行处理可恢复工具错误，最终无法恢复时用 `agent-error`。
- 不支持 `agent-started`、`agent-cancelled`、`session-started`、`session-ended`、`session-renamed`、`model-changed`、`thinking-level-changed`、`project-trust-required`。
- 用户主动 `aborted` 时只清理状态，不产生事件。
- `pi-ask` 完成和 permission 完成只清理等待状态，不产生 resolved 事件。
- provider 中间 HTTP 429/5xx/自动重试不产生事件；只看最终 agent 结果。
- 高频/内部事件（如 message/tool update、context、provider payload hooks）不进入通知语义层。

### 5.4 Agent 结果判定

- 一次用户可见运行从首次 `agent_start` 开始，到 `agent_settled` 结束。
- 自动重试、自动压缩和 continuation 中间不通知最终结果。
- 最终 stop reason 为 `error` 或 `length` -> `agent-error`。
- 最终正常停止 -> `agent-completed`。
- 无法识别 stop reason，但观察到 active run 并最终 settled -> `agent-completed`。
- `aborted` -> 静默清理。
- 不支持最短运行时长过滤；所有完成事件只由渠道 `events` 决定。
- `agent-completed` 与 `task-completed` 是两个独立事件：前者只表示 Pi 主代理完成，后者表示插件工作流/子任务完成。

## 6. 内置跨插件适配器

- 内置 `pi-ask`：开始等待 -> `input-required`；完成只清理状态。
- 内置 permission-system：UI 等待 -> `permission-required`；直接/转发 decision 只清理状态。
- 内置 pi-subagents：
  - async/foreground 成功 -> `task-completed`
  - failed/timeout -> `integration-error`
  - cancelled/stopped -> 静默
- 其它插件使用公开发布协议。

## 7. 外部发布协议与公共 API

- 共享事件 channel：`pi-notify:publish`，首版不带 `:v1` 后缀，payload 不含 version。
- payload 字段：已知 `eventId`、非空 `source`、可选安全 `label`。
- 不接受自定义 title/body 或任意 metadata。
- `label` 可用于所有事件的固定文案。
- 内部 label 不设长度上限，但渠道投递时按各自上限安全截断。
- `pi-notify` 不做外部发布去重；发布插件负责避免重复 emit，因此无 `dedupeKey`。
- 公共 helper 对非法 payload 抛 `TypeError`；直接手工 emit 的非法 payload 由接收端忽略并显示本地警告，不让异常传播。
- 包导出 `@xzzpig/pi-notify/api`，包含 publish channel 常量、事件 ID 常量、TypeScript payload 类型、运行时校验辅助和 `publishNotification({ events, eventId, source, label })`。
- 首版不开放第三方渠道 sender 注册；渠道接口仅为包内部扩展点。

## 8. 固定通知文案与隐私

- 不开放标题或正文模板配置；使用固定内置文案。
- 固定文案语言：英文。
- 标题采用行动导向式事件标题，例如 `Pi needs your input`、`Pi needs permission`、`Pi encountered an error`。
- 标题以事件为主体；项目和会话上下文放正文。
- 正文只包含：
  - 工作目录最后一级名称（不含完整路径）
  - Pi session display name（不存在时省略；不含 session 文件路径）
  - 外部/插件事件的净化 label（若提供）
- 不显示模型名、event source、运行耗时、原始提示、原始问题、权限 surface/value/message、命令、路径或工具参数。
- `input-required` 与 `permission-required` 使用完全通用文案。
- ntfy 正文使用多行排版；OSC 正文使用单行 `·` 分隔。
- ntfy 最终正文最多 4000 UTF-8 字节，按完整 Unicode 字符截断并加省略号。
- OSC 最终正文最多 512 个 Unicode 字符，超出截断并加省略号。

## 9. OSC 渠道

- 渠道类型：`type: "osc"`；专属配置放在 `osc: {...}`。
- 内置默认实例 ID：`terminal`，默认启用。
- 只在 `ctx.mode === "tui"` 发送；RPC/JSON/print 跳过。
- 只支持自动协议选择，不提供强制 `protocol` 覆盖。
- 自动检测顺序：
  1. `KITTY_WINDOW_ID` 存在 -> OSC 99
  2. `TERM_PROGRAM` 用户/内置映射
  3. fallback
- 不对 `WT_SESSION` 做特殊处理。
- 用户 `termPrograms` 扩展并覆盖内置映射，未覆盖内置项继续保留。
- fallback 默认 OSC 9。
- 支持 OSC 9、OSC 99、OSC 777。
- 内置映射（按官方资料修订）：
  - `ghostty` -> `osc777`
  - `iTerm.app` -> `osc9`
  - `WezTerm` -> `osc777`
  - `WarpTerminal` -> `osc777`
  - `vscode` -> `osc99`（依赖 VS Code 对应设置/版本）
- Kitty 不依赖 `TERM_PROGRAM`，由 `KITTY_WINDOW_ID` 优先检测为 OSC 99。
- 每次通知使用唯一 identifier，不替换通知中心中的历史通知。
- 继续净化控制字符、OSC 分隔符和多余空白。
- 子代理官方协议核验 run：`c28515dc-e75f-42c0-bbe2-b296ce725770`。

## 10. ntfy 渠道

### 10.1 基本连接与认证

- 渠道类型：`type: "ntfy"`；专属配置放在 `ntfy: {...}`。
- `serverUrl` 省略时默认 `https://ntfy.sh`。
- 允许 HTTP 和 HTTPS；HTTP + Bearer token 时显示本地安全 warning。
- topic 必填，严格匹配 `[-_A-Za-z0-9]`，最长 64 字符，不允许路径分隔符。
- 只支持 Bearer token，不支持 Basic auth。
- topic 和 token 均可直接写字符串或通过 `dotenv-expand` 统一环境变量插值。
- ntfy 在 TUI、RPC、JSON、print 全部模式可发送。

### 10.2 优先级

- 配置只接受数字优先级 `1` 到 `5`，不接受名称。
- 渠道实例默认优先级：`3`。
- 内置事件默认优先级：
  - `agent-error`、`integration-error` -> `5`
  - `input-required`、`permission-required` -> `4`
  - `agent-completed`、`task-completed` -> `3`
  - `context-compacted` -> `2`
- 渠道实例省略显式 priority 时使用内置事件等级；用户显式实例 priority 覆盖内置等级；`eventOptions[event].priority` 最高。
- 事件级 priority/icon 使用统一 `eventOptions` 对象；未订阅事件也可预配置。

### 10.3 Icon

- 首版支持 Icon URL，不支持 tags、click、actions、email 或 Markdown。
- 随包发布 512x512、不透明白底黑色 Pi badge PNG。
- 默认 Icon URL 指向 jsDelivr 上包含当前包版本的该 PNG。
- 每个 ntfy 实例可覆盖默认 icon，并可用事件级 icon map 覆盖。
- 省略 icon -> 使用默认 Pi PNG；字符串 -> 使用自定义 URL；`null` -> 显式禁用。
- 自定义 Icon 只接受 HTTP/HTTPS URL；ntfy 客户端只保证 JPEG/PNG。
- 子代理 ntfy 官方契约研究 run：`32ba69e0-8074-4556-b714-5aaeaf1d6c2e`。

### 10.4 投递

- 事件级配置使用统一 `eventOptions` 对象，例如 `eventOptions.agent-error: { priority: 5, icon: null }`。
- 使用 Node 内置 `fetch`，HTTP POST 纯文本正文，设置 Title、Priority、可选 Icon、可选 Bearer Authorization。
- 完全 fire-and-forget；事件 handler 不等待请求完成。
- 默认请求超时 5 秒；实例可覆盖但必须是正的有限整数，不设产品上限。
- 网络失败、非 2xx 或超时不重试。
- 渠道失败不产生 `integration-error`，避免通知循环。

## 11. 渠道健康与本地反馈

- TUI/RPC：渠道或配置失败通过 `ctx.ui.notify(..., "warning")` 显示，同时写 console。
- JSON/print：只写 console。
- 每个渠道实例维护健康状态：
  - 首次失败显示一次 warning
  - 持续失败不重复刷屏
  - 失败后首次成功显示一次恢复提示
- 所有诊断必须净化，不输出 token、Authorization header、完整 topic、原始响应正文或敏感配置值。
- 渠道故障互相隔离，任何渠道失败不得影响 Pi、问答、权限或其它渠道。

## 12. Herdr

- 公开事件名和 payload 保持 `herdr:blocked` 约定不变，只重构内部实现。
- `herdr.enabled` 与通知顶层 `enabled` 独立，默认 true。
- 首个活动问答/权限等待项出现时发布 blocked；只有全部活动项解决后解除。
- 直接与转发权限请求继续按现有 requestId/decision 规则关联。
- session shutdown 清理所有等待状态并解除 blocked。

## 13. 用户命令

- 首版不提供 `/notify-test`、`/notify-status`、`/notify-reload` 或配置初始化命令。
- 配置修改统一通过 Pi `/reload` 生效。

## 14. 最近确认的补充

- ntfy `timeoutMs` 不设产品上限，但实现必须是正的有限整数；默认 5000ms，拒绝 0、负数、NaN、Infinity。
- 默认 Pi icon 始终使用按 package version 生成的 jsDelivr URL；本地未发布版本图标不可用时仍发送正文，不回退其它 URL。
- 公共 API 提供完整发布辅助函数，采用单对象参数和最小事件总线：
  - `publishNotification({ events, eventId, source, label })`
  - `events` 至少提供 `emit(channel, data)`。
- 发布 API 只导出一个未版本化的 `pi-notify:publish` channel；未来 breaking 协议再通过新 channel 名演进。
- Icon 只接受 HTTP/HTTPS；ntfy 客户端只保证 JPEG/PNG。
- ntfy 正文最多 4000 UTF-8 字节；OSC 正文最多 512 Unicode 字符。
- 环境变量插值已精确锁定 `dotenv-expand@13.0.0`，仅引用真实 process.env。

## 15. 最终配置、API 与验收边界

- 完整配置结构采用已确认的 channel instance array、type 嵌套配置和 `eventOptions`；示例已写入 `design.md`。
- `$schema` 指向 GitHub main：`https://raw.githubusercontent.com/xzzpig/pi-extensions/main/packages/pi-notify/config/config.schema.json`。
- 项目 channels 允许只带 `id` 的 partial overlay；新 ID 必须完整。
- 固定标题精确值：
  - `agent-completed` -> `Pi finished the task`
  - `agent-error` -> `Pi encountered an error`
  - `input-required` -> `Pi needs your input`
  - `permission-required` -> `Pi needs permission`
  - `context-compacted` -> `Pi compacted the context`
  - `task-completed` -> `Pi completed a task`
  - `integration-error` -> `Pi encountered an integration error`
- 正文顺序：Label -> Project -> Session；OSC 9 将 title 前置到正文。
- `@xzzpig/pi-notify/api` 完整导出：channel 常量、事件常量/类型、payload 类型、type guard、assert 函数和 `publishNotification`。
- 自动测试全部 mock fetch；另提供默认 skip、只有显式环境变量齐备才运行的真实 ntfy smoke test。
- `/opsx-apply` 实现止于代码、测试、文档、lockfile 和本地 pack，不执行 npm publish/deprecate、git commit 或 push。
- 当前无未决产品问题；剩余均为实现与验证工作。
