# Tasks: add-goal-change-manifest-and-rollback

> 行为契约见 `specs/workspace-change-manifest/spec.md` 与 `specs/goal-completion-auditing/spec.md`；技术选择见 `design.md`。
> 所有命令在仓库根、direnv/Nix 环境内执行。

## 1. 设置层（`extensions/goal-settings.ts`）

- [x] 1.1 新增 `changeManifest?: "auto" | "off"` 与 `changeManifestDepth?: number` 到 `GoalSettings` 类型及文档注释，并在键校验 switch 中加入两个分支：非法枚举值、非整数、负数给出可操作诊断；验证：`grep -n "changeManifest" extensions/goal-settings.ts` 覆盖类型/解析/校验/持久化/显示五处
- [x] 1.2 接入既有 `track`/`resolveLeaf` 分层解析（project 覆盖 global），`changeManifest` 默认 `auto`、`changeManifestDepth` 默认 `1`（`0` 表示不向下扫描）；验证：`pnpm --filter pi-goal-x test` 中新增的分层与回退用例通过，且 `tests/goal-layered-settings.test.ts` 无回归

## 2. 仓库范围解析（新模块 `extensions/goal-change-manifest.ts`）

- [x] 2.1 实现主仓库解析：`git rev-parse --show-toplevel` 失败或不在仓库内时返回"不启用"，不抛错；验证：新增单测用 `os.tmpdir()` 下的临时目录断言非 git 目录返回空范围
- [x] 2.2 实现向上祖先仓库解析：从主仓库根逐级 `stat` 祖先目录寻找 `.git`，有界且不跨文件系统根；验证：临时仓库内嵌未注册嵌套仓库的用例能同时解出内外两个仓库
- [x] 2.3 实现 submodule 枚举：`git submodule status --recursive`，只纳入已初始化者并记录各 submodule 的路径与 HEAD；验证：用 `git submodule add`（`-c protocol.file.allow=always`）构造夹具断言路径与 HEAD 被记录
- [x] 2.4 实现向下有界遍历发现未注册嵌套仓库：深度取 `changeManifestDepth`，跳过 `.git`、依赖目录与被忽略目录（用 `git check-ignore` 判定），不设条目上限；验证：深度 1 只命中直接子目录、深度 3 命中三层内的用例；同时断言依赖目录未被进入
- [x] 2.5 实现重叠去重（最内层仓库优先）：输出中同一路径只归属最内层仓库；验证：对"已跟踪目录内 `git init`"夹具断言外层片段不再重复该路径

## 3. 基线采集与一次性触发

- [x] 3.1 实现每个仓库的基线采集：HEAD、`status --porcelain -z --untracked-files=all` 指纹、submodule 状态，以及有 HEAD 时的 `git stash create` 结果；验证：干净仓库用例断言 stash 结果为空且未新增 git 对象（比较 `git count-objects -v` 前后）
- [x] 3.2 实现 unborn HEAD 降级：无 commit 仓库跳过 stash 与 HEAD 差异，只记录 status 指纹；验证：临时无 commit 仓库用例断言基线写入成功且标记为 status-only
- [x] 3.3 实现基线 sidecar 写入 `.pi/goals/<id>.baseline.json`，采用"不存在才创建"（`wx`）语义并对已存在文件静默跳过；验证：连续两次调用后文件内容与首次一致
- [x] 3.4 接入一次性触发：在 `extensions/goal-events.ts` 既有的 `turn_start` 处理器开头，当存在 focused 且 `status === "active"` 的 goal 时调用采集并置位（内存 `attemptedGoals` + sidecar `wx` 双重只一次）；**不得**引入工具名分类、`tool_call` 钩子触发或 `task_started` 兜底；验证：新增单测断言每 goal 只采一次、重复触发不覆盖、无 active goal/草拟阶段不采集，且 `grep` 证明 `goal-tool-names.ts` 无工具分类新增、`tool_call` 处理器不含基线触发
- [x] 3.5 为所有 git 调用加超时（推荐 2000ms）与失败静默跳过；验证：注入一个超时/报错的 git 调用后 goal 正常创建与执行，无告警、无阻塞

## 4. 差异计算

- [x] 4.1 实现窗口内差异：`diff --numstat <stash|head>` 与 `status --porcelain -z` 求并，输出状态字母与行级增删统计；验证：临时夹具断言修改/新增/删除/重命名/未跟踪五类各自状态正确
- [x] 4.2 实现基线一致条目排除：与基线指纹状态完全一致的条目不出现在结果中；验证：①基线时已脏、窗口内未再动 → 不出现；②基线时已脏、窗口内又改 → 出现且只反映窗口内改动
- [x] 4.3 实现脏 submodule 递归差异：`git -C <path> diff --numstat HEAD`，并记录基线 HEAD 与当前 HEAD；验证：submodule 工作树被修改与 submodule HEAD 移动两个用例分别断言输出形态
- [x] 4.4 实现多仓库分段结果结构与"无改动"显式记录；验证：多仓库夹具断言分段路径相对各自根且无歧义；单仓库无改动时断言返回显式的空变更标记

## 5. 清单渲染与审计注入

- [x] 5.1 实现 `<change_manifest>` 渲染：按仓库分段（root/kind/基线标识）、逐条状态与增删统计、每段附可直接执行的展开命令、长度上界（6000 字符）截断、不内联 diff 正文；验证：新增 `tests/goal-change-manifest-prompt.test.ts` 断言命令存在、超出上界时被截断、且输出中不包含 diff 正文行
- [x] 5.2 在 `extensions/goal-completion.ts` 组装路径（`warmContext` 同段）计算清单并作为新参数传入 `runGoalCompletionAuditor`；验证：单测断言清单缺失/存在两种情况下参数被正确传递，且 `tests/goal-auditor-package.test.ts` 无回归
- [x] 5.3 在 `buildGoalAuditorPrompt`（`extensions/goal-auditor.ts:254`）渲染 `<change_manifest>` 块，与 `<warm_context>` 并列，并使用"机器采集的工作区证据"措辞；验证：prompt 组合断言清单块出现且 executor 声明仍标注 untrusted claim
- [x] 5.4 断言审计工具白名单与 verdict 契约不变（清单不引入新工具、不影响结构化结果解析）；验证：`tests/goal-auditor-selector.test.ts`、`tests/goal-auditor.test.ts` 通过且 `agents/goal-auditor.md` 的 `tools` 未改动

## 6. 生命周期清理

- [x] 6.1 在完成事务提交成功后删除基线 sidecar；验证：单测断言 approved 完成路径后文件不存在
- [x] 6.2 在审计拒绝或运行出错时保留基线；验证：断言 disapproved/error 后文件仍存在且内容未被改写
- [x] 6.3 在归档、中止、清除路径删除基线；验证：三条路径各有单测断言文件被删除
- [x] 6.4 在既有诊断/恢复路径（`/goal-recovery`、`/goal-status health` 一线，`extensions/goal-session-health.ts` / `goal-commands.ts`）清理无对应 goal 记录的孤儿基线；验证：构造孤儿 sidecar 后断言恢复/诊断路径将其清除，且不触碰用户 stash 列表与不可达对象

## 7. `/goal-clear` 回滚（`extensions/goal-commands.ts` + 新回滚模块）

- [x] 7.1 实现两段式交互：保留现有 `ctx.ui.confirm("Clear goal?")` 不变，在其后、`archiveCurrentGoal` 之前插入默认"否"的回滚询问，并在询问文本中给出将被恢复/删除的文件数量预览；验证：新增单测断言顺序为"确认 → 询问回滚 → 归档"，且回答"否"时工作区零改动、`tests/goal-mutation-boundary.test.ts` 无回归
- [x] 7.2 实现回滚条件的判定与静默跳过：无基线、窗口内无改动、非 git 目录或采集关闭时不询问，直接走既有清除路径；验证：四种情况各有单测断言不出现询问且清除结果与今天一致
- [x] 7.3 实现备份写入 `.pi/goals/archived/` 下与归档文件同命名风格的 `rollback_<时间戳>_<goalId>/` 目录（每仓库一份 `git diff --binary <base>..<现在>` 补丁 + 窗口内新建文件副本），复用既有路径安全校验；验证：临时仓库夹具断言目录位置、补丁可用 `git apply --check` 回放，且 `git stash list` 前后一致
- [x] 7.4 实现 fail-closed：备份整体写入成功后才允许修改工作区；失败/超时/超容量时放弃回滚并报告原因与目标位置；验证：注入备份失败后断言工作区未被修改、清除仍完成
- [x] 7.5 实现回滚执行：恢复类条目用 `git restore --source=<base> --worktree -- <path>`（不动索引）、新建类条目删除文件、尽力清理因此变空的目录、HEAD 移动类不回滚；验证：五类夹具（修改/删除/新增/未跟踪/已脏又改）断言回滚后内容等于基线，且 submodule 头部未变
- [x] 7.6 实现逐仓库结果报告：成功条目数、失败路径与原因、备份位置；部分失败不阻塞清除；验证：注入单个路径失败后断言报告包含该路径且 goal 仍被清除
- [x] 7.7 实现与基线清理的时序与竞态保护：基线删除晚于回滚流程，`focus token` 校验保持既有行为；验证：单测断言回滚流程中目标变化时不执行清除也不执行回滚，且 `tests/goal-deferred-archival.test.ts` 无回归

## 8. 降级与端到端验证

- [x] 8.1 断言非 git 目录与 `changeManifest: "off"` 下行为逐字节等价：无清单块、无 git 对象写入、无用户可见新增输出；验证：对两种情况断言审计 prompt 与今天一致（快照比对），并比较 `git count-objects -v`
- [x] 8.2 端到端链条验证：临时仓库中构造"goal 执行 → 改动若干文件 → 请求完成"与"goal 执行 → `/goal-clear` 选择回滚"两条链路，分别断言审计清单与实际改动一致、回滚后工作区回到基线；验证：新增集成用例通过 `pnpm --filter pi-goal-x test:integration`
- [x] 8.3 全量门禁：`pnpm --filter pi-goal-x run typecheck`、`pnpm --filter pi-goal-x test`、`pnpm exec prettier --check .` 全部通过；并确认本变更未触及 `packages/pi-goal-x` 之外的生产代码
