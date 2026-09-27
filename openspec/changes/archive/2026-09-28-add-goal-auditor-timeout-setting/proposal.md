# Proposal: add-goal-auditor-timeout-setting

## Why

pi-goal-x 的完成审计当前把总时长上限写死为 `TERMINAL_TIMEOUT_MS = 30 * 60_000`（`packages/pi-goal-x/extensions/goal-auditor.ts`），用户无法为大型目标（如需要真机验证、多仓库巡检的审计）调大上限；超时后审计按 fail closed 处理，只能改源码。fork 将上游的进程内审计改为 pi-subagents 委派时引入的三个超时常量中，仅总时长上限是真正"限制审查时间"的值，需要暴露为配置项；5s 握手与 5s 取消确认是防挂死保险，不应暴露。

## What Changes

- Goal-X settings 新增 `auditorTimeoutMs` 设置项：正整数毫秒，上限 2_147_483_647（Node timer 安全边界）；未设置或非法值回退默认 30 分钟；分层解析遵循现有 global/project 规则（project 覆盖 global），与 `auditorAgent` 等现有 auditor\* 叶子一致。
- 完成审计委派将解析后的 `auditorTimeoutMs` 同时应用于 delegation request 的 `timeoutMs` 与本地 terminal timer，二者保持同一配置值。
- `/goal-settings` 的键校验、持久化 round-trip、introspection 显示行支持 `auditorTimeoutMs`。
- 5s 握手（`START_HANDSHAKE_TIMEOUT_MS`）与 5s 取消确认（`CANCELLATION_TIMEOUT_MS`）保持硬编码，不新增设置项。
- 默认行为完全不变：未配置时审计上限仍为 30 分钟。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `goal-completion-auditing`: 审计总时长上限从固定 30 分钟改为可配置——新增要求：系统 SHALL 通过 Goal-X 分层设置解析 `auditorTimeoutMs` 并将其应用于审计委派 request 与本地 terminal timer；未设置或非法值回退 30 分钟默认；握手与取消确认兜底保持内部固定值。

## Impact

- 受影响代码：`packages/pi-goal-x/extensions/goal-settings.ts`（类型、分层解析、校验、持久化、/goal-settings 显示）、`packages/pi-goal-x/extensions/goal-auditor.ts`（读取配置并贯通 request/timer 两处）。
- 受影响测试：`packages/pi-goal-x/tests/goal-settings*.test.ts`、`packages/pi-goal-x/tests/goal-auditor.test.ts`（新增默认值/分层覆盖/非法值用例）。
- 文档：`packages/pi-goal-x/CHANGELOG.md`、`packages/pi-goal-x/README.md` 设置章节。
- 不修改 `packages/pi-subagents`（runner 侧默认超时不动）；不修改上游同步面。
