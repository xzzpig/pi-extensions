# Proposal

## Why

Goal-X 普通任务面板已经支持鼠标浏览，但审计进行时会切换到独立的审计 Dashboard，其长清单与依据目前只能使用键盘浏览，面板展开/收起也缺少可点击入口。用户希望审计阶段也能顺手使用鼠标，而不改变审计的执行或裁决。

## What Changes

- 审计进行时在紧凑和展开视图提供可发现的鼠标展开/收起控件，并与现有面板快捷键共用状态。
- 在展开的审计清单及依据窗口内支持鼠标滚轮，按宿主已计算的方向与步长浏览；窗口首尾不滚动背后聊天记录，区域外与浮层保持原有路由。
- 单击只改变展示；保留拖选复制、键盘导航、既有 Escape 审计暂停/选择流程和结果卡，不修改检查项、审计 attempt 或 verdict。
- 保持动态清单快照、逐项依据及终态结果语义；不新增单项详情折叠和鼠标停止审计控件。
- 沿用 Pi 原生组件鼠标派发和现有非鼠标降级，不新增全局鼠标拦截或强制依赖共享鼠标扩展。

## Capabilities

### New Capabilities

无。审计 Dashboard 属于已有 Goal-X 生命周期能力域。

### Modified Capabilities

- `goal-lifecycle`：补充交互式审计 Dashboard 的鼠标浏览和面板展开/收起契约，保留现有审计清单、终态和事务规则。

## Impact

- 涉及 `packages/pi-goal-x/extensions/widgets/fork-audit-viewport.ts`、`fork-auditor-dashboard-renderer.ts`、`goal-widget.ts` 及必要的 fork-only 鼠标/几何适配和测试。
- 与已完成但尚未归档的 `enhance-goal-task-tree-navigation` 共用普通目标 widget 和展开状态；实现应以其当前工作树为基线，不能回滚或破坏该变更。
- 根据实际上游接缝维护 `subtrees/pi-goal-x.json`；遵循 fork-only 逻辑、最小上游接缝与原格式，补充 fork 文档和 changelog。
- 不改 Pi 核心、其他插件、持久化格式、任务工具或审计协议；不扩展包 README，不提交、不发布、不自动归档。
