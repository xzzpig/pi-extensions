# Proposal

## Why

协调记录已经能随原 `update_goal` 工具结果回流,但用户在实际 TUI 里看不到也用不上:正文是一段 2 空格缩进的裸 JSON(含全部 UUID 字段),而 `update_goal` 的结果由 `goal-format.ts` 的渲染器压成紧凑卡片,`ctrl+o` 只展开 CustomMessage、不展开该卡片正文。结果是"数据回流了但不可读、不可见",审计问答对用户等于黑箱。

## What Changes

- 工具结果正文改为**人读摘要**:每条问答一组(原因 · 状态、问题、答复或未解决原因、短 ID),JSON 形态的访谈答复扁平化为 `key=value`,空答复/无原因给出确定措辞;正文不再出现 ASCII 花括号块。
- 机器可读性继续由既有 `details.supervisorCoordination = { records, usage }` 承担,结构与字段不变;usage 仍不进入模型可见文本。
- goal 结果渲染器新增协调记录展示:**折叠态一行**摘要(条数 + 原因 · 状态),`expanded` 态输出完整摘要;无问答时渲染输出与改动前逐字节一致。
- live E2E 驱动改为从 `details.supervisorCoordination.records` 读取记录,不再从正文刮 JSON;负向未解决判定与身份绑定强度不降。
- 不改变审计/旁路/路由/delegation 语义、工具 schema、终态枚举、ledger 事件与 usage 记账口径。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `goal-lifecycle`: 扩展现有「协调记录在原工具结果中有界回流」requirement,规定记录的**呈现形态**(人读摘要、无 JSON 块、空答复措辞)与 **TUI 展示**(折叠一行 + 展开全文、无问答零差异)。

## Impact

- 代码:`packages/pi-goal-x/extensions/goal-audit-supervisor-handoff.ts`(格式化与卡片 helper, fork-only)、`packages/pi-goal-x/extensions/goal-format.ts`(最小渲染接缝)。
- 测试:新增 fork-only `tests/goal-audit-supervisor-card.test.ts`、扩充 `tests/goal-audit-supervisor-handoff.test.ts`;`tests/e2e/goal-audit-supervisor-live.mjs` 改数据来源。
- 文档:`packages/pi-goal-x/docs/audit-supervisor-sidechannel.md` §7。
- 兼容性:无破坏性变更;无问答路径字节不变,`details` 结构不变,旁路 usage 记账口径不变。
