# Tasks: customize-goal-audit-via-settings

## 1. Settings 层：嵌套 auditor 组（goal-settings.ts）

- [x] 1.1 新增 `GoalAuditorSettings` 类型（三层字段全可选）、长度/条目上限常量（文本 ≤16k/≤4k、列表 ≤32×2048）与 `AUDITOR_STRICTNESS_LEVELS`；`GoalSettingsResolvedShape` 移除 8 个平铺 auditor 字段并加入 `auditor?: GoalAuditorSettings`（`auditorProjectResources` 保留以承载迁移提示）；验证：`tsc --noEmit` 通过
- [x] 1.2 `parseSettingsLayer` 新增 `auditor` 嵌套分支（逐叶解析 + 非法值 diagnostics 不中断兄弟叶）与旧平铺别名分支（解析期折叠进 `legacyAuditor`，循环后 `{ ...legacy, ...nested }` 合并，嵌套优先且与键序无关）；`ALLOWED_SETTINGS_KEYS` 加入 `auditor`；验证：`tests/goal-settings.test.ts` 别名/嵌套/诊断用例通过
- [x] 1.3 `resolvedSettingsSnapshot` 为每个 `auditor.*` 叶子建 `track`/`resolveLeaf`（agent/disabled/changeManifest/changeManifestDepth/warmContext/strictness 带默认值，其余 phantom）；`value.auditor` 恒构建；`copyResolvedSettings` 深拷贝 auditor（数组切片）；验证：`tests/goal-layered-settings.test.ts`、`tests/goal-fork-settings.test.ts` 分层覆盖与 provenance 键用例通过
- [x] 1.4 持久化与别名写回：`buildPersistedLayer` 写嵌套（agent 仅非默认、disabled 恒写、新字段仅非默认），`applyPathMutation`/`canonicalizeAliases` 支持 `auditor.thinkingLevel`/`thinking_level` 双拼写；`saveGoalSettingsFileConfig` 返回嵌套形状；验证：round-trip 用例通过
- [x] 1.5 `/goal-settings` 展示行与 `effectiveSettingsReport` 全面切换为 `auditor.x` 行（注入/定义字段显示 set/unset 或条数，定义层标注 next session）；`isAuditorEnabledByDefault` 改读 `auditor?.disabled`；验证：`effectiveSettingsReport` 行断言用例通过
- [x] 1.6 定义层新增 pi-subagents fork 的 profile 选择器字段 `sandbox`/`permissionProfile`（`GoalAuditorSettings` 定义层、`ALLOWED_AUDITOR_KEYS`、`asProfileName` 解析助手：与 fork 同名语法 `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`、≤128 字符、无外围空白、非字面 `false`、非法值 diagnostic 不落盘）；`resolvedSettingsSnapshot` 为两字段建 phantom track 并进入 `value.auditor`；`buildPersistedLayer` 提供即写；`effectiveSettingsReport` 新增两行（标注 next session）；验证：`tests/goal-settings.test.ts` 校验/诊断/持久化用例与 `tests/goal-fork-settings.test.ts` 报告行用例通过

## 2. 注册模块与接线（goal-auditor-registration.ts 新增 / goal-events.ts）

- [x] 2.1 新增 `DEFAULT_AUDITOR_DEFINITION`：system prompt 逐字保留原 `agents/goal-auditor.md` 正文，frontmatter 字段一一映射（tools 含 `report_auditor_progress`、`subagentOnlyExtensions` 用 `import.meta.url` 绝对路径、`systemPromptMode: replace`、`acceptanceRole: read-only`、`completionGuard: false` 等）；验证：`tests/goal-auditor-package.test.ts` 定义快照用例通过
- [x] 2.2 `mergeAuditorDefinition`：`systemPromptExtra` 追加、`subagentOnlyExtensions` 并集（进度提供器恒在首）、`tools` 替换后尾部补进度工具再应用 `excludeTools`、其余列表提供即替换、继承布尔提供即覆盖、**`sandbox`/`permissionProfile` 提供即覆盖**、无定义层字段时恒等返回；验证：定义合并用例（并集/替换/剔除/协议工具保留/恒等/profile 选择器）通过
- [x] 2.3 `resolveDefaultAuditorAvailability`：真实 `resolveSubagentLaunchContract` 探测，`missing_agent` → free、`ok` 与其他失败码 → taken、抛错 → unknown（均可注入 resolver 供测试）；`registerDefaultGoalAuditor` 先 dispose 旧句柄、free 时 `registerAgentViaEvents` 注册、pi-subagents 缺席时捕获返回 `unavailable`；`disposeDefaultGoalAuditor` 供 shutdown；验证：注册/跳过/失败软着陆/句柄释放用例通过
- [x] 2.4 接线进 `goal-events.ts` 既有 `session_start`（不另挂监听，避免 harness 同名事件覆盖）与 `session_shutdown`；注册失败静默（审计时既有错误路径给出同一诊断）；验证：`tests/goal-delegation-completion.test.ts` 等 harness 套件通过、notifications 无注册噪音
- [x] 2.5 删除包内 `agents/goal-auditor.md`、`package.json` 的 `pi.subagents.agents` 与 `files.agents`；验证：`tests/goal-auditor-package.test.ts` 断言包不再携带 agents 目录

## 3. Delegation 与提示注入（goal-auditor-delegation.ts / goal-auditor.ts / goal-completion.ts）

- [x] 3.1 `goal-auditor-delegation.ts` 消费嵌套形状（`resolveAuditorAgent`/`resolveAuditorTerminalTimeoutMs`/`resolveAuditorDelegationOverrides` 读 `settings.auditor.*`）；删除独立物化机制全部代码（`EXTRA_AGENT_DIRS_ENV`、`ensureStandaloneDefaultAuditorAgent`、`shouldPrepareStandaloneDefaultAuditor`、preflight 重试块）并更新文件头 fork 说明；验证：`tests/goal-auditor.test.ts` 委派超时/覆盖用例通过
- [x] 3.2 `buildGoalAuditorPrompt` 新增 `operatorAuditPromptBlocks`：固定顺序 checklist（`auditor.checklist` 整体替换，默认清单逐字保留）→ checklistExtra → evidenceRequests → strictness → instructions → reportFormat，全部 `escapePromptPayload` 转义，协议尾恒在；未设置字节不变；验证：新增六个注入/顺序/字节不变/转义用例通过
- [x] 3.3 `goal-completion.ts` 消费嵌套形状（auditorLabel、disabled 跳过、ledger provider/model/thinkingLevel）、`warmContext === false` 关闭 warm 注入、`feedbackNotes` 注入拒绝反馈；`goal-drafting.ts`/`goal-events.ts`/`goal-commands.ts`（offerClearRollback）同步切换；验证：delegation-completion 套件与 golden 用例通过
- [x] 3.4 审计 preflight 运行时感知回退（e2e 暴露的缺陷修复）：`runGoalCompletionAuditor` 接受可选 `pi`（ExtensionAPI）；preflight `missing_agent` 且提供 `pi` 时改用 `discoverAgentsWithRuntime` 合并视图解析，校验合并定义的 `tools`−`excludeTools` 保留 `report_auditor_progress`（`structured_output` 由结构化委派请求保证）后放行，解析不到仍原样 fail closed；`goal-completion.ts` 调用处传入 `core.pi`；验证：`tests/goal-auditor-package.test.ts` 新增三个用例——运行时注册 agent 通过 preflight 并正常委派、运行时视图也解析不到时 fail closed、`excludeTools` 剔除进度工具时 fail closed（且测试文件隔离 ambient `PI_SUBAGENT_EXTRA_AGENT_DIRS` 脏环境）

## 4. 移除 /goal-subagent-eject（goal-commands.ts）

- [x] 4.1 删除命令注册、`ejectGoalAuditorCommand`、`AGENT_MANAGEMENT_MODULE` 导入与 `AgentManagementApi` 类型；`/goal-settings` 菜单 `SETTING_ROWS` 迁移为嵌套 path（`["auditor","disabled"]` 等），`settingsValue`、modelSelector pairRoot、positiveInteger min 同步适配；验证：`tests/goal-command-palette.test.ts`、`tests/goal-surface-baseline.test.ts` 通过
- [x] 4.2 `tests/goal-settings-race.test.ts`/worker 改用 `["auditor", key]` 嵌套路径并发写入（原平铺键会被别名折叠吸收导致断言失真）；验证：race 测试通过

## 5. 测试补齐与回归

- [x] 5.1 `tests/goal-auditor-package.test.ts` 重写：D-05/D-12 md 发现与物化用例替换为注册模块用例（定义快照、定义合并、注册/跳过/不可用/碰撞安全、句柄释放、真实 preflight 的 D-04 project md 场景与 D-03 全局 md 前置）；验证：该文件仅剩已记录的 D-04 contact_supervisor 基线债务
- [x] 5.2 `tests/goal-settings.test.ts`/`goal-fork-settings.test.ts`/`goal-layered-settings.test.ts`/`goal-change-rollback.test.ts` 全面切换嵌套期望并补别名折叠、同层优先、持久化、diagnostics 用例；验证：`pnpm --filter pi-goal-x test` 全绿（除已记录 D-04 债务）
- [x] 5.3 补 `sandbox`/`permissionProfile` 用例：settings 解析（合法名接受、非法名/`false`/超长/非法字符 diagnostic 且不落盘）、持久化 round-trip、`effectiveSettingsReport` 两行、定义合并（提供即覆盖、缺省不出现、恒等保持）；验证：`pnpm --filter pi-goal-x test` 全绿（除已记录 D-04 债务）

## 6. 文档、版本与同步指引

- [x] 6.1 README：审计章节改写（运行时注册）、新增 `auditor` 三层配置全集与注入规则、旧→新键迁移表、eject 迁移口径、删除裸 `pi -e` 物化描述；验证：README 无 `/goal-subagent-eject` 残留
- [x] 6.2 `CHANGELOG.md` 0.8.0 条目（Changed/Removed/Migration）+ `package.json` 版本 0.8.0；`subtrees/pi-goal-x.json` notes 追加 fork 变更与"同步时不得恢复 md/物化机制"指引；验证：`direnv reload` 元数据校验通过、`pnpm exec prettier --check` 通过
- [x] 6.3 README：定义层表格补 `auditor.sandbox`/`auditor.permissionProfile` 两行（指向 pi-subagents fork 的命名 profile，选择器语义 + fail-closed 提示）；验证：README 定义层章节覆盖两字段
