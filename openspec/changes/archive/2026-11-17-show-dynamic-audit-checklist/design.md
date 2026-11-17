# 动态审计检查清单设计

## Context

动机见 proposal.md。当前 `goal-auditor.ts` 分别生成默认/替换清单及附加段落；`goal-auditor-progress.ts` 只接受 label/percentage；`goal-auditor-delegation.ts` 从版本化工具结果文本恢复进度。`widgets/auditor-dashboard-model.ts` 使用固定五项和百分比阈值，结束时自动将前四项置为 passed。渲染器直接遍历检查项，widget 最后进行高度裁剪，因此单纯扩充数组不能保证长清单可读。

相关旧契约在 `goal-lifecycle` 的 D-08、D-14、I-17/I-19/I-20、dashboard、Fleet 和进度要求中有交叉引用。本次用 D-17 明确声明呈现及协议变化，其他审计隔离、安全、生命周期和完成事务保证不变。

## Goals / Non-Goals

**Goals:**

- 同一审计清单只解析一次；提示词、父进度状态和 UI 引用同一快照。
- 项目状态及依据可增量更新，重复/重放事件不会回退状态或重复计数。
- 紧凑视图有界，展开可访问全部内容；覆盖度不冒充批准或通过率。
- 展示故障隔离，旧 auditor 不需要升级才能继续完成审计。

**Non-Goals:**

- 不让 auditor 自行派生新检查项，不从目标/任务树自动生成额外条目。
- 不增加逐项完成 gate、独立证据验证器、目标工具参数或 verdict 字段。
- 不修改 pi-subagents，不增加依赖、公开命令、设置、持久化记录版本或主模型自动提示。
- 不恢复跨进程中的活动审计；不将依据作为新的父模型上下文回放。

## Decisions

### 1. 父进程构建审计快照

在 fork-only 模块（建议 `extensions/fork-audit-checklist.ts`）持有清单数据类型、生成及状态更新函数。默认项保留现有正文与适用条件；显式 checklist（含空数组）整体替换；checklistExtra 原序追加。ID 使用来源与索引，例如 `default-1`、`checklist-1`、`extra-1`，仅在该 attempt 内有意义；默认项 ID 基于固定语义位置，而非过滤后的显示序号。

委派启动在解析 settings、取得 changeManifest 后生成快照，随后同时用于构建 task prompt 和初始 progress。快照保存原文，提示词转义只发生在渲染时，UI 使用终端安全的文字渲染。保留主清单与附加清单段落边界和其他注入块顺序；每个条目显式携带 ID。evidenceRequests、strictness、instructions、reportFormat 不自动变成检查项。

替代方案：分别在提示词与 widget 中读取配置会引入条件项/配置变更漂移；从渲染后的 prompt 反向提取会混淆转义和数据边界，均不采用。

### 2. 进度工具扩展而非新增工具

保留 `report_auditor_progress` 名称及旧 `{label, percentage}` 调用；增加逐项调用 `{checkId, state, detail?, label?, percentage?}`，两种调用均通过 schema 校验。state 为 pending/running/passed/failed；checkId 与 state 必须成对出现。工具不接受条目正文、任意 ID 注册或清单增删字段。

逐项调用的工具结果使用新版本进度记录 `pi-goal-x:audit-progress:v2:`，携带由 child-only 提供器生成的递增 sequence；旧 label/percentage 调用保留原 v1 结果正文以保持兼容，父端同时读取旧 v1 记录和既有旧文本格式。sequence 不由 auditor 参数提供。v2 从一次审计 child 的 1 开始，同一 child 挂起/继续不重置。解析时处理更新中全部记录，按 sequence 去重，只应用大于最后已处理序号的记录，避免累计 recentOutput 回放导致状态回退。不同 attempt 各自保存序号与状态，复用 ID 不产生串扰。

新字段采用有界校验：detail 最多 512 个 Unicode 码点、checkId 最多 80 个字符、单条 v2 记录最多 4 KiB UTF-8；越界逐项更新不截断后当作有效状态，而是忽略并生成有界诊断。旧 label/percentage 校验沿用兼容路径。工具输出 record 与普通审核正文分离，内部记录不显示为近期审核正文。

父端只接收绑定到当前 request/owner/node 的工具结果，不从 currentToolArgs 预览解析状态。损坏/未知 ID/非法状态只影响本条展示更新，不改变 verdict、取消审计或新建项目；诊断不得包含原始超长载荷。同一有效条目允许重新核验，最后一次新序号有效上报覆盖旧状态及依据。

替代方案：解析自然语言、百分比推断或将上报参数预览当作真实记录都不可靠；增加独立工具会扩大工具能力面及 preflight 改动，均不采用。

### 3. 状态生命周期与最终裁决解耦

初始全部 pending。条目快照和状态属于同一委派 attempt，首次进度回调就携带清单；挂起只暂停 UI 发布，继续后发布最新快照，不重启状态。终态冻结逐项状态，迟到更新无效；不将总进度强行设置为 100 再用它补勾。running 的最后状态保留，但终态视图以“检查中时审计已结束/中断”说明，不继续显示活跃旋转效果。

不读取逐项状态来授权或阻止完成。保留原 structured_output 验证、前置门控、唯一终态及完成事务。result card 保留原类型、findings 和恢复时序；批准卡改用实际 verdict 文案，不使用“全部检查项已核验”等可能与 pending/failed 冲突的固定断言。清单明细不新增磁盘持久化；完整审核过程仍可通过 Fleet 查看。

替代方案：要求全项 passed 才完成会改变用户已排除的完成 gate；终态全部置 passed 会继续误导，不采用。

### 4. 覆盖度与旧估计分离

已检查数量为当前 passed + failed 数量，不累计历史上报次数。紧凑视图显示已检查 N/M、通过数和不通过数；当前项选择最后一次有效上报且仍为 running 的项目，无 running 时显示“等待逐项上报”或结束状态，不把 pending 项冒充检查中。多个 running 时保持其状态，当前项仅选择最近一个。

主覆盖度展示采用 N/M，不要求百分比条。旧 percentage 如存在则标明“审计员估计”，仅作辅助，不影响条目计数；空清单显示“没有配置检查项”和 0/0，不渲染虚构百分比。全部已检查不代表全部通过，更不表示审计批准。

### 5. 紧凑/展开与滚动

紧凑视图固定为身份/耗时、汇总、当前项及操作提示，长当前项按宽度截断并提示可展开。展开视图包含汇总、完整条目及依据、现有工具诊断；长文字按终端可见宽度折行，所有行均可滚动到达。复用现有展开和滚动按键，不新增默认键位或命令。滚动偏移在同一 attempt 保留并随内容/窗口尺寸 clamp；新 attempt 重置。将审计滚动分支接到现有 widget 键盘处理及 viewport，不能只依赖末尾高度裁剪。

### 6. fork 接缝与兼容基线

清单、协议解析/状态更新及可独立提取的展示逻辑置于 fork-only 文件；上游来源文件只保留必要的类型、调用或渲染接缝。新增测试放 fork-only 测试文件；旧测试只调整被 D-17 明确替代的断言，不能删除其他生命周期断言。实施时重读 maintainer/fork-divergence 技能，更新 subtree 的 reapplyOnSync、doNotReintroduce 和必要 knownDebt；重新生成测试清单并运行分歧审计。

无设置与解析后未设置的 prompt 仍保持相等，但新协议的 ID 与逐项说明允许统一改变变更前 prompt；不为保持旧字节输出而维护第二套提示词分支。旧 auditor 只报百分比时清单保持 pending，最终合法 verdict 照常处理。自定义 auditor 同样收到快照和新任务级协议说明，定义层仍由原 agent 拥有。

## Risks / Trade-offs

- [auditor 不上报或上报与 verdict 矛盾] → 如实展示缺失/矛盾，不补勾、不新增 gate，文档明确状态是模型报告而非机器证明。
- [累计输出重放或工具结果重复] → v2 单调 sequence、attempt 隔离及终态冻结；覆盖多条记录和重复/迟到事件测试。
- [长清单挤掉控件或内容不可达] → 紧凑汇总、展开 viewport 与滚动，加入窄屏/矮屏/中文/超长依据测试。
- [进度协议丢失或非法] → 继续真实审计，保留最后有效状态并有界诊断；不降级成假通过。
- [旧规格有多处五阶段与字节不变表述] → 增量完整复制受影响要求和全部场景，基线中用 D-17 明确替代范围，归档前核查残余冲突。

## Migration Plan

1. 先完成清单快照和协议兼容测试，再将 prompt/委派接到共享快照。
2. 增加逐项状态传输与默认 auditor 指引，最后切换模型/渲染/滚动及结果卡文案。
3. 运行单元、委派集成、包 typecheck、分歧审计和真实 Pi/TUI 验证；真实交互验证使用隔离目录与持久 tmux，并依技能保留 asciinema 录制，不修改用户真实配置。
4. 不要求用户迁移现有配置，不变更 package 版本或发布。回退时回退本特性代码及对应规格，不重写目标/账本；旧 v1 进度和 verdict 仍受支持。
