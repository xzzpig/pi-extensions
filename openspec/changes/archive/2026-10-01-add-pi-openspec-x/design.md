# Design

## Context

动机见 proposal。落地前已核对的宿主能力（约束了设计的形状）：

- pi 宿主支持 `resources_discover` 事件返回 `skillPaths` 热加载 skill（`resource-loader.js` 的 `extendResources`），全仓库尚无插件使用，但机制完整；skill 列表会进系统提示，因此**中途增删 skill 会击穿提示词缓存**。
- `@xzzpig/pi-subagents` 提供运行时 agent 注册（`registerAgentViaEvents`，pi-goal-x 的 goal-auditor 已在用）、委派总线（request/:response，支持 `result: {kind:"structured", schema}`）与按 agent 的 tools 白名单。
- `@xzzpig/pi-sandbox` 以 `sandbox.json` 的命名 profile（`filesystem.allowRead/allowWrite` + bash OS 级沙箱）提供门控，`SandboxService.setProfile(name)` 切换；pi-agent-role 的角色激活走 `active_agent` entry + `PI_SUBAGENT_PERMISSION_PROFILE`/沙箱 profile 双通道。
- openspec CLI 1.13.1 的可提取面：`--version`、`schemas --json`、`templates --json`（返回可读模板路径）、`instructions <artifact> --change <id> --json`（依赖 change 上下文）。Nix 安装形态下包体不可假设可读，只能走 CLI 黑盒。
- 本仓库约定：openspec 产出物用简体中文（`openspec/config.yaml` context），这对官方轨 skill 生成的语言选择无约束（官方轨保持 CLI 原味），增强轨提示词需遵循。

## Goals / Non-Goals

**Goals:**

- skill 内容与实际安装的 CLI 版本强一致（提取，而非内置副本）。
- 增强流程的门控全部确定性：结构化裁决字段驱动，不解析自由文本。
- 受限模式（计划态、代理实现态）的写权限收敛走 OS 级沙箱，失败即拒绝进入（fail-closed）。
- 全程保住提示词前缀缓存：append-only 注入，session 内 skill 集与系统提示冻结。

**Non-Goals:**

- 不修改 openspec CLI、pi 宿主或其他包的任何代码。
- 不做跨 session 的模式状态持久化（角色 session 级，沿用 pi-agent-role 惯例）。
- 不内置 plan 的自动归档（归档始终由用户显式触发）。
- 不复制 oh-my-openagent 代码，仅吸收其流程设计（Prometheus/Metis/Momus/Atlas 的纪律以原创提示词重写）。

## Decisions

### D1 官方轨 skill 的提取通道：`resources_discover` + 版本化缓存

监听 `resources_discover`，解析 PATH 上的 `openspec`，依次取 `--version`、`schemas --json`、`templates --json`，生成 5 个同名 SKILL.md 写入缓存目录后返回 `{ skillPaths: [dir] }`。

- **缓存键**：CLI 版本号；缓存目录 `<agentDir>/cache/pi-openspec-x/skills/<version>/`，`agentDir` 经宿主的 agent 目录解析（遵循自定义 agent 目录，如 `PI_CODING_AGENT_DIR`，参照 pi-goal-x `resolveAgentDir` 先例），项目无关、跨项目复用。版本探测每 session 只做一次；缓存命中时不调用任何提取命令。
- **生成内容分层**：skill 骨架（触发时机、双轨边界、命令编排）为插件自有文案；schema/artifact 清单与模板要点来自 CLI 现场；**权威指令不进 skill 正文**——skill 指示 agent 在执行时运行 `openspec instructions <artifact> --change <id> --json` 现取（instructions 依赖 change 上下文，生成期不可得；现取也保证与 CLI 行为零漂移）。
- **否决的备选**：运行 `openspec update --tools pi` 抓官方生成文件——需要在已 init 的项目里写用户目录，且取到的仍是"当时的"静态副本，不解决漂移。

### D2 静态同名 skill 冲突：检测 + 提示，不代删

启动时探测项目 `.pi/skills/openspec-*`，命中则发一条提示（冲突路径 + 移除建议）。删除用户文件必须用户自己做或明确授权，插件不代劳。

### D3 子 agent 全部运行时注册，定义内置于插件

Gap-analysis / Plan-review / opsx-reviewer / opsx-worker 经 `registerAgentViaEvents` 注册（照 pi-goal-x goal-auditor 模式），不落 agent markdown 文件：

| agent         | tools 白名单                                                   | acceptanceRole | 裁决/上报通道                                                                                                        |
| ------------- | -------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| gap-analysis  | read + report_gap_analysis                                     | read-only      | `report_gap_analysis`（意图分类、矛盾/缺失约束/scope 风险/无依据假设/缺验收标准清单）                                |
| plan-review   | read + report_plan_review                                      | read-only      | `report_plan_review`（`verdict: OKAY/ITERATE/REJECT` + issues[file/line/description/blocking] + summary）            |
| opsx-worker   | 全写 + report_work                                             | writer         | `report_work`（改动文件清单、完成声明、自验证据）                                                                    |
| opsx-reviewer | read 类 + `report_auditor_progress`（底座 preflight 硬性要求） | read-only      | 最终裁决经底座完成审计的 `structured_output` 通道（schema 固定 verdict: approved/disapproved），插件不设平行裁决工具 |

前三个上报工具由插件注册、经委派总线以 `result: {kind:"structured", schema}` 返回；opsx-reviewer 由底座完成审计驱动，其裁决通道即 goal-x 的结构化输出 schema，插件侧留痕取自底座审计记录。worker 的 system prompt 声明 tasks.md 等计划文件对它只读，勾选权在主 agent（OmO：plan files READ-ONLY for worker）。循环上限纪律：`ITERATE` 自动修订最多 2 轮，之后升级用户；`REJECT` 无上限，但一旦其 blocker 与紧邻上一轮的 blocker 有交集就立即升级用户接管（一步升级，不需要连续两轮）。实现阶段的最终门由 goal-x 完成事务承担：`update_goal(complete)` 先跑独立审计、通过才提交完成，任务全勾而 disapproved 则目标保持未完成；审计执行者经 per-goal auditor 覆盖指向定制的 opsx-reviewer（见 D10），普通目标不受影响。

### D4 门控与角色切换走 pi-sandbox，三个内置 profile

- `opsx-planner`：allowWrite `openspec/**`，allowRead 项目全域。
- `opsx-agent`：allowWrite `openspec/**` + 构建产物 glob（`node_modules/**`、`dist/**`、`coverage/**`、`.cache/**`，可配置），allowRead 项目全域；bash 同白名单，主 agent 可自跑 build/test。
- `opsx-reviewer`：allowWrite 空，allowRead 项目全域。

激活复用 pi-agent-role 的通道（`active_agent` entry + `SandboxService.setProfile`），插件自带 `/opsx:plan`、`/opsx:implement` 命令完成切换，因此**不依赖 pi-agent-role 安装**；agent 定义携带 `sandbox:` frontmatter 以便 pi-agent-role 的 `/role` 发现与互操作（实现期探针结论：**不能互操作**——pi-subagents 运行时注册表按 owner ExtensionAPI 键控，`/role` 的发现视图不含跨扩展运行时注册的 agent；受限模式切换不依赖 `/role`，走自有命令 + 双通道，行为契约不受影响；README 不得宣传 `/role` 互操作）。**profile 的分发路径（pi-sandbox 二开）**：pi-sandbox 无 profile 编程注册 API（已核实：profile 仅来自用户 `sandbox.json`，`setProfile` 只能切换已存在 profile），故对 pi-sandbox 做 fork-only 二开新增**会话级内存 profile 注册表**——上游 seam 收敛在 profile 解析单点（`setProfile`/profile 查找处 merge 注册表），新增导出 `registerSandboxProfiles(profiles)`；解析顺序**用户配置 > 运行时注册**（用户同名定义不被覆盖），注册按会话生命周期、不落盘、不写用户配置文件。插件在扩展初始化时注册三个 profile；pi-sandbox 缺失时拒绝进入受限模式（fail-closed）。

- **否决的备选**：pi-permission-system 的 `path_write` 策略——用户明确选择 pi-sandbox；且 bash 重定向写只有 OS 级沙箱能完整拦住。

### D5 cache 稳定：append-only 三条纪律

1. 模式进入 = 追加一条"模式契约"消息（角色边界 + 流程总览）。
2. 阶段推进 = 只追加当前阶段的指令块，来源 `openspec instructions <artifact> --change <id> --json` 现取 + 该阶段的 decision-complete 规则切片；注入点用 turn_end BoundaryResult 或 steer 消息。
3. 禁止 `before_agent_start` 的 systemPrompt 覆盖做模式切换；skill 集 session 冻结（CLI 升级次 session 生效）。

### D6 双轨边界与命名

官方轨 5 个同名 skill 保持 CLI 原味流程；增强轨只有 `/opsx:plan` 与 `/opsx:implement` 两条命令（以及它们派发的 4 个子 agent）。增强轨的 change 脚手架复用官方 CLI 命令（`openspec new change`），不另造 artifact 格式；审查裁决记录写入 change 目录——plan 阶段事实源是插件自有 append-only 记录，implement 阶段事实源是底座账本（见 D10），`reviews.md` 为合并两者的人读投影（计划态与实现态主 agent 均可写该目录）。

### D7 可选依赖的探测与降级

`@eko24ive/pi-ask`、`@xzzpig/pi-agent-role` 均运行时探测（bus 通道/工具存在性），不做硬 peer：pi-ask 缺失降级纯文本提问；pi-agent-role 缺失用自身通道切换。`@xzzpig/pi-subagents`、`@xzzpig/pi-sandbox` 为必需 peerDependencies，缺失时插件报清晰错误退出。

### D8 可观测性：条目渲染 + 进度投影（照 pi-goal-x 模式）

三层界面，全部复用 goal-x 已验证的机制：

1. **流程条目**：以 `appendEntry` 写自定义条目（模式进出、阶段变更、派发、裁决、勾选），`registerMessageRenderer`/`registerEntryRenderer` 渲染为可见进度行；`display: false` 的状态快照条目每 turn 维护（goal-x 的 `buildTurnSnapshot` 模式），压缩后据此恢复界面。实现阶段的执行进度看板直接复用底座（goal-x），插件条目聚焦 plan 阶段与模式/裁决。
2. **子 agent 进度投影**：上报工具在最终裁决字段外携带过程进度（阶段标签 + 百分比，参照 goal-auditor-progress 的 label/percentage 参数与协议前缀文本）；委派期间父会话观察工具调用投影为看板，裁决字段仍单独作为门控输入（进度不影响门控）。
3. **会话状态行**：当前模式/阶段/轮次经 `ui.setStatus`/widget 常驻显示，受限模式下让"谁被限权、限到哪里"一目了然。

### D9 总线互操作：版本化 lifecycle 通道 + pi-notify 字面桥接

- **自有事件**：单一版本化通道 `pi-openspec-x:lifecycle:v1`，payload `{ type, change, ... }`（type 枚举：`plan_started` / `phase_changed` / `review_verdict` / `approval_wait` / `plan_approved` / `implement_started` / `task_dispatched` / `task_completed` / `final_verdict` / `flow_completed` / `mode_exited`），payload 的 TS 类型由插件导出供消费者复用。命名沿仓库惯例（对照 `pi-subagents:runtime-agent-register:v1`）。
- **pi-notify 桥接**：按其 API 约定以**字面 channel 名** emit、不 import 该包（缺失时零影响）：阻塞式 UI 打开前 emit `pi-notify:ui_span_silent`；审批等待 emit `pi-notify:publish` `{ eventId: "input-required", source: "pi-openspec-x" }`，流程完成发 `task-completed`，门控异常发 `integration-error`。
- **第三方消费**：channel 名与 payload schema 写入 README；pi-sentinel 用户可直接以 `event: pi-openspec-x:lifecycle:v1` 声明式审计增强流程。

### D10 执行底座：`/opsx:implement` 跑在 pi-goal-x 之上（零 goal-x 代码改动）

评估过"自建编排循环"与"复用 goal"两条路后选定复用：goal-x 的 scheduler 只负责推进主 agent（auto-continue 认领/checkpoint/恢复），不假设干活的是谁；objective 的结构化段恰好承载 opsx 的全部编排语义。

- **驱动方式**：主 agent 经 goal-x 公开工具 `create_goal` 启动（代理模式 `sisyphus: true`，直实现模式普通 autoContinue）。objective 由插件组装器生成：tasks.md 的任务清单 → `Steps` 段；只读边界（"主 agent 不得直接修改源码，一切改动经 opsx-worker 派发"）→ `Boundaries`/`Don'ts` 段；`Verification contract: 实现完成以完成审计 APPROVE 为准`。goal 的推进循环就此成为 opsx 的实现循环；崩溃恢复/压缩摘要/进度看板/窗口 manifest/窗口级回滚继承自底座，派发记账为插件自建（见能力边界）。
- **任务源同步**：tasks.md 是 openspec 契约（权威源），goal 任务树是底座状态——单向同步：组装器读 tasks.md 经 `set_goal_tasks` 镜像；主 agent 勾选写回 tasks.md 后以 `update_goal_task` 跟随。约束：`set_goal_tasks` 上限 50 项，超出时拒绝进入实现并指引拆分 tasks.md；镜像只使用 pending/complete 二值映射（不引入 goal 的 start/skipped 中间态）；禁止反向同步（goal 树上的手工改动不回流 tasks.md）。
- **审计关系（最终门 = 内建完成审计，流程隔离，双 fork seam）**：goal-x 的完成是单事务——`update_goal(complete)` 校验可完成状态后先跑独立审计，approved 才提交完成，disapproved 则目标保持 active（任务全勾 ≠ 完成）。因此最终审查门直接采用内建审计。已核实的落地障碍与对应 seam：① `settings.auditor` 是全局配置（会波及用户普通 `/goal`），且审计委派的 preflight 只做文件系统 agent 发现——**跨扩展的运行时注册 agent 对它不可见**（运行时注册表按 owner ExtensionAPI 键控；`missing_agent` 回退只认 goal-x 自身的 `goal-auditor`），指向 opsx-reviewer 会在启动前被拒。故 fork 收敛为两个 seam：**S1** per-goal auditor 覆盖——完成事务读取审计设置的单点（goal-completion 的 `settings.auditor` 读取处）改为 goal 级覆盖 merge；**S2** 审计委派的 agent 解析路径（`goal-auditor-delegation.ts`，本就是 fork-only 文件）支持对覆盖 agent 经 pi-subagents 运行时注册表解析。opsx-reviewer（只读，tools 含 `report_auditor_progress`）经该链路成为审计执行者，裁决走底座 `structured_output` schema；审查纪律（计划符合度/代码质量/验证证据/scope 保真、每轮 blocker 须新颖）经覆盖的提示词清单注入；窗口 delta 由底座审计的变更清单原生提供。普通目标走原路径，行为字节不变。`Verification contract` 保留一句行为契约（"实现完成以完成审计 APPROVE 为准"）。
- **底座能力边界（继承 vs 自建）**：直接继承——推进循环、崩溃恢复、压缩摘要、窗口 manifest、窗口级回滚（`/goal-clear` 用户命令触发）、完成审计；**不在底座、由插件自建**——派发用量记账（goal-x 账本无派发事件，插件从委派总线的 usage 记入自有流程记录）、按任务回滚（本轮不做，spec 已改为窗口级）。
- **任务源同步**：tasks.md 是 openspec 契约（权威源），goal 任务树是底座状态——单向同步：组装器读 tasks.md 经 `set_goal_tasks` 镜像；主 agent 勾选写回 tasks.md 后以 `update_goal_task` 跟随。约束：`set_goal_tasks` 上限 50 项，超出时拒绝进入实现并指引拆分 tasks.md；镜像只使用 pending/complete 二值映射（不引入 goal 的 start/skipped 中间态）；禁止反向同步（goal 树上的手工改动不回流 tasks.md）。
- **策略调校（同受流程隔离约束）**：不碰全局策略开关——`strictExecutionContract` 等是全局 settings（goal-x 无名为 waits 的键），改了会波及普通目标。流程纪律（不空等、每任务完成声明）写进 objective 文本（Steps/Don'ts）表达；本轮不做策略级 per-goal 化（scope 纪律：出现真实需要时另立修改），不新增全局写路径。
- **记录分工**：plan 阶段门控事件与派发用量记账（取自委派总线 usage）记入插件自有 append-only 记录（change 目录）；implement 阶段事实源是底座账本，`reviews.md` 投影合并两个来源。D9 lifecycle 事件照常由插件发布（门控节点双写）。

D5 的 cache 纪律：implement 阶段的请求级状态块由底座处理（goal-prompt-cache 的断点搬移已在 goal-x 内实现）；plan 阶段插件仅做 append-only 注入，若未来引入请求级状态块，参照断点搬移思路自行实现（goal-x 该模块无导出，不跨包引用）。

## Risks / Trade-offs

- [pi-sandbox 无 profile 编程注册 API（已证实）] → fork-only 二开：会话级内存注册表 + 解析单点 merge + `registerSandboxProfiles` 导出；走 pi-fork-divergence 纪律（上游字节稳定、knownDebt 申报、`pnpm run audit:fork-divergence` 过门）；用户配置同名优先，注册不落盘。
- [agent 构建产物 glob 覆盖不了非常规布局] → `opsx-agent` 的白名单暴露为配置；首次进入代理实现态校验项目的构建目录是否存在白名单内。
- [runtime 注册的 agent 未必被 pi-agent-role `/role` 枚举] → 已证实不可枚举（owner 键控注册表）：README 不宣传 `/role` 互操作；不影响核心流程（自有命令已可切换）。
- [pi 宿主同名 skill 解析优先级未验证] → 实现期验证；无论结果如何都提示用户移除静态文件，保证单一事实来源。
- [审查循环可能长尾消耗] → D3 的升级纪律（ITERATE 2 轮、REJECT 同 blocker 立即升级用户）。
- [官方轨 skill 骨架文案与 CLI 语义漂移] → 骨架只写"何时触发 + 如何调用 CLI"，流程语义一律指向 `openspec instructions` 现取输出。
- [进度上报被子 agent 滥用刷屏] → 看板投影做节流与折叠（同阶段重复进度不重复渲染），门控只认裁决字段，进度纯展示。
- [goal-x 行为耦合：公开工具语义随其版本演进] → peerDependencies 锁定版本范围；集成测试覆盖 `create_goal`/`set_goal_tasks` 契约，升级跑 e2e。
- [双任务源漂移（tasks.md vs goal 任务树）] → 单向同步（D10）：tasks.md 权威，goal 树仅底座状态；同步校验不一致时以 tasks.md 重镜像并告警。
- [goal 推进下主 agent 试图亲自改代码] → agent 沙箱拦截 + objective 边界段声明 + 拦截提示指回 worker 派发；e2e 断言越区写被拒。
- [goal 策略（waits/strictExecutionContract）与审查门互相等待] → objective 组装时按 opsx 流程显式配置策略（默认关 waits），e2e 覆盖 REJECT 循环在 goal 推进下可收敛。
- [goal-x 审计落地需双 fork seam（已核实）] → S1 per-goal 覆盖（goal-completion 设置读取单点 merge）+ S2 委派 agent 解析路径支持运行时注册（`goal-auditor-delegation.ts` 本为 fork-only）；均走 pi-fork-divergence 纪律（上游字节稳定、knownDebt 申报、`pnpm run audit:fork-divergence` 过门）；S2 若实现中发现 pi-subagents 无跨扩展查询面，退化为 goal-x fork-only 内代注册审计 agent 的组合方式。
- [tasks.md 超过 set_goal_tasks 的 50 项上限] → 进入实现前校验任务数，超限拒绝并指引拆分 tasks.md；镜像只用 pending/complete 二值映射。
- [流程隔离失效波及普通目标审计] → 隔离锚定在 per-goal 字段而非全局开关/环境变量：插件只为 opsx 目标写覆盖，普通目标读取路径不经过 merge 分支；e2e 断言普通 `/goal` 审计走默认 agent。

## Migration Plan

发布后用户侧：安装 `@xzzpig/pi-openspec-x` → 重启会话即得官方轨 skills（首次自动生成缓存）→ 按提示移除 `.pi/skills/openspec-*` 静态文件。回滚 = 卸载插件并重跑 `openspec update`，恢复原静态文件，无持久状态残留（缓存目录可随手删）。

## Open Questions

无阻塞性未知；D3/D4 的两个实现期验证点（`/role` 枚举 runtime agent、profile 编程注册）已列入 tasks，其结论只影响文档与引导路径，不影响架构。
