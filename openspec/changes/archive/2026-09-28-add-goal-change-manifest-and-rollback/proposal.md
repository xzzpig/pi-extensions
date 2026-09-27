# Proposal: add-goal-change-manifest-and-rollback

## Why

完成审计由 fresh-context 子代理执行，其审计输入只有目标、任务树、验证契约、详细摘要和近期 ledger evidence——**没有任何工作区事实**。审计员因此不知道 executor 实际改过哪些文件，只能从零开始用 `find`/`ls`/`read` 全仓摸索，把预算大量花在"发现该审什么"而不是"审得对不对"上，且仍可能漏审或审错方向。

## What Changes

- 新增**工作区变更清单（change manifest）**：goal 首次进入执行阶段时对相关 git 仓库采集基线，在完成请求时计算该窗口内的差异，作为**机器采集的工作区证据**注入审计 prompt。
- **仓库覆盖**：主仓库（cwd 所属最内层仓库）+ 递归 submodule + 向上祖先仓库 + 向下按目录深度（默认 1，可配置）遍历发现的未注册嵌套仓库；重叠路径以最内层仓库为准。
- **基线方式**：`git stash create` 为主（干净树不写任何对象、零成本），unborn HEAD 降级为 `status --porcelain` 指纹；每个仓库一份，存于 `.pi/goals/<id>.baseline.json`。
- **差异来源**：`git diff --numstat <stash|head>` + `git status --porcelain`（untracked/新增/删除/重命名），减去与基线一致的条目；脏 submodule 递归取其内部 diff。
- **审计注入**：`buildGoalAuditorPrompt` 新增 `<change_manifest>` 块，与 `<warm_context>` 并列，附带可直接执行的展开命令；**不内联全量 diff**，审计员用既有 `bash`/`read` 权限按需取内容，工具白名单不变。
- **静默降级**：不在 git 仓库内、git 不可用或任一采集步骤失败时，完全保持今天的行为，不新增输出、不阻塞 goal 创建与完成。
- **生命周期清理**：goal 完成、归档、abort、clear 时删除对应基线文件；无对应 goal 记录的孤儿基线由恢复/诊断路径清理；dangling stash 对象交由 git 常规 gc，不做侵入式 prune。清除路径上，基线保留到回滚流程结束之后才删除。
- **`/goal-clear` 回滚选择**：用户确认清除后、归档生效前再询问一次是否回滚本次执行窗口的改动（默认不回滚）；回滚前先把将被丢弃的改动备份到归档目录下的自包含位置（补丁 + 新建文件副本，不碰用户 stash 列表），备份失败则拒绝回滚；回滚把被修改/删除的已跟踪文件恢复到基线内容并删除窗口内新建的文件，但**不重置**任何仓库 HEAD（已发生的 submodule/嵌套仓库提交如实报告为未回滚项）。
- 新增设置项：嵌套仓库扫描目录深度（默认 1）；另提供显式关闭开关，供不希望仓库产生 git 对象写入的用户使用。
- 明确接受的盲区：超过配置深度的嵌套仓库、未被深度扫描命中的嵌套仓库、worktree 隔离中的改动，均静默不可见。

## Capabilities

### New Capabilities

- `workspace-change-manifest`: 工作区变更清单的仓库范围解析、基线采集、差异计算、审计注入契约、生命周期清理与静默降级语义。
- `goal-change-rollback`: `/goal-clear` 的回滚选择、回滚范围与动作、回滚前备份、结果报告，以及与基线清理的时序。

### Modified Capabilities

- `goal-completion-auditing`: 审计输入新增机器采集的工作区变更清单，并明确其证据性质与 trust 边界（不得替代或软化 executor 声明的 untrusted 标记）。

## Impact

- `packages/pi-goal-x/extensions/`：新增变更清单采集与渲染模块、回滚执行与备份模块；改动 `goal-auditor.ts`（审计 prompt 构造）、`goal-completion.ts`（完成路径组装 Δ）、goal 执行起点（基线触发）、`goal-commands.ts` 的 `/goal-clear` 流程（回滚询问与执行）、`goal-settings.ts`（新设置项）、storage（基线文件读写与清理）。
- `openspec/specs/goal-completion-auditing/spec.md`：审计输入相关要求。
- **首次引入子进程调用**：pi-goal-x 目前没有任何 `node:child_process` 使用，本变更需要 fork `git`。扩展内直接执行 git **绕过工具级权限门**，与同仓库的 `pi-permission-system` / `pi-sandbox` 不产生交互；需在实现时明确该边界并在文档中如实说明。
- 无新运行时依赖；不改变审计工具白名单、结构化 verdict 契约或完成事务；不新增阻塞 goal 生命周期的同步步骤（除用户显式选择的回滚）。
- 副作用说明：`git stash create` 会写入不入 reflog 的 dangling object，随 git 常规 gc 回收。
