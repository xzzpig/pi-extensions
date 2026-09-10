# Tasks: add-goal-auditor-timeout-setting

## 1. Settings 层（goal-settings.ts）

- [x] 1.1 新增 `auditorTimeoutMs?: number` 到 `GoalSettings` 类型与文档注释，并在键校验 switch 中加入 `auditorTimeoutMs` 分支：非正整数、非整数或 > 2_147_483_647 时给出可操作诊断信息；验证：`grep -n "auditorTimeoutMs" extensions/goal-settings.ts` 覆盖类型/解析/校验/持久化/显示五处
- [x] 1.2 加入 `track`/`resolveLeaf` 分层解析（project 覆盖 global）、持久化 round-trip（persisted 写入与读回）、introspection 显示行（未设置显示默认 1800000）；验证：新增单测运行通过

## 2. Auditor 层（goal-auditor.ts）

- [x] 2.1 新增解析 helper：从 settings 取合法 `auditorTimeoutMs`，否则回退 `TERMINAL_TIMEOUT_MS`（常量保留为默认回退）；`START_HANDSHAKE_TIMEOUT_MS` 与 `CANCELLATION_TIMEOUT_MS` 不改动；验证：`grep -n "TERMINAL_TIMEOUT_MS\|START_HANDSHAKE_TIMEOUT_MS\|CANCELLATION_TIMEOUT_MS" extensions/goal-auditor.ts` 确认握手/取消常量仍为字面硬编码且仅默认回退引用 TERMINAL
- [x] 2.2 delegation request 的 `timeoutMs` 与 `armTerminalTimeout` 均改用该 helper（显式 `args.timeouts?.terminalMs` 仍最优先）；验证：单测断言 request 与 timer 取同一配置值

## 3. 单元测试

- [x] 3.1 `tests/goal-settings.test.ts` / `tests/goal-layered-settings.test.ts`：默认 30min（1800000）、global 设置生效、project 覆盖 global、非法值（负数/0/非整数/超上限）拒绝或回退且带诊断；验证：`npm test` 对应用例通过
- [x] 3.2 `tests/goal-auditor.test.ts`：settings 配置值贯通 request timeoutMs 与本地 terminal timer（同值）、未配置回退默认；验证：`npm test` 对应用例通过

## 4. 文档与 CHANGELOG

- [x] 4.1 更新 `packages/pi-goal-x/README.md` 设置章节（auditorTimeoutMs 语义、默认值、合法范围、project/global 分层）；验证：README 含 auditorTimeoutMs 小节
- [x] 4.2 更新 `packages/pi-goal-x/CHANGELOG.md`（Unreleased 条目：新增可配置审计时长上限）；验证：CHANGELOG 含 auditorTimeoutMs 条目

## 5. 验证

- [x] 5.1 `cd packages/pi-goal-x && npm run check`（tsc --noEmit 0 错误）；验证：命令输出无错误
- [x] 5.2 `cd packages/pi-goal-x && npm test`（0 失败）；验证：测试全绿输出
- [x] 5.3 `openspec validate --type change --strict add-goal-auditor-timeout-setting` 通过且 tasks.md 全部勾选；验证：validate 输出 valid、勾选完整
