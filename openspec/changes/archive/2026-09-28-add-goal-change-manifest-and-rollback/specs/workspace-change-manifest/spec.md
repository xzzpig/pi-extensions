# workspace-change-manifest Specification

## Purpose

为完成审计提供一份机器采集的工作区变更清单：在 goal 执行窗口内记录相关 git 仓库的基线，在完成请求时计算窗口内差异，使审计员无需全仓摸索即可定位真实改动范围。

## ADDED Requirements

### Requirement: 变更清单的仓库范围解析

系统 SHALL 以 cwd 所属的最内层仓库作为主仓库，并 SHALL 在同一份清单中纳入该仓库的递归 submodule、向上发现的祖先仓库，以及按配置的目录深度向下遍历发现的未注册嵌套仓库。系统 MUST NOT 无界递归，且 SHALL 以最内层仓库为准报告重叠路径，同一路径 MUST NOT 在清单中出现两次。

#### Scenario: cwd 位于 submodule 内

- **WHEN** goal 在某个 submodule 的工作目录内执行
- **THEN** 该 submodule 被解析为主仓库，其文件级改动按 submodule 自身根路径报告

#### Scenario: 主仓库包含递归 submodule

- **WHEN** 主仓库声明了 submodule，且其中被修改的 submodule 又被初始化
- **THEN** 每个被修改的 submodule 作为独立片段出现，路径以其在主仓库中的相对位置标识

#### Scenario: 存在祖先仓库

- **WHEN** 主仓库位于另一个仓库的工作树内（cwd 在嵌套仓库中，外层仓库也存在）
- **THEN** 祖先仓库同样被纳入清单，并按各自根路径分段报告

#### Scenario: 按目录深度发现未注册嵌套仓库

- **WHEN** 目录深度配置为 1
- **THEN** 只在主仓库根的直接子目录中发现嵌套仓库，且不进入更深层级
- **WHEN** 目录深度配置为 3
- **THEN** 最多遍历到主仓库根下三层目录，并跳过 `.git`、依赖目录与其他被忽略目录

#### Scenario: 重叠路径以最内层为准

- **WHEN** 同一路径同时被外层仓库和更内层仓库跟踪
- **THEN** 清单只按最内层仓库报告该路径一次，外层片段不再重复

#### Scenario: cwd 不在任何 git 仓库内

- **WHEN** cwd 及其祖先目录都不属于 git 仓库
- **THEN** 系统不采集任何基线，审计输入的组成与今天完全一致

### Requirement: 执行阶段起点的快照基线采集

系统 SHALL 在 goal 确认后的第一个执行回合开始时，对每个在范围内的仓库至多采集一次基线，且 MUST NOT 依赖任何工具调用、工具名判定或任务事件来决定触发时机。基线 SHALL 包含该仓库的 HEAD、脏状态指纹与 submodule 状态；当仓库存在 HEAD 时，SHALL 额外包含 `git stash create` 的结果。系统 MUST NOT 修改工作区内容、索引、引用或用户的 stash 列表，且在仓库干净时 MUST NOT 产生新的 git 对象。基线采集的任何失败 MUST NOT 阻塞 goal 执行。

#### Scenario: goal 创建后尚未开始执行

- **WHEN** goal 已创建但尚未进入执行回合（讨论/草拟阶段），或当前不存在 focused 且 active 的 goal
- **THEN** 系统不采集基线，之后的审计窗口从第一个执行回合开始时起算

#### Scenario: 第一个执行回合开始

- **WHEN** goal 处于 active 并开始第一个执行回合
- **THEN** 系统在该回合的任何工具调用之前、对范围内每个仓库采集一次基线，后续回合不再重复采集

#### Scenario: 触发不依赖工具调用

- **WHEN** 检查基线触发的实现
- **THEN** 触发时机只由“focused 且 active 的 goal 开始执行回合”决定，不存在以工具名集合、`tool_call` 钩子或 `task_started` 事件为条件的触发分支

#### Scenario: 仓库干净时的零成本基线

- **WHEN** goal 开始执行时仓库没有未提交改动
- **THEN** 批量暂存快照为空且不写入对象，审计期以 HEAD 作为基线

#### Scenario: 仓库已有未提交改动

- **WHEN** goal 开始执行时仓库已存在未提交改动
- **THEN** 基线记录该时点的完整工作树快照，使后续能识别"基线时已脏、窗口内又被进一步修改"的文件

#### Scenario: 仓库尚无任何 commit

- **WHEN** 范围内仓库处于无 commit 状态，快照与 HEAD 差异都无法计算
- **THEN** 系统降级为脏状态指纹基线，仅报告窗口内的文件存在性变化

#### Scenario: 基线采集失败

- **WHEN** 某仓库的 git 命令超时、报错或 git 不可用
- **THEN** 系统静默跳过该仓库，goal 执行不受影响，清单中不出现该仓库片段

### Requirement: 变更差异计算与清单渲染

系统 SHALL 在收到完成请求时，对每个持有基线的仓库计算窗口内差异，数据来源为基线与现状之间的文件级差异统计以及脏状态列表，并 SHALL 排除与基线一致的条目。被修改的 submodule SHALL 单独取其内部文件级差异。清单 SHALL 按仓库分段标注来源与路径根，SHALL 为每段附上可直接执行的展开命令，MUST NOT 内联全量差异内容，且 SHALL 受长度上界约束。差异计算的任何失败 MUST NOT 阻塞完成请求。

#### Scenario: 各类文件状态被区分

- **WHEN** 窗口内发生了修改、新增、删除、重命名与未跟踪文件创建
- **THEN** 清单以各自状态区分这些条目，并给出每个条目的行级增删统计（不可得时省略）

#### Scenario: 已脏文件被进一步修改

- **WHEN** 某文件在基线时已处于未提交状态，且在窗口内又被修改
- **THEN** 该文件出现在清单中，并反映窗口内的改动

#### Scenario: 仅在基线时脏的文件不出现

- **WHEN** 某文件在基线时已脏，但窗口内未再被修改
- **THEN** 该文件不出现在清单中

#### Scenario: submodule 内部改动

- **WHEN** 某 submodule 的工作树在窗口内被修改，或其 HEAD 在窗口内移动
- **THEN** 清单给出该 submodule 路径、基线 HEAD 与当前 HEAD，并在工作树被修改时附上其内部文件级差异

#### Scenario: 多个仓库同时有改动

- **WHEN** 主仓库与至少一个嵌套/祖先仓库在窗口内都有改动
- **THEN** 清单按仓库分段，每段的路径相对其自身根，不存在路径歧义

#### Scenario: 窗口内没有任何改动

- **WHEN** 所有范围内仓库的窗口内差异都为空
- **THEN** 清单仍作为明确记录出现，声明"未检测到工作区改动"，而不是静默缺省

#### Scenario: 超出深度或处于隔离 worktree 的改动

- **WHEN** 改动发生在超过配置目录深度的嵌套仓库中，或留在隔离 worktree 内
- **THEN** 该改动不出现在清单中，且清单 MUST NOT 声称自身完整

### Requirement: 快照基线的生命周期清理

系统 SHALL 在 goal 进入终态（完成、归档、中止、清除）时删除该 goal 的基线数据，并 SHALL 清理没有对应 goal 记录的孤儿基线。在清除路径上，基线数据 SHALL 在回滚选择、备份与回滚执行全部结束之后才被删除。系统 MUST NOT 执行会修剪用户对象的侵入式 git 操作，未引用的 git 对象交由 git 常规回收。清理失败 MUST NOT 阻塞生命周期转换，且清理 MUST NOT 删除 `goal-change-rollback` 在归档目录中留下的回滚备份。

#### Scenario: goal 成功完成

- **WHEN** 审计批准且目标完成事务提交成功
- **THEN** 该 goal 的基线数据被删除

#### Scenario: goal 被拒绝或审计出错

- **WHEN** 审计拒绝或运行出错，目标保持 active
- **THEN** 基线数据被保留，以便后续重新请求完成时继续计算同一窗口

#### Scenario: goal 归档、中止或清除

- **WHEN** goal 被归档、中止或被用户清除
- **THEN** 该 goal 的基线数据被删除

#### Scenario: 清除路径上的删除时机

- **WHEN** 用户在 `/goal-clear` 流程中选择回滚或选择不回滚
- **THEN** 基线数据在归档与清除完成之后才被删除，且回滚备份保持存在

#### Scenario: 孤儿基线

- **WHEN** 存在基线数据但其对应的 goal 记录已不存在
- **THEN** 诊断或恢复路径清理该孤儿基线

#### Scenario: 不触碰用户对象

- **WHEN** 清理基线数据
- **THEN** 用户的 stash 列表、引用与不可达对象均保持原样，系统不运行修剪对象的 git 命令

### Requirement: 变更清单的设置与静默生效

系统 SHALL 提供控制嵌套仓库扫描目录深度的设置项，默认值为 1，非法值回退默认值并给出可操作诊断；SHALL 提供显式关闭变更清单采集的设置项，供不希望仓库产生 git 对象写入的用户使用。设置在未显式配置时的默认行为 SHALL 为：处于 git 仓库内的 goal 自动采集清单，处于非 git 仓库的 goal 不产生任何新输出，且与今天的行为逐字节等价。设置解析 SHALL 遵循既有的分层规则（project 覆盖 global）。

#### Scenario: 默认深度

- **WHEN** 用户未配置目录深度
- **THEN** 有效深度为 1

#### Scenario: 非法深度值

- **WHEN** 用户为目录深度配置了非法值
- **THEN** 系统回退到 1，并在设置校验中给出可操作诊断

#### Scenario: 显式关闭

- **WHEN** 用户关闭变更清单采集
- **THEN** 系统不采集基线、不在审计输入中新增清单块，且不因该功能写入任何 git 对象

#### Scenario: 非 git 仓库下的零影响

- **WHEN** goal 在非 git 目录中运行
- **THEN** 审计输入与用户可见输出与今天完全一致，不出现空清单、告警或额外提示
