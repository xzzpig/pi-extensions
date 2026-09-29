# Tasks

## 1. 配置与校验（`extensions/config.ts`）

- [x] 1.1 `TRIGGER_TYPES` 增加 `"event"`；`SentinelTrigger` 增加可选 `event?: string` 字段；触发器未知键集合放行 `event` 键。验证：`pnpm --filter @xzzpig/pi-sentinel run typecheck` 通过
- [x] 1.2 新增 `KNOWN_CORE_EVENTS` 常量（按 design D5 从宿主 0.87.1 `ExtensionEvent` union 枚举），并新增对照测试：表内每个名字均能在宿主类型/运行时事件名清单中找到。验证：新增测试通过
- [x] 1.3 `validateRule` 支持 event 触发器：`trigger.event` 必填非空；`trigger.event` 对其他触发器类型出现即校验失败；`core:` 前缀名字不在 `KNOWN_CORE_EVENTS` 时校验失败并列出全部合法名；`mode: "blocking"` + event 拒绝；`trigger.tools`/`trigger.threshold` 对 event 出现即校验失败；裸名不校验。验证：`test/config.test.ts` 新增用例覆盖上述六条分支（含 delta 中"未知核心事件名加载期拒绝""总线通道名不做校验"两个场景），并加一条"`core:message_update` 等逐 token 级事件名订阅被接受（不因事件频率拒绝，对应 delta『高频核心事件不设防』场景）"断言

## 2. 事件数据（`extensions/event-data.ts`）

- [x] 2.1 新增 `toJsonSafe` JSON 安全投影（null/布尔/数值/字符串原样，数组与纯对象递归，其余值 `"[unserializable]"` 占位）与 `buildEventEventData`（`{ name, event }`，载荷投影后复用 `truncateEventData`；总线 `data` 非纯对象时包 `{ value }`）；`EventEventData` 并入 `SentinelEventData` union。验证：`test/event-data.test.ts` 新增用例覆盖投影占位、非对象包裹、超长截断
- [x] 2.2 `buildScopeText` 将载荷 JSON 范围段分支放宽到 `event` 触发器；`defaultWindowKind` 增加 `event` case。验证：`test/event-data.test.ts` 新增用例覆盖"event 默认范围为载荷 JSON 而 window 覆盖为转写"场景

## 3. 订阅注册表（新模块 `extensions/event-subscriptions.ts`）

- [x] 3.1 实现 `EventSubscriptionRegistry`：按事件名引用计数 reconcile；`core:` 前缀经受控 cast 的字符串签名订阅 `pi.on`，裸名订阅 `pi.events.on`（裸名 handler 仅收到 `data`，宿主不传 ctx，转发给运行时即可）；保存退订函数，引用归零即退订；`clear()` 整体退订。验证：`test/event-subscriptions.test.ts` 用 fake `pi`/`events` 覆盖建立、同名共享单订阅、归零退订、core/bus 分流四条路径

## 4. 运行时接线（`extensions/index.ts`）

- [x] 4.1 `SentinelRuntime` 增加 `handleEventTrigger(name, payload, ctx?)`：按事件名过滤启用中的 event 规则（复用 `rulesFor` 的启用/屏蔽判断路径），构造 `buildEventEventData` 并走既有 `buildRequest`/`fireBackground`；`core:` 事件的 ctx 由宿主 handler 第二参传入，裸名总线事件宿主不传 ctx、使用 `rebuild()` 时刷新的运行时当前会话 ctx（为 null 时跳过本次触发）；dispatch 全程 try/catch，异常走 `onAuditFailure` 警告。验证：新增运行时单测（事件到达触发审计、禁用规则不触发、同名多规则全触发）
- [x] 4.2 `rebuild()` 末尾以生效 event 规则的事件名集合 reconcile 注册表；`session_shutdown` 处理器中调用 `clear()`（与会话切换/树导航共用的 `resetRuntimeState` 不得触碰注册表）。验证：`test/session-lifecycle.test.ts` 新增"会话切换不退订""最后一条规则移除后退订"用例，既有热加载/生命周期用例零回归
- [x] 4.3 `runDryRun` switch 增加 event case：模拟载荷按 JSON/`{ text }` 解析（复用 `parseSimulatedInput`），`name` 取配置原文。验证：`test/dry-run.test.ts` 新增"试运行 event 规则"用例（含 delta 场景的无分流副作用断言）

## 5. 展示（`extensions/commands.ts`、`extensions/fleet-view.ts`）

- [x] 5.1 规则清单与 fleet 触发器列对 event 规则显示 `event:<配置原文>`（bus 名原样、`core:` 前缀保留）。验证：`test/commands.test.ts` 或 `test/fleet-view.test.ts` 新增文案用例
- [x] 5.2 `configure-dialog.ts` 的规则字段速查表增补 `event` 触发器类型、`trigger.event` 字段与 blocking/background 组合说明（否则配置对话无法生成 event 规则）。验证：`test/configure-dialog.test.ts` 更新速查表文案断言

## 6. 文档

- [x] 6.1 README 增补：event 触发器语法与示例（总线裸名 + `core:` 前缀）、`core:` 保留前缀说明、热事件（逐 token 级）代价警告与 `overlap` 建议。验证：README 渲染检查（示例 JSON 合法）
- [x] 6.2 CHANGELOG 追加 Unreleased 条目。验证：条目存在且格式与既有条目一致

## 7. 全量验证

- [x] 7.1 `pnpm --filter @xzzpig/pi-sentinel run test && pnpm --filter @xzzpig/pi-sentinel run typecheck` 全绿
- [x] 7.2 `pnpm exec prettier --check .` 通过（pi-sentinel 非 upstream 子树，须过 prettier）
- [x] 7.3 按 `pi-plugin-e2e-test` 技能做真实冒烟：配置一条 `event` 裸名规则与一条 `core:session_compact` 规则，验证加载无警告、事件到达触发审计、fleet 可见。验证：冒烟结论记录到任务备注。**冒烟结论（2026-09-30，沙箱 /tmp/pi-e2e-sentinel，pi 0.87.1 -runtime 构建 + 冒烟伴随扩展 /smoke:emit）**：加载无任何警告；裸名 `smoke-channel` 规则经总线事件触发真实 LLM 裁决 `pass`；core 事件以 `core:user_bash` 替代 `core:session_compact`（`!echo hi` 确定触发，`session_compact` 需手动压缩不可靠），pass/warn 双路径均验证（warn 裁决成功注入会话，3637ms）；`/sentinel:list` 触发器列显示 `event:smoke-channel` 与 `event:core:user_bash` 原文。
