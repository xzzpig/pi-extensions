# pi-openspec-x Specification

## Purpose

提供 pi-openspec-x 插件的完整行为契约：从已安装的 openspec CLI 动态提取同名 skill 取代静态生成文件，并提供 `/opsx:plan`（深度计划 + 缺口分析 / 计划审查门）与 `/opsx:implement`（代理实现/主会话直实现 + 最终整体审查门）两条增强流程，全程以 pi-sandbox profile 收敛写权限、以结构化工具上报驱动门控、以 append-only 增量提示保住提示词缓存。

## Requirements

### Requirement: 动态提取并同名提供 openspec skills

插件 SHALL 在 skill 发现阶段调用当前安装的 openspec CLI（版本号、schema 列表、模板与各 artifact 指令），生成与官方同名的一组 skill（openspec-explore、openspec-propose、openspec-apply-change、openspec-archive-change、openspec-sync-specs），其流程知识 MUST 来自 CLI 的现场输出而非插件内置的静态副本。生成的 skill MUST 按*cli 版本*落盘缓存，缓存目录 MUST 解析自 pi 的 agent 目录配置（遵循自定义 agent 目录，不得硬编码固定用户路径）；同版本内重复加载不得重新调用提取。openspec CLI 不在 PATH 时，插件 MUST 优雅降级：不提供这组 skill、不报错崩溃，并在会话中给出一次性的缺失提示。

#### Scenario: 已安装 CLI 时提供同名 skills

- **WHEN** pi 会话启动且 `openspec` 可在 PATH 解析到
- **THEN** 会话内可用 openspec-explore 等 5 个同名 skill，其内容指向并服从该 CLI 版本的现场 `instructions` 输出——骨架缓存在以 CLI 版本为键的目录，权威指令执行期以 `openspec instructions` 实时获取并按现场输出执行，从而保障提示词缓存稳定性；同一会话内的重新发现保持路径与内容不变，会话中途的 CLI 升级不在本会话生效

#### Scenario: 同版本重复加载不重复提取

- **WHEN** 缓存中已存在当前 CLI 版本的 skills 且会话再次发生 skill 发现
- **THEN** 不重新调用 openspec CLI 的提取命令，直接复用缓存内容

#### Scenario: CLI 版本升级后重新提取

- **WHEN** 已安装 CLI 的版本号与磁盘缓存记录的版本不同
- **THEN** 下一次 skill 发现时按新版本重新生成 skill 内容并更新缓存

#### Scenario: CLI 缺失时降级

- **WHEN** `openspec` 无法在 PATH 解析
- **THEN** 不注册这组 skill，会话正常启动，且只提示一次 CLI 缺失

### Requirement: 静态同名 skill 冲突提示

当项目中存在 `openspec init` 生成的静态同名 skill 文件（如 `.pi/skills/openspec-*`）时，插件 MUST 检测并向用户提示移除它们以避免同名双供；插件 MUST NOT 在未经用户确认的情况下删除用户项目中的文件。

#### Scenario: 检测到旧静态文件

- **WHEN** 会话启动且项目内存在静态 openspec-\* skill 文件
- **THEN** 用户收到一条指出冲突路径与移除建议的提示，文件保持原样

### Requirement: /opsx:plan 深度计划流程

`/opsx:plan` SHALL 以增强流程创建并撰写 openspec change：主 agent 进入计划态后，其文件写入 MUST 被沙箱 profile 限制在 `openspec/` 目录内，目录外只读；计划内容 MUST 遵循 decision-complete 写作规范（实现者零判断调用：精确路径、穷举引用、显式 Must-NOT-Have、验收标准可由 agent 执行），各阶段的写作指令块 SHALL 包含该规范的对应切片；各阶段的写作指令 MUST 增量取自当前 CLI 对该 artifact 的 instructions 输出，指令获取失败（如 change 未创建、CLI 报错）时 SHALL 降级为 skill 内置骨架文案并提示，不得中断流程。写作过程中插件 SHALL 支持派发只读的缺口分析子 agent（opsx-gap-analysis）做缺口分析（矛盾、缺失约束、scope 膨胀、无依据假设、缺失验收标准），其发现 MUST 被吸收进计划产物而非仅停留在对话中。

#### Scenario: 计划态写权限收敛

- **WHEN** 主 agent 处于计划态并尝试写 `openspec/` 之外的文件
- **THEN** 写操作被沙箱拒绝（受限模式 fail-closed；拒绝信息由沙箱层给出），读取不受限；计划态的模式契约已预先指明可写范围，并指引把写入收敛回 `openspec/`

#### Scenario: 缺口分析被吸收

- **WHEN** 计划写作中派发缺口分析子 agent 且其报告了缺口
- **THEN** 后续计划产物体现对这些缺口的修正，缺口分析子 agent 自身未修改任何文件

### Requirement: 计划审查门

计划产物完成时，插件 SHALL 派发只读的计划审查子 agent（opsx-plan-review）审查成品计划，检查引用有效性、任务可执行性、关键阻塞与验收场景可执行性；计划审查 MUST 经专用上报工具提交结构化裁决（`OKAY` / `ITERATE` / `REJECT` 及问题清单）。裁决为 `ITERATE` 或 `REJECT` 时，主 agent MUST 修订计划并重新送审，循环直到 `OKAY`；只有 `OKAY` 的计划才允许进入用户审批。

#### Scenario: 裁决非 OKAY 时循环修订

- **WHEN** 计划审查提交 `REJECT` 及阻塞问题清单
- **THEN** 主 agent 修订计划后再次派发计划审查，直至裁决为 `OKAY`

#### Scenario: OKAY 前不得进入审批

- **WHEN** 计划审查尚未提交 `OKAY`
- **THEN** 流程不呈现用户审批请求

### Requirement: 计划用户审批门

计划审查通过后，插件 SHALL 向用户请求对计划的明确批准（pi-ask 可用时用结构化提问，否则纯文本）；未经用户批准 MUST NOT 进入 `/opsx:implement` 流程。审批语义 MUST 仅覆盖"计划定稿"，不构成开始实现的授权。

#### Scenario: 未批准不实现

- **WHEN** 用户在审批请求中拒绝或要求修改
- **THEN** 主 agent 回到计划修订，不派发任何 worker

### Requirement: /opsx:implement 模式选择

`/opsx:implement` SHALL 让用户在两种实现模式间选择（通过命令参数或结构化提问）：代理实现模式与主会话直实现模式。选定前 MUST NOT 开始任何实现动作。同一会话中已存在进行中的 opsx 实现流程时，MUST NOT 启动第二条流程，MUST 指引用户恢复或结束既有流程。

#### Scenario: 按选择进入模式

- **WHEN** 用户通过审批请求选定"主会话直实现"
- **THEN** 会话不做角色/沙箱切换，主 agent 直接按 tasks.md 实现

#### Scenario: 已有实现流程时拒绝二次进入

- **WHEN** 会话中已存在进行中的 opsx 实现流程且用户再次执行 /opsx:implement
- **THEN** 命令拒绝启动新流程并指引恢复或结束既有流程

### Requirement: 代理实现模式的沙箱白名单与派发审查

代理实现模式下，主 agent MUST 切入 agent 角色（opsx-agent 沙箱 profile）：文件写入被沙箱 profile 限制在 `openspec/` 目录与构建产物目录（如 node_modules、dist），源码区只读，bash 在同一白名单下运行以支持自跑 build/test 验证。实现 MUST 通过派发全写权限的 opsx-worker 子 agent 逐任务完成，派发提示词 MUST 包含任务、预期产出、所需工具、必须做、禁止做、上下文六个部分；每次派发返回后，主 agent MUST 审查 worker 全部改动（逐文件读取与 diff 核对，对照其结构化完成声明）并运行验证，通过后才可勾选 tasks.md 对应任务。

#### Scenario: 主 agent 越区写被拒

- **WHEN** 代理实现模式下主 agent 尝试修改源码文件
- **THEN** 写操作被沙箱拒绝，提示应改为派发 worker

#### Scenario: 未审查不得勾选

- **WHEN** worker 返回但主 agent 尚未核对其改动与验证结果
- **THEN** tasks.md 中该任务保持未勾选状态

### Requirement: 主会话直实现模式

主会话直实现模式下，会话 MUST NOT 切换角色或收紧权限；主 agent 按 tasks.md 顺序实现并自行验证、勾选。全部任务完成后 MUST 与代理模式走相同的最终整体审查门。

#### Scenario: 直实现后仍受最终审查约束

- **WHEN** 直实现模式勾完全部任务
- **THEN** 派发只读审查子 agent 做整体审查，REJECT 时由主会话自行修复并重审

### Requirement: 最终整体审查门

全部任务勾选完成后，插件 SHALL 经执行底座的完成事务触发整体审查：goal-x 的完成审计在提交完成前运行，审计执行者为插件定制的只读 opsx-reviewer 子 agent（审查维度覆盖计划符合度、代码质量、验证证据、scope 保真，审查范围注入执行窗口 delta），MUST 提交 `APPROVE` 或 `REJECT` 结构化裁决。任务全部勾选而审计为 `REJECT` 时，目标 MUST 保持未完成状态；插件 SHALL 继续修复（代理模式派 worker、直实现模式主会话自行修）并重审，循环直到 `APPROVE` 使目标达成完成；`APPROVE` 后插件 SHALL 引导用户走 openspec 归档流程，且 MUST NOT 代替用户执行归档。审计定制（执行者、审查清单、裁决映射）MUST 仅作用于插件为增强流程创建的目标；用户以普通方式创建的目标（如直接 `/goal`）的完成审计行为 MUST NOT 受插件影响。

#### Scenario: 任务全勾而审计不通过

- **WHEN** tasks.md 全部勾选但完成审计提交 `REJECT` 及问题清单
- **THEN** 底座目标保持未完成，修复后重审，直至 `APPROVE` 才达成完成并进入归档引导

#### Scenario: APPROVE 前不得归档

- **WHEN** 完成审计尚未提交 `APPROVE`
- **THEN** 流程不呈现归档引导

#### Scenario: 普通目标审计不受影响

- **WHEN** 用户在安装了插件的环境中直接创建普通持久目标并触发完成审计
- **THEN** 审计使用 goal-x 默认配置（默认审计 agent 与清单），未被替换为 opsx-reviewer

### Requirement: 结构化裁决上报

缺口分析、计划审查、opsx-worker 三类子 agent MUST 各经插件注册的专用上报工具提交结果（缺口分析、计划裁决、完成声明与证据），结果以带 schema 的结构化形式经委派总线返回；opsx-reviewer 的最终裁决 MUST 经执行底座完成审计的结构化裁决通道提交（verdict 语义映射 APPROVE/REJECT），插件不另设平行裁决通道。门控判断 MUST 依据结构化裁决字段，MUST NOT 依赖解析子 agent 的自由文本；不满足 schema 的上报 MUST 被拒绝。

#### Scenario: 裁决字段驱动门控

- **WHEN** 计划审查的上报工具收到 `verdict: OKAY`
- **THEN** 门控以该结构化字段放行，无需解析文本

### Requirement: 提示词缓存稳定

插件注入的全部模式与阶段提示词 MUST 采用 append-only 增量方式（会话消息追加），每个阶段只追加该阶段的指令块；MUST NOT 在会话中途改写系统提示或增删 skill 集合来实现模式切换；动态 skill 内容 MUST 在同一会话内保持不变（CLI 升级在后续会话生效）。

#### Scenario: 模式切换不改写系统提示

- **WHEN** 用户在会话中执行 /opsx:plan 或 /opsx:implement
- **THEN** 模式指令以追加消息出现，系统提示与 skill 集合保持原样

#### Scenario: 会话内 skill 内容稳定

- **WHEN** 同一会话内发生 skill 重新发现（如扩展 reload）
- **THEN** 动态 skill 的路径与内容保持不变，期间发生的 CLI 升级不在本会话生效

### Requirement: 流程可观测界面

插件 SHALL 将增强流程的关键状态——当前模式与阶段、子 agent 派发与进度、审查裁决与轮次、任务勾选进展——以自定义会话条目记录，并渲染为会话内可见的进度界面（计划阶段参照 pi-goal-x 的条目渲染与进度看板模式自行实现，实现阶段的进度看板复用执行底座）。子 agent 的过程进度 MUST 经结构化上报（阶段标签 + 百分比，或等效字段），由主会话投影为看板展示；流程快照 SHALL 随会话持久化，并在会话压缩后仍能恢复显示当前状态。

#### Scenario: 审查进度与裁决可见

- **WHEN** 计划审查进行中并上报了阶段进度，随后提交裁决
- **THEN** 会话界面先后显示审查阶段与百分比、最终裁决与问题摘要

#### Scenario: 压缩后状态恢复

- **WHEN** 增强流程进行中会话发生压缩
- **THEN** 压缩后界面仍显示当前模式、阶段与进展快照

### Requirement: 生命周期总线事件与插件互操作

插件 SHALL 在流程关键节点向扩展总线发布版本化的 lifecycle 事件（模式进入/退出、阶段变更、审查裁决提交、审批等待与完成、任务派发/完成、最终裁决、流程完成），事件名与 payload MUST 带结构化 schema 并标识所属 change，且写入文档供第三方订阅（如 pi-sentinel 的 `event:` 触发器）。插件 SHALL 在打开阻塞式 UI（模式选择、审批等）前按约定发布静默 UI 跨度事件，在等待用户审批、流程完成等节点以字面 channel 名向 pi-notify 的发布通道发送通知事件（审批等待映射 `input-required`、流程完成映射 `task-completed`），且这些桥接 MUST NOT 依赖 pi-notify 已安装。

#### Scenario: 等待审批发布通知

- **WHEN** 流程到达用户审批门并打开阻塞式提问
- **THEN** 打开前发布静默 UI 跨度事件，pi-notify 在场时收到 `input-required` 通知，不在场时流程不受影响

#### Scenario: 第三方订阅 lifecycle 事件

- **WHEN** pi-sentinel 配置了订阅 lifecycle 通道的 `event:` 触发器
- **THEN** 阶段变更与裁决提交事件按序到达触发器

### Requirement: 流程耐久性与恢复

实现流程 SHALL 以持久目标为执行底座运行：会话崩溃或压缩后，实现流程状态可恢复并向用户提供恢复入口。计划阶段的门控事件（审查裁决、轮次、审批）SHALL 由插件以 append-only 记录持久化于所属 change 目录，作为事实源；`reviews.md` 等人读记录 MUST 可由记录投影生成。进入实现流程时，审查范围 SHALL 限定为执行窗口 delta（窗口前已存在的未提交改动不误计入审查或回滚范围）；REJECT 后 SHALL 支持按安全模型（先计划、备份落盘、后动工作树）回滚执行窗口的改动（任务粒度的偏差由修复循环承担，不提供按任务回滚），非 git 目录下降级为不可用且静默跳过。用户在流程进行中手动清除、暂停或归档底座目标时，插件 SHALL 检测生命周期分叉并向用户提示。诊断报告 SHALL 只读，任何修复动作 MUST 经用户确认。

#### Scenario: 审查范围限定于执行窗口

- **WHEN** 进入实现流程前工作树已有未提交改动，随后流程完成并派发最终审查
- **THEN** 审查者收到的改动范围为窗口 delta，不包含窗口前已脏的文件

#### Scenario: REJECT 回滚带备份

- **WHEN** 用户在最终审查 REJECT 后选择回滚执行窗口的改动
- **THEN** 被丢弃改动先完整备份落盘，工作树才被修改，且可从备份恢复

#### Scenario: 底座目标被手动清除时提示分叉

- **WHEN** 实现流程进行中用户手动清除或暂停了底座目标
- **THEN** 插件提示流程与底座目标已分叉，并给出恢复或终止流程的选项

#### Scenario: 中断后恢复

- **WHEN** 会话在实现流程进行中崩溃，用户在新会话启动后选择恢复
- **THEN** 实现流程从底座与记录重建状态（当前阶段、已完成任务、待处理裁决）并继续

### Requirement: 可选依赖降级与受限模式 fail-closed

`@eko24ive/pi-ask` 缺失时降级为纯文本提问；角色切换与沙箱 profile 选择由插件自建通道完成（等价于始终降级，不依赖 `@xzzpig/pi-agent-role` 包）。受限模式所需的沙箱 profile 由插件经 pi-sandbox 的编程注册接口自动提供（会话级内存注册，不写用户配置文件；用户配置中的同名 profile 优先）。`@xzzpig/pi-goal-x` 缺失时，`/opsx:implement` MUST 拒绝执行并说明原因，官方轨 skills 与 `/opsx:plan` 不受影响。pi-sandbox 缺失时，插件 MUST 拒绝进入计划态与代理实现态等受限模式并给出明确原因（fail-closed），主会话直实现模式与官方轨 skills 不受影响。

#### Scenario: 首次进入受限模式无需手动配置沙箱

- **WHEN** 用户的 `sandbox.json` 未定义任何 opsx profile 且用户首次执行 /opsx:plan
- **THEN** 插件经编程注册接口注册所需 profile 后进入计划态，用户配置文件保持不变

#### Scenario: 用户同名 profile 优先

- **WHEN** 用户配置中已存在与 opsx 同名的沙箱 profile 且插件进入受限模式
- **THEN** 沙箱使用用户定义的 profile 内容，插件的注册不覆盖它

#### Scenario: 无沙箱时拒绝受限模式

- **WHEN** pi-sandbox 未安装且用户执行 /opsx:plan
- **THEN** 命令报错说明缺少沙箱依赖，会话保持未受限状态

#### Scenario: 无 pi-ask 时降级提问

- **WHEN** pi-ask 未安装且流程到达用户审批门
- **THEN** 以纯文本问题请求批准，流程继续
