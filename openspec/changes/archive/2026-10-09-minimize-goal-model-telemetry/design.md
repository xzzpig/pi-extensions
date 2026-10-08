# 主模型新生成内容精简设计

## Context

用户通过 goal-tweak 明确收缩范围：只抑制 Goal-X 新生成的插件遥测，不处理会话中已经持久化的旧消息或旧工具返回。第一版为旧会话清洗建立的生成布局匹配、半条 JSON 解析、cursor 链重组不再属于功能要求，必须删除，而不是继续增加例外。

本 change 在既有 `goal-lifecycle` 下添加契约；不改其它能力。主模型输出渠道包括 active request-only prompt、新生成的 goal-context/state、目标工具 content、新历史查询、审计拒绝反馈与压缩恢复。宿主负责自动压缩，本包不新增上下文阈值或停止策略。

## Goals / Non-Goals

### Goals

- 新生成内容不输出上下文占用/容量/百分比/unavailable、累计耗时、无有效预算的累计消费、无限额度的运行计数及插件审计花费。
- 保留真实 lifetime spending cap 与有效预算读数、有限/零运行约束、任务/契约、wait/admission、阻塞、审计原文及恢复信息。
- 分离模型 content 与 UI/内部 details/usage，保持账本和 auditor/Oracle 输入不变。
- 用新内容组合请求与真实 SDK pre-dispatch 捕获验证，不新增付费调用。

### Non-Goals

- 不清洗或请求时重投影已经持久化的旧 Goal-X 消息、旧工具返回、旧分页结果或宿主压缩 prose。
- 不承诺混有旧历史的整个 SDK payload 无遥测，不重写原始 session/ledger，不防止模型直接读原始文件获得统计。
- 不新增开关、工具、依赖、数据迁移、JSON 碎片解析或 cursor 链重组；不清理无关 settings/harness 债务。
- 不归档 change、不更新版本/lockfile、不提交、发布、推送或安装全局包；保留用户 settings 并发编辑。

## Decisions

### D1：生成边界选择主模型视图

保留小型 fork-only `goal-model-view.ts`：`goalModelPromptParts` 生成策略与有效预算/运行读数；`goalModelDetailedSummary` 用于创建/完成工具 content；`goalModelAuditRejectionText` 仅去掉插件生成的审计成本表头。保留新历史查询所需的事件字段选择，但不解析已序列化历史或猜测消息身份。

禁止清零 usage、修改共享 `detailedSummary()` 或全局 token/百分比替换。完整 auditor task 和 UI 通知继续使用原权威格式化。共享生成器中只做必要的最小预算文案接缝，用户原文不经正则清洗。

### D2：自动输入先精简，再使用既有 retention

`goal-events.ts` 的 active 分支只调用 `goalModelPromptParts`，不读取宿主 `getContextUsage`。context handler 回到既有 display-only filter 与 checkpoint 规范化，不做旧消息遥测投影，也不为历史读取额外 settings。

无动态约束时不生成 counters 或空 Limits；有效预算或可展示的有限运行额度时只保留必要读数。有限/零额度的执行含义始终保留，showAutonomousRuns 只控制计数展示。使用既有 request-only retention 的会话/模型身份、上界和失效规则；不追溯清洗旧持久消息。

### D3：新工具 content 与 UI 分离

`get_goal` compact/verbose、新创建和新完成返回使用模型视图；任务与草稿返回不得引入累计统计。`details.goal` 和内部 `.usage` 不变，Goal-X 不声明 `outputSchema` 或 structuredContent。`renderGoalResult` 通过 fork-only `goal-model-display.ts` 的 restoreDisplayUsage 在确定的生成摘要边界用 details 恢复 create/completion 卡片的 Time spent/Tokens used，不改模型 content。

批准成本行只用于 display-only audit card；拒绝工具 content 仅剥离插件成本表头。auditor 报告、findings、feedbackNotes 和错误原因原样保留，报告中即使引用完整摘要也不进行历史投影。

### D4：新历史查询在分页之前选字段

仅在构造新 `get_goal(history)` 返回时，根据事件类型过滤 audit_usage；无当前有效预算时选择 budget changed/limited/warning 的执行字段，保留 oldBudget/newBudget/budget、时间和自由文本。近期摘要先排除 audit_usage 再截取。

字段选择发生在序列化与既有 4000 字符分页之前；继续使用既有内容 hash 与 cursor。新查询传入按当前预算选择的历史数据，但不把原始账本 revision 当作这种 caller-owned 视图的缓存代次；沿用既有无 revision 时的内容校验，避免预算变化复用错误缓存。删除只服务旧请求投影的版本缓存和 revision-token 改造。cursor 与最终返回内容不匹配时沿用 invalid/stale 提示；内容未变不要求额外失效。objective/tasks 页无损。已存于 session 的旧页不处理，无论是否完整、单页、后续页或部分 cursor 链。

### D5：压缩恢复只约束新内容

保留 session_before_compact 记账、session_compact 完整目标上下文重发与续跑、compaction failure active 状态。新 post-compaction delta 保留任务/契约/未解决审计 finding，只过滤生成摘要的纯消费事件。可调用 compact-summary helper 使用同一新内容边界，但不把无 runtime caller 的 helper 描述为实际宿主 summary。旧宿主摘要不清洗。

### D6：删除与维护纪律

删除 `goal-history-view.ts` 和 `goal-model-view.ts` 的全部旧消息请求投影、布局匹配、旧 budget/run gate 追溯处理及 JSON 前缀/后缀解析。删除仅为这些要求建立的测试和 SDK fixtures；保留新输出、UI、ledger 不变与 SDK 配对测试。撤销无用上游接缝，必要接缝保持上游字节/缩进稳定。

按实际 inventory 更新 subtree reapplyOnSync/doNotReintroduce，去掉真实失效条目，不给 fork-only 自有逻辑新增维护义务。manifest 用既有 writer 更新。README 不扩写。

## Risks / Trade-offs

- 旧历史可能含遥测或过期预算读数：这是明确接受的效果边界，不是本 change 的新清洗任务。说明与 SDK 旧历史负例要验证原样保留。
- 新工具查询可能重新暴露账本统计：所有新 content 渠道与生成前事件选择均需正负断言。
- UI/审计输入可能被薄化：同 fixture 比较 content、renderer、details/usage、完整 auditor summary；审计原文按精确出现次数验证。
- 删旧回归可能被误解为削弱门禁：只删已经移出规格的历史清洗用例；保留新的信息边界、既有上游测试及已批准例外门禁。
- 文档证据陈旧：先重置新范围矩阵到待执行，最终填真实测试数/命令结果，不能继承旧 24 项专项绿灯。

## Migration Plan

无需设置或数据迁移，重载后新生成内容使用新视图；建议新会话观察效果，旧会话中的既存消息允许继续重放。回退只撤销本 change 源码/测试接缝，不恢复、重置或擦除用户 goal、预算、焦点、session 或 ledger。

## 验证策略

覆盖 99%/unavailable、无预算/有效预算/预算删除、有限/无限/零/隐藏运行计数、wait、各 goal 状态、创建/草稿/完成/审计拒绝、生成前历史字段选择及分页、压缩恢复、用户原文和 UI/internal/auditor 兼容。旧消息原样保留用例是边界证明，不要求旧历史无遥测。

所有命令从仓库根 direnv/Nix 环境执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @xzzpig/pi-goal-x run typecheck
pnpm --filter @xzzpig/pi-goal-x run test:all
pnpm --filter @xzzpig/pi-goal-x run test:selfcheck
pnpm --filter @xzzpig/pi-goal-x run context:gate
pnpm --filter @xzzpig/pi-goal-x run context:provider-check
pnpm run audit:fork-divergence
pnpm exec prettier --check openspec/changes/minimize-goal-model-telemetry
git diff --check && git diff --cached --check
openspec validate minimize-goal-model-telemetry --type change --strict --no-interactive
```

fork-only 模型视图单测与两种 SDK worker 需通过；SDK 捕获在网络 dispatch 前终止。格式化只作用于计划/metadata/fork-only 文件，不格式化上游源码。context:measure 若执行只写临时路径，不改 baseline。

## 用户批准的验证例外

以下是保留的门禁例外，与本次删除旧历史功能要求是两件事；不得通过改运行时、旧门禁或 baseline 把它们变绿：

- test:all 仅允许 validation.md 逐项列出的九个 integration settings/profile 用例失败。
- context:gate 仅允许既有 24 fixture baseline/semantic drift、旧 Goal snapshot/双尾断言及 audit-rejection-and-rework、completion-audit、guided-drafting-question、guided-proposal、tasks-disabled 的 capture/profile 类别。
- provider-check 仅允许 active-regular-no-tasks 的 get_goal/create_goal system-prompt 工具行顺序差异；Responses 三态 compatibility pre-dispatch 段须通过。

其它新失败须停止并询问。所有真实结果记录到 validation.md，后续未执行的 provider 捕获不冒充通过。
