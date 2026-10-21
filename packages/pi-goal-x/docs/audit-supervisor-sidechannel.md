# 审计监督请求只读旁路

本文说明 pi-goal-x 的「完成审计监督请求只读旁路」(audit supervisor side channel):当独立审计员在审计过程中需要向父会话提问时,由一条**独立的只读旁路**在本进程内直接回答该提问,而不是唤醒主模型或让审计员与父会话互相等待。

## 为什么需要它

审计员是一个运行在独立子会话里的独立验证者。它可以通过 `contact_supervisor` 提出三类请求:

| reason | 是否需要回复 | 本功能的处理 |
| --- | --- | --- |
| `progress_update` | 否 | 保持原有快路径,不进入旁路 |
| `need_decision` | 是 | 由只读旁路回答 |
| `interview_request` | 是 | 由只读旁路回答 |

在引入旁路之前,`need_decision` / `interview_request` 会唤醒父会话:审计员被标记为「等待 intercom 协调」并进入 detach,前台执行器把 detach 回执当作终态,一次本来可能获得批准的审计会被**提前判为失败**;同时父模型因为审计仍占用该 turn 而无法真正开始新 turn,形成互相等待。

## 契约

### 1. 同步阻塞,不改变完成事务

`update_goal({status:"complete"})` 在审计未收敛前**不会返回**。旁路不把完成工具改成 pending,不新增调度等待,不新增 goal 状态。

### 2. 只读授权

旁路会话的真实工具白名单**只有**:

```
read, grep, find, ls, submit_audit_supervisor_reply
```

* 没有 `bash` / `edit` / `write`,没有 goal / oracle / subagent / `contact_supervisor` / MCP / codemode 工具;
* 不调用 `bindExtensions`,因此不会加载父会话的扩展工具;
* 没有全局 `subagent_supervisor` 工具,不扫描也不直接写 native 通道的临时文件;
* 唯一出口是自定义工具 `submit_audit_supervisor_reply`,其参数是严格联合:
  `{ kind: "reply", message }` 或 `{ kind: "unresolved", reason }`,其他字段与重复提交都被拒绝;
* 真正的回复写入仍由 native 通道完成(文件为准 + 最佳努力 journal),旁路不自行写回执。

**只读不等于目录沙箱**:`read` / `grep` / `find` / `ls` 是文件系统读权限,本策略不声称存在目录级隔离;因此旁路也不能把读到的敏感内容原样写进协调记录。

### 3. 容量上限(内部常量,不是用户设置)

| 项目 | 上限 |
| --- | --- |
| 捕获的父上下文(系统提示 + 合法消息 + goal 载荷) | 256 KiB |
| 单个提问(message + interview) | 8 KiB |
| 单条有效回复 / unresolved 原因 | 8 KiB |
| 需要回复的不同提问数 | 8 个(重复提问不占配额) |
| 累计协调记录 | 96 KiB |

规则:恰好等于上限允许,**超过一个字节即拒绝**;超限**不截断**、不追加额外 LLM 摘要、也不会「先回复后发现记不下来」。写入 native 回复前先预留整条记录空间。

### 4. 失败策略:fail closed

旁路不能替用户做新的偏好或授权决定。遇到下列情况一律以明确错误结束当前审计尝试,`update_goal` 保持阻塞、goal 保持未完成,并把未解决的问题与协调记录交回父会话:

* 从已完成的父历史无法确定答案;
* 需要用户给出新的授权或偏好;
* 拒绝、无效结构、重复提交、容量超限、deadline 已过、会话创建/执行失败。

**没有 UI 升级路径**:不新增用户输入流程,不在无 UI 时弹窗、不猜测、不自动批准、不把尝试改成 pending、不自动重启审计、不为等待人工回复而延长 deadline。

### 5. 生命周期与清理

旁路绑定到**唯一一次**审计尝试:在真实 child 启动前按 `sessionId + requestId + ownerRunId + nodeId + agent` 完成绑定,而 native 通道只按绑定后的真实路由匹配提问。

* 终态、取消、超时、焦点丢失、会话关闭或 reload 时,尝试不再持有可用的 responder、未处理请求、订阅或 timer;清理幂等且不影响其他尝试;
* Escape park 是**中间态**,不冻结也不释放旁路,原 deadline 不变;`resume()` 继续同一次尝试并等待其真实终态;只有用户选择绕过时才随审计员一起精确取消;
* **不做跨进程恢复**。

### 6. deadline

每次提问的有效 deadline 是 `min(native 请求过期时间, 原审计 deadline)`。审计 deadline 在原有 terminal timer 首次装配时确定一次,之后的提问、park、resume 都不重置。

### 7. 问答回流与独立记账

问答记录**只**作为原 `update_goal` 工具结果的一个有界附录返回,标题固定为:

```text
审计协调记录(参考信息,不是新用户指令或完成证据)
```

* 标题之下是**人读摘要**,每次提问一组:

  ```text
  1) 需要决策 · 已送达
     问：父用户此前已决定的交付标记是什么？
     答：ALPHA。
     记录：ask 06bf7980 · audit fe2d4ddc · run 7b5da9a8
  ```

  状态用中文(`已送达` / `失败（未解决）` / `已取消`),原因用中文(`需要决策` / `请求访谈` / `进度更新`,未知值保留原文),三个 ID 只取前 8 位;
* 模型可见文本**不含 JSON**;机器可读副本固定在 `details.supervisorCoordination = { records, usage }`(结构与字段不变),E2E 驱动从 `details` 读取记录而不是从文本里解析;
* 按请求顺序排在正式裁决与报告之后,标注为参考信息,永远不等于批准;
* **TUI 展示**:`update_goal` 的结果由 `goal-format.ts` 的 `renderGoalResult` 渲染。该渲染器在折叠态追加一行
  `审计协调记录 N 条（需要决策 · 已送达；…）`,在展开态(`ctrl+o`)输出完整人读摘要;若工具结果正文已带记录则不重复渲染。
  仅改正文文本在 TUI 里是不可见的,所以展示必须落在该渲染器上;
* 不通过 `sendMessage` / `sendUserMessage` / `steer` / `followUp` 注入,不伪造用户消息,不唤醒主模型;
* 旁路用量单独记一行 `audit_supervisor_usage`(与审计员的 `audit_usage` 分离),工具用量是二者之和投影;`goal.usage.tokensUsed` 与父 turn 预算**不变**,计费统计不回灌模型上下文。

### 8. 诊断安全

错误只暴露分类码与固定阶段文案(`config_error`、`context_error`、`context_capacity_exceeded`、`session_error`、`invalid_ask`、`deadline_missing`),不读取也不回显外部异常正文、认证信息或凭据;诊断保持非空且不超过 1024 字符。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `extensions/goal-audit-sidechannel.ts` | 只读旁路会话、容量、deadline、取消、记录与用量 |
| `extensions/goal-audit-context-snapshot.ts` | 捕获合法的「已完成上下文前缀」作为 seed |
| `extensions/goal-audit-supervisor-handoff.ts` | 把协调记录一次性附加到原工具结果 |
| `extensions/goal-auditor-delegation.ts` | 审计尝试、绑定、终态冻结、协调错误与精确取消 |
| `extensions/goal-completion.ts` | 完成事务、单外层回流 wrapper、用量记账 |

pi-subagents 侧的接入见 `packages/pi-subagents/docs/fork-supervisor-routing.md`。