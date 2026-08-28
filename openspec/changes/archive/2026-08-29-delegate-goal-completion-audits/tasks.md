## 0. 实现范围约束

- [x] 0.1 初始范围内，`packages/pi-subagents` 仅允许从现有 eject handler 抽取共享 service，以及该 service 的直接 public export、必要适配和测试
- [x] 0.2 用户在真实 Pi 事件确认 host 以 `message_end`/`toolResult` 而非 `tool_result_end` 发出 auditor tool result 后，明确批准一项额外的最小 runtime 修复：仅在 foreground executor 归一化这两种既有 event shape、按 `toolCallId` 去重，并修改其直接测试
- [x] 0.3 发布前复核允许 `src/api/preflight.ts` 的 `packageVersion()` 对损坏 package metadata 提供 fail-closed 错误包装；不得改变其 public async contract、launch 语义或工具计划
- [x] 0.4 除上述例外外，delegation 调度、preflight、MCP、skills、Fleet、mission、slash command 和文档实现仍不修改；范围外 lint/warning/格式问题明确忽略，不为消除它们扩展 `pi-subagents` 修改面

## 1. 改造前基线与验收追踪

- [x] 1.1 为 spec 中每个 `D-01..D-13` 和 `I-01..I-18` 建立初始追踪表，标出改造前用例、计划中的改造后用例、自动化/人工验证类型及负责测试层次
- [x] 1.2 在修改运行时代码前执行现有 auditor、completion、settings、五阶段 dashboard/result card、transcript overlay、`/goal-audit` command surface 和 Escape 相关测试，将命令、版本、结果与已知缺口记录到 `compatibility-verification.md` 的“改造前基线”部分
- [x] 1.3 评审追踪表，确认每个 baseline ID 都有可执行的验证方案，且所有可自动化行为均未降级为人工检查

## 2. 包、默认审计 Agent 与管理 API

- [x] 2.1 在 `pi-goal-x` manifest 中加入兼容版本的 `@xzzpig/pi-subagents` 运行时依赖和 package agent 声明，移除仅供 transcript 面板使用的 `@xzzpig/pi-components` dependency/bundledDependency，并同步 package lockfile
- [x] 2.2 新增 `agents/goal-auditor.md`，配置隔离 system prompt、fresh/read-only 角色约束、默认严格普通工具集、禁用 ambient extensions 和 package-required progress provider
- [x] 2.3 将 `report_auditor_progress` 移为 auditor agent 使用的 child-only extension tool；通过版本化 tool-result record 而非 `currentToolArgs` 展示摘要传递 label/percentage。`pi-subagents` foreground executor 同时归一化真实 `message_end`/`toolResult` 和 `tool_result_end`，并在 bounded progress stream 中按 toolCallId 去重，确保 delegation update 驱动现有五阶段 dashboard
- [x] 2.4 在 `pi-subagents` 从现有 eject handler 抽取共享 service，并新增 `@xzzpig/pi-subagents/agent-management` public export 与结构化 `ejectAgentDefinition` 结果类型
- [x] 2.5 让 eject service 保持 package agent 的 path-bearing extensions/skills 依赖在目标 scope 可解析，并以重新 discovery、资源存在性、skills/tool-plan launch preflight 和 no-overwrite 作为成功条件；不改变 `pi-subagents` 的 public launch/preflight contract
- [x] 2.6 为 package agent discovery、内部 progress tool、默认 frontmatter、public eject API 和发布内容增加自动化测试

## 3. 审计配置迁移

- [x] 3.1 在 `GoalSettings` 中新增并校验 `auditorAgent`，默认解析为 `goal-auditor`，同时覆盖 load/save/effective-settings round trip
- [x] 3.2 保留 `auditorProjectResources` 的兼容读取但停止应用该设置，并在 verbose status/settings UI 中显示迁移到 auditor agent 配置的废弃提示
- [x] 3.3 将现有 provider/model/thinkingLevel 组合为 delegation request 的 model/thinking override，并测试未配置时由 agent 默认值接管

## 4. Structured Delegation 适配器

- [x] 4.1 定义固定的审计 structured-output JSON Schema，以及从 schema-valid value 映射到 `GoalAuditorResult` 的纯函数和测试
- [x] 4.2 实现 foreground delegation 请求客户端：生成 request/owner/node identity，先订阅 started/update/response 再发送请求，并只接受完整 identity 匹配的事件
- [x] 4.3 将现有目标、任务树、验证契约、completion summary 和 warm ledger evidence 组装为 fresh-context 审计 task，并确保父会话历史不被隐式传入
- [x] 4.4 实现 started handshake timeout、terminal timeout、监听器清理和缺失/不兼容 `pi-subagents` runtime 的可操作错误，且不调用旧 auditor fallback
- [x] 4.5 将 delegation terminal statuses 完整映射为 approved、disapproved、cancelled 或 audit error，覆盖 failed、timed_out、interrupted、budget exhausted、structured_output_failed、duplicate_node 和 unavailable_context
- [x] 4.6 将外部 AbortSignal 映射为带完整 identity 的 delegation cancel 事件，并验证 cancel-before-start、运行中取消及重复终态均只产生一次结果

## 5. 完成流程、命令与高层审计 UI

- [x] 5.1 在 `runGoalCompletionFlow()` 中以新的 delegation adapter 替换 embedded session 调用，同时保持 completion focus token、ledger 事件、拒绝反馈和 deferred completion transaction 不变
- [x] 5.2 将 delegation started/update/response 和 `report_auditor_progress` 的 tool-result record 映射到现有 `auditProgress`，只从 `recentOutputLines` 读取 progress authority，不将 `currentToolArgs` 展示摘要当作 JSON；保持五阶段名称、百分比带、progress bar、auditor identity、elapsed time、展开工具诊断和 done/100% 终态
- [x] 5.3 保留 `APPROVED`、`CHANGES REQUIRED`、`ERROR` result card、findings 摘要和约 6 秒后恢复正常 dashboard 的 timer/状态语义
- [x] 5.4 删除 `SessionTranscript`/`lastAuditTranscript` 状态、auditor transcript overlay 文件与自动 open/refresh/close 逻辑，并从 curated command 注册和 surface baseline 中删除 `/goal-audit`
- [x] 5.5 注册 `/goal-subagent-eject`：解析 `global|project`，无参数交互选择，headless/无效参数显示 usage，project scope 检查 trust，并调用 public eject API 后显示结构化结果
- [x] 5.6 保证 eject 成功、失败、冲突或取消均不修改 goal、focus、runtime、ledger、auditProgress 或 completion 状态，并且从不覆盖现有目标文件
- [x] 5.7 确认 structured delegation foreground child 自动出现在 `pi-subagents` Fleet，Goal-X 不实现第二套 transcript/Fleet viewer，且 Fleet UI 故障不影响审计事务
- [x] 5.8 复用现有 Esc audit-cancellation 对话框，验证“无审计完成”和“继续工作”两条分支均保持既有 ledger 与 goal 状态语义
- [x] 5.9 删除 embedded auditor 的 `createAgentSession`、内存 SettingsManager/SessionManager、ResourceLoader、文本 verdict parser 及不再使用的 session-event/transcript stub/import

## 6. 基线驱动的行为与集成测试

- [x] 6.1 在新增或调整的测试名称/注释中引用对应 `D-*` / `I-*` ID，并持续更新追踪表，确保测试实现与规格条目双向可追溯
- [x] 6.2 增加 delegation adapter 单元测试，覆盖结构化批准、结构化拒绝、普通文本伪批准、schema 缺失/无效和所有非成功 terminal status
- [x] 6.3 增加事件生命周期和 dashboard 测试，覆盖 display-safe progress tool 参数摘要、tool-result record 投影、五阶段百分比、identity 隔离、runtime 缺失、启动超时、取消、observer 异常和 listener/timer 清理
- [x] 6.4 扩展完成流程测试，验证本地 gate、audit_started/audit_result/audit_skipped ledger、stale focus、批准提交、拒绝保持 active、错误后手动重试及用户显式绕过
- [x] 6.5 保留并适配 `goal-audit-dashboard`/widget 测试，覆盖五阶段顺序与百分比带、响应式宽度、展开诊断、三类 result card 和 timer 后恢复正常 dashboard
- [x] 6.6 删除 transcript overlay 与 `/goal-audit` reopen 测试，改为断言旧 overlay/command/state/dependency 已移除，`/goal-subagent-eject` 已加入 command palette/surface baseline，并验证 README 与 pack surface 一致
- [x] 6.7 增加 public eject API 与 command 测试，覆盖 global/project 路径、交互选择/取消、headless usage、无效参数、project trust、已有 agent/chain/file 冲突、逐字节 no-overwrite 和结构化通知
- [x] 6.8 增加 eject 后 discovery 测试，证明 ejected agent shadow package source，system prompt、普通工具和 progress/extension 的 package-relative 依赖仍可解析；不为 launch-preflight 修改 `pi-subagents` 其他实现
- [x] 6.9 增加真实或 loader-based 子进程集成测试，验证 fresh context、标准 Pi retry settings、严格工具白名单、extension/progress tool 可用性、缺失 provider 的首轮前失败和 foreground child 的 Fleet registration
- [x] 6.10 增加 MCP fixture 测试，验证 `mcp:<server>/<tool>` 只暴露选定 direct tool 且不会隐式授权其他 MCP 或普通工具
- [x] 6.11 增加认证与配置边界测试，证明磁盘/env 认证可用于 child、父进程 runtime-only provider 不会被误继承，并验证 `auditorProjectResources` 迁移提示
- [x] 6.12 执行确实无法自动化的 Fleet/TUI 联合观察验证，记录 D-08/I-12/I-17/I-18 的终端环境、步骤、预期与实际结果
- [x] 6.13 验证 Goal-X、eject service 与用户批准的 foreground event-normalization 的相关 typecheck/unit/command contract；`pi-subagents` 其他非 scope 文件的既有 lint/warning 不修复且不纳入本变更
- [x] 6.14 增加真实 `message_end`/`toolResult` 前景 child 事件回归，覆盖 `tool_result_end` 双形态去重、bounded `recentOutput` 与 structured delegation `recentOutputLines` 投影

## 7. 文档、差异验收与最终验证

- [x] 7.1 更新 `pi-goal-x` README，记录双包安装/加载要求、默认 auditor agent、`/goal-subagent-eject` global/project 用法、用户 override 示例、Pi retry settings 继承、runtime-only provider 限制，以及使用 Fleet 查看详细 review
- [x] 7.2 更新 `pi-goal-x` 文档和 CHANGELOG，说明 eject API、无 embedded fallback、`/goal-audit`/transcript overlay 移除、五阶段 dashboard/result card 保留及 `bash` 非沙箱边界；不修改 `pi-subagents` 范围外文档
- [x] 7.3 检查 npm pack 内容包含 agent/progress provider、agent-management export 与 delegation dependency，不包含已删除 transcript overlay 或 `pi-components` bundle，并确认不会重复自动注册 `pi-subagents` extension
- [x] 7.4 完成 `compatibility-verification.md`：为全部 `D-01..D-13`、`I-01..I-18` 填写测试文件/用例、命令、预期、实际结果和 PASS/FAIL，并列出任何未声明差异
- [x] 7.5 对比改造前基线和改造后结果；任何缺失、未执行、FAIL 或未声明差异都必须阻塞完成，先修复实现或更新并重新评审 OpenSpec artifacts
- [x] 7.6 运行 OpenSpec strict validation、Goal-X 与 eject-service 相关测试、范围内格式检查和 diagnostics，并把命令、输出摘要、残余风险写入最终验收记录；范围外 `pi-subagents` lint/warning 明确忽略
- [x] 7.7 最终 `git diff` 仅保留 `pi-subagents` eject service、其 public entrypoint、manifest export、直接测试，以及用户批准的 foreground tool-result event-normalization 与直接测试；其他 `pi-subagents` 差异必须还原
- [x] 7.8 使用新 Pi interactive 进程复验真实 child 的 20/40/60/80% record 依次到达 Goal-X dashboard；用户已确认进度正常展示，已移除临时诊断代码

## 8. 发布前复核修复

- [x] 8.1 修复用户 Esc/unfocus 取消未获 terminal acknowledgement 时可能永久挂起的问题；取消后任何迟到 structured approval 必须 fail closed，并增加 identity、timer 与 listener cleanup 回归测试
- [x] 8.2 让 public eject service 在写入后重新检查 ejected agent 的 skill 与 launch tool plan；失败时删除仅由本次 eject 创建的文件，并增加成功/rollback 测试
- [x] 8.3 将 Goal-X 升至 `0.2.0`、pi-subagents 升至 `0.4.2`，同步 `versions.json`、workspace/package lock、精确 runtime dependency、package file allowlist 与 CHANGELOG
- [x] 8.4 重跑 release 相关测试、pack content 检查、OpenSpec strict、格式、diagnostics 与独立最终 review；独立 `pack -> install -> RPC` 门禁不纳入本变更，保留用户完成的人工打包安装验证
