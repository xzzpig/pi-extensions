# Proposal: customize-goal-audit-via-settings

## Why

pi-goal-x（fork 0.7.x）完成审计的自定义只有一条路径：用 `/goal-subagent-eject` 把包内 `agents/goal-auditor.md` 复制到 user/project 作用域后整文件手改。整文件覆盖极易破坏审计原有流程与内容——frontmatter 里的 `subagentOnlyExtensions`（五阶段步骤反馈的子会话进度提供器）与 `tools`（preflight 硬性要求 `report_auditor_progress`/`structured_output`）一旦丢失或改坏，审计要么拒绝启动、要么步骤反馈静默消失；正文里的审计原则与结构化裁决约定也无法得到保护。同时，为裸 `pi -e` 模式服务的临时目录物化机制（复制 md、正则改写扩展路径、追加 `PI_SUBAGENT_EXTRA_AGENT_DIRS`）是纯粹的脆弱胶水。pi-subagents 上游现已提供 `pi-subagents:runtime-agent-register:v1` 运行时注册契约，插件可以直接注册 sub agent，用代码持有默认定义、用配置文件定制审计内容成为可能。

## What Changes

- **默认 auditor 改为运行时注册**：pi-goal-x 在 `session_start` 通过 `registerAgentViaEvents`（`@xzzpig/pi-subagents/agents`）注册代码内规范定义的默认 `goal-auditor`（进度提供器以绝对路径引用）；删除包内 `agents/goal-auditor.md` 与 `pi.subagents.agents` 包发现声明；删除独立物化机制（`EXTRA_AGENT_DIRS_ENV`、`ensureStandaloneDefaultAuditorAgent`、preflight 重试块）。
- **注册冲突安全**：注册前用 launch preflight 探测；仅当结果为 `missing_agent`（名字空闲）才注册。已存在同名配置 agent（如旧 eject 产物）时跳过注册，旧 md 继续以 shadow 方式生效；其余 preflight 结果一律跳过（注册是碰撞而非遮蔽）。
- **嵌套 `auditor` 设置组**：新增 `auditor: { ... }` 嵌套设置组，分三层生效：
  - 请求层（每次审计读取）：`agent`、`provider`、`model`、`thinkingLevel`、`timeoutMs`、`disabled`、`changeManifest`、`changeManifestDepth`、`warmContext`（新增，控制父会话 warm context 注入开关）；
  - 提示注入层（每次审计读取）：`instructions`、`checklist`（整体替换默认清单）、`checklistExtra`、`evidenceRequests`、`strictness`（balanced/strict/lenient 预设口径）、`reportFormat`、`feedbackNotes`（拒绝反馈附加说明）；
  - 定义层（注册期合并进默认 agent，需新会话/reload）：`systemPromptExtra`、`extensions`、`subagentOnlyExtensions`（与必需进度提供器取并集）、`skills`、`skillPath`、`tools`（替换普通白名单，进度工具强制保留）、`excludeTools`、`mcpDirectTools`、`defaultReads`、`inheritProjectContext`、`inheritSkills`、`sandbox`（pi-subagents fork 的命名 sandbox profile 选择器，指向全局 `pi-sandbox` 配置）、`permissionProfile`（pi-subagents fork 的命名 permission profile 选择器，指向全局 `pi-permission-system` 配置）。两个 profile 字段均为经校验的标量选择器（非内联策略），提供即覆盖、缺省即不设置；校验语法与 pi-subagents 同名选择器一致，注册契约仍是无效名/缺包时的 fail-closed 兜底。
- **旧平铺键迁移**：`auditorAgent`、`auditorTimeoutMs`、`provider`、`model`、`thinkingLevel`、`disabled`、`changeManifest`、`changeManifestDepth` 继续解析为 `auditor.*` 叶子的 deprecated 别名（同层嵌套优先）；resolved 形状移除这些平铺字段，持久化改写嵌套形态。
- **提示注入规则**：固定顺序 checklist（或替换版）→ checklistExtra → evidenceRequests → strictness → instructions → reportFormat；全部经 `escapePromptPayload` 转义；协议尾两行（进度上报 + structured_output 裁决）在任何替换下保留；全部未设置时审计 prompt 字节不变。
- **BREAKING**：移除 `/goal-subagent-eject` 命令。旧 eject 出的 `goal-auditor.md` 继续生效（注册自动跳过）；删除该文件即回到代码内默认；完全自定义改用 `auditor.agent` 指向自建 agent 定义。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `goal-completion-auditing`：默认 `goal-auditor` 从包内 markdown 发现改为 `session_start` 运行时注册；`/goal-subagent-eject` 要求移除；新增嵌套 `auditor` 设置组的三层定制要求（请求层、提示注入层、定义层）与兼容性基线（未设置时 prompt 字节不变、协议尾保留、旧平铺键别名、旧 eject md 继续 shadow 生效）；裸 `pi -e` 场景改由运行时注册覆盖，不再依赖 extra-agent-dir 物化。

## Impact

- 受影响代码：`packages/pi-goal-x/extensions/goal-settings.ts`（嵌套类型、解析、别名折叠、分层解析、持久化、/goal-settings 展示；新增 profile 选择器解析与报告行）、`extensions/goal-auditor-registration.ts`（新增）、`extensions/goal-auditor.ts`（提示注入）、`extensions/goal-auditor-delegation.ts`（消费嵌套形状、删除物化机制）、`extensions/goal-events.ts`（session_start 注册 / session_shutdown 释放）、`extensions/goal-completion.ts`（消费嵌套形状、feedbackNotes）、`extensions/goal-commands.ts`（移除 eject、菜单嵌套化）、`extensions/goal-drafting.ts`、`package.json`、`agents/goal-auditor.md`（删除）。
- 受影响测试：`tests/goal-auditor-package.test.ts`（注册模块与定义合并重写）、`tests/goal-settings*.test.ts`、`tests/goal-auditor.test.ts`（注入用例）、`tests/goal-command-palette.test.ts`、`tests/goal-surface-baseline.test.ts`、`tests/goal-settings-race.test.ts`、`tests/goal-change-rollback.test.ts`、`tests/goal-fork-settings.test.ts`。
- 不修改 `packages/pi-subagents`：注册契约（`runtime-agent-register:v1`）、preflight、碰撞语义均为上游既有能力。
- 文档与元数据：`packages/pi-goal-x/README.md`、`CHANGELOG.md`、版本 0.7.5 → 0.8.0、`subtrees/pi-goal-x.json` fork notes（上游同步冲突指引）。
