# 任务清单：Esc 审计挂起并复用同一子代理

## 1. 委托层：park / resume / cancel 会话句柄

- [ ] 1.1 `extensions/goal-auditor-delegation.ts`：`GoalAuditorResult` 新增 `interrupted?: boolean` 与 `session?: GoalAuditorSessionHandle`；新增并导出 `GoalAuditorSessionHandle`（`resume(): Promise<GoalAuditorResult>`、`cancel(): Promise<GoalAuditorResult>`）；`GoalCompletionAuditorArgs` 新增 `parkOnAbort?: boolean`（默认 false）。验证：`pnpm --filter pi-goal-x run typecheck` 通过
- [ ] 1.2 `runGoalCompletionAuditor` 内部：`onAbort` 在 `parkOnAbort` 时调用 `park()`（不发 CANCEL、不拆监听、保留 timer，用 `interrupted` 结果结算外层 promise），否则维持 `cancelAttempt("user_abort")`；request 前置 `signal.aborted` 检查同样按 `parkOnAbort` 分流。验证：typecheck + 既有 delegation 测试不回归
- [ ] 1.3 终态路由：`finish()` 在 park 已注册 resolver 时把终态（completed / 失败 / 取消确认 / timed-out 取消）路由到 park promise，路由后照常 `cleanup()`（清 listener/timer）；`resume()` 复位 `parked` 恢复进度回传，`cancel()` 发送 `SUBAGENT_DELEGATION_CANCEL_EVENT` 并返回 park promise。验证：typecheck + 新增 park 单测通过

## 2. 完成流程：按用户选择分流

- [ ] 2.1 `extensions/goal-completion.ts`：生产调用 `runGoalCompletionAuditor` 传 `parkOnAbort: true`；在既有 `auditor.error === "Auditor aborted."` 分支前新增 `auditor.interrupted && auditor.session` 分支：清空审计显示与 `core.auditAborted`、进 modal 弹窗、弹窗后焦点丢失时 `await session.cancel()` 并返回焦点丢失结果。验证：typecheck + 焦点丢失用例通过
- [ ] 2.2 `complete_without_audit` 分支：`await session.cancel()`（取取消终态 usage 供 `withAuditorUsage`），沿用既有 `audit_skipped` ledger + `commitGoalCompletion` 绕过逻辑。验证：绕过用例断言 ledger `audit_skipped` 且 usage 记账不丢
- [ ] 2.3 “继续审计”分支：重新挂起 `auditProgress`/spinner 动画 → `await session.resume()` → 复用共享裁决处理（usage 记账、`audit_result` ledger、approved/disapproved 卡片与 commit）；恢复阶段异常按既有 catch 兜底。验证：继续用例断言复用同一 requestId、且 completed RESPONSE 驱动既有裁决流程

## 3. 弹窗语义

- [ ] 3.1 `extensions/widgets/goal-escape-dialog.ts`：`EscapeDialogResult` 第二值改为 `"continue_audit"`；第二个选项 label/描述改为“继续审计 / 复用同一个审计子代理继续审计直到出结果”；Esc 键与 headless 回退默认值同步改为 `continue_audit`；头部/底部文案同步。验证：typecheck + 弹窗渲染测试（如有）更新后通过

## 4. 测试

- [ ] 4.1 `tests/goal-delegation-completion.test.ts`：Esc 继续用例改为——`abortAudit` 后不发 cancel 事件、`ui.custom` 返回 `"continue_audit"`、同一 requestId 上补发 completed RESPONSE → 断言复用同一 identity、无 `audit_skipped`、目标完成
- [ ] 4.2 绕过用例改为——`abortAudit` 后 `ui.custom` 返回 `"complete_without_audit"` → 断言此时才收到 cancel 事件（identity 匹配）、ledger 有 `audit_skipped`
- [ ] 4.3 usage 记账用例改为分别覆盖 continue（completed RESPONSE 带 usage）与 bypass（cancelled RESPONSE 带 usage）两条路径，断言 `withAuditorUsage` 形状与 `audit_usage` ledger 记录；另断言焦点丢失分支也尝试 append `audit_usage`（用 cancelled 终态 usage）
- [ ] 4.4 新增焦点丢失用例：park 弹窗期间焦点变化 → 断言发送 cancel（无孤儿）且返回焦点丢失结果、目标未完成。验证：`pnpm --filter pi-goal-x test` 全绿
- [ ] 4.5 新增“弹窗期间子代理已完成”用例：park 后先补发 completed RESPONSE（approved），`ui.custom` 返回 `"continue_audit"` → 断言复用同一 identity、目标完成且无重复 `audit_result`；另一变体 `"complete_without_audit"` → 断言只记 `audit_skipped`、不产生 `audit_result`
- [ ] 4.6 新增“挂起超时 fail closed”用例：park 后不补发终态，terminal timeout 到期 → 继续选择返回 error 终态、目标保持 active、无 `audit_result`
- [ ] 4.7 新增“恢复阶段重复 Esc 无效”用例：resume 后再次 `core.abortAudit` → 断言审计继续至终态且不产生第二个 cancel 事件

## 5. 文档与收尾

- [ ] 5.1 更新 `packages/pi-goal-x/CHANGELOG.md`（fork release 条目：Esc 继续审计复用同一子代理）与 `README.md` 交互说明。验证：prettier `--check` 通过
- [ ] 5.2 全量验证：`pnpm install --frozen-lockfile` 后 `pnpm --filter pi-goal-x run typecheck`、`pnpm --filter pi-goal-x test`、`pnpm exec prettier --check .` 全部通过；`direnv reload` 无 schema/ref 报错
