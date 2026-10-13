# Proposal

## Why

`packages/pi-openspec-x/src/index.ts` 在普通主会话初始化时注册三个子代理上报工具，其 `promptGuidelines` 因而进入主模型的通用规则，诱导模型在日常任务中调用 `report_gap_analysis` 等工具。与此同时，代理实现流程要求主会话再次调用 `report_work` 才能勾选任务，把 worker 的交付报告与父侧验收混在同一个工具中，不能仅靠隐藏工具修复。

## What Changes

- **BREAKING**：`report_gap_analysis`、`report_plan_review`、`report_work` 不再由主扩展入口注册。通过 `OPSX_AGENT_DEFINITIONS` 的 `subagentOnlyExtensions` 分别只提供给 `opsx-gap-analysis`、`opsx-plan-review`、`opsx-worker`；主会话、其他子代理及 `opsx-reviewer` 均不获得这些工具及其提示词。
- 新增插件内的子报告接收逻辑，从本会话所拥有的成功原生子结果及完整规范会话证据接收结构化工具报告；不得解析模型自由文本、工具参数显示预览、best-effort 诊断日志或要求主模型转录报告。报告必须关联到当前分支流程、目标、具体子运行/attempt 和任务，不能因同一个 `taskId` 就复用旧运行的报告；证据不可取得、版本不兼容或超过明确预算时保持拒绝并诊断。
- 保留主会话核对 diff、验证证据的责任，但不新增 `review_work`、`opsx_review_work` 或等价父侧确认工具。主会话审查后使用现有 `update_goal_task(status="complete", evidence=...)` 申请完成；插件在该操作执行前核对权威焦点、刷新已接收报告并使用实际改动门控。冷重启先恢复绑定再恢复证据，单项/批量都不能跳门；仅在真实任务状态转换后发布完成事件。
- 保留报告 schema、计划阶段的 `opsx_plan_gap_analysis` / `opsx_plan_verdict`、最终独立完成审计及直实现模式。移除 `objective.ts`、错误提示和 README 中要求主会话调用 `report_work` 的旧指引，进度投影改为使用已关联的子报告。
- 按用户要求补充完整真实运行时 E2E：隔离临时目录中的 Pi CLI、真实模型、tmux TUI、原生子报告、任务完成及冷恢复链路，覆盖 ordinary/direct 回归和最终审计；机器证据断言不能被 mock 集成或模型口头确认替代。

## Capabilities

### New Capabilities

无；复用既有能力域，不新增同域窄 spec。

### Modified Capabilities

- `pi-openspec-x`：明确结构化上报工具的角色隔离、worker 报告的自动接收，以及通过现有任务完成接口实施父侧验收门控。

## Impact

- 工具提供：`packages/pi-openspec-x/src/index.ts::piOpenspecX`、`src/report-tools.ts::registerReportTools`、`src/agents.ts::OPSX_AGENT_DEFINITIONS`；新增位于本包 `src/` 内的三个独立子扩展入口，不加入 `package.json` 的 `pi.extensions`。
- 报告接收与完成门：新增本包内部接收/读取模块及子 attempt 元数据；调整 `src/implement-command.ts`、`src/dispatch-gate.ts`，并扩展 `src/goal-base.ts` 的只读焦点解析、`src/flow-recovery.ts` / `src/plan-command.ts` 的分支绑定恢复。使用现有原生身份、结果消息及 Pi 规范会话，不修改 pi-subagents 的启动、持久化或公开 API，也不修改 goal-x 状态。
- 流程指引与显示：`src/objective.ts::agentBoundaries`、`src/agent-prompts.ts::WORKER_SYSTEM_PROMPT`、`src/progress-observer.ts`、`packages/pi-openspec-x/README.md`。
- 验证：调整工具注册、完成门、目标/流程恢复、提示及进度测试；新增隔离矩阵、规范证据读取和自动接收回归，真实接线覆盖资源加载、前台错误包装及 goal-x 逻辑拒绝。实现后运行 `pnpm --filter @xzzpig/pi-openspec-x run typecheck`、`pnpm --filter @xzzpig/pi-openspec-x test`，再执行本 change `e2e.md` 的完整真实验证。新增测试专用 `test/e2e/{run-live.mjs,assert-live.mjs,probe.ts}`，只在临时目录驱动业务操作并保留脱敏证据，不进入发布包；凭据/tmux 缺失时明确 BLOCKED，不伪报通过。
- **Must-NOT-Have**：不修改 pi-goal-x 的 `update_goal_task` 参数或全局完成策略；不把完整 worker 报告塞入其短文本 `evidence`；不保留主会话 `report_*` 兼容别名；不借此修复 change-id 命令解析、重构所有代理协议、支持远程/外部 runner，或新增发布、版本提升、提交、推送操作。本轮仅撰写 `openspec/changes/isolate-opsx-child-report-tools/` 下的计划产物，不实现代码。
