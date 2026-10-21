# Design

## Context

协调记录已随 `update_goal` 工具结果回流,但两处不可用:正文是裸 JSON;`update_goal` 结果由 `packages/pi-goal-x/extensions/goal-format.ts` 的 `renderGoalResult` 渲染成紧凑卡片,`ctrl+o` 只展开 CustomMessage,不展开该卡片正文。pi 的 `ToolExecutionComponent` 会优先使用工具注册的 resultRenderer,因此"只改正文文本"在 TUI 里不可见。

## Goals / Non-Goals

- Goals:正文人读化且无 JSON 块;TUI 折叠一行、展开全文;无问答零差异;自动化消费方改用结构化 details。
- Non-Goals:不改审计/旁路/路由/delegation 语义、工具 schema、终态枚举、ledger 事件、usage 记账口径;不改其他 goal 工具的渲染行为;不引入新配置项。

## Decisions

### D1 正文格式(数据层)

`formatSupervisorCoordination(records)` 输出固定形状:标题行 + 每条一组

```text
1) 需要决策 · 已送达
   问：…
   答：… / 未解决：…
   记录：ask <8> · audit <8> · run <8>
```

- 状态映射:delivered→已送达、failed→失败（未解决）、cancelled→已取消;原因映射:need_decision→需要决策、interview_request→请求访谈、progress_update→进度更新。
- 未知原因/状态**保留原文**;映射查表用 `Object.hasOwn`,避免读到 `constructor`/`toString` 等原型成员。
- 值渲染:JSON 对象/数组先 `JSON.parse` 再扁平化为 `key=value`(嵌套同规则、数组用「、」、null→「空值」);其余文本经 `braceFree()`(折叠空白 + `{`→`｛`、`}`→`｝`)。键名同样过 `braceFree`。
- 空答复 → `答：（无答复内容）`;无原因的 failed/cancelled → `未解决：（记录未附原因）`;不输出 undefined/null 字面量。
- 同一输入逐字节确定:无时间戳、无随机、无本地化差异。

### D2 显示层(渲染接缝)

- fork-only 模块 `goal-audit-supervisor-handoff.ts` 导出单一入口 `goalCardCoordination(result, text, expanded)`,返回 `{ text, suffix }`:
  - 无结构化记录 → 原样返回 text、suffix 为空(上游渲染逐字节不变);
  - 有记录 → 用 `formatSupervisorCoordination(records)` 生成的**确切附录文本**从 text 中剥离(`lastIndexOf`,找不到就原样),suffix 折叠态为一行 `审计协调记录 N 条（原因 · 状态；…）`、展开态为完整记录。
- 上游 `goal-format.ts` 只保留最小接缝:一行 import + `first`/`card`/`firstText`/`out(text + card.suffix)` 四处调用;数据提取与剥离逻辑不得留在上游文件(fork-divergence 纪律)。
- 剥离按确切附录文本而非标题匹配:标题可能出现在报告或答复正文里,按标题截断会破坏内容。
- 重复渲染防护:正文已带记录时先剥离再按态重渲染,因此折叠态不会整块倾倒、展开态不会出现两份。

### D3 自动化消费方

live E2E 驱动从 `message.details.supervisorCoordination.records` 读取记录;正文断言只检查"人读摘要存在且无 JSON 块",负向 unresolved 判定仍要求 `deliveryStatus=failed` + 非空 `unresolvedReason` + 非空 question + runId 匹配;摘要断言接受「答：」或「未解决：」。

## Risks / Trade-offs

- 扁平化会改变 JSON 答复的可复制形态(键值对而非原 JSON):机器可读副本仍在 details,风险可控。
- 折叠态只给一行摘要,细节需展开:这是为了让卡片在长报告下仍可读;展开态保证全文可达。
- 上游渲染器仍有小接缝(4 处调用):以 fork-divergence 记录与 fork-only 测试守护,避免上游文件继续膨胀。
- 卡片文本会进入模型上下文(正文是模型可见的):摘要化降低噪声,但记录内容仍可能较长;容量上限沿用既有 96 KiB 记录上限,不新增开关。

## Migration

无迁移。无问答路径字节不变,`details` 结构不变,旁路 usage 记账口径不变。
