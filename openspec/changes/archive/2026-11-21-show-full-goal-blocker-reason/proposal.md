# 提案

## Why

`pi-goal-x` 进入 `blocked` 时，紧凑面板将阻塞原因裁成一行，展开面板不显示原因，会话中的 `update_goal` 结果也没有全文。用户需要快速了解阻塞原因，并能读到长说明的末尾，而不必牺牲任务区空间。

## What Changes

- 保留紧凑面板的一行阻塞摘要；展开面板增加按终端宽高限制的多行预览。预览未显示完整原因时，在空间允许且命令启用时提示使用 `/goal-status verbose` 看全文。
- 成功进入 `blocked` 的 `update_goal` 结果折叠时仍简短，展开时显示当次完整阻塞原因。从会话回看该结果时，不使用当前目标重新计算原因。
- 保留现有的阻塞提交、恢复、自动续跑、审计与 Oracle 行为。不增加新的命令、按键、独立详情弹窗或持久化格式。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `goal-lifecycle`：补充 `blocked` 状态的摘要、预览与全文查看约定。

## Impact

影响 `packages/pi-goal-x/` 的普通 Dashboard 渲染、`update_goal` 的人类可见结果展示，以及相关回归测试。复用 `/goal-status verbose` 及 Pi 现有的工具结果展开操作；无新增依赖或迁移。
