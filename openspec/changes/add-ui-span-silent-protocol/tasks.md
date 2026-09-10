# Tasks: add-ui-span-silent-protocol

## 1. pi-notify 协议层

- [ ] 1.1 在 `packages/pi-notify/api.ts` 导出 `PI_NOTIFY_UI_SPAN_SILENT_EVENT = "pi-notify:ui_span_silent"` 常量与 `UiSpanSilentPayload { reason?: string }` 类型；验证 `pnpm --filter pi-notify run typecheck` 通过
- [ ] 1.2 在 `packages/pi-notify/extensions/ui-prompts.ts` 增加 `parseUiSpanSilentPayload`（非对象忽略；reason 存在但非字符串或空白 → 整包忽略；`{}` 与 `{reason:"fleet"}` 合法）与 `createUiPromptContexts` 的 `pendingSilent`/`markSilent()`/`consumeSilent()`（one-shot），`reset()` 清除标记；在 `test/ui-prompts.test.ts` 增加对应单测（合法/非法 payload、one-shot 第二次返回 false、reset 清除）；验证 `pnpm --filter pi-notify test` 相关用例全绿

## 2. pi-notify 适配器集成

- [ ] 2.1 在 `packages/pi-notify/extensions/index.ts` 注册 `pi.events.on(PI_NOTIFY_UI_SPAN_SILENT_EVENT)` 消费标记，并在 `ui_prompt_start` 处理链中于 parse/duplicate 守卫之后、agent 门控之前插入 `consumeSilent()`：静默 span 仍登记 `openSpanId` 但不 `route()` 不 `state.startUiPrompt`，`ui_prompt_end` 零改动（`completeUiPrompt` 对未登记 spanId 为 no-op）；验证既有 159 测试无回归
- [ ] 2.2 在 `test/index.test.ts` 增加集成用例：运行中带标记对话框 0 通知 0 herdr、静默后真实对话框仍通知、空闲期打开 span 消费标记且不泄漏到后续运行期 span、标记优先于 pending permission（不产生 permission-required）、非法 payload 仍正常通知、session 重置清除未消费标记；验证 `pnpm --filter pi-notify test` 全绿

## 3. pi-subagents 接入

- [ ] 3.1 在 `packages/pi-subagents/src` 增加共享 observational emit helper（本地事件名字面量 + try/catch，不引入对 `@xzzpig/pi-notify` 的依赖），并在 `src/tui/fleet.ts` `openFleetView` 的 `ctx.ui.custom` 前一行 emit；验证 `pnpm --filter pi-subagents run typecheck` 与相关测试全绿
- [ ] 3.2 在 `src/slash/subagents-admin.ts` 的 `selectFromList` 入口与其余 `select`/`editor` 对话框前 emit；确认 `subagent-executor.ts` 的三处 agent 等待 confirm 不接入；验证 `pnpm --filter pi-subagents run typecheck` 与测试全绿

## 4. 文档

- [ ] 4.1 在 `packages/pi-notify/README.md` 增加「静默标记协议」节（事件名、payload、发送契约：同步紧邻 `ctx.ui.*`、observational try/catch、MUST NOT 依赖 pi-notify 包、示例片段）；验证 `pnpm exec prettier --check packages/pi-notify` 通过

## 5. 真机 e2e（pi-plugin-e2e-test skill，复用隔离 harness）

- [x] 5.1 复用 /tmp/pi-e2e-notify 的 mock-ntfy + 探针 + 独立 agentdir：agent 运行中探针发出静默标记后打开对话框 → mock-ntfy 无 input-required 且探针无 herdr:blocked；随后 agent 提问对话框仍正常通知；收集 pane 捕获、探针/服务器日志与精确启动命令存证据目录，失败如实报告
- [x] 5.2 e2e 结束后清理 tmux session，保留临时目录证据供报告引用

## 6. 终验

- [ ] 6.1 全量验证：`pnpm --filter pi-notify run typecheck && pnpm --filter pi-notify test && pnpm --filter pi-subagents run typecheck && pnpm --filter pi-subagents test` 全绿；`pnpm exec prettier --check packages/pi-notify packages/pi-subagents openspec/changes/add-ui-span-silent-protocol` 通过；`openspec validate add-ui-span-silent-protocol --strict` 通过；`git status` 确认 `packages/pi-goal-x/` 与 `packages/pi-sandbox/` 未改动
