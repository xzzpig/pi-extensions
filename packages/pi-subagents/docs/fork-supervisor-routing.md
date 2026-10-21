# Fork:监督请求路由(supervisor responder routing)

本文说明 pi-subagents 在本仓库中新增的 **fork-only** 接入:让父扩展按「精确的一次委派尝试」登记一个只读 responder,从而在该尝试的 supervisor 提问到来时**独占接管**,不唤醒主模型、不触发 detach。

上游(upstream)语义保持不变:普通 subagent / workflow 的监督行为、终态枚举、detach 状态转换与模型可见的工具 schema 都没有改动。

## 新增文件

| 文件 | 作用 |
| --- | --- |
| `src/api/supervisor-routing.ts` | 版本化父扩展 API:事件常量、类型、scope 校验、客户端调用 |
| `src/intercom/fork-supervisor-routing.ts` | 按 owner 分域的登记表、启动前绑定、接管 dispatcher、回复与清理 |

`package.json` 增加 `./supervisor-routing` 导出;**不提升版本**,不新增依赖。

## API

```ts
import {
  SUPERVISOR_RESPONDER_REGISTER_EVENT, // pi-subagents:supervisor-responder-register:v1
  registerSupervisorResponderViaEvents, // ({ pi, scope, respond, onFailure }) => { dispose() }
  type SupervisorResponderScope,        // sessionId + requestId + ownerRunId + nodeId + agent
  type SupervisorResponderRequest,      // requestId(提问 id) + reason + message + interview? + runId + agent + childIndex + deadlineAt + signal
  type SupervisorResponderOutcome,      // { kind:"reply", message } | { kind:"error", code, message }
} from "@xzzpig/pi-subagents/supervisor-routing";
```

契约要点:

* 复用 `runtime-agent-events.ts` 的**同步回执**模式:发出请求后立刻读回 `request.result`。owner 缺失、版本不支持、`ok:false` 或回执畸形都会抛出可执行的 Error;`dispose()` 幂等。
* **只接受完整 scope**:五个字段都必须是去空白后非空、长度 ≤ 256 且不含 CR/LF 的字符串;`agent === "*"` 被明确拒绝(禁止「仅按 agent 名接管」)。
* 同一 scope 重复登记被拒绝;旧 handle 的 `dispose()` 只移除自己。

## 启动前绑定(唯一的身份来源)

```text
runGoalCompletionAuditor
  → 生成身份三元组并登记(scope = sessionId + requestId + ownerRunId + nodeId + agent)
prompt-template-bridge.ts
  → executeStructured 增加内部可选第 6 参数 request(仅当完整请求解析通过时传入)
extension/index.ts
  → 由完整 scope 得到 launch hooks,作为可选第 6 参数传给 executeDelegated
subagent-executor.ts
  → createSubagentExecutor 用 WeakMap 存 hooks;在真实 runId 分配、canonical agent 解析之后、
    任何 child prompt 或工具启动之前调用 beforeNativeChildLaunch(runId, agent, childIndex=0,
    parentSessionId, bridgeActive)
```

绑定规则:

* 必须使用执行器**已解析的 canonical agent**,请求里的别名不能作为路由;不得从 child 自报字段推断;
* scope 只绑定一次;路由冲突、身份变化、已释放的登记、非法的 childIndex、空的 runId/agent 都在**任何模型调用之前**失败;
* `bridgeActive` 为 false 时不绑定,保持原行为。

## 独占接管

native supervisor channel 的 poll 在完成 owner / lifecycle 校验并写入 pending 之后、`parentWake.sendMessage` 与 detach 事件之前调用 dispatcher:

* claim 返回同步布尔值;命中时跳过默认唤醒与 detach,**不 await 模型**,因此不会阻塞其他通道扫描;
* 同一提问 id 的重复观察复用现有处理,不重复提问也不重复写回复;
* `progress_update` 保持原有快速路径;
* 其他路由保持原有的 pending + 唤醒 + detach 行为;
* 被接管的提问**不会**产生主模型提醒;通用 `subagent_supervisor` 的 reply 动作对被接管的提问返回明确错误(`responder-managed`)。

回复写入复用通道自身的 `writeReply` + `appendSupervisorReplyEntry`,并且在写之前重新确认:pending 请求仍存在、尚无回复文件、路由 owner 与 generation 仍有效、时间未过期。文件写入成功即为投递依据;journal 失败仍遵循既有「文件为准、最佳努力」策略,不撤回已写入的回复。

## 失败与清理

* claim 后启动、回答、投递或过期任一环节出错:先锁定 failed,再对同一 scope **至多一次**调用 `onFailure`,由父侧取消该次审计;绝不回退到默认通知或 detach,也绝不把错误当成「无人接管」;
* native 通道清理已不在 pending 的请求时会通知 dispatcher:已解决的保持 delivered,过期/不活跃/缺失则使未完成的模型请求失效并取消;
* owner session 重置、shutdown、reload 或登记 `dispose()` 都会释放绑定;普通(未登记)的调用保持原有行为。

## 与上游的关系(fork-divergence)

* 新增逻辑都在 fork-only 文件里;上游文件只保留**最小 seam**:结构化委派的第六参数、执行器内部的启动钩子、native 通道的 dispatcher 挂点,以及 `package.json` 的一个导出条目;
* 上游文件保持字节稳定,不做格式化,不手改 lockfile;
* 具体 seam 与 replay 记录见 `subtrees/pi-subagents.json` 的 `reapplyOnSync`;不为此新增 fork-only 模块填写维护债务。
