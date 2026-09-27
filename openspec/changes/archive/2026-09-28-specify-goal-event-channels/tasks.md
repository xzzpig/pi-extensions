## 1. 规范核对

- [x] 1.1 核对 spec 与代码事实一致：`extensions/goal-format.ts` 的三个通道常量、`extensions/goal-record.ts` 的 `GoalContextMessageDetails` 与 `GoalStateSnapshotDetails` 形状、`extensions/goal-state.ts` 的 `sendGoalContextMessage`（四个 `reason` 分支与失败处理）与 `buildTurnSnapshot`、`extensions/goal-events.ts` 的 `session_compact` 重发与状态快照分发、`extensions/goal-drafting.ts` 的 `"tweaked"` 调用点；验证方式：`grep -n` 输出与 spec 逐项一致
- [x] 1.2 确认这些通道确为 fork 分歧而非上游行为；验证方式：`git grep -l GOAL_CONTEXT_EVENT_ENTRY <subtrees/pi-goal-x.json 的 upstreamCommit>` 与 `GOAL_STATE_EVENT_ENTRY`、`GOAL_STEERING_EVENT_ENTRY` 均返回空
- [x] 1.3 确认与既有 spec 不冲突：`packages/pi-goal-x/specs/2026-09-12-escape-foreign-ui-prompt-guard/`（Escape 防护）与上游 `specs/2026-09-16-prompt-cache-prefix`；验证方式：逐条比对，无相互矛盾的表述
- [x] 1.4 确认规范描述的行为已有实现与测试覆盖；验证方式：`pnpm --filter @xzzpig/pi-goal-x test` 结果与 `subtrees/pi-goal-x.json` `knownDebt` 中记录的既有失败基线一致（不新增失败）

## 2. notes 精简与归档

- [x] 2.1 精简 `subtrees/pi-goal-x.json` 的 `notes`：删除本 spec 已承载的架构叙述（三条持久化通道的时机与保证），只保留上游接缝位置、每次同步需重做的手工步骤、不要再引入的决定；验证方式：`jq -r .notes subtrees/pi-goal-x.json | wc -c` ≤ 1500，且 notes 不再描述通道契约
- [x] 2.2 归档本 change，使 spec 落到 `openspec/specs/goal-persisted-event-channels/spec.md`；验证方式：`openspec validate` 通过，且该文件存在
- [x] 2.3 确认记录与代码仍然一致；验证方式：`pnpm run audit:fork-divergence` 退出 0（`undeclared=0`、`stale=0`）
