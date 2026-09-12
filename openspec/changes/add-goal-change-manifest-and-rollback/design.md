# Design: add-goal-change-manifest-and-rollback

> 动机与范围见 `proposal.md`；行为契约见 `specs/workspace-change-manifest/spec.md` 与 `specs/goal-completion-auditing/spec.md`。

## Context

审计子代理是 fresh context（`agents/goal-auditor.md`，`defaultContext: fresh`），其输入由 `buildGoalAuditorPrompt`（`extensions/goal-auditor.ts:254`）构造：目标、executor 声明、目标元数据、任务树、验证契约，以及 `warmContext`（`goal-completion.ts:245` 组装的 ledger 尾部 8 条事件）。`warmContext` 里只有生命周期与任务事件，**没有任何工作区事实**。

已存在但不可复用的机制：

- 五阶段 dashboard 的第 4 阶段名为 "Workspace inspection"，但没有任何数据驱动它（`specs/2026-08-23-checkpoint-context-growth/TECH.md` 的 checkpoint 只持久化 goal 状态本身）。
- ledger 事件类型（`extensions/goal-ledger.ts:9`）中没有任何文件级事件。

约束：

- goal 存储位于 `.pi/goals/`（`extensions/storage/goal-files.ts:19`），在本仓库被 `.gitignore` 排除，天然不污染 diff。
- 审计员已有 `read`/`grep`/`find`/`ls`/`bash`（`agents/goal-auditor.md` 的 `tools`），因此**能自己执行展开命令**，清单只需做索引。
- goal 生命周期存在跨进程并发保护（`goal-service.ts` 的 revision/token 检查），基线写入必须一次性且不可覆盖。
- 实测结论（临时仓库验证）：`git stash create` 在干净树上**输出为空且不写任何对象**；脏树上返回 dangling commit，且之后 `git diff <sha>` 能捕获"基线时已脏、窗口内又被进一步修改"的文件；外层仓库对嵌套仓库只报一个不透明条目（`?? nested/`），对脏 submodule 只报一条 gitlink 行（行内为 `M sub`）与 `0 0 sub`；unborn HEAD 下 `stash create` 与 `git diff HEAD` 均失败，仅 `status --porcelain` 可用。

## Goals / Non-Goals

**Goals:**

- 在 goal 完成时向审计员提供**按仓库分段的工作区变更索引**，使其定位改动范围的成本接近零。
- 采集与清理对 goal 生命周期**完全非阻塞**，且失败时行为与今天逐字节一致。
- 支持多仓库现实：主仓库、递归 submodule、祖先仓库、有界深度内的未注册嵌套仓库。
- 在 `/goal-clear` 时让用户选择把工作区回滚到基线状态，且回滚前有可恢复的备份。

**Non-Goals:**

- 不做工具调用级归因（谁改的、哪一次改的）——只用 git 快照。
- 不追踪 worktree 隔离中的改动，也不追踪超过配置深度的嵌套仓库。
- 回滚不重置任何仓库 HEAD，不尝试撤销 submodule/嵌套仓库内部的提交。
- 不改变审计工具白名单、结构化 verdict 契约、完成事务或 dashboard 阶段语义。
- 不内联全量 diff，也不做会修剪用户对象的 git 操作。

## Decisions

### D1：数据来源只用 git 快照

**选择**：变更范围完全由 git 状态推导。

**否掉的替代**：①拦截 `tool_call` 记录 write/edit 路径——对 `bash` 写入（`sed -i`、`git apply`、生成器）无法归因，且 pi-subagents 子会话的父进程看不到其工具调用；②解析父会话 transcript——把发现成本又推回审计员，与目标相反；③仅 `git diff HEAD` 不做基线——无法区分 goal 开始前就存在的未提交改动。

**代价（已接受）**：非 git 目录下功能整体不生效。

### D2：逐仓库独立快照，重叠以最内层为准

**选择**：每个仓库一份独立基线；路径按各自仓库根分段；同一路径同时被内外层跟踪时（如已跟踪目录内 `git init`）只按最内层报告。

**理由**：实测证明外层仓库对嵌套仓库内容与 submodule 文件内容完全不可见，单仓库假设必然漏报。

### D3：仓库范围解析（向上廉价、向下有界）

````text
主仓库     = git rev-parse --show-toplevel（cwd 所属最内层；cwd 在 submodule 内时天然命中该 submodule）
submodule  = git submodule status --recursive（只枚举已初始化者）
祖先仓库   = 从主仓库根向上逐级 stat .git（O(depth)）
嵌套仓库   = 向下有界遍历：深度 = changeManifestDepth（默认 1，0 表示不向下），
             跳过 .git / 依赖目录 / 被忽略目录；无条目上限（按用户决策）
```text

**否掉的替代**：只捡 `git status` 免费吐出的未跟踪目录——成本最低但与"目录深度"语义不一致，且漏掉被 gitignore 的嵌套仓库。

**理由**：向上是 O(depth)、向下是唯一昂贵方向，因此用显式深度限制它；默认深度 1 在本仓库量级（约 20 个子目录）几乎是零成本。

### D4：基线原语用 `git stash create`

**选择**：有 HEAD 时执行 `git stash create` 并把返回 SHA 连同 HEAD、脏状态指纹、submodule 状态一起写入 sidecar；无 HEAD 时降级为纯 `status --porcelain -z --untracked-files=all` 指纹。

**否掉的替代**：①仅脏状态指纹——无法发现"已脏文件在窗口内又被改"；②把工作树 diff 存成 patch 文件——减patches 不是 git 原语，无法在窗口末精确分离；③对每个脏文件 `git hash-object`——只能说明"变了"，拿不到窗口内的内容差。

**副作用**：会写不入 reflog 的 dangling object。干净树零成本；脏树成本正比于脏文件数量。提供显式关闭开关给不接受对象写入的用户。

### D5：基线触发点 = goal 确认后的第一个执行回合开始（一次触发，不做追踪）

**选择**：在 `extensions/goal-events.ts` 既有的 `turn_start` 处理器开头加**一次调用**：当存在 focused 且 `status === "active"` 的 goal 时采集基线，之后置位不再触发。"只一次"由两层保证：进程内 `attemptedGoals`（每 goal 一次尝试，不分成功失败）+ sidecar 写入的 `wx`（已存在则拒绝覆盖）。

**理由**：agent 只能通过工具修改文件，而任何工具都运行在某个回合之内，因此"执行回合开始时采集"与"第一次改动之前采集"在**覆盖范围上等价**——每一次 agent 改动都落在窗口内。差别只有一处：确认之后、第一个回合开始之前用户手动做的编辑不计入窗口，方向更保守（宁可少报，不把用户自己的改动当成 agent 的）。代价是一个调用点、一个守卫、一个一次性标志：没有工具名分类表、没有 `bash` 保守触发、没有兜底事件。

**否掉的替代**：把触发挂在 `tool_call` 钩子上（按 `write`/`edit`/`bash` 分类，`task_started` 兜底）—— 需要三套额外机制，收益只是让窗口起点晚几十毫秒，并把生命周期语义耦合到工具层；用户判定为复杂且不必要，故否决。

### D6：差异计算与排除规则

```text
每个持有基线的仓库：
  base = stash || head
  条目 = diff --numstat <base>   ∪   status --porcelain -z
  排除 = 在基线指纹与当前指纹中状态完全一致的条目（＝窗口前就脏、窗口内未再动）
脏 submodule：git -C <path> diff --numstat HEAD，并记录基线/当前 HEAD
无 HEAD 仓库：只有 status 维度，只报存在性变化
```text

**理由**：`stash` 基线让"已脏文件被进一步修改"仍能报出真实窗口内改动；排除规则防止把用户此前的未提交工作误算成 goal 成果。

### D7：清单渲染

按仓库分段（`root` + `kind` + 基线标识 + 置信度注记），逐条给出状态字母与行级增删统计，附**可直接执行的展开命令**（如 `git -C vendor/lib diff HEAD`），并受长度上界约束（推荐 6000 字符，超出时按仓库截断并在段内标注）。**不内联 diff 正文**——审计员用既有 `bash`/`read` 拉取。

无任何改动时仍输出一条明确的"未检测到工作区改动"记录，避免审计员把"空"误读为"采集失败"。

### D8：注入点

在 `goal-completion.ts:245` 附近的同一段组装逻辑里计算清单，作为新参数传入 `runGoalCompletionAuditor`，最终由 `buildGoalAuditorPrompt` 渲染成 `<change_manifest>` 块，与 `<warm_context>`（`goal-auditor.ts:302`）并列。措辞必须与 `goal-completion-auditing` 的 trust 边界一致：清单是**机器采集的工作区证据**，executor 声明仍是 untrusted claim。

### D9：生命周期清理

- 基线 sidecar 在完成事务提交、归档、中止、清除时删除；审计拒绝/出错时保留（目标仍 active，重试要复用同一窗口）。
- **清除路径例外**：`/goal-clear` 上的删除必须晚于回滚选择、回滚备份与回滚执行（见 D13），否则回滚会失去基线依据；回滚备份自身不受清理影响。
- 孤儿基线（无对应 goal 记录）由既有诊断/恢复路径清理（`/goal-recovery`、`/goal-status health` 一线）。
- 清理只删 sidecar 文件，**不运行任何 git 修剪命令**；dangling 对象交由 git 常规 gc。
- 写入用"不存在才创建"语义（`wx`），重复触发或跨进程竞争不会覆盖首个基线。

### D10：静默降级与设置

两个设置项：`changeManifest`（`auto` 默认 / `off`）与 `changeManifestDepth`（默认 1，0 表示不向下扫描），遵循既有 global/project 分层（project 覆盖 global）与非法值回退默认的模式（`goal-settings.ts`）。

非 git 仓库、git 缺失、命令超时、写入失败：一律静默跳过且不产生任何新输出。按用户决策，向下遍历不设条目上限，也不在清单里提示"扫描不完整"。

### D11：回滚复用清单 delta 作为唯一真相

**选择**：回滚的输入就是 D6 算出的窗口内差异（同一份代码路径）。`恢复类` 条目（M/D）→ 用基线树内容恢复工作区；`新建类` 条目（A/??）→ 删除文件；`HEAD 移动类` 条目（submodule / 嵌套仓库）→ **不回滚，列入报告**。恢复内容一律取自基线快照（`stash` 树或 HEAD），因此"基线时已脏、窗口内又改"的文件会回到基线内容而非 HEAD 内容。

**理由**：审计与回滚若各自推导"改了什么"，必然产生分歧；复用一份 delta 同时消除了重复实现和"回滚范围与清单不符"这类不一致。

**实现细节**：用 `git restore --source=<base> --worktree -- <path>`（只动工作树、不动索引）而非 `git checkout <tree> --`（会同时改索引），以保持"不改写暂存区"的承诺。

**否掉的替代**：`git reset --hard` / `git checkout .` —— 会连带丢掉基线前就存在的未提交改动，与排除规则直接矛盾。

### D12：备份形态 = 归档目录内自包含 + fail-closed

**选择**：备份写到归档目录下与该 goal 归档文件同目录、同命名风格的独立目录（`rollback_<时间戳>_<goalId>/`，遵循 `makeArchivedGoalPath` 的命名与路径安全校验）：每个仓库一份 `git diff --binary <base>..<现在>` 补丁，加上窗口内新建文件的副本。**备份全部成功后才开始修改工作区**；写入失败、超时或超过容量上限则放弃回滚并报告原因。不调用 `git stash push`，因此不污染 `git stash list`。

**理由**：这与既有"归档"机制同构（制品随归档长期保留、位于被 gitignore 的 `.pi/goals/` 下），也与我们已有的"MUST NOT 修改用户 stash 列表"约束一致。

**否掉的替代**：命名 stash（`git stash push`）—— 恢复体验最好（`git stash pop` 一条命令），但会往用户 stash 列表写条目、多仓库时条目割裂，且与 baseline 的 stash 约束语义不一致。

### D13：交互形态与执行时序

**选择**：保留现有 `ctx.ui.confirm("Clear goal?", ...)` 不变，确认通过后再用一个默认"否"的二次询问（带文件数量预览）收集回滚意愿。执行时序固定为：

```text
确认清除 → focus token 校验 → 计算 delta 并预览 → 写备份 → 执行回滚 → 报告结果
        → archiveCurrentGoal → setGoal(null) → 删除基线
```

**理由**：两段式让清除（轻）与回滚（重且不可逆）彻底解耦，误按 Enter 不会既清除又回滚；也避免改动既有确认流程的语义与测试。无交互 UI 时 `/goal-clear` 本就拒绝执行，因此回滚无需额外的无 UI 分支。

**否掉的替代**：把清除确认升级为三选项对话框 —— 改动既有交互面与其基线测试，且把破坏性选项放进了主确认路径。

## Risks / Trade-offs

- [回滚是不可逆的破坏性操作] → 备份前置且 fail-closed、预览后默认"否"、不重置任何 HEAD、部分失败逐条报告并给出备份位置。
- [备份容量：大仓或大二进制文件会产生可观写入] → 设容量上限；超限时**拒绝回滚**并报告，而不是静默跳过备份后继续破坏工作区。
- [部分失败导致工作区处于半回滚状态] → 逐条列出失败路径与原因，不清除或覆盖已成功回滚的部分，用户可依备份手工收敛。
- [扩展内 fork `git` 绕过工具级权限门] → 只使用固定子命令集、路径参数以数组形式传入（不拼 shell 字符串）、全局限时；把"扩展内 git 不经权限门"写入文档，避免用户误以为受 `pi-permission-system`/`pi-sandbox` 保护。
- [跨平台路径与 `core.autocrlf`/文件权限差异影响补丁恢复] → 备份与恢复都用 `--binary` 补丁并记录模式变更；无法完整恢复的条目归入失败报告。
- [无条目上限 + 静默截断：深度调大后在超大仓库上 goal 创建变慢，且清单缺失对审计员不可见] → 保留每仓库命令超时（推荐 2000ms）与总预算作为唯一硬边界；截断只写进诊断路径（`/goal-status`），不进审计 prompt 也不弹通知。
- [stash 基线产生 dangling object，若 goal 跨过 gc 导致 SHA 失效] → 差异计算失败时降级为 status 维度并静默继续，不阻塞完成。
- [盲区：超深嵌套仓库、worktree 隔离内的改动] → 明确记为已知限制，清单不声称完整，避免审计员过度信任。
- [unborn HEAD 仓库只能报存在性变化] → 已在 spec 中显式建模，避免被当成"改了但没记录"。
- [首个执行回合只是只读探索] → 触发点是“第一个执行回合开始”而非“第一次改动”，所以只读探索也会开启窗口；代价仅是多报几条探索期改动，方向是过报而非漏报。
- [多 goal 并发共享同一仓库窗口] → 每个 goal 独立基线；重叠窗口下各自报告"自其基线以来"的差异，这是预期语义而非缺陷。

## Migration Plan

新增能力，无数据迁移：`.pi/goals/<id>.baseline.json` 是新文件，旧 goal 记录不含基线时清单缺失、行为不变。回滚方式为关闭开关或移除采集调用点——两份 spec 的 delta 在归档前不会影响主 spec。

## Open Questions

- 是否在五阶段 dashboard 的第 4 阶段 "Workspace inspection" 显示变更文件计数。属展示层增强，不影响 spec、方案与任务分解，可后续单独决策。
````
