# 自动续跑与子代理唤醒门禁

## 目的与范围

启用自动续跑的目标会在每次正常执行结束后尝试发送一个 checkpoint。父模型若刚启动异步子代理并结束当前执行，子代理结果可能很快通过 Pi 的原生通知机制唤醒父会话；goal-x 的 checkpoint 不应抢先启动另一轮模型请求。

`pi-goal-x` 提供进程内事件 `pi-goal:before-auto-continue:v1`，让知道原生后台运行和结果交接状态的扩展（当前为 `pi-subagents`）同步阻止一次 goal 自动续跑。该事件仅门控 goal-x 自己的 checkpoint，不是通用后台任务依赖推断器，也不替代显式等待。

## 调用时机

门禁在原有 continuation timer 到期、goal 仍可执行且 Pi 会话没有 pending messages 并处于 idle 之后触发；它发生在领取自主运行额度、追加 goal 状态快照和发送 checkpoint 之前。

```text
原有 timer → readiness 检查 → before-auto-continue 事件
                                      ├─ defer() → 本次结束，不发 checkpoint
                                      └─ 未 defer → 原有授权、快照和 checkpoint
```

如果事件处理期间会话出现新消息、变忙、goal 失焦、暂停或被替换，发送路径会再次检查状态，不能用旧决定发出过期 checkpoint。

## 同步事件契约

请求携带协议版本、当前父会话 `sessionId`、`goalId`，以及 `defer({ owner, reason })` 回调。监听者应同步检查已经拥有的本地状态，并在事件处理器返回前调用回调。以下仅为伪代码；`hasNativeWakeWorkFor` 是占位判断，并非 goal-x API：

```ts
pi.events.on("pi-goal:before-auto-continue:v1", request => {
  if (hasNativeWakeWorkFor(request.sessionId)) {
    request.defer({
      owner: "example-extension",
      reason: "Current-session work will wake the parent natively.",
    });
  }
});
```

Pi 的 `events.emit()` 不等待监听器 Promise，也不使用监听器返回值作决定。若监听器是 `async`，必须在第一个 `await` 之前完成状态判断和 `defer()`；异步迟到回调不生效。任一监听者的 `defer()` 都是单向 veto，其他监听者不能覆盖为放行。reason 只供扩展间诊断，不写入会话、goal 账本或模型上下文。

没有门禁监听者时，goal-x 沿用原来的授权、状态快照、checkpoint 与回合行为。

## 子代理与原生唤醒

`pi-subagents` 只应为**当前父会话拥有、且完成/监督结果会通过原生机制唤醒该父会话**的运行 veto。已确认纳入的运行与终态交接范围由其 fork-only 适配器及直接测试定义；不能根据任意工具返回的文本、通用 `status`/`id` 字段、其他会话的运行或仅用于展示且不会唤醒父会话的任务推断阻止条件。

Veto 不取消子代理，不改变结果交付、去重、监督请求、child 终态或 parent-wake ownership。任何子代理结果或监督请求仍可照常送达并启动父模型；处理完后 goal-x 按原有 settled/scheduler 流程决定是否再次续跑。

## 被阻止后的行为

一次 `defer()` 只结束当前自动发送尝试：

- 不领取自主运行次数或等待检查额度；不增加 checkpoint 序号。
- 不追加状态快照或 checkpoint，不启动模型回合。
- 不创建额外 retry timer、轮询、解除事件或持久化等待状态；目标保持原生命周期状态。
- 原有 50ms readiness 重试保持不变，它只用于 Pi 会话在发送检查时尚未 idle 或仍有消息的情况，不用于轮询被 veto 的子代理。
- 用户输入和原生子代理/监督唤醒不受阻。没有结果通知而又不再发生其他事件时，本机制不会自行轮询；用户仍可继续交互或使用现有恢复入口。

## 与 strict execution contract 的关系

门禁只在调度器已经允许进入自动 checkpoint 发送路径时运行。`strictExecutionContract` 的 `ready`、`wait`、repair、deadline、额度和暂停规则均保持不变；本事件不会把缺失的执行 disposition 自动改成 ready，也不会替代模型声明等待。

## 接入提示

扩展应在拥有会话运行状态之后注册监听，并在 session shutdown、reload 或 session replacement 时清理会话级资源。仅在处理同步请求时查看当前会话的权威内存状态；不得扫描磁盘、启动模型、等待异步结果或对不同父会话共享 veto。若自有状态读取出错，应在监听器内部捕获并同步 fail closed；Pi EventBus 会隔离监听器异常，不能依赖异常向发射方传播。
