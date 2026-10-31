# 技术设计

## 背景

动机见 proposal.md。当前 `goal-events.ts` 在 `agent_settled` 调用调度器；`goal-runtime.ts` 的 `sendQueuedContinuation()` 负责最终 readiness 检查并调用 `authorize`，后者领取调度额度，再发送状态快照与 checkpoint。创建、恢复及定时入口也汇入此发送路径，因此门禁必须接在公共发送路径，不能只接 settled handler。

Pi 1.4 的 `events.emit()` 返回 void，内部不会等待异步监听者或收集返回值。仓库 `runtime-agent-events.ts` 已使用同步 payload 回填协议。本设计沿用这个限制，不修改宿主。

原生 subagents 具备 asyncJobs、foregroundRuns、结果交接归属与通知队列；不能用 Fleet 的展示状态或“某工具返回 status/id”替代原生唤醒契约。上游 #83 的拒绝理由适用于通用字段推断，不妨碍生产者显式参与。

## 目标与非目标

**目标：**

- 只增加最后发送前的可否决事件，避免父模型在原生子代理运行期间被 goal 兜底唤醒。
- 两个包各自拥有 fork-only 模块，通过极小上游接缝接入。
- 被阻止不留下已领取 dispatch、孤立快照、待重试 timer 或永久阻止标志。

**非目标：**

- 不修改原有 50ms timer、settled 入口、strictExecutionContract、repair、等待 deadline、网络恢复与 idle pacing 策略。
- 不提供通用后台任务依赖推理、完整租约系统、解除事件、事件触发后的轮询或新的运行模式。
- 不拦截真实结果、用户输入、监督请求，不修改审计旁路、子代理启动与结果终态，不保证通知损坏时无人值守自动恢复。
- 不新增 UI 布局、模型提示、持久化 schema、设置、命令、依赖或 README 章节。

## 决策

### 1. 事件位于 timer 之后、授权之前

发送顺序固定为：

```text
原有 timer 到期
  → 原有 actionable / idle / pending 检查
  → 获取当前 goal
  → 同步发送门禁事件
  → 任意阻止：结束本次尝试
  → 再校验当前 goal 身份和宿主 readiness
  → 原有 authorize / claim
  → checkpointSeq 递增
  → 状态快照 + checkpoint
```

在 `GoalRuntimeHooks` 增加同步、可选的发送门禁 hook；在 `goal-state.ts` 的 hooks 接线调用 fork-only goal 事件模块。缺省 hook 放行，不破坏现有 runtime fixtures。`goal-runtime.ts` 只保留调用与提前返回的最小接缝。

二次校验用于处理同步监听者导致的状态变化；若此时变忙，复用原 readiness 处理，不绕过 pending 消息。不得把 hook 塞进 claim 事务内：被阻止时不应创建或消耗 dispatch，也不应触发授权失败暂停。

替代方案：只在 settled 发事件会漏掉其他入口；先 claim 再 veto 需要回滚额度；直接取消 timer 或全局调大 50ms 都不是本变更。

### 2. 单向同步协议

事件名固定为 `pi-goal:before-auto-continue:v1`。payload 只包含只读的 `version: 1`、`sessionId`、可选 `sessionFile`、`goalId`，以及 `defer({owner, reason})`。所有身份来自当前有效宿主上下文，不暴露 ctx、goal 可变对象或 sessionManager。

事件发射器以闭包持有本次阻止结果，不将可覆盖的 `blocked` 布尔值放在 payload 上。`defer` 只能把结果变为阻止；理由采用固定短诊断码/有界文本，不写入模型上下文。派发使用 try/finally 关闭回调窗口，异步迟到调用无操作；协议明确要求监听器在首次 await 前完成全部判定。payload 可冻结，但此机制不是恶意扩展隔离或安全沙箱。

goal-x 拥有发射模块；subagents 拥有兼容该协议的结构校验与监听模块，不新增反向包依赖。事件字面量和结构的契约测试跨两个实际模块检查，防止漂移。

宿主会吞掉监听者抛出的异常，不能声称事件总线天然 fail-closed。subagents 的适配器必须自行捕获必要状态读取错误并调用 defer；其他第三方监听器未响应视为未阻止，不提供不存在的全局错误保证。

### 3. 原生状态只读判定

subagents 在当前会话启动并完成原生状态恢复后安装监听；复用 currentSessionId、宿主 session ID/file 及已有会话归属解析，不能直接拿文件路径与 UUID 做不匹配的字符串比较，也不能让其他父会话运行阻止本会话。

只读候选来源：

| 状态                                                            | 门禁处理                                          |
| --------------------------------------------------------------- | ------------------------------------------------- |
| 当前父会话拥有的 queued/running async，原生完成通知会唤醒父模型 | 阻止                                              |
| detached foreground，原生终态/监督请求会唤醒父模型              | 阻止                                              |
| 顶层 workflow 根仍运行或交接                                    | 按根判断，避免对嵌套 child 重复承担交接           |
| 已终态但结果尚未进入原生父会话交接                              | 阻止                                              |
| 结果已交接，且没有其他候选工作                                  | 不阻止；宿主 readiness 处理已启动或排队的结果回合 |
| 其他会话、显式 triggerTurn:false、只展示且无原生唤醒契约        | 不阻止                                            |

实现时先列出已有运行与 notify 状态的实际所有者、交接完成标记，再将必要的只读查询回调注入 fork-only 模块。不得另建 started/complete 计数器、扫描状态文件或通过工具调用查询 RPC。若通知队列状态未暴露，增加最小只读查询接缝；不改投递顺序、重试、去重和 ownership。

“结果交接完成”必须复用现有 delivery/parent-wake 接受语义，不能只用 child status=complete 或从 asyncJobs 消失来证明。原生 sendMessage 已接受但结果回合尚在启动时，要用现有 wake pending/交接状态覆盖这个窗口，不能让 goal 再发一轮。

### 4. 阻止结束本次尝试，不创建新等待系统

timer 回调进入时已清理 scheduledFor/timer；veto 后直接返回。scheduler 保持尚未领取的原意图，不新写 waiting/paused 状态，不创建 checkpoint、不推进 used、remainingChecks 或 checkpointSeq。内存 armed generation 不得使已结束尝试重新发火；后续正常 schedule 会重新建立授权候选并重新发门禁。

原生结果或监督请求启动父模型后，原有 begin/settled 流程自然继续；多个子代理中任一结果都能唤醒，其他仍运行时下一次 goal 自动续跑可再次被阻止。用户主动输入、暂停、恢复照常，不添加强制绕过或特殊命令。若结果通知损坏，用户输入和原有控制命令是恢复途径；不在本变更中添加兜底轮询。

strict 模式在到达发送前产生的 repair/暂停仍按既有规则处理。本门禁不替代显式执行契约，也不声称修复 strict 模式的缺失 disposition。

### 5. 生命周期与 fork 接缝

- goal-x：fork-only 发射/协议模块，runtime 可选 hook 与 state 接线最小接缝。
- subagents：fork-only 判定/监听模块，扩展 session_start/shutdown/reload 接线和必要只读 notify 查询。
- 每个监听 disposer 属于当前会话，替换前先释放；迟到请求身份校验后忽略。复用已恢复的权威状态，不把 veto 持久化。
- fork-only 测试和文档；更新测试清单；只为实际上游接缝更新 reapplyOnSync。遵循字节稳定要求，真实 NOISE/DELETED 不得静默豁免。
- 增量规格只修改原跨包范围要求以允许本次接缝，并保留其既有场景；新增要求明确本次补充兼容性差异，其他审计 D/I 不变。

## 风险与取舍

- **无唤醒任务被错误纳入会永久阻止** → 必须证明通知契约，不从通用字段猜测；显式无唤醒任务设负向用例。
- **终态与结果入队存在空窗** → 用真实 notify/parent-wake 状态测试交接之前、已接受、父回合启动三个阶段。
- **事件监听错误被宿主吞掉** → 自有适配器捕获并同步阻止，固定诊断；不声称保护恶意或不合规第三方。
- **停止本次尝试不主动重试** → 有意保留最小范围；通知失败时允许用户交互恢复，不自动新增 timer。
- **拦截可能推迟跨轮次独立工作** → 仅影响父模型结束后的 goal 自动兜底，当前轮次及用户/真实结果唤醒不受限；不增加“工具调用就是进展”的推理。
- **多入口或旧会话绕过** → 公共最终发送门禁，覆盖创建/恢复/定时路径，并测试 stale context、focus 和 reload。

## 验证与迁移

先做 runtime 与协议单测，再用真实 Pi EventBus 和两个实际扩展模块做无网络集成，验证 emit 返回值无效、同步回调有效、迟到回调失效。通过 fake clock 证明阻止后没有新增 50ms 重试、快照、模型请求或额度消耗；未阻止路径与原 golden 对照。

最后在隔离临时目录以真实 Pi、真实模型和持久 tmux 运行 async 不显式 wait、监督请求、结果回流场景，按 e2e skill 录制 asciinema，自动检查父模型请求来源。不得修改真实用户 goal 或配置。该层不可执行时报告具体阻塞，不以 mock 结果替代 live 证明。

无需存储迁移。两包同时更新后生效；只加载 goal-x 或未安装监听器时保持旧行为。回滚移除两端 fork 接缝与模块即可，已有目标记录无需转换。部署/发布不属于本次规划授权。
