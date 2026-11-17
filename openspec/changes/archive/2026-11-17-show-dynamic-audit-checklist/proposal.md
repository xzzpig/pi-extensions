# 动态完成审计检查清单

## Why

当前审计 dashboard 使用固定五阶段和百分比推算状态，与 auditor 实际收到的默认/替换清单及 `checklistExtra` 脱节，结束时还会自动将前四项显示为通过。用户需要看到本次真实清单及 auditor 逐项报告的状态，而不改变目标完成的判定门槛。

## What Changes

- 审计开始时生成一份实际生效清单快照，供提示词和 dashboard 共用：显式 `checklist` 替换默认清单，随后追加 `checklistExtra`；保留默认条件项规则和显式空数组语义。
- 扩展 child-only `report_auditor_progress`，支持按唯一检查项 ID 上报待检查、检查中、通过、不通过及简短依据；清单不允许由 auditor 临时增删改。
- **BREAKING（展示契约）**：以动态清单替代固定五阶段和百分比状态推算；终态不自动补勾。保留旧 label/percentage 上报兼容，但不以其推导逐项状态。
- 紧凑视图展示已检查/总数、通过/不通过数量及当前项；展开视图支持完整清单、依据和工具诊断的有界滚动。
- 最终结构化 verdict 继续独立决定审计批准；缺少进度上报、未检查项或失败项均不成为新的完成 gate，全项通过也不能代替 verdict。
- 保持同一审计挂起/继续的清单和状态、精确 attempt 隔离、结果卡、失败关闭及现有完成事务；不增加主模型提醒或持久化版本。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `goal-lifecycle`：修改审计可视化、进度投影及兼容性基线，增加清单快照、逐项上报和展示/完成判定分离的行为契约。

## Impact

- `packages/pi-goal-x/extensions/goal-auditor.ts`、`goal-auditor-progress.ts`、`goal-auditor-registration.ts`、`goal-auditor-delegation.ts` 的提示词、进度类型和解析链路。
- `widgets/auditor-dashboard-model.ts`、`widgets/goal-dashboard-renderer.ts`、`widgets/goal-widget.ts` 及必要的 widget 键盘/滚动接缝。
- fork-only 清单/状态模块、测试与详细文档；更新 `subtrees/pi-goal-x.json` 的重放规则及接受的分歧记录。
- 不修改 `pi-subagents`、目标工具 schema、verdict schema、目标/账本存储格式或发布版本；本提案只规划，不实施代码。
