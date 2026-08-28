## Context

`@xzzpig/pi-terminal-notifications` 当前把 Pi 生命周期、`pi-ask`、permission-system、Herdr 状态和 OSC 输出集中在一个扩展入口闭包中。它只有一个全局 OSC 配置，没有渠道实例、项目覆盖、语义事件目录、公共事件 API 或远程发送能力。

本设计以 `agent_settled` 作为主代理最终边界，避免自动重试、自动压缩和排队 continuation 期间误报。`pi-ask`、permission-system 与 pi-subagents 均已有稳定进程内事件，可被适配为低频语义事件；未知插件通过 `pi-notify:publish` 主动发布。ntfy 官方契约要求严格 topic、HTTP(S) Icon URL、1-5 数字优先级和小于 4096 字节的文本正文。

两轮子代理研究已确认：

- 环境变量展开应精确锁定 `dotenv-expand@13.0.0`；其 v1000 latest 含 `$(...)` 命令替换，不适合用户配置。
- OSC 推荐映射为 Ghostty/WezTerm/Warp -> OSC 777，iTerm2 -> OSC 9，Kitty -> OSC 99；VS Code 新版可选 OSC 99；未知终端更适合 OSC 9 fallback。

完整访谈决策记录见 `decision-log.md`。

## Goals / Non-Goals

**Goals:**

- 将包直接改名为 `@xzzpig/pi-notify@0.1.0`，保留 OSC 与 `herdr:blocked` 的可验证行为。
- 建立封闭的低频语义事件目录，使 Pi、已知插件和外部发布协议共享统一数据模型。
- 支持多个具名渠道实例、逐渠道事件列表、全局/受信任项目覆盖和按实例容错。
- 支持 ntfy.sh 与自建 ntfy、Bearer token、事件级数字优先级和图标。
- 固定安全英文文案，确保远程通知、日志和 warning 不泄露原始提示、权限值或凭据。
- 保证配置、OSC、网络和外部插件错误不改变 Pi、问答、权限、Herdr 或其它渠道流程。
- 提供稳定的 `@xzzpig/pi-notify/api` 供其它插件发布预定义事件。

**Non-Goals:**

- 首版不提供原生桌面、声音、TTS、Gotify、Telegram、通用 Webhook、tags、click、actions、email 或 Markdown。
- 不保留旧包/旧配置兼容层，不自动迁移配置。
- 不提供 tool/provider 中间错误、agent start/cancel、session/model/thinking/project-trust 等通知事件。
- 不提供最短任务时长、自动重试、持久化队列、退出 flush、提醒定时器或消息模板。
- 不提供 `/notify-*` 命令、配置 watcher 或自动创建配置文件。
- 不开放第三方渠道 sender 注册；新增渠道仍需修改本包。
- 本次实现不执行 npm publish/deprecate、git commit 或 git push。

## Decisions

### 1. 采用“来源适配器 -> 语义事件 -> 路由器 -> 渠道”流水线

内部事件对象只保留路由和安全文案需要的信息：

```ts
interface NotificationEvent {
  id: NotificationEventId;
  source: string;
  label?: string;
  projectName: string;
  sessionName?: string;
  timestamp: number;
}
```

封闭事件目录为：

```ts
const NOTIFICATION_EVENT_IDS = [
  "agent-completed",
  "agent-error",
  "input-required",
  "permission-required",
  "context-compacted",
  "task-completed",
  "integration-error",
] as const;
```

默认订阅除 `context-compacted` 外的六项。事件目录常量同时驱动 TypeScript 联合类型、配置 Schema、运行时解析和公共 API，防止漂移。来源适配器是唯一接触原始 Pi/插件 payload 的层；渠道永远只接收净化后的内部事件。

备选的一对一映射全部 Pi hook 会暴露高频/内部细节并制造通知噪声，因此不采用。

### 2. 用 agent state machine 确定最终结果

状态机跟踪一次可见运行是否 active 及最近低层运行的最终 assistant stop reason：

- 首次 `agent_start` 进入 active；后续自动重试只重置候选结果。
- `agent_end` 只记录候选 stop reason，不通知。
- `agent_settled` 消费最终候选：`error`/`length` -> `agent-error`；正常 stop 或未知结果 -> `agent-completed`；`aborted` -> 静默清理。
- 没有观察到 active run 的 settled 不产生事件。
- tool failure 与 provider 429/5xx/retry 不产生独立事件；只有最终无法恢复才形成 `agent-error`。

不记录运行时长，也不提供最短时长过滤。

### 3. 内置已知插件适配器

- `pi-ask`：started -> `input-required`；completed 只清理等待状态。
- permission-system：`permissions:ui_prompt` -> `permission-required`；直接/转发 decision 按现有匹配规则清理 requestId。
- pi-subagents：async/foreground success -> `task-completed`；failed/timeout -> `integration-error`；cancelled/stopped 静默。
- `session_compact` -> 默认关闭的 `context-compacted`。

`pi-ask` 与 permission 原始标题、message、surface、value、命令、路径和 agent 名均不进入通知投影。

### 4. 保留 Herdr 公开契约，但独立开关和实现

继续发布既有 `herdr:blocked` payload，不改事件名：

- 首个活动 ask/permission 出现时发送 `{active:true,label}`。
- 任一项完成但仍有其它活动项时保持 blocked。
- 全部完成或 session shutdown 时发送 `{active:false}`。

顶层 `enabled` 只控制通知；`herdr.enabled` 独立且默认 true。通知关闭、渠道过滤或渠道失败不影响 Herdr 状态机。

### 5. 外部插件使用未版本化 publish channel 与公共 API

共享 channel 为 `pi-notify:publish`。payload 只接受：

```ts
interface PiNotifyPublishPayload {
  eventId: NotificationEventId;
  source: string;
  label?: string;
}
```

不接受 title/body、metadata、version 或 dedupeKey；pi-notify 不为外部 emit 去重。label 移除控制字符和多余空白，内部不限制长度，渠道投影时再截断。

包通过 `exports` 暴露 `@xzzpig/pi-notify/api`：

- `PI_NOTIFY_PUBLISH_EVENT`
- `NOTIFICATION_EVENT_IDS`
- `NotificationEventId`
- `PiNotifyPublishPayload`
- `isPiNotifyPublishPayload`
- `assertPiNotifyPublishPayload`
- `publishNotification({events,eventId,source,label})`

`events` 只需实现 `emit(channel, data)`。helper 对非法参数抛 `TypeError`；直接手工 emit 的非法 payload 被接收端忽略并本地告警，不能把异常传播到发布插件。未来 breaking 协议通过新 channel 名演进。

### 6. 配置采用分层的具名渠道实例数组

全局路径为 Pi agent 目录下 `extensions/pi-notify/config.json`；项目路径使用 `CONFIG_DIR_NAME`（默认 `.pi`）下的 `pi-notify.json`，且只在 `ctx.isProjectTrusted()` 为真时读取。

最终结构：

```json
{
  "$schema": "https://raw.githubusercontent.com/xzzpig/pi-extensions/main/packages/pi-notify/config/config.schema.json",
  "version": 1,
  "enabled": true,
  "herdr": { "enabled": true },
  "channels": [
    {
      "id": "terminal",
      "type": "osc",
      "events": [
        "agent-completed",
        "agent-error",
        "input-required",
        "permission-required",
        "task-completed",
        "integration-error"
      ],
      "osc": {
        "fallback": "osc9",
        "termPrograms": { "MyTerminal": "osc777" }
      }
    },
    {
      "id": "phone",
      "type": "ntfy",
      "events": [
        "agent-completed",
        "agent-error",
        "input-required",
        "permission-required",
        "task-completed",
        "integration-error"
      ],
      "ntfy": {
        "serverUrl": "https://ntfy.sh",
        "topic": "${PI_NOTIFY_TOPIC}",
        "token": "${PI_NOTIFY_TOKEN}",
        "priority": 3,
        "timeoutMs": 5000,
        "eventOptions": {
          "agent-error": { "priority": 5 },
          "permission-required": { "priority": 4, "icon": null }
        }
      }
    }
  ]
}
```

项目配置是 partial overlay，例如：

```json
{
  "channels": [
    {
      "id": "phone",
      "ntfy": { "topic": "${PROJECT_NTFY_TOPIC}" }
    }
  ]
}
```

合并顺序：内置默认 -> 全局 -> 受信任项目。规则：

- 内置 `{id:"terminal",type:"osc"}` 是固定基础实例。
- 对象递归合并，普通数组整体替换，channels 数组按唯一 ID 合并。
- 同 ID 项目实例可改变 type；type 改变时丢弃继承的旧 type 专属对象，只保留 id/enabled/events 等通用字段，再合并项目提供的新 type 专属对象并完整校验。新 ID 必须是完整实例。
- inherited 渠道只能用 `enabled:false` 禁用，不提供 remove 标记。
- 显式实例省略 enabled 时为 true；省略 events 时使用六个默认事件，空数组表示无订阅。
- event selector 只接受明确 ID；eventOptions 可预配置未订阅事件。
- 配置 version 可选，省略为 1；未知版本整份不应用。

Schema 对未知字段严格，运行时忽略未知字段并 warning。解析/校验按实例隔离，不让一个坏 ntfy 实例破坏 OSC 或其它实例。配置只在 session_start/reload 时刷新，不创建文件或 watcher。

### 7. 精确锁定 dotenv-expand 13 并隔离展开

运行时 dependency 使用精确版本 `dotenv-expand@13.0.0`。配置完成默认/全局/项目 raw merge 后，薄适配器遍历字符串叶子并逐值使用隔离 processEnv 展开；只读取真实 `process.env`，不允许配置字段互相引用。

遵循库默认语义：`$VAR`、`${VAR}`、`${VAR:-default}`、递归展开、`\$` 转义、缺失变量变空字符串。展开后再做字段校验；空 topic 使对应 ntfy 实例无效，空 token/icon 等可选值省略。适配器不修改 process.env，并跳过危险对象键。

必须在 manifest、lockfile、测试和 README 中解释精确锁版原因，禁止无审查升级到含命令替换的 v1000。

### 8. 使用固定、低敏感英文通知投影

固定标题：

| Event                 | Title                                 |
| --------------------- | ------------------------------------- |
| `agent-completed`     | `Pi finished the task`                |
| `agent-error`         | `Pi encountered an error`             |
| `input-required`      | `Pi needs your input`                 |
| `permission-required` | `Pi needs permission`                 |
| `context-compacted`   | `Pi compacted the context`            |
| `task-completed`      | `Pi completed a task`                 |
| `integration-error`   | `Pi encountered an integration error` |

正文顺序为 Label -> Project -> Session。只使用 cwd basename 和 session display name；不使用完整路径、模型、source、运行耗时或原始事件内容。

- ntfy 每项一行，最终正文最多 4000 UTF-8 字节。
- OSC 使用单行 `·`，最多 512 Unicode 字符。
- 截断保留完整 Unicode 字符并加省略号。
- OSC 9 没有 title 槽，因此把固定 title 前置到正文；OSC 99/777 使用独立 title/body。

### 9. OSC 渠道只做自动、安全的 TUI 输出

`type:"osc"` 的专属配置放在 `osc`。自动选择顺序：

1. `KITTY_WINDOW_ID` 存在 -> OSC 99。
2. TERM_PROGRAM 用户映射（扩展/覆盖内置）或内置映射。
3. fallback（默认 OSC 9）。

内置映射：

```ts
{
  ghostty: "osc777",
  "iTerm.app": "osc9",
  WezTerm: "osc777",
  WarpTerminal: "osc777",
  vscode: "osc99",
}
```

VS Code 映射依赖支持 OSC 99 的版本及 `terminal.integrated.enableNotifications`。不对 WT_SESSION 特判，不提供强制 protocol。只在 `ctx.mode === "tui"` 写序列；RPC/JSON/print 跳过。每次 OSC 99 通知使用唯一 identifier。现有控制字符、OSC 分隔符和空白净化继续保留。

### 10. ntfy 使用严格配置与 best-effort 投递

`type:"ntfy"` 的专属配置放在 `ntfy`：

- serverUrl 默认 `https://ntfy.sh`，允许 HTTP/HTTPS；HTTP + token 产生本地安全 warning。
- topic 必填，匹配 `[-_A-Za-z0-9]` 且最长 64 字符。
- 只支持可选 Bearer token；topic/token 均可直接配置或通过字符串插值。
- priority 只接受数字 1-5。
- 实例显式 priority 覆盖内置事件等级；省略时使用：error 5、input/permission 4、completed 3、compacted 2。
- `eventOptions[event]` 的 priority/icon 优先于实例值；未订阅事件也可预配置。
- icon 省略时使用 `https://cdn.jsdelivr.net/npm/@xzzpig/pi-notify@<packageVersion>/assets/pi.png`；该 asset 是 512x512 白底黑色 Pi badge PNG。
- instance icon 与 event icon 只接受 HTTP/HTTPS；null 明确禁用。首版不抓取或验证远程 MIME。
- Node fetch POST 纯文本，设置 Title、Priority、可选 Icon 和 Authorization。
- 最终正文不超过 4000 UTF-8 字节，避免 ntfy 将其转成附件。
- TUI/RPC/JSON/print 均可发送。
- 完全 fire-and-forget，默认 timeoutMs 5000；可配置任意正的有限整数，不设上限。
- 非 2xx、网络失败和超时不重试，也不产生 integration-error。

### 11. 渠道健康状态负责本地失败/恢复反馈

路由器同步选择匹配渠道并分别启动 send；任何同步/异步错误都在实例边界捕获。每个实例维护健康状态：首次失败 warning，持续失败静默，失败后首次成功显示恢复提示。

TUI/RPC 使用 ctx.ui.notify warning/success 并写 console；JSON/print 只写 console。消息只包含实例 ID、type、净化错误类别/HTTP status，不含 token、Authorization、完整 topic、URL path 或响应正文。配置错误、非法 raw publish 和 HTTP 明文 token 也走去重的本地 warning 路径。

### 12. 模块和测试边界

建议结构：

```text
packages/pi-notify/
  api.ts
  assets/pi.png
  config/config.example.json
  config/config.schema.json
  extensions/
    index.ts
    config.ts
    env.ts
    events.ts
    messages.ts
    agent-events.ts
    interaction-events.ts
    subagent-events.ts
    router.ts
    health.ts
    channels/osc.ts
    channels/ntfy.ts
```

纯函数/窄接口分别测试配置 merge、env expansion、event parse、agent state、消息投影、UTF-8 截断、OSC 序列、ntfy request 和 health transitions。扩展入口测试只覆盖订阅/组合与故障隔离。

自动测试全部 mock fetch。另提供默认 skip、只有显式环境变量齐备才运行的真实 ntfy smoke test；CI 不要求网络或 secret。

## Risks / Trade-offs

- [直接改名中断现有安装] -> README 给出卸载、安装和手工迁移步骤；新包发布后另行授权 deprecate 旧包。
- [项目配置可改远程目标] -> 仅受信任项目读取；未信任项目完全忽略 `.pi/pi-notify.json`。
- [dotenv-expand latest 可执行命令] -> 精确锁定 13.0.0，测试 `$(...)` 保持普通文本，并在依赖升级审查中设明确阻断条件。
- [直接 token 或项目 basename 仍可能敏感] -> 文档优先推荐环境变量；固定消息不包含原始提示、权限值、完整路径或 source。
- [外部 label 无内部长度上限] -> 两个渠道分别做协议级截断；调用方仍应提供短、低敏感 label。
- [fire-and-forget 在短命进程可能丢通知] -> 明确 best-effort，不引入阻塞或持久队列；真实 smoke test只验证可用路径。
- [实例 priority 会覆盖内置事件等级] -> 文档说明省略 priority 才保留 severity defaults；需要统一等级时显式设置实例 priority。
- [VS Code OSC 99 依赖版本/设置] -> README 标注 caveat，用户仍可覆盖 termPrograms。
- [jsDelivr 本地未发布版本图标 404] -> ntfy 正文投递不依赖图标成功，不使用不稳定 fallback。
- [非法 helper payload 抛错] -> 强类型 API 让调用方尽早发现契约错误；raw event listener 仍 fail-open。

## Migration Plan

1. 将旧包 Git 重命名为 `packages/pi-notify`，设置版本 `0.1.0`，更新 manifest、repository/homepage、files、exports 与依赖。
2. 先引入 API、事件目录、固定消息、agent/interaction/subagent 适配器和独立 Herdr 状态机，用现有行为测试固定回归。
3. 实现 layered config、partial merge、dotenv-expand adapter 和 Schema/example，再接入 router/health。
4. 迁移并更新 OSC 渠道与官方 mapping 测试；实现 ntfy、Pi PNG asset、mock fetch 与 optional live smoke test。
5. 更新包 README、根 README、lockfile 和旧名引用；运行 typecheck/test/prettier/diagnostics。
6. 本地 pack 并检查 tarball；本次到此结束，不执行 npm publish/deprecate。
7. 后续得到单独授权后发布 `@xzzpig/pi-notify@0.1.0`，确认可安装，再 deprecate 旧包并指向新包。

## Open Questions

无。产品与公共契约细节已在 `decision-log.md` 中全部确认；剩余工作属于实现与验证。
