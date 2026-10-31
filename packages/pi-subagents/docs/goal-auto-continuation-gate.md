# Goal 自动续跑门禁接入

本说明记录 pi-subagents 如何响应 goal-x 的 `pi-goal:before-auto-continue:v1` 同步门禁。该监听器只延迟 goal-x 自己的 fallback checkpoint；不拦截子代理结果、监督请求、用户输入或其他原生唤醒。

## 状态来源与判据

| 工作阶段 | 读取的既有权威状态 | 门禁判据 |
| --- | --- | --- |
| Async / workflow root 仍在排队或运行 | `SubagentState.asyncJobs`，由 `SUBAGENT_ASYNC_STARTED_EVENT` 建立、session 恢复时由 `listAsyncRuns` 的状态投影恢复 | 只对 `queued` / `running` 且通过 `ResultDeliveryOwnership.owns(sessionId, completionOwnerId)` 的运行阻止。workflow root 是一个普通的活动 async job；嵌套/并行子任务不另建阻止计数。恢复与 live status refresh 均保留 `AsyncStatus.completionOwnerId`，新建 single/chain context 显式使用父扩展的 owner，确保此判据不会因状态投影丢失归属。 |
| 显式静默的定时运行 | 已投影的 `AsyncJobState.scheduleOrigin`（源自当前启动事件或 `AsyncStatus.scheduleOrigin`） | `scheduleOrigin.quiet === true` 不单独阻止续跑；其成功完成本来就不会触发父会话续跑。失败等可操作结果仍沿用原通知策略。 |
| Detached foreground 仍运行 | `SubagentState.foregroundControls`（当前扩展 session 的内存控制器） | 用现有 `ownsRun(state.currentSessionId, control.sessionId)` 复用 session succession 归属；不扫描会话文件或 transcript。 |
| Async 已终态、结果还未交给 notifier | 既有 `owedResultRunIds`，由当前拥有者的 `holdOwedResult` 在 job terminal 路径维护 | 只要仍欠一个拥有者结果交接，就阻止 checkpoint，覆盖 runner terminal 与 result watcher/notifier 之间的窗口。该 Set 原已用于 session liveness，不为门禁新增计数器。 |
| 通知正在发送或 Pi 已接受 wake、父回合尚未开始 | `CompletionNotifier.hasPendingWake()`：仅观察原 notifier 的 pending trigger-turn deliveries 和 `unstartedWakes`；`messageStarted` 按现有语义释放已启动 wake | 只有当前通知确实承诺 native turn wake 时阻止。显式 `triggerTurn:false`、quiet 成功结果、或当前 held 状态下没有已承诺的 wake 不阻止。 |

门禁请求用当前 SDK `session_start` 的 `sessionManager.getSessionId()` UUID 与 `state.supervisorOwnerSessionId` 精确匹配。Async / foreground 运行归属仍由现有 ownership helper 按它们自己的 session 标识处理；绝不把 session UUID 和 session-file path 当作可直接比较的同类字符串。

## 同步监听及生命周期

监听器在 `session_start` 恢复当前运行状态后安装；会话替换时先 dispose 旧 listener 再安装新 listener，`session_shutdown` / 扩展 reload 由 runtime cleanup 移除。listener 在首个 `await` 前完成所有判断，只通过请求的单向 `defer` 回调投票；本地权威状态读取异常时 catch 并用固定短原因 fail closed，不调用模型、不读磁盘，也不改变 notifier、子代理状态或 goal 生命周期。

## 明确不做

- 不解析任意 tool result、tool-call args/status/id 或任务文本来猜测后台工作。
- 不在门禁热路径扫描状态目录、result 文件、session transcript 或事件日志。
- 不新增 started/completed 计数器、等待/重试机制、用户设置、命令或持久化 schema。
- 不改变 `sendMessage`、结果去重/所有权、监督请求或 `message_start` 的交付顺序。
