# Design: customize-goal-audit-via-settings

## Context

完成审计由 `goal-auditor-delegation.ts` 通过 `@xzzpig/pi-subagents` 的 structured delegation 执行；默认 `goal-auditor` 以包内 markdown（`agents/goal-auditor.md` + `package.json` 的 `pi.subagents.agents` 声明）发布，自定义只能 `/goal-subagent-eject` 复制后整文件手改。裸 `pi -e` 模式下包发现不生效，`goal-auditor-delegation.ts` 依赖一套临时目录物化机制：把 md 复制到 tmp、正则改写 `subagentOnlyExtensions` 为绝对路径、追加 `PI_SUBAGENT_EXTRA_AGENT_DIRS`。

pi-subagents 上游提供两个关键能力（fork 无需改动）：

- `pi-subagents:runtime-agent-register:v1` 运行时注册契约（`@xzzpig/pi-subagents/agents` 的 `registerAgentViaEvents`）：同步事件注册，`RuntimeAgentDefinition` 覆盖 md frontmatter 全部字段，返回可 `dispose()` 句柄；owner 监听在扩展加载时安装，文档建议在 `session_start` 发出。
- 碰撞语义：运行时 agent 与任何已发现配置 agent（builtin/package/user/project，含被 disable 的）同名时在发现期抛错（`mergeRuntimeAgents` 的 `assertNoConfiguredCollision`），**不是 shadow**。

Goal-X 的分层设置机制（`goal-settings.ts`）：environment > project > global 逐叶解析、provenance 记录、`/goal-settings` 展示、锁化 mutation；任何 diagnostic 都会把 layer 状态置为 `invalid` 并阻止后续 mutation 写入。

## Goals / Non-Goals

**Goals**

- 审计内容定制全部收敛到设置文件：提示注入、清单替换、证据指令、口径预设、报告格式、拒绝附言，以及默认 agent 定义的扩展/技能/工具合并与 pi-subagents fork 的 sandbox/permission profile 选择器。
- 默认 `goal-auditor` 的协议接线（进度提供器、协议工具、裁决契约）代码所有，配置只能增量定制、无法破坏。
- 旧平铺设置键与旧 eject 产物零迁移成本继续工作。

**Non-Goals**

- 不修改 `packages/pi-subagents`（注册契约、preflight、碰撞语义均为上游既有行为；碰撞改 shadow 会扩大上游同步冲突面）。
- 不提供 per-goal 级别的审计定制（goal 上已有 verificationContract；未列入本次范围）。
- 不为嵌套 `auditor` 字段新增 `PI_GOAL_*` 环境变量（现有 env 键只覆盖少数布尔/数值叶子，保持现状）。
- 不支持运行中热重载定义层（注册期字段需新会话/reload，文档注明）。

## Decisions

1. **默认定义由代码持有，注册在 `goal-events.ts` 既有的 `session_start` handler 内**
   - 规范定义（`DEFAULT_AUDITOR_DEFINITION`）逐字保留原 md 的 system prompt 正文，frontmatter 字段一一映射；`subagentOnlyExtensions` 直接用 `import.meta.url` 解析的绝对路径，物化机制整体删除。
   - 接线放在 `goal-events` 现有 handler 内而不是 goal.ts 另挂新监听：测试 harness 的 `handlers` Map 对同名事件只保留最后一个 handler，另挂会覆盖 `loadState` 等关键逻辑（实现期已踩过并回归测试证实）；真实 Pi 支持多监听，但仓库约定是所有 `pi.on` 集中在 `registerGoalEvents`。
   - 备选：保留 md 并仅加设置——被否，物化机制与整文件覆盖路径仍会残留。

2. **注册前以 preflight 探测名字占用；仅 `missing_agent` 才注册**
   - `resolveSubagentLaunchContract({ agent: "goal-auditor", context: "fresh", cwd, projectTrusted?, trustedProjectCwd? })` 返回 `ok` 说明存在同名配置 agent → 跳过（旧 eject 用户继续生效）；`missing_agent` → 注册；**其他失败码也跳过**，因为那些码意味着配置 agent 存在但配置损坏——此时注册会触发发现期碰撞，破坏整个会话的所有 subagent 操作。
   - pi-subagents 未加载时 `registerAgentViaEvents` 抛错被捕获，返回 `unavailable` 且**不产生会话级告警**：审计时的 delegation 路径本就会给出同样的可操作错误，session_start 每次会话告警是噪音（实现期回归测试 `notifications.length === 0` 证实）。
   - 句柄保存在模块内，`session_shutdown` 释放、每次注册前先释放旧句柄（runtime registry 以 owner 的 `pi` 为 WeakMap 键，不释放会同名碰撞）。

3. **旧平铺键在解析期折叠为 `auditor.*` 叶子（nested wins），不产生 deprecated diagnostic**
   - 解析时把 8 个平铺别名累积进 legacy 对象，循环结束后以 `{ ...legacy, ...nested }` 合并——同层嵌套优先且与键序无关。
   - 不发 `deprecated_key` diagnostic：任何 diagnostic 都会把 layer 状态置为 `invalid`，从而阻止 `/goal-settings` 的 mutation 写入，对存量用户是伤害；迁移指引改由 README 表格承担。
   - resolved 形状移除平铺字段，消费方全部改读 `settings.auditor.*`；`parseGoalSettings`（严格模式）因此对旧键返回嵌套形状，属预期破坏，CHANGELOG 迁移表说明。
   - 备选：layer 保留平铺、仅解析期合并——被否：mutation 路径会把折叠后的形状写回磁盘（race test 实证 flat key 丢失），两种形状并存更难推理。

4. **提示注入固定顺序 + 协议尾硬保留 + 未设置字节不变**
   - 顺序：checklist（或 `auditor.checklist` 替换版）→ checklistExtra → evidenceRequests → strictness → instructions → reportFormat；全部经 `escapePromptPayload` 转义（`</operator_instructions>` 等载荷无法提前闭块）。
   - 协议尾两行（`report_auditor_progress` 约定与 structured_output 裁决约定）不属于 checklist，替换不影响；注入块渲染在清单之后、协议尾之前。
   - 未设置任一注入字段时 prompt 逐字节不变（与 change manifest 的既有约定一致）；`feedbackNotes` 注入在 `goal-completion.ts` 拒绝反馈文本的报告之后。
   - `strictness` 是注入文本的语法糖：`balanced` 不注入任何内容；strict/lenient 各映射一段姿态说明。

5. **定义合并规则：必需项并集保序、白名单替换后补进度工具、其余替换**
   - `subagentOnlyExtensions`：进度提供器恒在首位，用户项去重追加；`tools`：替换后缺失则**尾部**补 `report_auditor_progress`，`excludeTools` 随后剔除（剔掉进度工具时由 preflight fail closed 并给出明确错误——不静默复活，保持"用户显式选择 + preflight 兜底"语义）；`extensions`/`skills`/`skillPath`/`mcpDirectTools`/`defaultReads` 默认为空，提供即替换；`inheritProjectContext`/`inheritSkills` 默认 false（隔离），提供即覆盖。
   - `sandbox`/`permissionProfile`（pi-subagents fork 能力，经 `RuntimeAgentDefinition` 的 `sandbox`/`permissionProfile?: string` 字段承载）：提供即覆盖、缺省即不设置；settings 解析层以 fork 相同的命名语法（`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`、≤128 字符、无外围空白、非字面 `false`）校验非法名并发 diagnostic；合法选择性名在注册合并时原样传递，pi-subagents 注册校验（`validateSandboxProfileName`/`validatePermissionProfileName`）与审计启动路径对未知 profile、缺包（`pi-sandbox`/`pi-permission-system` 未安装）fail closed。
   - 无任何定义层字段时返回原定义对象（恒等），避免无谓重建。
   - 信任边界不放大：项目层 settings 提供的扩展/工具仍经 pi-subagents launch preflight 校验，非受信项目沿用 `untrusted_project`/`invalid_extension_bindings` fail closed。

6. **注册探测与 settings 读取顺序**
   - 先探测（preflight 读磁盘发现，不依赖 settings），名字空闲才 `loadGoalSettings` 并合并定义层注册；无论 `auditor.agent` 是否为默认名都注册默认 agent（多注册的 agent 无副作用，且支持会话中途切换 `auditor.agent`）。

7. **审计 preflight 对运行时注册 agent 做运行时感知回退**（e2e 暴露的实现缺陷修复）
   - 审计路径调用 `resolveSubagentLaunchContract` 做 fail-fast 预检，但该契约基于纯磁盘发现（`discoverAgentSnapshot`），结构上无法看到 session_start 注册的运行时 agent；e2e 证实裸 `pi -e` 场景下审计直接以 `Unknown agent: goal-auditor` 失败。
   - 修复：preflight 返回 `missing_agent` 且 caller 提供 ExtensionAPI 时，改用 `discoverAgentsWithRuntime`（executor 启动时所用的同一合并视图）解析 agent；运行时视图能找到该 agent（即运行时注册生效）则以合并定义的 `tools` 减去 `excludeTools` 校验 `report_auditor_progress` 保留，`structured_output` 由结构化委派请求保证；找到才放行，找不到仍走原 `missing_agent` fail closed 错误。
   - 运行时感知回退不成为绕过：非 `missing_agent` 错误继续原样 fail closed，进度工具被 `excludeTools` 剔除同样 fail closed（I-20 不因回退而松动）；`discoverAgentsWithRuntime` 未注册时为纯 `discoverAgents` 包装，与磁盘视图一致。

## Risks / Trade-offs

- [会话中途创建 `goal-auditor.md`（或升级前未删除的 eject md 在注册后才出现）] → pi-subagents 碰撞语义会在下一次发现期抛错；文档注明需重启会话，eject 命令已移除、常规路径不再产生该文件。
- [user 作用域同名 md 被 settings override 显式 disable 的用户] → disable 后 effective discovery 不含该名字，探测可能返回 `missing_agent` 而注册运行时 agent，等于"disable 失效"；属极小集合（旧 eject + 显式禁用 + 期望禁用保持），记录为已知边界，未特殊处理。
- [上游同步：`goal-auditor.ts`、`package.json`、`goal-events.ts` 出现新的 fork 差异] → 全部新逻辑集中在 fork-only 的 `goal-auditor-registration.ts` 与已 fork 化的文件；删除的 md 与物化机制已在 `subtrees/pi-goal-x.json` notes 记录"同步时不得恢复"。
- [审计 preflight 的磁盘发现看不到运行时 agent] → pi-goal-x 在自己的 preflight 内做运行时感知回退（决策 7）：`missing_agent` 时走 `discoverAgentsWithRuntime` 合并视图校验协议工具后放行，只有真正解析不到才 fail closed；pi-subagents 自身的 preflight/executor 行为不改，碰撞语义与注册契约仍为上游既有行为。
- [`auditor.extensions` 指向的路径随子进程 cwd 解析] → 与 md 时代的相对路径语义一致由 pi-subagents 解析规则决定；进度提供器刻意使用绝对路径规避（原物化机制的正则改写被此取代）。
- [旧平铺键被折叠进嵌套后再写盘，文件形态变化] → mutation 写回嵌套形态是一次性迁移，README 迁移表 + `/goal-settings` 展示新形态；strict 解析器 `parseGoalSettings` 对旧键返回嵌套形状，测试已同步。

## Migration Plan

- 旧设置文件：零操作（平铺键继续解析）；下一次 mutation 会把触达的键落为嵌套形态。
- 旧 eject 产物：零操作（注册自动跳过）；删除 md 即回到代码内默认。
- 完全自定义用户：`auditor.agent` 指向自建 agent 定义；定义层仅对默认 agent 生效这一点在 README 明示。
- 回滚：还原 commit 即恢复 md + eject 路径；嵌套设置键对旧代码是 unknown key（diagnostics），回滚不会静默丢配置语义之外的东西。

## Open Questions

（无——定义合并剔除进度工具的行为选择、别名不告警、注册静默失败均已在实现期用回归测试验证并固化。）
