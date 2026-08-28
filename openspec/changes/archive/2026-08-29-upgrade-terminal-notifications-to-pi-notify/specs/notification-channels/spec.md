## ADDED Requirements

### Requirement: 新包身份与发布内容

系统 SHALL 以目录 `packages/pi-notify`、npm 包名 `@xzzpig/pi-notify` 和初始版本 `0.1.0` 提供扩展。包内容 SHALL 包含扩展、`api.ts`、配置 Schema/example、README 和 512x512 Pi PNG，并 MUST NOT 自动读取旧包配置路径。

#### Scenario: 安装新包

- **WHEN** 用户安装 `@xzzpig/pi-notify`
- **THEN** Pi 从新 manifest 加载扩展，消费者可从 `@xzzpig/pi-notify/api` 导入公共 API

#### Scenario: 仅存在旧配置

- **WHEN** 新包运行但只有 `extensions/pi-terminal-notifications/config.json` 存在
- **THEN** 系统忽略旧配置并使用 pi-notify 默认配置

### Requirement: 分层配置路径与信任边界

系统 SHALL 从 Pi agent 目录下的 `extensions/pi-notify/config.json` 读取全局配置，并 SHALL 仅在 `ctx.isProjectTrusted()` 为真时从项目 `CONFIG_DIR_NAME/pi-notify.json`（默认 `.pi/pi-notify.json`）读取项目配置。配置 SHALL 在 `session_start` 重新加载，系统 MUST NOT 监听或自动创建配置文件。

#### Scenario: 受信任项目覆盖

- **WHEN** 当前项目受信任且存在 `.pi/pi-notify.json`
- **THEN** 系统将项目配置作为全局配置之上的 partial overlay

#### Scenario: 未信任项目存在配置

- **WHEN** 当前项目未受信任但存在 `.pi/pi-notify.json`
- **THEN** 系统完全忽略项目配置且不从中解析远程目标或凭据

#### Scenario: Pi reload

- **WHEN** 用户修改配置后执行 Pi `/reload`
- **THEN** 新扩展实例在 `session_start` 重新解析全局与项目配置

### Requirement: 具名渠道实例与合并

系统 SHALL 使用包含 `id`、`type`、`enabled`、`events` 及 type 专属对象的渠道实例数组。内置 `{id:"terminal",type:"osc"}` SHALL 作为固定基础实例；全局与项目 channels SHALL 按唯一 ID 深度合并，新 ID SHALL 追加，同 ID 项目 overlay MAY 改变 type。普通对象 SHALL 递归合并，普通数组 SHALL 整体替换。

#### Scenario: 项目部分覆盖渠道

- **WHEN** 全局存在完整 `phone` ntfy 实例且项目只提供 `{id:"phone",ntfy:{topic:"..."}}`
- **THEN** 系统只覆盖 topic 并继承该实例其它字段

#### Scenario: 项目改变渠道类型

- **WHEN** 项目用同 ID 将继承的 ntfy 实例改为 osc，并提供有效 osc 专属配置
- **THEN** 系统丢弃继承的 ntfy 专属对象，只保留通用字段、合并 osc 对象并按 osc 完整校验

#### Scenario: 项目增加新实例

- **WHEN** 项目配置提供一个全局不存在的新渠道 ID
- **THEN** 该项目条目必须满足完整实例 Schema 后才能加入合并结果

#### Scenario: 项目禁用继承渠道

- **WHEN** 项目配置用同 ID 设置 `enabled:false`
- **THEN** 系统保留实例配置但不向该实例投递，且不要求删除标记

#### Scenario: 重复渠道 ID

- **WHEN** 同一配置文件包含重复渠道 ID
- **THEN** 系统隔离冲突条目、显示本地 warning 且不静默覆盖另一条目

### Requirement: 渠道默认开关与事件列表

显式渠道实例省略 `enabled` 时系统 SHALL 视为 true。实例省略 `events` 时系统 SHALL 使用默认六事件；显式空数组 SHALL 表示不订阅任何事件。事件选择 MUST 只接受明确预定义 ID，不支持 wildcard 或 include/exclude 表达式。

#### Scenario: 省略 events

- **WHEN** 已启用渠道实例没有 events 字段
- **THEN** 系统使用 `agent-completed`、`agent-error`、`input-required`、`permission-required`、`task-completed` 和 `integration-error`

#### Scenario: 空事件数组

- **WHEN** 渠道实例配置 `events:[]`
- **THEN** 系统保留实例但不向其投递任何通知

### Requirement: 配置版本、Schema 与运行时容错

配置 SHALL 接受可选 `version`，省略时视为 1；未知版本 MUST 整份不应用。发布的 JSON Schema SHALL 拒绝未知字段、未知渠道类型、未知事件 ID、非法协议和非法优先级。运行时 SHALL 忽略未知字段并 warning，且 SHALL 按渠道实例隔离其它校验错误。

#### Scenario: 未知配置版本

- **WHEN** 配置声明不受支持的 version
- **THEN** 系统不应用该文件并使用较低层配置结果

#### Scenario: 单个 ntfy 实例无效

- **WHEN** 一个 ntfy 实例 topic 或 priority 无效而 OSC/其它实例有效
- **THEN** 系统仅禁用无效 ntfy 实例并继续使用其它实例

#### Scenario: 配置文件语法错误

- **WHEN** 全局或项目 JSON 无法解析
- **THEN** 系统忽略该层、显示一次净化 warning 并继续使用较低层结果

### Requirement: 环境变量展开

系统 MUST 精确使用 `dotenv-expand@13.0.0` 对合并后配置的字符串叶子做一次环境变量展开，并 MUST NOT 使用含命令替换的 v1000。展开 SHALL 只读取隔离副本中的真实 `process.env`，MUST NOT 允许配置字段互相引用或修改 process.env。

#### Scenario: 展开环境变量和默认值

- **WHEN** 字符串包含 `$VAR`、`${VAR}` 或 `${VAR:-default}`
- **THEN** 系统按 dotenv-expand 13 默认语义递归展开该字符串

#### Scenario: 环境变量缺失

- **WHEN** 字符串引用不存在且没有默认值的环境变量
- **THEN** 系统将引用展开为空字符串并由字段后续校验决定有效性

#### Scenario: 转义美元符号

- **WHEN** 配置使用 `\$` 转义变量语法
- **THEN** 系统保留字面美元表达式而不展开

#### Scenario: 命令替换文本

- **WHEN** 配置值包含 `$(command)`
- **THEN** 系统将其作为普通文本处理且绝不执行 shell 命令

### Requirement: OSC 渠道自动协议

`type:"osc"` 渠道 SHALL 支持 OSC 9、OSC 99 和 OSC 777，且 SHALL 只在 Pi TUI 模式输出。自动选择 SHALL 优先识别 `KITTY_WINDOW_ID` 为 OSC 99，其次使用用户覆盖后的 TERM_PROGRAM 映射，最后使用默认 OSC 9 fallback。系统 MUST NOT 提供强制 protocol 字段。

内置映射 SHALL 为 Ghostty/WezTerm/Warp -> OSC 777、iTerm2 -> OSC 9、VS Code -> OSC 99；VS Code 支持限制 SHALL 在文档中说明。

#### Scenario: Kitty 环境

- **WHEN** `KITTY_WINDOW_ID` 存在
- **THEN** 系统使用 OSC 99，无需依赖 TERM_PROGRAM

#### Scenario: 已知 TERM_PROGRAM

- **WHEN** TERM_PROGRAM 命中用户或内置映射
- **THEN** 系统使用映射协议，且用户条目覆盖同名内置条目

#### Scenario: 未知终端

- **WHEN** 没有 Kitty 信号且 TERM_PROGRAM 缺失或未知
- **THEN** 系统使用 OSC 9 fallback

#### Scenario: 非 TUI 模式

- **WHEN** Pi 运行于 RPC、JSON 或 print 模式
- **THEN** OSC 渠道不向 stdout 写任何控制序列

### Requirement: OSC 输出净化与长度

系统 SHALL 移除 OSC title/body 中的控制字符、协议分隔符和多余空白，并 SHALL 将最终单行正文限制在 512 Unicode 字符内。OSC 9 SHALL 把固定 title 前置到正文；OSC 99/777 SHALL 使用独立 title/body。每次 OSC 99 通知 SHALL 使用唯一 identifier。

#### Scenario: 恶意控制字符

- **WHEN** label 或上下文包含 ESC、BEL、ST 或换行
- **THEN** 输出不能逃逸当前 OSC 通知序列

#### Scenario: 超长 OSC 正文

- **WHEN** 最终单行正文超过 512 Unicode 字符
- **THEN** 系统在完整字符边界截断并添加省略号

### Requirement: ntfy 服务、topic 与认证

`type:"ntfy"` 渠道 SHALL 默认使用 `https://ntfy.sh`，并 SHALL 允许 HTTP/HTTPS 自建服务。topic MUST 匹配 `[-_A-Za-z0-9]` 且最长 64 字符。认证 SHALL 只支持可选 Bearer token；topic/token MAY 直接配置或通过统一字符串展开获得。

#### Scenario: 有效 ntfy 请求

- **WHEN** 实例启用且 serverUrl、topic 和可选 token 有效
- **THEN** 系统向服务基址下的 topic 端点 POST 通知，并在 token 非空时设置 Bearer Authorization

#### Scenario: 空或非法 topic

- **WHEN** topic 展开为空、包含路径分隔符、非法字符或超过 64 字符
- **THEN** 系统禁用该实例并显示不包含 topic 值的 warning

#### Scenario: HTTP 加 token

- **WHEN** serverUrl 使用 HTTP 且 token 非空
- **THEN** 系统允许实例但显示一次明文凭据风险 warning

### Requirement: ntfy 数字优先级与事件选项

ntfy priority SHALL 只接受整数 1-5。实例省略显式 priority 时 SHALL 使用内置事件等级：agent/integration error 5，input/permission 4，agent/task completed 3，context compacted 2。显式实例 priority SHALL 覆盖内置事件等级；`eventOptions[event].priority` SHALL 具有最高优先级。未订阅事件 MAY 预配置 eventOptions。

#### Scenario: 事件级覆盖

- **WHEN** eventOptions 为当前事件声明合法 priority
- **THEN** 请求使用该事件值

#### Scenario: 实例级覆盖

- **WHEN** 事件没有事件级 priority 且用户显式声明实例 priority
- **THEN** 请求使用实例 priority

#### Scenario: 使用内置事件等级

- **WHEN** 用户没有显式实例或事件 priority
- **THEN** 请求使用该事件的内置等级

### Requirement: ntfy 图标

系统 SHALL 随包发布 512x512 白底黑色 Pi PNG，并 SHALL 在 icon 未配置时使用包含当前 package version 的 jsDelivr URL。实例 icon 与 `eventOptions[event].icon` SHALL 接受 HTTP/HTTPS URL 或 null；事件值优先于实例值，null SHALL 明确禁用 Icon header。系统 MUST NOT 主动抓取、执行或解析自定义 URL。

#### Scenario: 使用默认 Pi 图标

- **WHEN** 实例和事件均省略 icon
- **THEN** 请求使用版本化 jsDelivr Pi PNG URL

#### Scenario: 事件关闭图标

- **WHEN** eventOptions 为当前事件设置 `icon:null`
- **THEN** 请求不发送 Icon header，即使实例有默认 icon

#### Scenario: 非 HTTP 图标 URI

- **WHEN** icon 使用非 HTTP/HTTPS scheme
- **THEN** 系统判定该 icon 配置无效并使用较低优先级图标值或禁用该条目

### Requirement: ntfy 消息与投递

系统 SHALL 使用 Node fetch 发送纯文本 title/body/priority/可选 icon，并 SHALL 在 TUI、RPC、JSON、print 模式均可投递。最终正文 MUST 限制在 4000 UTF-8 字节内。请求 SHALL 完全 fire-and-forget，默认 timeoutMs 为 5000；自定义值 MUST 是正的有限整数。系统 MUST NOT 自动重试或在 session shutdown flush。

#### Scenario: 超长 ntfy 正文

- **WHEN** 最终正文超过 4000 UTF-8 字节
- **THEN** 系统按完整 Unicode 字符截断并添加省略号，且不得触发 ntfy 附件行为

#### Scenario: 网络失败或非成功响应

- **WHEN** fetch 失败、超时或返回非 2xx
- **THEN** 系统捕获失败、不重试且不产生 integration-error

#### Scenario: print 模式

- **WHEN** Pi 在 print 模式 settled 且 ntfy 订阅该事件
- **THEN** 系统启动 fire-and-forget ntfy 请求

### Requirement: 渠道隔离与健康反馈

系统 SHALL 独立向所有启用且订阅事件的渠道扇出。任一渠道失败 MUST NOT 阻止其它渠道或改变 Pi/问答/权限/Herdr 结果。每个实例 SHALL 在首次失败时 warning、持续失败时静默，并在失败后的首次成功时显示恢复提示。

#### Scenario: ntfy 失败而 OSC 成功

- **WHEN** 同一事件路由到 OSC 和 ntfy 且 ntfy 失败
- **THEN** OSC 仍发送且调用方流程继续

#### Scenario: 重复失败与恢复

- **WHEN** 实例连续失败多次后成功一次
- **THEN** 系统只显示一次失败 warning 和一次恢复提示

#### Scenario: 无 UI 模式

- **WHEN** JSON/print 模式出现渠道失败
- **THEN** 系统只写净化 console 诊断；TUI/RPC 则同时使用 Pi UI warning

### Requirement: 敏感信息不得进入诊断

系统 MUST NOT 在远程消息、本地 warning、console、fixture 或响应错误中泄露 token、Authorization header、完整 topic、完整 URL path、响应正文、原始提示、权限值、命令或路径。

#### Scenario: 带 token 的请求失败

- **WHEN** ntfy 返回错误或抛出包含请求信息的异常
- **THEN** 用户可见诊断只包含实例 ID、渠道 type、净化错误类别或 HTTP status
