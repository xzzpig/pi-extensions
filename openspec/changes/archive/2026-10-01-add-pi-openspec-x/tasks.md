# Tasks

## 1. 包脚手架

- [x] 1.1 创建 `packages/pi-openspec-x`：目录结构、`package.json`（npm 名 `@xzzpig/pi-openspec-x`，pi manifest 指向 extension 入口；peerDependencies 声明 `@xzzpig/pi-subagents`、`@xzzpig/pi-sandbox`、`@xzzpig/pi-goal-x`）、tsconfig；验证：`pnpm install --frozen-lockfile` 与 `pnpm --filter pi-openspec-x run typecheck` 通过
- [x] 1.2 ExtensionFactory 入口骨架与配置面（`opsx-agent` 构建产物白名单 glob 等可配置项）；验证：pi 加载扩展无报错，`pnpm exec prettier --check packages/pi-openspec-x` 通过

## 2. 官方轨动态 skill

- [x] 2.1 openspec CLI 解析器：PATH 解析二进制、`--version` 探测（每 session 一次节流）、`schemas --json` / `templates --json` 调用与错误处理；验证：单测覆盖 CLI 存在/缺失/版本变化三种情形（spawn mock）
- [x] 2.2 skill 生成器：按 CLI 输出生成 5 个同名 SKILL.md 到 `<agentDir>/cache/pi-openspec-x/skills/<version>/`（agentDir 遵循宿主目录解析，参照 pi-goal-x `resolveAgentDir`），骨架文案含版本戳与 artifact 清单、执行期指向 `openspec instructions` 现取；同版本命中缓存不调用 CLI；验证：单测断言生成内容、缓存命中（mock CLI 计数不增）、自定义 agent 目录解析
- [x] 2.3 接线 `resources_discover` 返回 `skillPaths`；CLI 缺失时不注册并发一次性提示；验证：集成测试（真实 pi 加载）确认 skill 在会话可见、缺失时不崩溃（注：真实 pi 0.87.1 加载冒烟通过——resources_discover 触发、5 个 skill 落盘；会话内 system-prompt 可见性验证因环境缺 PI_NEW_API_KEY 并入 10.1 e2e）
- [x] 2.4 静态同名 skill 检测提示（探测项目 `.pi/skills/openspec-*`，提示移除、不代删）；验证：fixture 项目单测断言提示内容与文件未被改动

## 3. pi-sandbox 二次开发：编程注册 API

- [x] 3.1 fork-only 修改（遵循 `pi-fork-divergence`：fork-only 文件、上游字节稳定、`knownDebt` 申报、whitespace 审计与 `pnpm run audit:fork-divergence` 过门）：会话级内存 profile 注册表 + profile 解析单点 merge（**用户配置同名 > 运行时注册**）+ 包根导出 `registerSandboxProfiles(profiles)`（非法 profile 定义拒绝，注册不落盘）；验证：单测断言注册后 `setProfile` 可选、用户同名优先、未注册名行为不变
- [x] 3.2 插件侧接线：扩展初始化经新 API 注册三个 profile（`opsx-planner` / `opsx-agent` / `opsx-reviewer`，定义由 JSON 示例迁为代码常量）；验证：集成测试断言 `sandbox.json` 无 opsx profile 时 `setProfile('opsx-planner')` 直接成功且用户配置文件未被修改

## 4. 受限模式基座（消费第 3 组 API）

- [x] 4.1 角色激活通道：`active_agent` entry + `SandboxService.setProfile`，`session_start` 清理残留状态；验证：单测模拟事件序列断言 profile 切换与清理
- [x] 4.2 fail-closed：pi-sandbox 缺失时拒绝进入计划态/代理实现态并说明原因，直实现模式与官方轨不受影响；验证：单测模拟缺失依赖

## 5. 子 agent 与结构化上报

- [x] 5.1 三个插件侧上报工具的 schema 与注册：`report_gap_analysis`、`report_plan_review`（verdict: OKAY/ITERATE/REJECT）、`report_work`；验证：schema 校验单测（非法 verdict 拒绝）
- [x] 5.2 运行时注册四个子 agent（gap-analysis / plan-review / opsx-reviewer 只读白名单 + worker 全写；opsx-reviewer 的 tools 含 `report_auditor_progress` 以过底座 preflight，最终裁决走底座 `structured_output` 通道；内嵌提示词：decision-complete 规则切片、OmO 审查纪律、ITERATE 2 轮/同 blocker 2 轮升级上限、worker 对计划文件只读）；验证：委派总线往返单测，结构化 `result` 字段可读
- [x] 5.3 验证 runtime 注册 agent 能否被 pi-agent-role 的 `/role` 枚举；结论写入 README（并入 10.3 文档任务，无独立交付物）；验证：探针运行记录随 10.3 归档（结论：不能——注册表按 owner ExtensionAPI 键控，`/role` 视图不含 opsx agent；README 不得宣传 /role 互操作，受限模式切换不受影响）

## 6. goal 底座集成（先于 /opsx:implement）

- [x] 6.1 双 fork seam（pi-goal-x，遵循 `pi-fork-divergence` 纪律，同 3.1 的门禁要求）：S1 per-goal auditor 覆盖（goal-completion 审计设置读取单点 merge，goal 级 > 全局，损坏覆盖回退全局）；S2 审计委派 agent 解析路径支持跨扩展运行时注册 agent（`goal-auditor-delegation.ts` 本为 fork-only；若 pi-subagents 无跨扩展查询面则退化为 fork 内代注册组合方式）；验证：单测断言覆盖解析顺序与普通目标路径字节不变
- [x] 6.2 objective 组装器：tasks.md → Steps、只读边界 → Boundaries/Don'ts、`Verification contract:` 生成；任务数 > `set_goal_tasks` 上限 50 时拒绝进入实现并指引拆分；镜像只用 pending/complete 二值映射；流程纪律写进 objective 文本，不改全局策略开关；验证：单测覆盖有任务/空任务/无 tasks.md/超 50 项四种输入
- [x] 6.3 任务源同步：组装时经 `set_goal_tasks` 单向镜像 tasks.md，勾选写回后 `update_goal_task` 跟随；不一致时以 tasks.md 重镜像并告警；验证：单测模拟双向扰动断言 tasks.md 权威
- [x] 6.4 启动与恢复接线：`create_goal(sisyphus)`（代理模式）/ 普通 autoContinue（直实现）启动；`session_start` 检测未完结目标提供恢复入口（复用 goal-x `/goal-resume` 语义）；检测用户手动清除/暂停底座目标的分叉并提示；只读诊断、修复需确认；验证：单测模拟崩溃-重启-恢复与手动清除分叉全序
- [x] 6.5 审查窗口接入：实现阶段审查范围取底座窗口 delta 并注入 reviewer 派发上下文，非 git 目录降级为全量读代码 + `report_work` 声明；验证：fixture git 仓库单测——窗口前脏文件不出现在审查范围
- [x] 6.6 fail-closed：pi-goal-x 缺失时拒绝 `/opsx:implement`（plan 与官方轨不受影响）；验证：单测模拟缺失依赖

## 7. /opsx:plan 计划流程

- [x] 7.1 命令接线与 cache 稳定注入：进入计划态发模式契约消息，各阶段经 turn_end BoundaryResult / steer 追加指令块（现场取 `openspec instructions <artifact> --change <id> --json`，change 未创建或 CLI 报错时降级骨架文案并提示）；全程不改写系统提示、不增删 skill；验证：集成测试断言注入均为 append-only、降级路径可用
- [x] 7.2 审查循环编排：缺口分析中途派发与发现吸收、成品后计划审查门（非 OKAY 修订重审）、裁决与轮次及派发用量（委派总线 usage）追加进 plan 阶段 append-only 记录（`reviews.md` 由其投影）、升级上限触发用户接管；验证：单测模拟裁决序列（OKAY 直通 / ITERATE×2 升级 / REJECT 同 blocker 升级）
- [x] 7.3 用户审批门：pi-ask 探测与纯文本降级，未批准不得进入实现（含写权限收敛生效）；验证：单测 + 集成测试

## 8. /opsx:implement 实现流程（消费第 6 组产物）

- [x] 8.1 模式选择（命令参数或结构化提问，未选定不动作；同会话已有进行中流程时拒绝并指引恢复/结束）与主会话直实现路径（不切角色，普通 autoContinue 目标承载，终点接最终审查门）；验证：单测
- [x] 8.2 agent 代理路径：经 6.2 组装 objective + `create_goal(sisyphus)` 启动 + `opsx-agent` profile + worker 6 段式派发契约 + 派发后逐文件 diff 审查对照 `report_work` 声明 + build/test 验证通过才勾选 tasks.md 并经 6.3 同步 goal 任务树；验证：fixture 项目 e2e 断言越区写被拒、未审查不勾选、goal 推进不空转（**已真机验证**：objective 强制六段式契约并要求先 `report_work` 再勾选；`src/tick-gate.ts` 在 `update_goal_task status=complete` 的 `tool_call` 阶段强制拦截——真机首轮 block「no observed opsx-worker dispatch」→ 派发后 block「has not been reviewed」→ `report_work` 后放行并产生 `task_complete`；主代理直接 edit 源码被 `opsx-agent` 的 allowWrite 拒绝；`detectStalledDispatch` 空转提示有单测）
- [x] 8.3 最终整体审查门：完成 = goal-x 完成事务内建审计（执行者经 6.1 的 per-goal 覆盖指向 opsx-reviewer）；REJECT（disapproved）时目标保持未完成 → 修复（代理模式派 worker / 直实现主会话修）→ 重审循环至 APPROVE，随后引导归档且不代执行；验证：e2e 断言"全勾 + REJECT 时目标未完成、APPROVE 后才完成、普通 `/goal` 审计走默认 agent"

## 9. 可观测性与总线互操作

- [x] 9.1 流程条目与渲染：自定义条目（模式进出/阶段变更/裁决/勾选）+ `registerMessageRenderer`/`registerEntryRenderer` 进度行 + 每 turn `display:false` 状态快照与压缩后恢复（plan 阶段自建；实现阶段进度看板复用 goal-x 底座）；验证：单测断言条目序列与快照渲染，compact 模拟后界面状态可恢复
- [x] 9.2 子 agent 进度投影：上报工具携带阶段标签 + 百分比，父会话观察工具调用投影为看板（同阶段重复进度折叠），会话状态行常显当前模式/阶段；验证：单测模拟进度序列断言投影与折叠
- [x] 9.3 lifecycle 总线事件：`pi-openspec-x:lifecycle:v1` 单通道发布 + 导出 payload TS 类型 + README 事件字典（含 pi-sentinel `event:` 订阅示例）；验证：单测断言一次完整流程的事件序列与 payload 结构（**已完成**：11 个类型全部有真实发射方——`task_dispatched`/`task_completed`/`final_verdict` 由 `createImplementLifecycleToolHandler` 观察 `subagent(agent=opsx-worker)`/`update_goal_task`/`update_goal` 的工具流量发出，`mode_exited` 在实现流程结束及 `/opsx:implement` 接管计划模式时发出；测试改为驱动真实 handler 而非自造事件数组；README 事件字典补齐每个类型的触发点与「观察而非推送」说明）
- [x] 9.4 pi-notify 字面桥接：阻塞 UI 前 emit `pi-notify:ui_span_silent`，审批等待/流程完成/门控异常分别发 `input-required`/`task-completed`/`integration-error`，pi-notify 缺失时零影响；验证：无 pi-notify 环境单测 + pi-notify 在场的集成测试断言通知到达（**已完成（单测侧）**：三个通知 id 均有真实发射方——审批等待 `input-required`、流程结束 `task-completed`、objective 组装失败与 opsx-agent 受限模式进入失败 `integration-error`；两个阻塞弹窗（审批、模式选择）都先 emit `ui_span_silent`；「pi-notify 在场」的集成断言因 pnpm 隔离无法在单测中 import 该包，交由 10.1 e2e）

## 10. 质量门与发布准备

- [x] 10.1 e2e（pi-plugin-e2e-test）· 官方轨与计划轨：skills 出现与版本缓存、`/opsx:plan` 全门序（缺口分析→计划审查→审批）、lifecycle 事件与通知桥接；验证：e2e 报告全绿（真实 pi+tmux：`[Skills]` 列出 5 个 openspec-\*、缓存 `skills/1.13.1/`；planner 模式进入 + 4 个 append-only plan-phase 块；opsx-gap-analysis 派发并被吸收、opsx-plan-review 返回 OKAY；`opsx_record_plan_review` 打开阻塞审批弹窗，批准后账本落 `plan_review_verdict`+`plan_approval` 并投影 reviews.md）
- [x] 10.2 e2e（pi-plugin-e2e-test）· 实现轨：`/opsx:implement` 双模式（goal 底座推进、REJECT 循环收敛、互斥拒绝）、崩溃恢复、普通目标审计隔离；验证：e2e 报告全绿（真实 pi+tmux/agnes-2.0-flash：direct 与 agent 双模式均跑通；goal 推进 create_goal→set_goal_tasks→实现→验证→勾选→完成审计 approved→archived；REJECT 循环：首轮 audit_result=disapproved 且目标保持 active→修复→重审 approved→completed；互斥拒绝、普通 goal 审计走 goal-auditor 隔离、强杀重启 recovery-notice+/goal-resume 均验证）
- [x] 10.3 README 与文档：安装、双轨说明、profile 注册说明（无需手动配置沙箱）、静态文件迁移、lifecycle 事件字典、goal 底座与恢复说明、`/role` 互操作结论（5.3）、`reviews.md` 格式；验证：文档审阅通过
- [x] 10.4 仓库质量门与发版准备：`pnpm --filter pi-openspec-x run typecheck && pnpm --filter pi-openspec-x test`、`pnpm run verify`（fork-divergence 审计 + prettier）全绿，版本 0.1.0；验证：命令退出码 0

## 11. REJECT 回滚带备份（补齐 spec MUST：原分解漏项）

- [x] 11.1 回滚安全模型：`/opsx:rollback <change-id>` 按「先计划、备份落盘、后动工作树」三步委托 goal-x 的 `goal-change-rollback`：`planRollback` 只读产出动作清单，`writeRollbackBackup` 把将被丢弃的文件以可回放补丁复制到 `.pi/goals/archived/rollback_<ts>_<goalId>/`（补丁 + `manifest.json`）且失败即中止，`executeRollback` 才修改工作树（`restore` 走 `git checkout <baseline stash> -- <path>`，窗口内新增文件删除，重命名按「删新路径 + 恢复旧路径」撤销）；回滚范围严格限定执行窗口 delta，窗口前已存在的未提交改动不在 delta 内因而永不被动到；非 git 仓库/未诞生 HEAD/无 baseline 降级为「不可用」且不改动任何文件；不提供按任务回滚；实现：插件侧 `/opsx:rollback` 是薄入口（找 change 的 active goal、读窗口 delta、委托 goal-x 的 `goal-change-rollback`：plan → writeRollbackBackup → executeRollback），备份落 `.pi/goals/archived/rollback_<ts>_<goalId>/`（可 git apply 回放的补丁 + manifest.json），goal-x 与插件永不漂移；验证：单测（fake facet 断言 plan→backup→execute 顺序、备份失败不动工作树、delta 缺失/无 goal/加载失败降级）+ 真机 e2e（baseline 落盘后改 `src/x.js` 为 `x()=>7`，`/opsx:rollback rb` 恢复为 `x()=>1`、备份目录落 `.patch` 与 `manifest.json`、提示 "Rolled back 1 file(s)"）
- [x] 11.2 回滚流程条目与提示：新增 `pi-openspec-x/rollback` 自定义条目与渲染（`↩ rollback: N restored, M removed`），命令报告含跳过/失败明细与备份目录；验证：单测断言渲染与报告文本

## 12. 审查修正轮（spec 映射漏项与死代码清理）

- [x] 12.1 spec MUST 补齐：REJECT 回滚带备份（11.1/11.2）；验证：单测（fake goal-x facet：先 plan、backup 失败即中止且不动工作树、execute 成功）+ 真机 e2e（11.1 内联证据）
- [x] 12.2 skill 会话级冻结：首次成功解析后按 `agentDir::cwd` 钉住版本与目录，reload/重发现复用，会话中途 CLI 升级不生效（`resetSkillsFreezeForTests`）；验证：单测断言第二次发现（注入更高版本）仍返回首次路径与版本，失败解析不冻结
- [x] 12.3 压缩/重启后状态恢复接线：`restoreFlowState`/`currentFlowState` 接进状态行 handler——内存注册表为空时从最后一个 status-snapshot 条目恢复渲染（`ended` 标记的流程不再渲染）；验证：单测断言空注册表时恢复渲染、ended 不渲染、live 优先
- [x] 12.4 结构化进度上报与投影：三个上报工具增加可选 `progress:{phase,percentage,label?}`，父侧 `registerProgressObserver` 折叠为 `pi-openspec-x/progress` 条目并投影看板（同 agent+phase 取最高百分比）；验证：单测断言 schema 字段、`progressUpdateFrom` 容错、观察器折叠
- [x] 12.5 只读诊断接线：恢复提示改由 `diagnoseFlow` 产出（未完结单一目标时含分叉检测 notice），`repairRequiresConfirmation` 保持只读；验证：goal-base 测试断言恢复消息与静默路径
- [x] 12.6 死代码清理：删除 6.5 的 `[OPSX REVIEW SCOPE]` 渲染块与 8.2 的 `renderWorkerDispatch`（契约保留为 objective 散文 + `STANDARD_WORKER_MUST_NOT_DO`；理由：goal-x 原生把 change manifest 注入审查上下文、插件侧无注入点）；验证：typecheck/tests 全绿
- [x] 12.7 门控结构化化与口径修正：`report_work` 增加 `verificationPassed`，门优先于文本启发式；spec/README 修订 C1（skill 内容指向现场输出）、C3（自建通道等价于始终降级）、C4（写拒绝由沙箱层给出、模式契约预先指明）；验证：单测断言结构化裁决优先于 result 文本
