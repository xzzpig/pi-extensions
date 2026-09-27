# 设计：Esc 审计挂起并复用同一子代理

## Context

完成审计通过 `packages/pi-goal-x/extensions/goal-auditor-delegation.ts` 的
`runGoalCompletionAuditor` 走 pi-subagents 结构化委托桥
（`SUBAGENT_DELEGATION_REQUEST/STARTED/UPDATE/RESPONSE/CANCEL` 事件）。委托参数在
pi-subagents 的 `toSubagentDelegationExecutionParams` 中被硬编码为
`async: false, foregroundOnly: true`——即**前台实时运行**：没有 asyncDir、没有持久会话。
pi-subagents 的 stop 路径（`deliverStopRequest` / `stopAsyncRun`）对前台子代理就是 kill；
`action: "resume"` 只能复活 paused/completed/failed 的**异步**子代理，并明确拒绝仍在前台运行的
子代理。委托桥对同一 attempt 的重复 REQUEST 直接忽略（`attemptControllers.has(key) || settledAttempts.has(key)`）。

结论：杀掉后无法复活，重新 REQUEST 无法挂到旧 attempt。复用同一子代理的唯一可行方式是**不杀**——
Esc 时保留子代理与监听，先弹窗，由用户选择后再决定取消或继续等待。

## Goals / Non-Goals

**Goals:**

- Esc 中断审计时子代理不被立即杀死，其全部上下文与审计进度得到保留。
- 弹窗选“继续审计”后，复用**同一**子代理 attempt 等待终态裁决（approved → 完成；disapproved → 拒绝卡片）。
- 仅选“直接完成”或弹窗期间焦点丢失时才真正取消，避免孤儿子代理。
- 兼容现有依赖注入：`core.dependencies.runCompletionAuditor` 桩（无 park 能力）仍走既有 Esc 分支。

**Non-Goals:**

- 不修改 `packages/pi-subagents`（方案 B：改委托协议为 async 持久会话 + `action:"resume"` 复活，已评估并排除，见 Decisions）。
- 不支持把同一子代理跨多个执行轮次保持存活（pi-subagents 前台委派生命周期限于单次 delegated execution）。
- 不改变审计 prompt、结构化裁决协议、usage 记账与 ledger 事件语义。
- 挂起恢复后二次 Esc 不再生效（`auditAbortController` 已置空，二次中断在恢复阶段被忽略）。

## Decisions

### D1：Esc 时挂起（park）而非取消，外层 promise 以 `interrupted` 结果 + 会话句柄结算

`runGoalCompletionAuditor` 新增 `parkOnAbort?: boolean`（生产流程传 `true`）。`onAbort` 时：

- `parkOnAbort` 为真 → `park()`：**不**发 CANCEL、**不**清理监听与 timer（startedTimer 由 STARTED/UPDATE
  处理清除），用 `{ approved:false, disapproved:true, output:"", error:"Auditor aborted.",
cancelled:true, interrupted:true, session }` 结算外层 promise。
- 为假 → 维持现有 `cancelAttempt("user_abort")`（非 parkable 桩/测试依赖的兼容路径）。

`session` 为 `GoalAuditorSessionHandle`：

```ts
interface GoalAuditorSessionHandle {
  resume(): Promise<GoalAuditorResult>; // 继续等待同一 attempt 的终态
  cancel(): Promise<GoalAuditorResult>; // 现在才发 CANCEL，等待取消终态
}
```

两者都返回同一个 park promise；park 期间到达的 child 终态（completed/失败/取消确认/timed-out
取消）统一路由到该 promise 的 resolver，由既有的 `finish()` 在路由后清理监听与 timer。挂起期间
`cancelAttempt("terminal_timeout")` 仍可触发（terminal timer 未清除），作为防挂死兜底：超时则发
CANCEL 杀子代理，按 fail closed 结束。`resume()` 会把 `parked` 标志复位，恢复进度回传（弹窗期间
不向 dashboard 推进度更新，避免覆盖流程已清空的 `auditProgress`）。

### D2：复用同一 identity，不重发 REQUEST

park 不复用委托桥的取消/请求通道：CANCEL 延迟到用户决定后发送（同一 requestId/ownerRunId/nodeId，
bridge 能精确定位 attempt）；继续等待则直接复用已保留的 RESPONSE 监听，因此不需要也不能重新 emit
REQUEST（bridge 对同一 attempt 的重复 REQUEST 会忽略）。

### D3：完成流程按用户选择分流（goal-completion.ts）

`runGoalCompletionFlow` 在 `auditor.interrupted && auditor.session` 时：

1. 清空审计显示、`core.auditAborted = false`、进入 goal modal 弹窗（沿用 `showEscapeDialog`）。
2. 弹窗后检查 `core.isFocusedOperationCurrent(completionFocus)`：
   - 焦点丢失 → `await session.cancel()`（杀孤儿）→ 返回既有焦点丢失结果。
3. `complete_without_audit` → `await session.cancel()`（此刻才杀子代理；其终态携带 usage，供
   `withAuditorUsage` 记账）→ 既有 `audit_skipped` + `commitGoalCompletion` 绕过分支。
4. “继续审计”（`continue_audit`）→ 重新挂起 spinner/`auditProgress` → `await session.resume()` →
   落到**共享的裁决处理代码**（usage 记账、ledger `audit_result`、approved/disapproved 卡片、commit）。
5. 保持 `else if (auditor.error === "Auditor aborted.")` 旧分支，兼容无 park 能力的依赖桩（桩返回的
   `continue_audit` 在该分支中视为“保持目标 active”，与旧 `continue_working` 等价）。

### D3a：audit_usage 记账归属

共享代码现状在 dialog 之前用 `auditor.usage` append `audit_usage`。park 后 interrupted 结果不带 usage
（usage 挂在会话终态上），因此：

- 继续路径：resume 终态落下后由共享代码 append（位置不变，使用终态 usage）。
- 直接完成路径：分支内用 `session.cancel()` 的 cancelled 终态 usage append（比现状更可靠——现状绕过时
  aborted 结果通常无 usage，只有取消确认及时到达才记）。
- 焦点丢失路径：同样在分支内 append（保持现状“焦点丢失也会尝试记账”的行为）。

三条路径互斥，`audit_usage` 至多 append 一次，不重复。

### D4：弹窗语义更新（goal-escape-dialog.ts）

- 第二个选项：label 改为“继续审计”，value 改为 `continue_audit`，描述改为“复用同一个审计子代理
  继续审计直到出结果（目标保持 active）”。
- 默认选中仍为第二项；Esc 键提交的默认值同步改为 `continue_audit`；headless 回退同样改为
  `continue_audit`。头部/底部文案同步更新。

### D5：排除方案 B（改 pi-subagents 委托协议）

让审计走 async 持久会话 + `action:"resume"` 复活同一会话，需要重写委托桥的执行/响应时序
（REQUEST 立即返回 → 需要轮询/等待 asyncDir 终态）、增加 stop/resume 控制通道，并改动共享包
pi-subagents（被其他插件使用、且是安全敏感区域）。收益仅是弹窗期间子代理不烧 token（通常数秒），
风险与维护成本不成比例，故排除。

## 边界情况与状态机

约定：**外层 promise** = 流程拿到审计结果（正常终态或 interrupted）；**park promise** = 会话终态
（`resume()`/`cancel()` 都返回它）。`settled` 表示该 attempt 已产生终态。

### 时序竞态

1. **Esc 早于 STARTED（握手前）**：park 不清 startedTimer；STARTED/UPDATE 到达时照常处理并清除。若
   child 永不启动，5s 握手 timer fire → 终态路由到 park promise（fail closed：`did not acknowledge`）。
   弹窗选“继续审计”→ resume() 返回该错误终态，目标保持 active；选“直接完成”→ cancel() 见下方
   **cancel() 幂等与已结算** 条目，不重发 CANCEL，直接按绕过提交。
2. **abort 与 RESPONSE 竞态**：`onAbort` 以 `settled` 守卫——RESPONSE 先到则正常裁决（settled=true），
   abort 后到被忽略（不 park 不 cancel）；abort 先到则 park，RESPONSE 后到路由到 park promise。两种
   顺序结果确定，无中间态。
3. **弹窗期间 child 已终态**：终态路由到 park promise（不触外层，外层早已以 interrupted 结算）。继续 →
   resume() 立即返回裁决，spinner 刚挂起即被裁决处理取代；直接完成 → cancel() 已结算不重发 CANCEL，
   按绕过提交——completed 终态不进入裁决，ledger 只记 `audit_skipped`，不产生重复 `audit_result`。
4. **cancel() 幂等与已结算**：`cancel()` 仅在未结算且未设 cancellationReason 时通过 `cancelAttempt` 发
   CANCEL（现有守卫）；已结算（settled）或已在取消流程中时直接返回 park promise，不重发 CANCEL、不产生
   第二个终态。
5. **挂起超时（terminal timeout 兜底）**：park 不清 terminal timer；到期 `cancelAttempt("terminal_timeout")`
   → 发 CANCEL → child 被杀 → cancelled 终态路由 park promise。继续 → resume() 返回 fail closed error
   （目标 active）；直接完成 → cancel() 见 cancellationReason 已设，直接返回。
6. **取消后迟到批准**：CANCEL 已发后 child 才回 completed/approved → RESPONSE handler 的
   cancellationReason 分支优先 → 视为取消确认，不读取 verdict（与既有“迟到批准不能授权完成”一致；
   park 下该终态由 park promise 承接，两条路径都不会把迟到 verdict 当批准）。

### 记账与 ledger

1. **audit_usage 三条路径**：继续 → 共享代码 append（resume 终态 usage）；直接完成 → 分支内 append
   （cancelled 终态 usage）；焦点丢失 → 分支内 append。见 D3a。
2. **无重复无泄漏**：三条路径互斥且都在共享代码前 return（继续路径除外），`audit_usage` 至多一次；
   interrupted 结果本身不带 usage，`withAuditorUsage` 一律使用对应终态（cancelled/completed）的 usage。
3. **取消确认超时丢 usage**：cancellation deadline（5s）fire 时 park promise 以无 usage 的
   cancellationResult 结算 → bypass 分支 usage 缺失（fail closed，与现状行为一致，不阻塞提交）。

### UI 与输入

1. **弹窗期间二次 Esc**：goalModalDepth 守卫让键进入弹窗组件 → 提交默认值“继续审计”。连续 Esc =
   中断后立即恢复同一审计（非破坏性默认）。
2. **恢复阶段 Esc 无效**：首次 finally 已把 `auditAbortController` 置空；恢复阶段 `auditProgress` 非空但
   `abortAudit` 因 controller 为 null 提前返回——键被消费但不中断审计（行为有界，文档化限制）。
3. **无 UI/headless**：`showEscapeDialog` 回退“继续审计”→ 中断后自动复用同一子代理到终态（比现状回退
   continue_working 且审计已死的行为更好）。
4. **progress 抑制**：parked 标志抑制 safeProgress 与 dashboard 推进（弹窗期间 `auditProgress` 保持
   null）；`resume()` 复位后 UPDATE 回传恢复。

### 运行时与兼容

1. **turn 中断（Ctrl+C 等）**：审计是 `update_goal` 工具调用的一部分，子代理生命周期由 pi-subagents 随
   会话清理；park 不改变此边界（非目标）。
2. **unfocus 与 ESC 竞态**：unfocus 对已置空的 controller 的 abort 不动作；焦点丢失统一由弹窗后
   `isFocusedOperationCurrent` 兜底（先 `cancel()` 杀孤儿再返回焦点丢失结果）。
3. **abort 单次**：signal 监听 `{ once: true }`，同一流程至多 park 一次；park 后外层已结算，后续 abort
   事件被 `settled` 守卫忽略。
4. **桩兼容与防御**：分支入口 `auditor.interrupted && auditor.session` 双真才走新路径；无 session 的桩
   落到旧 `error === "Auditor aborted."` 分支，行为不变。

## Risks / Trade-offs

- **弹窗期间子代理继续运行**：通常数秒，且子代理仍在做审计工作而非纯空闲；terminal timeout 兜底限制
  最坏情况。已在 PRODUCT 中与用户确认可接受。
- **绕过分支多一次往返**：`session.cancel()` 需等待取消终态（真实环境通常毫秒级；cancellation
  deadline 5s 兜底）才能拿到 usage 记账，绕过完成会略有延迟。
- **二次 Esc 在恢复阶段无效**：恢复后 `auditAbortController` 为 null，恢复期间再按 Esc 不中断审计
  （键被消费但不动作），行为有界且可预期。
- **测试改动面**：`goal-delegation-completion.test.ts` 中 Esc 相关用例从“cancel 事件断言”改为
  “park 后 continue 复用同一 attempt / complete 时才 cancel”两条路径；mock 需要为继续路径补发
  completed RESPONSE。
