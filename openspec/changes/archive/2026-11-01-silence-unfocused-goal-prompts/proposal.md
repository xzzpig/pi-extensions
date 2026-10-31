# Proposal

## Why

存在未完成目标不代表当前会话参与该目标；当前未聚焦提示把执行安全边界与对话引导耦合，可能让普通请求被引向 goal 工作流。执行权限应由工具和调度器校验，而不是靠向模型持续提示其他目标的存在来约束。

## What Changes

- 未聚焦会话不再因存在 open goal 而生成模型提示，覆盖请求上下文和一次性隐藏 steering 两条路径。
- **BREAKING**：`hideUnfocusedPrompt` 不再控制行为，无论旧值是 `true`、`false` 或缺省，都不再产生该提醒；旧键仅保留解析与持久化兼容，从可编辑设置菜单和常规设置展示中移除。
- 保留未聚焦 UI 提示及独立的 `hideUnfocusedBanner` 设置。
- 保留人工 focus 所有权、需要 focus 的工具校验、过期 checkpoint 拦截及聚焦目标的正常上下文、恢复、执行与审计行为。
- 不清洗或改写已有会话消息、工具结果和压缩摘要；不自动选择、恢复或切换目标。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `goal-lifecycle`：将未聚焦状态定义为不自动提供 open-goal 模型引导，调整一次性引导通道和压缩恢复兼容约定，并规定旧设置兼容与执行护栏。

## Impact

- `packages/pi-goal-x/extensions/goal-events.ts` 的请求上下文生成和 `goal-state.ts` 的未聚焦通知路径。
- `goal-settings.ts`、`goal-commands.ts` 中旧键的展示/兼容处理，相关上下文测试与设置测试。
- fork-only 测试、说明与必要的 subtree 分歧记录；不修改其他包、不引入依赖、不改变存储版本或工具 schema。
- 当前用户修改的 `.pi/pi-goal-x-settings.json` 不属于本变更范围；不提交、不发布、不修改任何真实 goal。
