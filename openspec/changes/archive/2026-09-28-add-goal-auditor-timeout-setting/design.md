# Design: add-goal-auditor-timeout-setting

## Context

完成审计由 `goal-auditor.ts` 通过 `@xzzpig/pi-subagents` 的 structured delegation 执行。委派机制带三个 fork 引入的超时常量（`goal-auditor.ts:80-82`）：

- `START_HANDSHAKE_TIMEOUT_MS = 5_000`：REQUEST 发出后子代理必须启动的时限，防委派链路（extension 未加载/无订阅者）挂死；
- `TERMINAL_TIMEOUT_MS = 30 * 60_000`：delegation 启动后的绝对墙钟上限，delegation request 的 `timeoutMs`（runner 侧杀 child）与本地 terminal timer（同值兜底）共用；
- `CANCELLATION_TIMEOUT_MS = 5_000`：发出 CANCEL 后等待终态确认的时限，防 child 不可中断时 UI 永久挂起。

bridge 层（pi-subagents `prompt-template-bridge.ts`）保证所有已接收 request 都会产出 terminal response，runner 对 foreground 单 run 亦有 `DEFAULT_FOREGROUND_TIMEOUT_MS = 30min` 兜底；因此本地 terminal timer 与 runner 超时同值赛跑，属 belt-and-suspenders。settings 为分层（global/project）结构，`auditorAgent` 是现有 auditor\* 叶子的先例（`track`/`resolveLeaf` 解析、键校验 switch 分支、持久化、introspection 显示行）。

## Goals / Non-Goals

**Goals:**

- 新增 settings 叶子 `auditorTimeoutMs`，贯通 settings → auditor → delegation request timeoutMs 与本地 terminal timer 三处，使用同一有效值。
- 校验与回退：正整数毫秒、上限 2_147_483_647；非法值带诊断信息并回退默认。
- 默认行为零变化（未配置 = 30 分钟）。

**Non-Goals:**

- 不暴露、不调整 `START_HANDSHAKE_TIMEOUT_MS` 与 `CANCELLATION_TIMEOUT_MS`（防挂死保险，与审查时长无关）。
- 不修改 pi-subagents runner 侧默认超时或 delegation 协议。
- 不提供"完全不限时"模式（runner 层 foreground 默认 30min 决定了必须显式传有限值；本变更不引入绕过）。

## Decisions

1. **只暴露总时长上限一个设置项**（`auditorTimeoutMs`）。
   - 理由：三个常量中仅它限制审查时长；另两个只在异常路径触发，暴露出去只会增加误配面（例如把取消确认调到 30 分钟会让 Esc 失去即时反馈）。
   - 备选方案：三个都进 settings——被否决，收益为零且扩大配置面。
2. **单位与上限：正整数毫秒，≤ 2_147_483_647。**
   - 理由：与 delegation request 的 `timeoutMs` 字段单位一致（毫秒），避免二次换算；上限来自 Node `setTimeout` 的 32 位符号整数安全边界（超出会溢出为立即触发），与 pi-subagents `resolveConfigDefaultTimeoutMs` 的既有校验语义对齐。
   - 备选方案：分钟单位、无上限校验——被否决，前者与运行时字段单位不一致，后者会让溢出值静默变成立即超时。
3. **回退语义：非法值 → 诊断 + 默认 30 分钟，而不是 fail closed 拒绝审计。**
   - 理由：配置错误不应让目标无法完成审计；与"审计依赖缺失 fail closed"（依赖真的不可用）区分——这里依赖可用，只是上限取值坏。
   - 备选方案：非法值拒绝启动审计——被否决，会把纯配置错误升级为完成阻塞。
4. **默认值解析位置：settings 层负责校验与分层，auditor 层负责取值。**
   - `goal-settings.ts` 新增叶子：类型 `number | undefined`、`track`/`resolveLeaf` 解析、键校验分支（非正整数/超上限给诊断）、持久化 round-trip、introspection 显示行（默认显示 1800000）。
   - `goal-auditor.ts`：新增模块内 helper（如 `resolveAuditorTerminalTimeoutMs(settings)`）返回 `settings.auditorTimeoutMs`（settings 层已保证合法）否则 `TERMINAL_TIMEOUT_MS`；delegation request 的 `timeoutMs` 与 `armTerminalTimeout` 均取该 helper。`TERMINAL_TIMEOUT_MS` 保留为代码内默认常量。
   - 备选方案：校验也放 auditor 层——被否决，settings 层已有统一的 per-leaf 校验与诊断管道（`networkRecovery` 先例），分散校验会产生两套诊断格式。
5. **复用 `args.timeouts?.terminalMs` 既有参数口**：显式传参仍优先于 settings（测试注入用），settings 是默认来源。`goal-completion.ts` 调用点不传 `timeouts`，行为由 settings 决定。

## Risks / Trade-offs

- [runner 默认 30min 与显式 `timeoutMs` 的优先级被误解] → 设计上 request 恒带显式 `timeoutMs`（默认 30min 或配置值），runner 默认永不参与；测试断言 request 字段值。
- [用户把 `auditorTimeoutMs` 配得极小（如 1ms）导致审计必然超时] → 合法值照常生效，这是配置自由的一部分；超时走既有 fail closed 路径，诊断包含上限值，可自行调回。
- [同值赛跑（本地 timer vs runner 超时）顺序不定] → 二者语义一致（fail closed + audit error），竞态只影响错误文案来源，不影响裁决；维持现状。
- [settings 层与已发布 snapshot 的兼容] → 新叶子缺省 undefined，旧 snapshot 无需迁移；持久化 round-trip 测试覆盖新键。

## Migration Plan

纯增量变更，无数据迁移。发布顺序：代码 + 测试 + 文档同一变更内交付；用户侧无需任何动作，不配置即保持现状。回滚 = 还原本变更涉及的文件。

## Open Questions

（无）
