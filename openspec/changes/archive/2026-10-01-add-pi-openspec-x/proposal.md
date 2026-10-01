# Proposal

## Why

openspec 的 AI 助手 skill 由 `openspec init/update` 在项目里静态生成（`.pi/skills/openspec-*`，frontmatter 印着 `generatedBy` 版本戳），随 CLI 升级漂移，也不会把"深度规划、计划审查、实现期权限收敛"这些流程纪律交给 agent。oh-my-openagent v4.19.4（Prometheus/Metis/Momus/Atlas 编排）已经验证了 spec 驱动流程的增强模式，而本仓库的 pi 宿主恰好具备全部落地机制（`resources_discover` 动态 skill、pi-subagents 委派总线与运行时 agent 注册、pi-sandbox profile 门控），值得把它们收敛为一个插件。

## What Changes

- 新增 `packages/pi-openspec-x` 插件（npm `@xzzpig/pi-openspec-x`）。
- **双轨 skill 层**：
  - 官方轨：`resources_discover` 时从当前安装的 openspec CLI 现场提取（`--version` / `schemas --json` / `templates --json` / `instructions <artifact> --json`），生成与官方同名的 5 个 skill（explore/propose/apply/archive/sync），按 CLI 版本落盘缓存；同名替换 `.pi/skills/openspec-*` 静态文件，检测到旧文件时提示删除；CLI 不在 PATH 时优雅降级。
  - 增强轨：`/opsx:plan` 与 `/opsx:implement` 两个命令，承载 omO 式增强流程，与官方轨互不干扰（分离双轨）。
- **`/opsx:plan`（增强计划流程）**：主 agent 进入 planner 沙箱 profile（只写 `openspec/**`，其余只读）；按 decision-complete 原则（实现者零判断调用：精确路径、穷举引用、显式 Must-NOT-Have）撰写 proposal/specs/design/tasks；写作中派发 **缺口分析子 agent**（opsx-gap-analysis，只读）做缺口分析，发现静默吸收；成品后派发 **计划审查子 agent**（opsx-plan-review，只读）独审，裁决 `OKAY/ITERATE/REJECT`，非 OKAY 循环修改重审；通过后经 `@eko24ive/pi-ask`（可选依赖）呈交用户审批。
- **`/opsx:implement`（实现流程，模式二选一）**：
  - 代理实现（agent 角色）：主 agent 沙箱白名单为 `openspec/**` + 构建产物目录可写、源码区只读；逐任务派发 **opsx-worker**（全写权限）并做 6 段式派发提示词；每次派发后读全部 diff 审查 + 自跑 build/test 验证，再勾选 tasks.md。
  - 主会话直实现：无角色切换、正常权限，主 agent 按 tasks.md 直接实现。
  - 两轨殊途同归：全部任务勾完后派发 **opsx-reviewer**（只读）整体审查，`REJECT` 则（代理模式派 worker 修 / 直实现模式主会话修）后重审，循环直到 `APPROVE`，再引导 openspec archive 归档。
- **4 个运行时注册子 agent + 3 个插件侧结构化上报工具**（照 pi-goal-x goal-auditor 模式）：gap-analysis / plan-review / opsx-reviewer 只读（tools 白名单 + `acceptanceRole: "read-only"`），opsx-worker 全写；gap-analysis / plan-review / opsx-worker 经插件专用工具（`report_gap_analysis` / `report_plan_review` / `report_work`）结构化上报，opsx-reviewer 的最终裁决走底座完成审计的 `structured_output` 通道（approved/disapproved），插件不另设裁决工具。门控判断不解析自由文本。
- **cache 稳定纪律**：模式与阶段提示词全部 append-only 增量注入（turn_end BoundaryResult / steer 消息），每阶段只追加该阶段指令块（现场取自 `openspec instructions <artifact> --json`）；skill 集合每 session 冻结（按 CLI 版本缓存，升级次 session 生效）；禁止用 `before_agent_start` 的 systemPrompt 覆盖做模式切换。
- **可观测性与插件互操作**：流程状态（模式、阶段、派发与进度、裁决与轮次、任务勾选进展）以自定义会话条目记录并渲染为进度界面（参考 pi-goal-x 的条目渲染、auditor progress 工具投影与 turn 快照模式）；关键节点向扩展总线发布版本化 lifecycle 事件（模式进出、阶段变更、裁决、审批等待、任务派发/完成、流程完成），并按字面 channel 名桥接 pi-notify（`pi-notify:publish` 通知、`pi-notify:ui_span_silent` 静默 UI 跨度），事件对 pi-sentinel 的 `event:` 触发器等第三方可订阅，均不硬依赖对端安装。
- **执行底座（复用 pi-goal-x）**：`/opsx:implement` 双模式均以持久目标为执行底座——插件组装 objective（tasks.md → Steps、只读边界 → Boundaries/Don'ts、`Verification contract:` = 完成以审计 APPROVE 为准）并经 pi-goal-x 公开工具 `create_goal`（代理模式 sisyphus）启动；推进循环、执行窗口清单与回滚、账本、崩溃恢复、压缩摘要、派发记账、进度看板全部复用 pi-goal-x。**最终审查门 = goal-x 内建完成审计**：完成是单事务（先独立审计、通过才提交完成），任务全勾而审计不通过则目标保持未完成；审计定制**流程隔离**——经 fork-only 最小修改新增 per-goal auditor 覆盖（goal 级 > 全局 `settings.auditor`），只有 opsx 创建的目标被指向 opsx-reviewer（审查纪律随之注入），用户普通 `/goal` 的审计行为不受影响。tasks.md 为任务权威源，单向镜像到 goal 任务树。
- **流程记录**：plan 阶段门控事件（缺口分析 / 计划审查裁决、轮次、审批）由插件自有 ledger 记录于 change 目录，`reviews.md` 为人读投影；实现阶段投影取自底座账本摘要。
- **权限与角色**：门控全部走 pi-sandbox profile（`filesystem.allowRead/allowWrite` + bash OS 级沙箱），不依赖 pi-permission-system；profile 经为 pi-sandbox 新增的编程注册 API 会话级注册，用户无需手动编辑 `sandbox.json`；角色状态 session 级（`active_agent` entry + 沙箱 profile 双通道），pi-agent-role 可选互操作（opsx 角色声明 `sandbox:` frontmatter，`/role` 可见可切）；不装 pi-agent-role 时插件自身命令也能完成切换。

## Capabilities

### New Capabilities

- `pi-openspec-x`: 插件全部外部可观察行为——动态 skill 提取与同名替换、/opsx:plan 计划流程与双审查门、/opsx:implement 双模式与最终审查门、四个子 agent 与结构化裁决上报、沙箱 profile 门控、cache 稳定纪律、依赖降级行为。

### Modified Capabilities

（无——本仓库既有 capability 均不涉及 openspec 域，经 `openspec list --specs` 核对。）

## Impact

- **新增代码**：`packages/pi-openspec-x`（extension 入口、CLI 提取器、skill 生成器、4 个 agent 定义、4 个上报工具、沙箱 profile 定义、两条命令）。
- **peer 依赖**：`@xzzpig/pi-subagents`、`@xzzpig/pi-sandbox`、`@xzzpig/pi-goal-x`（必需）；goal-x 优先零改动消费其公开配置面（`create_goal`/`set_goal_tasks` 工具与 `settings.auditor.*`）；若审计定制确需扩展配置面，允许对 pi-goal-x 做**最小 fork 修改**，必须遵循 `pi-fork-divergence` 技能（fork-only 文件、上游文件字节稳定、`knownDebt` 申报、whitespace 审计）。`@xzzpig/pi-agent-role`、`@eko24ive/pi-ask`（可选，缺失时降级：角色自管 / 纯文本提问）。
- **不改动** pi 宿主与 openspec CLI（黑盒外部依赖）；对两个 upstream 子树做收敛的 fork-only 二开：**pi-sandbox** 新增编程注册 API（会话级内存 profile 注册表，`setProfile` 解析点 merge，用户配置同名 profile 优先）；**pi-goal-x** 双 seam（S1 per-goal auditor 覆盖、S2 审计委派 agent 解析路径支持运行时注册 agent）。均遵循 pi-fork-divergence 纪律并申报 `knownDebt`。
- **用户项目侧**：安装本插件后建议删除 `openspec init` 生成的 `.pi/skills/openspec-*` 静态文件（插件会检测并提示），避免同名双供。
