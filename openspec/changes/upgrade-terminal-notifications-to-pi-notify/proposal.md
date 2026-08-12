## Why

现有 `@xzzpig/pi-terminal-notifications` 只通过终端 OSC 协议发送少量提醒，无法覆盖离开终端后的跨设备通知，也缺少多实例渠道、逐渠道事件路由、事件级优先级和项目覆盖配置。将其升级为 `pi-notify`，可以在保留轻量终端通知与 Herdr 状态集成的同时，为 Pi、问答、权限、子代理和其他插件提供统一、可扩展且低敏感的通知能力。

## What Changes

- **BREAKING**：将包目录和 npm 包名直接改为 `packages/pi-notify` / `@xzzpig/pi-notify`，新包版本从 `0.1.0` 开始；旧包、旧目录和旧配置路径不提供兼容入口。
- 新包发布后计划将 `@xzzpig/pi-terminal-notifications` 标记 deprecated 并指向新包，但本次实现只做到本地 pack，不执行 npm publish/deprecate。
- 将 OSC 9、OSC 99、OSC 777 重构为默认启用的 `osc` 渠道；更新官方终端映射、Kitty 检测和 OSC 9 fallback，并保持 TUI-only 与控制序列净化。
- 新增可多实例配置的 ntfy 渠道，支持 ntfy.sh/自建 HTTP(S) 服务、严格 topic、Bearer token、数字优先级、事件级 priority/icon、版本化默认 Pi PNG、5 秒默认超时和旁路式无重试投递。
- 建立七个封闭的低频语义事件：`agent-completed`、`agent-error`、`input-required`、`permission-required`、`context-compacted`、`task-completed`、`integration-error`；除压缩事件外均为渠道默认订阅。
- 内置 Pi agent、`pi-ask`、permission-system 和 pi-subagents 适配器；中间工具/provider 错误、流式更新和用户主动 abort 不产生通知。
- 新增 `pi-notify:publish` 跨插件协议和 `@xzzpig/pi-notify/api` 公共入口，让其他插件通过预定义事件 ID 和安全 label 发布通知，不开放第三方渠道注册。
- 配置改为带唯一 ID 的渠道实例数组；支持全局配置与受信任项目 `.pi/pi-notify.json` 的按 ID 深度合并、项目 partial overlay、严格 Schema 和逐实例容错。
- 精确依赖 `dotenv-expand@13.0.0`，按其默认规则对合并后的配置字符串做环境变量展开；禁止升级到带命令替换的 v1000。
- 使用固定英文行动导向文案，只投影安全 label、项目目录名和 session display name；不发送原始问题、权限值、命令、路径、模型或凭据。
- 保留 `herdr:blocked` 公开契约，但将其放入独立、默认启用的 `herdr.enabled` 状态机，不受通知总开关控制。
- 增加 mock fetch 测试和默认跳过的可选真实 ntfy 冒烟测试，并更新 Schema、示例、README、lockfile 与本地打包验证。

## Capabilities

### New Capabilities

- `notification-channels`: 定义多实例 OSC/ntfy 渠道、分层配置、环境变量展开、消息投递、优先级、图标、健康状态和故障隔离。
- `notification-event-routing`: 定义封闭语义事件、Pi/插件适配器、固定安全文案、逐渠道路由、Herdr 状态和公共发布 API。

### Modified Capabilities

无。

## Impact

- `packages/pi-terminal-notifications/` 将迁移并重构为 `packages/pi-notify/`，package manifest 需要新增 `./api` export、PNG asset 和 `dotenv-expand@13.0.0` runtime dependency。
- 根 `README.md`、`pnpm-lock.yaml` 以及所有旧目录/包名引用需要同步更新。
- 新增全局配置 `extensions/pi-notify/config.json` 和受信任项目配置 `.pi/pi-notify.json`；旧配置不会自动迁移。
- 新增 `pi-notify:publish` 进程内事件契约；非法 helper 调用抛 `TypeError`，非法原始 emit 被接收端忽略并本地告警。
- ntfy topic/token 与环境变量值属于敏感信息；日志、UI warning、测试 fixture 和文档示例不得泄露真实值。
- 真实网络测试默认跳过；本次 change 不授权 git commit/push 或 npm registry 写操作。
