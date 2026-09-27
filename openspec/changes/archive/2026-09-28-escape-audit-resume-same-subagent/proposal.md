# Proposal: escape-audit-resume-same-subagent

## Why

pi-goal-x 完成审计时按 Esc 会立即向 pi-subagents 发送取消请求杀掉审计子代理，随后弹窗询问“直接完成”还是“继续”。选“继续”后审计子代理已被杀死，后续再次请求完成时只能新开一个 fresh-context 的子代理从头审计，此前全部审计工作与上下文丢失，体验很差。pi-subagents 对前台委派子代理（`async: false, foregroundOnly: true`）只有 kill 没有 pause/resume，无法在杀掉后复活，因此复用只能通过“不杀”实现。

## What Changes

- Esc 中断审计时不再立即发送 CANCEL，改为**挂起（park）**：子代理保持运行、事件监听保留、不发取消请求，流程先弹窗让用户选择。
- 弹窗第二个选项语义从“继续工作（本轮不再审计）”改为**“继续审计”**：复用同一个子代理 attempt，等待其终态裁决（approved → 既有批准流程；disapproved → 既有拒绝流程），目标保持 active 直到出结果。
- 仅当用户选择“直接完成（跳过审计）”时才发送 CANCEL 杀掉挂起的子代理；弹窗期间焦点丢失（如 `/goal-unfocus`）同样取消挂起 attempt，防止孤儿子代理继续运行。
- 挂起期间审计 terminal timeout 仍作为防挂死兜底：超时后照常取消该 attempt 并按 fail closed 结束。
- 弹窗打开期间子代理继续运行（通常数秒，消耗少量 token）——这是复用同一子代理的必要代价。
- 不修改 `packages/pi-subagents`；不改审计 prompt、结构化裁决协议与委派事件格式；`interrupted` 结果仍携带 `error: "Auditor aborted."` 哨兵值，保留对非 parkable 依赖桩的既有 Esc 分支兼容。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `goal-completion-auditing`: “审计进度和取消保持可观察”要求中的 Esc 取消行为改为挂起同一审计 attempt；用户选择继续审计时复用同一子代理等待终态，仅在选择直接完成或焦点丢失时才真正取消

## Impact

- 受影响代码：`packages/pi-goal-x/extensions/goal-auditor-delegation.ts`（park/resume/cancel 会话句柄与事件路由）、`packages/pi-goal-x/extensions/goal-completion.ts`（弹窗后继续分支复用同一会话、绕过分支延迟取消）、`packages/pi-goal-x/extensions/widgets/goal-escape-dialog.ts`（选项文案与默认值语义）。
- 受影响测试：`packages/pi-goal-x/tests/goal-delegation-completion.test.ts`（Esc 取消/绕过/usage 相关用例改为 park 后 continue/complete 两条路径）。
- 文档：`packages/pi-goal-x/CHANGELOG.md`、`packages/pi-goal-x/README.md`（Esc 交互说明）。
- 不修改 `packages/pi-subagents` 及其委托协议；不修改上游同步面。
