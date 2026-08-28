## 1. 包改名与公共表面

- [x] 1.1 将 `packages/pi-terminal-notifications` Git 重命名为 `packages/pi-notify`，设置 manifest 名称 `@xzzpig/pi-notify`、版本 `0.1.0`，同步 repository/homepage/keywords/tsconfig。
- [x] 1.2 更新 package `files` 和 `exports`，加入 `api.ts`、`assets/pi.png`、配置资源，并保持 Pi core 依赖为 peer dependency。
- [x] 1.3 从官方 Pi badge 生成并提交 512x512 白底黑色 PNG，验证 packed asset 路径可组成版本化 jsDelivr URL。
- [x] 1.4 实现 `@xzzpig/pi-notify/api` 的 channel/事件常量、类型守卫、断言和单对象 `publishNotification`，覆盖合法 emit 与非法 TypeError 测试。

## 2. 分层配置与环境变量

- [x] 2.1 定义 v1 配置类型、内置 terminal 基础实例、默认六事件、独立 `enabled`/`herdr.enabled` 和 channel discriminated union。
- [x] 2.2 实现全局配置与受信任项目 `.pi/pi-notify.json` 加载，确保未信任项目不读取，且配置只在 session_start/reload 刷新。
- [x] 2.3 实现对象递归、普通数组替换、channels 按唯一 ID 合并和项目 partial overlay，覆盖新 ID 完整校验、type 切换时丢弃旧 type 专属对象、enabled:false 与重复 ID 隔离。
- [x] 2.4 精确添加 runtime dependency `dotenv-expand@13.0.0`，实现只读取 process.env 的字符串叶子适配器，隔离 process.env 并跳过危险对象键。
- [x] 2.5 测试 `$VAR`、`${VAR}`、`${VAR:-default}`、递归、缺失为空、`\$` 转义和 `$(...)` 不执行，并固定禁止 v1000 命令替换的安全回归。
- [x] 2.6 重写 `config.schema.json` 与 `config.example.json`，使用 GitHub main `$schema` URL，严格 unknown fields，同时体现渠道实例数组、eventOptions、null icon 和项目 partial 示例。
- [x] 2.7 增加配置容错测试，覆盖未知 version、损坏 JSON、未知字段 warning、单实例无效隔离、旧配置路径忽略和缺失配置默认值。

## 3. 语义事件与来源适配器

- [x] 3.1 实现七事件封闭目录、默认六事件、固定标题和 Label/Project/Session 安全文案投影，并从同一常量生成配置与公共 API 类型。
- [x] 3.2 实现 agent state machine，覆盖自动重试后成功、error/length、unknown -> completed、aborted 静默、无 active run 和中间 tool/provider 错误不通知。
- [x] 3.3 重构 pi-ask 适配器为 input-required，并保持 flowId 去重、完成只清理和不投影原始问题。
- [x] 3.4 重构 permission-system 适配器为 permission-required，保持 requestId、直接/转发 decision 关联和通用低敏感文案。
- [x] 3.5 重构独立 `herdr.enabled` 状态机，保持 `herdr:blocked` 公开契约、多等待项计数和 session shutdown 清理。
- [x] 3.6 实现 pi-subagents async/foreground completion 适配器，测试 success -> task-completed、failed/timeout -> integration-error、cancelled/stopped 静默。
- [x] 3.7 实现 session_compact -> context-compacted，并确认压缩摘要和上下文不进入通知。
- [x] 3.8 实现 `pi-notify:publish` 接收端，测试安全 label、无去重、额外字段裁剪和非法 raw emit 忽略+warning。

## 4. 路由器、消息与健康状态

- [x] 4.1 定义内部 `NotificationChannel` 和路由器，实现顶层开关、实例开关、显式事件过滤、多实例扇出、模式可用性与独立异步错误捕获。
- [x] 4.2 实现固定英文 title 和渠道正文布局，覆盖 label/project/session 缺失组合、敏感字段排除、ntfy 4000 UTF-8 字节与 OSC 512 字符安全截断。
- [x] 4.3 实现每实例健康状态，覆盖首次失败 warning、重复失败静默、首次恢复提示和 reload 后状态重置。
- [x] 4.4 实现 TUI/RPC UI warning + console、JSON/print console-only，并测试 token/topic/URL path/响应正文不会进入诊断。

## 5. OSC 渠道

- [x] 5.1 将 OSC 9/99/777 序列构造与 writer 注入迁移到 `type:"osc"` 渠道，保留控制字符、分隔符和空白净化。
- [x] 5.2 实现 Kitty 环境信号、用户覆盖后的 TERM_PROGRAM 映射和 OSC 9 fallback 自动选择，不提供强制 protocol 或 WT_SESSION 特判。
- [x] 5.3 更新内置映射为 Ghostty/WezTerm/Warp -> OSC 777、iTerm2 -> OSC 9、VS Code -> OSC 99，并在文档标注 VS Code 版本/设置限制。
- [x] 5.4 实现 OSC 9 title 前置、OSC 99 唯一 identifier、TUI-only 输出和非 TUI 无 stdout 污染测试。

## 6. ntfy 渠道

- [x] 6.1 实现 serverUrl 默认值/HTTP(S) 校验、严格 topic、可选 Bearer token 和 HTTP+token 本地安全 warning。
- [x] 6.2 实现数字 priority 1-5、内置事件等级、显式实例 priority 和 `eventOptions` 事件覆盖，固定事件 > 实例 > 内置解析规则。
- [x] 6.3 实现默认版本化 Pi icon、实例/事件 HTTP(S) icon 覆盖、null 禁用和未订阅事件预配置。
- [x] 6.4 实现所有 Pi 模式可用的纯文本 fetch POST、4000 字节正文、正的有限整数 timeoutMs、完全 fire-and-forget、非 2xx/网络/超时不重试。
- [x] 6.5 使用 mock fetch 覆盖 ntfy.sh/自建 base path、topic、Authorization、Title/Priority/Icon headers、优先级/图标覆盖、HTTP warning、超时、敏感错误净化，以及 timeoutMs 小数/0/负数/NaN/Infinity 拒绝。
- [x] 6.6 添加默认 skip 的可选真实 ntfy smoke test，仅在显式环境变量齐备时发送测试通知，CI 默认不访问网络。

## 7. 组合、文档与验证

- [x] 7.1 重写扩展组合根，接入配置、事件适配器、Herdr、路由器、OSC、ntfy 和健康状态，并在 session shutdown 清理订阅/状态。
- [x] 7.2 重写入口集成测试，覆盖默认六事件、context 显式订阅、逐实例分流、多渠道故障隔离、项目覆盖和 reload 生命周期。
- [x] 7.3 更新包 README：新安装/迁移、完整配置、环境变量语义与锁版原因、七事件、publish API、pi-subagents 映射、OSC caveat、ntfy best-effort/隐私/可选 live test。
- [x] 7.4 更新根 README、`pnpm-lock.yaml` 和仓库元数据，确认除迁移说明外没有旧目录/包名引用。
- [x] 7.5 运行 `pnpm install` 更新锁文件，再运行 `pnpm install --frozen-lockfile` 验证可复现 workspace。
- [x] 7.6 运行 `pnpm --filter @xzzpig/pi-notify run typecheck`、`pnpm --filter @xzzpig/pi-notify test`、针对包路径的诊断和 `pnpm exec prettier --check .`。
- [x] 7.7 本地 pack 并检查 tarball 只包含 manifest、README、api、extensions、config 和 PNG asset，不包含测试、真实凭据或旧包路径。
- [x] 7.8 在 release 文档中记录后续步骤：另行授权后发布新包并 deprecate 旧包；本次实现 MUST NOT 执行 npm publish/deprecate、git commit 或 push。
