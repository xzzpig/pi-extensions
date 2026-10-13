# 真实运行时 E2E 验证步骤

## 范围与执行时机

用户选择“完整真实运行链路”。这是实现后的必做验收，不是本次计划阶段的执行记录。它补充 tasks 6.2 的确定性集成测试：**真实 Pi CLI 进程、真实模型、实际扩展资源加载、真实 tmux TUI/对话框、原生子运行、会话文件和目标状态**；不得以 mock、SDK 假模型、只检查静态数组或模型口头声称代替。

覆盖 E0–E8：启动、主/子工具隔离、计划/实现模式、前台/后台/工作流交接、完成前阻塞与完成后放行、失败与新 attempt、原子批量、冷重启、普通目标/direct 回归、最终审计。对通知竞态、断链、版本/资源上限等难以稳定制造的边界，仍保留原确定性测试；不把一次 live 顺序碰巧出现当作覆盖全部竞态。

只在用户批准计划并进入实现、静态与单元/集成验证通过后执行。本轮不运行模型、创建测试目标或启动 tmux pane。后续长流程前核对可用模型与凭据；环境缺失算 BLOCKED，不跳过后宣称完成。

## 依据和新增测试文件

先完整读取：

- `.agents/skills/pi-plugin-e2e-test/SKILL.md`、`scripts/pi-e2e-env.sh`、`references/worked-example.md`。
- `.agents/skills/pi-tmux-tmp-server/SKILL.md`。
- 本 change 的 design D1–D8、delta spec，以及 Pi 的真实 session-format/API 文档。

实现阶段新增、仅供测试且不进入发布包：

- `packages/pi-openspec-x/test/e2e/run-live.mjs`：前置检查、临时环境/fixture、print smoke、tmux 驱动、场景调度、证据 manifest 与清理。
- `packages/pi-openspec-x/test/e2e/assert-live.mjs`：读取真实 session/native status/goal 文件及捕获记录，对下表各场景作机器断言，失败返回非零。
- `packages/pi-openspec-x/test/e2e/probe.ts`：只观察真实注册表/活跃工具/系统规则及生命周期并记录 `e2e/` 自定义条目，不注册报告工具、不改业务状态、不代替执行/审批/完成门。

沿用现有技能的 tmux wrapper，不改它或 peers。驱动器可生成本次专用 launcher 和 fixture 到 `/tmp`，不新增通用服务、IPC 或生产配置。

## E0：前置条件与隔离

从仓库根用 direnv 的工具运行：

```bash
ROOT="$(git rev-parse --show-toplevel)"
direnv exec "$ROOT" node "$ROOT/packages/pi-openspec-x/test/e2e/run-live.mjs" --preflight
```

驱动器必须做到：

1. 确认 direnv 内 node/pi/tmux/openspec 可用，记录真实版本、包版本及测试代码 revision。不要裸调用可能来自另一环境的 npm/node。先准备隔离 agentHome 再探测 Pi：即使 CLI 信息命令也可能初始化 trust/lock，不能写用户全局目录。
2. 运行 `TMUX_TMPDIR=/tmp tmux ls` 确认 host server 可连接。计划补充时已观察到 host 会话可连接，但执行时仍重新检查。缺失时停止、按 tmux 技能给用户 host 启动指令并用 ask_user 确认；不能在 sandbox 内启动 server，不能 kill-server/删除他人 socket 或会话。没有 TUI 的 headless 替代不能算完整 E2E 通过。
3. 唯一临时根 `mkdtemp(/tmp/opsx-report-e2e-...)`，权限 0700；每 case 独立 cwd/agentHome/sessions/evidence。测试源写入仅发生在临时 fixture，不在真实仓库实现文件内。
4. 使用临时 `PI_AGENT_DIR`，把 model/provider 必需设置、显式 companion 资源和 subagent 数据目录限制在该根；`PI_GOAL_ROOT` 固定在该 case 的临时目标目录。不得 `pi install`、改用户 settings/trust/目标或全局扩展。所选模型沿用执行前用户配置，不在本计划固定某个供应商/型号。
5. 若需要文件凭据，只将所选 provider 的必要条目复制到临时 auth 文件，权限 0600；不输出内容、不复制到仓库/报告、不 symlink 可被刷新写入的全局 auth。若需模型 provider 扩展，只显式加载该必需路径并写入资源 manifest；不能因此打开所有 ambient 扩展。退出时删除临时凭据，保留脱敏证据。
6. 主进程禁用所有 discovery：`--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`，通过绝对 `-e` 只加载下面五个入口及确需的 provider；固定 `--session-dir`。子进程的临时 agent settings 同样仅列必需 companion/provider，使后台默认资源继承不加载用户旧插件。

显式入口：

```text
$ROOT/packages/pi-sandbox/index.ts
$ROOT/packages/pi-subagents/index.ts
$ROOT/packages/pi-goal-x/extensions/goal.ts
$ROOT/packages/pi-openspec-x/index.ts
$ROOT/packages/pi-openspec-x/test/e2e/probe.ts
```

`probe.ts` 仅给主测试运行加载；不手工把三个报告入口加到任意 role 的 extensions，不更改 OPSX_AGENT_DEFINITIONS 的默认白名单/subagentOnlyExtensions 来制造隔离“通过”。子角色表面从其真实系统工具声明/资源加载与报告结果校验。

环境 runner 以绝对 `PI_BIN` launcher 使用既有 wrapper。launcher 在 host pane 内设置 PI_AGENT_DIR/PI_GOAL_ROOT 后 exec 已核对的 pi；不依赖 tmux server 自动继承 client 环境。wrapper 的 start 会清空同名 envdir，因此使用唯一名称，凭据/launcher 放在其外的本次临时根，不会被 start 删除。使用 wrapper 的 send/capture/entries/stop；重启使用记录的同一 launch manifest 加 `--session <精确原会话文件>`，**不再次调用会擦掉状态的 start**。

先执行真实 print smoke：

```text
cwd=<该 case 的临时 cwd>
PI_AGENT_DIR=<临时 agentHome> PI_GOAL_ROOT=<临时 goalRoot>
timeout 120 <已核对 pi> <上述 isolation flags/绝对 -e/session-dir>
  -p "Reply with exactly the word: pong"
```

期望 exit 0、实际 assistant 文本 pong、真实 session 文件、无扩展/工具重复注册或依赖加载错误。credential 存在检查不足以证明可用；这一真实 round-trip 才证明运行条件。失败停止，不尝试换 CLI/模型绕过或自动安装。

## 受控 OpenSpec fixture

runner 为每条实施链路生成独立小项目：

- `git init`，不创建 commit 或更改真实 repo；goal-x 支持 unborn HEAD 的 status-only 窗口，断言此次实际 window delta 非 degraded 且能观察被修改的测试路径。
- `openspec init --tools none --language zh-CN`、`openspec new change e2e-report-isolation`；检查 status JSON 的 planningHome.root 正好是临时 cwd，指向 store/真实仓库时立即停止。
- 写入最小合法 proposal/design/spec/tasks：任务 `1.1` 将 `src/value.cjs` 从导出 0 改为 1；任务 `1.2` 将 `src/second.cjs` 从导出 0 改为 2。Node 验证命令分别检查导出值。openspec/ 和测试驱动已有文件不在 worker 的任务改动声明中。
- goal/focus/任务通过真实 `/opsx:implement` → create_goal/set_goal_tasks 生成，不能直接拼目标文件、手造 binding/receipt、预填计划批准或勾选 tasks.md 来让结果通过。
- 计划测试走真实 `/opsx:plan e2e-report-isolation`、子报告与父侧计划工具，实际批准对话框由 runner 观察后发送对应按键；禁止 PI_GOAL_AUTO_CONFIRM 或等价 helper。纯派发场景用已批准 fixture 进入 agent 模式。

每 case 使用自己的新 change/session，避免同 session 的第二条实现流程被正常守卫拒绝。worker 每次新派发/resume 的 Task 段使用 D3 的唯一编码 marker，六段 brief 保留。

## 场景、操作与机器断言

| Case                        | 真实操作步骤                                                                                                                                                                                                                             | 必需证据和通过条件                                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 主会话/模式工具表面      | 普通 prompt 后记录 probe 表面；进入真实 `/opsx:plan`，驱动 gap/review；在独立 case 分别进入 agent/direct；结束后 `/reload` 再记录                                                                                                        | 每个主注册表/活跃工具/实际系统声明均无 report_gap_analysis/report_plan_review/report_work 及其专用规则；两个父计划工具仍存在。按工具定义验证，不以模型“我不会调用”算通过                                                                                                |
| E2 对应子角色表面           | 从实际主进程经原生 subagent 启动 gap-analysis、plan-review、worker；最终 audit 启动 reviewer；启动一个内建只读非对应角色。按前台/后台 native 资源分别取证                                                                                | 三对应角色各自只有其一个 report\_\*，其他角色/reviewer 无三工具；合法对应 report 调用成功且 envelope/attempt/role 正确；reviewer 保留 report_auditor_progress 和执行底座最终裁决。前台仅用于此明确测试的路径，不是失败后 fallback                                       |
| E3 前台/后台/工作流成功链路 | 进入 agent fixture；分别对任务派发前台 worker、后台 worker，以及含两个明确 task 的成功原生工作流。先只交报告不申请 complete，再由主模型读真实 diff、运行 Node 验证并 complete+短 evidence                                                | 原生成功子终态、规范子会话报告 → 主 flow-binding/run/ready receipt → 真实完成申请 → goal 任务 complete/新 completedAt → taskTicked/完成事件。收到报告时任务尚未完成。主会话没有第二次 report_work、没有 review_work；没有通过手动 status/bg_wait 转录报告才能成功的路径 |
| E4 缺报告/失败/新 attempt   | 在无对应报告时要求实际 complete 调用；让 worker 产生实际 Node 验证失败并以合法 report 标记 verificationPassed=false；已成功任务的新 resume 故意产生失败报告，再尝试完成                                                                  | 必须看到真实完成调用被 block，而不是模型仅口头拒绝。goal 任务与 tasks.md 保持未完成，无 task_completed。新 run/attempt 与旧不同，旧成功不能放行。模型未产生预期调用时本 case 算未覆盖/失败，不用叙述算通过                                                              |
| E5 批量及 goal 原生拒绝     | 两任务分别准备有效与失败报告，调用真实 updates[] complete 批量；随后准备两项有效报告完成。另以有合同但无 evidence 或父任务子项未完成触发 goal-x 拒绝                                                                                     | 首次批量任一不符则两项都不变；全部符合后原子完成。goal-x 即使未给 isError 的逻辑拒绝也不能有 taskTicked/task_completed；以真实 v3 结果和任务前后状态比对                                                                                                                |
| E6 冷重启/恢复              | 两任务 case 中等待一个 ready receipt、另一项无 receipt；在 complete 前通过真实 `/goal-pause` 保持未完成，停止 Pi；以同 agentHome/cwd/session-dir 和精确原 session 文件启动新 Pi，再 `/goal-resume` 后尝试完成缺报告项，随后补合法 worker | 进程/PID 确实更换，磁盘真实目标与分支证据保留；冷读先重绑定 flow/gate，再重建 receipt；缺报告项仍 block，补新有效报告才能完成。未人工补写 metadata。driver 未能在 complete 前暂停则此轮不算 cold-ready 覆盖，可明确重建该 case 一次，不伪造记录                         |
| E7 焦点与 ordinary/direct   | 有未完成 opsx agent 目标时通过真实 goal-focus/UI 聚焦普通目标，完成其合法任务；新 case 走 `/opsx:implement --direct`，无 worker 完成；回到 opsx 目标再检查缺报告项                                                                       | ordinary/direct 不被 worker 条件拦，不把它们计为 opsx task_completed；回到 agent 仍需要其自己的 receipt。工具表面仍无三项，目标 id/焦点条目与事件归属匹配                                                                                                               |
| E8 审计及收尾               | 对成功 agent 和 direct 链路请求真实目标完成，让 opsx-reviewer 运行；ordinary 目标仍走默认 auditor。收集并检查 final structured verdict/任务状态                                                                                          | opsx 目标只在执行底座审计批准后真正完成，普通目标默认配置未被替换。不运行 openspec archive/publish/真实 repo commit；不能以任务全勾选替代最终审计。停止本次 pane/子运行、移除临时 auth，保留脱敏 evidence                                                               |

控制器等待可验证的 pane/会话状态再发下一步，不把 running/steering 当新 idle prompt。smoke 120 秒、各链路场景 600 秒、整次最多 3600 秒；每次启动先 capture，按有界间隔取 pane/session 更新。这是驱动外部 TUI 的观测，不对本会话的原生 async 子审查轮询。超时失败并终止本次拥有的运行，不以静态测试绿或模型最终一句话掩盖。

## 执行入口与证据

新增 runner 提供这些固定 CLI：

```bash
# 只检查基础设施/版本/隔离，不启动模型、pane 或子运行
direnv exec "$ROOT" node "$ROOT/packages/pi-openspec-x/test/e2e/run-live.mjs" --preflight

# 完整真实运行；打印本次临时根与证据 manifest 路径，不输出凭据
direnv exec "$ROOT" node "$ROOT/packages/pi-openspec-x/test/e2e/run-live.mjs" --suite full

# 重复执行纯取证断言，不重新发起模型/子运行
# EVIDENCE 是 runner 打印的本次证据目录
direnv exec "$ROOT" node "$ROOT/packages/pi-openspec-x/test/e2e/assert-live.mjs" --evidence "$EVIDENCE"
```

允许 `--case E1` 等做单一失败复现，不把部分 case 的通过宣称 full 通过。全部 cases 通过时 runner 和 assert-live 都 exit 0；基础设施不具备返回明确 BLOCKED 与非零，case 失败返回 FAIL 与非零。

manifest 至少记录：实际启动命令（去凭据）、版本/源码 revision、case 时间与结果、pane 捕获路径、父/子 sessionFile、原生 runId/attemptId/flowId/goalId/taskId、status/receipt 与工具 surface 断言、任务状态前后、节点验证命令真实输出和退出码、审计结构化裁决、清理结果。文件中只能保存本次拥有的证据，不扫描其他 user sessions。失败保留取证文件，不删除真实目标或全局配置；不上传日志/思考签名/密钥。

开始/结束比对真实 repo 的 git 状态、用户安装/settings/trust 的非敏感文件哈希；只允许实施本身的既定变更，E2E 不产生额外生产文件或全局配置差异。证据目录留 `/tmp` 并在最终报告给绝对路径；停止只杀本次 tmux 名称和已归属测试子运行，绝不 kill-server。旧正常 host 会话保持存活。

## 当前计划状态

本文件仅定义未来步骤。当前已验证的是计划格式/CLI 校验及 tmux host 可连接，不是 E0–E8 已通过。实现完成但任意必做 live case 尚未执行/被 BLOCKED 时，不能勾选对应 E2E 任务或宣称变更验收完成。

## 实际验证记录（实现期）

本节记录**实际执行过**的 live 验证，区别于上文定义的未来步骤。执行方式依据用户 2026-10-06 的明确要求：
**不使用 runner 长链路，改为手工 tmux 驱动真实 pi 并逐步观测 pane**（原话：「你不要使用什么 run-live.mjs 来 e2e 测试了，
直接自己使用 tmux 启动 pi 来进行测试，然后你自己观测 tmux pane 进行测试推进」）。因此下表的证据来自手工驱动，
`run-live.mjs` 属次要路径（其隔离映射缺陷已修，见 design 处置表）。

### 通过情况（真实 pi 1.0.3 + 真实模型，隔离 agentHome/goalRoot/session/native，未触碰用户全局配置）

| 场景                       | 关键证据                                                                                                                                                                                                                                   | 结论                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| E1 主会话隔离              | 191 条 `pi-openspec-x-e2e/surface:v1`，跨 11 次 session*start / 170 次 turn_end；三个 report*\* 在 `activeTools`/`registered`/`promptMentions` 三处零出现；两个父侧计划工具始终在册                                                        | 通过                 |
| E2 按角色隔离              | 15 个子会话：13 个各自只调用自己的一个 report\_\*，零跨工具；非对应角色 oracle 全程零 report 调用                                                                                                                                          | 通过                 |
| E3 前台/后台 worker 端到端 | `DISPATCH → RUN running → RUN complete → RECEIPT(task, verificationPassed=true) → TICK`；子会话 `report_work isError=false`                                                                                                                | 通过                 |
| E4 门阻塞                  | 无有效回执的 complete 申请被勾选门真实拦截（`has no verified worker report yet`），tick 保持 0                                                                                                                                             | 通过                 |
| E6 冷重启恢复              | 2026-10-12 `/tmp/e2e-e6/sessions/2026-10-12T17-14-25-756Z_01a1311b-c45a-7594-8afd-a556384943d2.jsonl`：旧回执 1.1 留在重启前；PID `1148745→1151428`；重启后首次 complete 请求与 tick 均为 1.1，期间无新的 1.1 派发（1.2 派发在 tick 之后） | 通过；旧回执直接放行 |
| E7 direct 模式             | `/opsx:implement --direct` 无模式对话框、`child-report-dispatch/run/receipt` 均为 0、ticks=2、源码真实落盘                                                                                                                                 | 通过                 |
| E8 最终独立审计            | 目标经只读 opsx-reviewer 审计批准后归档为 `status: complete`，两任务各带真实验证命令的 evidence                                                                                                                                            | 通过                 |

**最完整的一次证据**（`/tmp/e2e-e4`，当前工作区代码）：

```
DISPATCH 1.2 @18:08:04 → RUN e9f2d249 running → RUN e9f2d249 complete
                       → RECEIPT task=1.2 vp=true → TICK 1.2
                       → RECEIPT task=1.1 → TICK 1.1
归档目标 muwz63b8-uxkc42: status=complete, 1.1 @18:08:04.663Z, 1.2 @18:08:26.265Z
```

goal-x **只在完成审计 APPROVE 后才归档**，故这一次运行同时覆盖 D2/D3/D7/D8 与 D1。

### 实现期仅由 live 暴露的两处真实缺陷（确定性套件 512 项全绿时不可见）

1. **marker 提取过严致死锁**：`WORKER_DISPATCH_MARKER_RE` 原要求 marker 独占一行，而真实模型写出
   `Task: [OPSX WORKER DISPATCH task=1.1]`，导致 0 匹配 → 子工具包装抛错 → worker 上报永远失败 → 回执永远产不出 →
   任务永久死锁（子会话实测 `report_work(err=true)` 两次）。已放宽为「唯一即可」并修订 D3。
2. **派发 agent 记录顺序**：`dispatchAgents.set` 原写在协议检查之后，检查抛错即永远记不上，
   表现为「分支有 dispatch 条目但 0 条 run 条目」。已移到 `tool_call` 处理器最前。

两处均已配**有鉴别力**的确定性测试（各自实测：回退修复即失败）。

### 诚实边界

- 上文证据位于 `/tmp`（`/tmp/e2e-m`、`/tmp/e2e-v2`、`/tmp/e2e-e4`、`/tmp/opsx-report-e2e-*`），
  属临时目录、不随仓库保留；本节记录的是其结论与关键片段，原始文件不进入仓库。
- **E5（批量与 goal 原生逻辑拒绝）在最近一批修复之后未重跑 live**；其覆盖目前依赖确定性测试。
- **F15–F17 所指的 runner 留存证据缺口未补齐**：本节是手工驱动证据，不替代对 `run-live.mjs` 留存证据的批评。
- 由于 `--no-extensions` 下加载的是工作区源码而非 npm 打包产物，**live 通过不等于已安装包可用**；
  打包形态仍需 `npm pack` 后在临时项目安装验证。

## 实际验证记录（2026-10-10 / 10-11，手工 tmux 驱动真实 Pi）

按用户 2026-10-10 的指令，本层改为**手工 tmux 驱动真实 Pi**并逐步观测 pane；断言一律回到会话
JSONL 与目标文件，不依赖 pane 正则、也不依赖模型自愿配合。以下每条都给出可复核的绝对路径。

### 环境与命令

- 隔离根：`/tmp/e2e-man`（agent 模式全链路）与 `/tmp/e2e-e7`（direct / ordinary）。
  每个根含 `proj/`、`agent/`、`sessions/`、`goals/`、`evidence/`；`proj` 由已批准 fixture 复制而来，
  `git init` 后**不预暂存**（`git status --porcelain=v1` 仅 `?? .gitignore` / `?? openspec/` / `?? src/`）。
- 启动（`/tmp/e2e-man/launch.sh` 先 export `PI_CODING_AGENT_DIR`、`PI_SUBAGENTS_TEMP_ROOT`、
  `PI_GOAL_ROOT`、`TMUX_TMPDIR=/tmp`，再 `cd proj` 并 `exec` 绝对路径 `pi`）：

  ```
  TMUX_TMPDIR=/tmp tmux new-session -d -s man -x 140 -y 45 \
    "/tmp/e2e-man/launch.sh --no-extensions --no-skills --no-prompt-templates --no-themes \
     --no-context-files --session-dir /tmp/e2e-man/sessions \
     -e <repo>/packages/pi-sandbox/index.ts -e <repo>/packages/pi-subagents/index.ts \
     -e <repo>/packages/pi-goal-x/extensions/goal.ts -e <repo>/packages/pi-openspec-x/index.ts \
     -e <repo>/packages/pi-openspec-x/test/e2e/probe.ts"
  ```

- 观测/取证命令：`TMUX_TMPDIR=/tmp tmux capture-pane -p -t man -S -40`；条目统计用 python 读
  `/tmp/e2e-man/sessions/<时间戳>_<uuid>.jsonl` 的 `customType`；目标状态读
  `/tmp/e2e-man/goals/active_goal_*.md`（花括号配平截取首个 JSON 对象后再解析）。

### 逐项结果

| 场景 | 证据（绝对路径 / 条目）                                                                                                                                                                                                                                                                                                                                                        | 结论                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0   | `/tmp/e2e-man/launch.sh`；pane `[Extensions] goal.ts, pi-openspec-x, pi-sandbox, pi-subagents, probe.ts`                                                                                                                                                                                                                                                                       | 五扩展全部加载 ✓                                                                                                                                                                                                                          |
| E1   | 同上会话；`probe.ts` 的 `pi-openspec-x-e2e/surface:v1` 条目中 `activeTools` 含 `opsx_plan_gap_analysis`/`opsx_plan_verdict`，**不含**三个 `report_*`                                                                                                                                                                                                                           | 主会话无三工具 ✓                                                                                                                                                                                                                          |
| E2   | `/tmp/e2e-man/proj/openspec/changes/…`；`/opsx:plan` 进入后 pane 出现 `◆ opsx plan mode entered`，模型派发 `opsx-gap-analysis` 并回显 `Gap analysis submitted (intent: build-from-scratch, confidence 0.7, 32 findings)`；随后出现阻塞对话框 `Approve the plan`，**手动按 Enter**；`openspec/changes/e2e-report-isolation/.opsx-plan-review.jsonl` 中 `plan_approval` 计数 = 1 | 计划流程 + 真实批准 + 子报告接收 ✓                                                                                                                                                                                                        |
| E3   | 同会话 JSONL：`child-report-dispatch:v1` 12、`child-report-run:v1` 15、`child-report-receipt:v1` 12、`task-ticked` 10（1.1–3.3）；**每个 tick 的 taskId 都有 `verificationPassed=true` 的回执**；主会话 assistant 消息中**零** `report_*` 调用                                                                                                                                 | 派发→回执→勾选闭环且隔离成立 ✓                                                                                                                                                                                                            |
| E4   | 同一会话：对 5.1 提交 `update_goal_task{task_id:'5.1',status:'complete',evidence:'manual no-report probe'}`（不派发）→ 返回 `Task 5.1 has no observed opsx-worker dispatch. …`；4.1 的回执 `verificationPassed=false` 且始终未产生 tick                                                                                                                                        | 缺报告被真实拒绝、失败报告不放行 ✓                                                                                                                                                                                                        |
| E5   | 同一会话：批量 `updates=[{4.1},{5.2}]` → 被拒且两任务**均保持 pending**（完成数不变）；批量 `updates=[{4.2},{4.3}]`（两份回执均 `verificationPassed=true`）→ `4.2 complete; 4.3 complete. 12/20 tasks complete.`；另复现 goal-x 原生拒绝 `Task "4.2" is already complete and cannot be reopened.`                                                                              | 一失败整批不变、全有效原子成功 ✓                                                                                                                                                                                                          |
| E6   | pane PID `147721 → 152300`（`tmux list-panes -t man -F '#{pane_pid}'`）；以 `--session /tmp/e2e-man/sessions/2026-10-10T13-35-00-839Z_01a12606-….jsonl` 冷重启后，对已有已验证回执的 4.7 提交 complete 且**不派发新 worker** → `4.7 complete. 17/20 tasks complete.`                                                                                                           | PID 改变 ✓；但该次 tick 依据的是**重新派发后的新回执**（JSONL 时间线：15:26:05 旧回执 → 15:26:18 重启 → 15:27:32 重新派发 4.7 → 15:27:54 新回执 → 15:28:05 tick），故「恢复的旧回执在不重新派发时被门使用」**未被验证 ✗**（审计 F11/F13） |
| E7   | `/tmp/e2e-e7`：`/opsx:implement --direct e2e-report-isolation` 后 `task-ticked` 20 而 `child-report-receipt:v1` **0**，其目标随后归档；另建普通目标 `mv2kxcg4-4j4lc1`（objective `ordinary goal probe: …`），其 `proj/probe.txt` 已创建、目标 `status: complete` 且任务 `1.1` 完成，而 opsx `task-ticked` **仍为 20**                                                          | direct 无回执要求且保留自身完成事件；ordinary 无 opsx 投影 ✓                                                                                                                                                                              |
| E8   | `/tmp/e2e-man/goals/archived/goal_2026101023400273_mv2hghxr-rmpvw5.md`（`Status: sisyphus complete`、`Time spent: 27m45s`）；`/tmp/e2e-e7/goals/archived/goal_2026101023590019_mv2kdhc6-npds2h.md`                                                                                                                                                                             | goal-x 仅在完成审计 APPROVE 后归档 ⇒ 审计通过 ✓                                                                                                                                                                                           |

### 本轮 live 暴露并修复的真实缺陷

E6 首轮实测暴露：冷重启后 `child-report-run:v1` / `child-report-receipt:v1` 会从分支恢复，但
`DispatchReviewTracker` 的**派发观测是内存态**，`rememberReport` 只会回填已存在的 record，因此
`dispatched(taskId)` 恒为 false，恢复的回执无法被门使用（实测返回 `no observed opsx-worker dispatch`）。
修法：`src/dispatch-gate.ts::rememberReport` 在无 record 可回填时补建一条（已验证报告本身即派发证据）。
回归测试 `test/dispatch-gate.test.ts` → `restored receipts after a cold restart (D5)`，鉴别力已实测
（停用该分支后 `expected false to be true`）。全包 34 文件 577 项通过、`typecheck` 0 error。

### 未覆盖 / 不勾选

- 打包形态未验证：`--no-extensions` 加载的是工作区源码，**live 通过不等于已安装包可用**。
- E5 的「同一任务先成功后 resume 失败不能复用旧成功」未单独构造；已由确定性测试覆盖。
- runner 形态（`run-live.mjs --suite full` / `assert-live --evidence`）已按用户指令废弃，不再作为验收路径。

### 清理与差异核对（2026-10-11）

- 本次自建 pane 已全部结束（`tmux kill-session -t man`、`-t e7`），并清掉历史遗留的 `e2e-3fb4868904c0-E6`；
  `TMUX_TMPDIR=/tmp tmux ls` 现仅剩 `host`（`created Sat Oct 10 19:37:19 2026`），host 其他会话存活 ✓。
- 仓库差异：`git status --porcelain=v1` 共 33 行，受跟踪改动**全部**位于 `packages/pi-openspec-x/**`
  （README、src/{agent-prompts,agents,dispatch-gate,flow-recovery,goal-base,implement-command,index,
  objective,plan-command,progress-observer,report-tools}.ts 等），未跟踪项为变更目录本身；
  无本变更之外的仓库差异。`HEAD` 为 `bf461ad3ec`，未提交、未发布、未升版本。
- 用户全局配置：本会话所有写入均在 `/tmp/e2e-man`、`/tmp/e2e-e7`（pi 进程经 `PI_CODING_AGENT_DIR`
  指向临时 agentHome），未向 `~/.pi/agent` 写入。诚实边界：本轮**未在开始前**对
  `~/.pi/agent/{settings,trust,models}.json` 做哈希快照，故只能给出结束时哈希供后续比对——
  `settings.json` `eb7e9757652fbdda…`、`trust.json` `af23e88aa59ae5d0…`（两者 mtime 均为 2026-10-10，
  早于本次 10-11 的收尾核对）。
- 门禁：`prettier --check .` 全绿；`openspec validate isolate-opsx-child-report-tools --strict`
  输出 `Change 'isolate-opsx-child-report-tools' is valid`；`pnpm --filter @xzzpig/pi-openspec-x test`
  34 文件 577 项通过；`run typecheck` 0 error TS。

## 2026-10-11 手工 live 复跑（当前工作树代码，含审计第 4 轮修复）

环境：`/tmp/e2e-live`（五目录；proj 由已批准 fixture 复制、`git init` 后 `git reset` 未预暂存、`src/*.cjs` 归零、tasks.md 两个未勾选任务；
`agent/models.json` 整份复制、`agent/settings.json` 三键；`PI_CODING_AGENT_DIR`/`PI_SUBAGENTS_TEMP_ROOT`/`PI_GOAL_ROOT` 均指向本次临时根）。
启动：`pi 1.1.0` + 五个 `-e` 入口（pi-sandbox、pi-subagents、pi-goal-x/extensions/goal.ts、pi-openspec-x、test/e2e/probe.ts），
`--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --session-dir /tmp/e2e-live/sessions`；
启动 pane 显示 `[Extensions] goal.ts, pi-openspec-x, pi-sandbox, pi-subagents, probe.ts`、模型 `deepseek-v4-flash • max`。

会话文件：`/tmp/e2e-live/sessions/2026-10-11T12-48-14-511Z_01a12b01-b4ad-72f8-9bea-cb01230c67c7.jsonl`

| 场景                | 驱动                                                                            | 机器判据（会话 JSONL）                                                                                                                                                                                            | 结论                |
| ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| E4-A 无派发直接完成 | agent 模式下窄指令直接 `update_goal_task(task_id 1.1, complete)`，不派发 worker | `task-ticked=0`、`child-report-run:v1=0`、`child-report-receipt:v1=0`，工具调用被门拦截并给出 `Task 1.1 has no observed opsx-worker dispatch. Agent mode implements every task through a dispatch: dispatch o…`   | ✅ 门 fail-closed   |
| E3 派发→回执→勾选   | steer 要求以 `[OPSX WORKER DISPATCH task=1.1]` 派发 `opsx-worker`               | 原生后台运行 `/tmp/e2e-live/native/async-subagent-runs/4b24435c-…`；会话出现 `child-report-run:v1`（source=background）→ 完成后 `child-report-receipt:v1`（task 1.1）→ **`pi-openspec-x/task-ticked` taskId=1.1** | ✅ 自动接收链路成立 |
| E3 续               | 窄指令要求勾选已有回执的 task 1.2                                               | `child-report-receipt:v1` 2 条（1.1、1.2）、**`task-ticked` = 2（1.1、1.2）**                                                                                                                                     | ✅                  |
| D1 子角色工具面     | 直接扫描子会话                                                                  | 子会话 `…/f9b43407-…/run-0/session.jsonl` 的工具调用集合为 `read,bash,edit,report_work` —— 只含自己那一个上报工具                                                                                                 | ✅ 隔离成立         |

| E8 最终独立审计 | 两任务勾选后模型请求完成 | 目标归档为 `/tmp/e2e-live/goals/archived/goal_2026101121320084_mv3to3be-pm87lo.md`：`status=complete`、两任务 complete、`Status: sisyphus complete`、`Time spent: 37m36s`、`Tokens used: 99K (98,704)`；会话出现 `mode-exited` | ✅ 审计 APPROVE |

### 子角色工具面（同一次运行 + 续跑会话，逐子会话扫描）

| 子会话（相对 `/tmp/e2e-live*/sessions/`）                                                                  | 实际工具调用集合                                                                                   | 判据                                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------ | ------------------------------- |
| `…/80e13e40-…/run-0/session.jsonl`（完成审计）                                                             | `report_auditor_progress, bash, structured_output`                                                 | 无三个 report\_\*，保留 `report_auditor_progress` ✅ |
| `…/99d3c10e-…/run-0/session.jsonl`（opsx-worker）                                                          | `read, edit, bash, report_work`                                                                    | 只含自己的上报工具 ✅                                |
| `…/f9b43407-…/run-0/session.jsonl`（opsx-worker）                                                          | `read, bash, edit, report_work`                                                                    | 只含自己的上报工具 ✅                                |
| `/tmp/e2e-live2/sessions/subagent-artifacts/a9d2bcdf-…_oracle_transcript.jsonl`（内建 oracle，非对应角色） | `bash`（`report\_(gap_analysis                                                                     | plan_review                                          | work)` 出现 0 次） | 非对应角色拿不到任何上报工具 ✅ |
| 主会话（`/tmp/e2e-live/sessions/2026-10-11T12-48-14-511Z_….jsonl`）                                        | `pi-openspec-x-e2e/surface:v1` 30 条，`registered`/`active`/`promptMentions` 三数组均无 report\_\* | 主会话隔离 ✅                                        |

### E6 冷重启（2026-10-11，`/tmp/e2e-live5`，修复后的当前代码）

| 判据                           | 实测                                                                                                                                       | 结果                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 进程确实更换                   | pane 的 pi PID `774279` → `780120`                                                                                                         | ✅                     |
| 未自动重入流程                 | 重启后沙箱 `2 write paths`；首次 tool_call 后才变 `agent · implementing`，并写 `recovery-notice`                                           | ✅ 惰性重绑            |
| 回执跨重启保留                 | 重启前 `child-report-receipt:v1`(1.1)；重启后仍为 1 条                                                                                     | ✅                     |
| **重启不再误撤销已挣得回执**   | 重启前（修复前行为，`/tmp/e2e-live4`）重启后 30 秒内出现 `child-report-revoke:v1`(1.1)；本轮（修复后）重启后 `child-report-revoke:v1` 为 0 | ✅ 修复在真机成立      |
| 重启后由恢复的回执直接放行勾选 | 会话模型在饱和上下文（CH≈99.7%）中始终未发出 `update_goal_task` 调用（`task-ticked` 仍为 0）                                               | ✗ 模型侧未驱动，未验证 |

### E4/E5 相位（2026-10-11，`/tmp/e2e-live6`，5 个任务含 1 个内在不可验证任务）

fixture 的 task 3 的验证命令写死为 `node -e "process.exit(1)"`（任何诚实 worker 都无法通过），用于稳定诱发「失败验证不放行」。

| 判据                         | 实测                                                                                                           | 结果                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 不可验证任务始终未被勾选     | task 3：`child-report-dispatch:v1`=2、`child-report-run:v1`=4、`child-report-receipt:v1`=2，而 `task-ticked`=0 | ✅ 失败验证不放行（无 tick）  |
| 模型反复重试同一不可验证任务 | 模型连续两次派发 task 3 的 worker 并重跑其验证，均无法通过                                                     | 记录                          |
| 勾选门显式拦截文案           | 该相位模型始终未发出 `update_goal_task`（上下文 CH≈99.8% 后冻结），未取到 `gate-blocks` 增量                   | ✗ 待补（E4-B 的显式拒绝文案） |

### E5 批量与 D3 失效语义（2026-10-11，`/tmp/e2e-live9`，修复后的当前代码）

| 判据                             | 实测                                                                                                               | 结果              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 两个可验证任务各得一份已验证回执 | task 4、5：`child-report-run:v1`=4（complete/foreground）、`child-report-receipt:v1`=2（vp=true）、`task-ticked`=0 | ✅                |
| 干净相位无任何误撤销             | 该相位 `child-report-revoke:v1` = **0**（修复前同一形态出现 2 次撤销）                                             | ✅ 修复在真机成立 |
| 新派发按 D3 作废旧回执           | 模型随后 4 次重新派发同一批任务 → `child-report-revoke:v1` 相应为 4（每次重派发 1 次撤销，1:1）                    | ✅ 失效语义正确   |
| 批量（`updates[]`）原子成功      | 模型未按指示发出批量调用（在 CH≈99.9% 处转为反复重派发），未取到批量结果                                           | ✗ 待补            |

诚实边界：本节只记录上述五项；E4-B/C（失败验证不放行、新 attempt 才放行）、E5 批量原子性、E6 冷重启、E7 ordinary/direct、
E8 最终审计 APPROVE 以及 oracle/reviewer 非对应角色面仍须在本环境继续逐项驱动后才可引用。

## 下一轮 live 配方（覆盖 F11 / F12 剩余项）

审计指出的剩余缺口全部在真实运行层：**后台（async）子运行**、**非对应角色**与 **reviewer 面**。本节把它们写成可直接执行的步骤，断言一律用**单次快查**（不做轮询等待）。

### 0. 环境（沿用既有纪律）

1. `BASE=/tmp/e2e-<case>`，建 `proj`、`agent`、`sessions`、`goals`、`evidence` 五个目录。
2. `proj` 从已批准的计划产物复制；`git init` 之后**绝不 `git add -A`**（预暂存会让完成审计在 Workspace inspection 看到 `AM` 状态并反复驳回 provenance）。
3. `agent/models.json` **整份复制**用户文件（按 provider 摘取会写出空对象并静默变成「模型未解析」）；`settings.json` 只写 `defaultProvider`/`defaultModel`/`defaultThinkingLevel`。
4. `launch.sh` 依次 export `PI_CODING_AGENT_DIR`、`PI_SUBAGENTS_TEMP_ROOT`、`PI_GOAL_ROOT`、`TMUX_TMPDIR=/tmp`，`cd` 到 `proj` 后 `exec` 绝对路径 `pi` 加参数；`-e` 五个入口为 `pi-sandbox/index.ts`、`pi-subagents/index.ts`、`pi-goal-x/extensions/goal.ts`、`pi-openspec-x/index.ts`、`test/e2e/probe.ts`。
5. 若计划缓存缺失（host 重启会清空 `/tmp`），先在 tmux 里手工走一次计划流程并在批准对话框按 Enter；否则 agent 模式会以 `The plan … is not approved yet` 拒绝进入。

### 1. 后台（async）子运行 —— 对应审计 F15 的「只有前台」缺口

1. 进入 agent 模式并建目标、接受 `set_goal_tasks` 对话框。
2. 发一条**明确要求异步**的派发提示：

   ```
   Dispatch one opsx-worker for task 1.1 with async: true. The Task section must be
   exactly the line [OPSX WORKER DISPATCH task=1.1] on its own line. Do not wait for
   it; stop after dispatching.
   ```

3. 单次快查（约 60–90 秒后执行一次，不要轮询）：

   ```bash
   ls -t "$BASE/sessions"/*.jsonl | head -1 | xargs -I{} node -e '
     const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");
     const c={};for(const l of lines){try{const e=JSON.parse(l);if(e.customType)c[e.customType]=(c[e.customType]||0)+1}catch{}}
     console.log(c)' {}
   ls -d "$BASE/native"/async-subagent-runs/* 2>/dev/null | wc -l
   ```

   期望：`pi-openspec-x/child-report-dispatch:v1` 与 `pi-openspec-x/child-report-run:v1` 出现，且 `source` 为 `background`；原生 `async-subagent-runs` 目录数大于 0。

4. 完成通知到达后再做**一次**同样的快查，期望出现 `pi-openspec-x/child-report-receipt:v1`（这是「后台链路自动接收」的正向证据）。

### 2. 非对应角色与 reviewer 面 —— 对应审计 F12

1. 发一条要求同时派发**非对应角色**与 **reviewer** 的提示：

   ```
   Dispatch two subagents: one with agent oracle and one with agent opsx-reviewer,
   each with a short read-only task. Do not dispatch opsx-worker.
   ```

2. 单次快查：列出每个子运行目录下的 `run-0/session.jsonl`，逐个统计其中的工具调用名：

   ```bash
   find "$BASE/sessions" -name session.jsonl -path '*run-*' -print0 | xargs -0 -I{} node -e '
     const fs=require("fs");const p=process.argv[1];
     const names=new Set();for(const l of fs.readFileSync(p,"utf8").trim().split("\n")){
       try{const e=JSON.parse(l);const m=e.message;if(!m)continue;
         for(const part of (m.content||[])) if(part&&part.type==="toolCall") names.add(part.name);
       }catch{}}
     console.log(p, [...names].join(","))' {}
   ```

   期望：**任何**子会话都不出现 `report_gap_analysis` / `report_plan_review` / `report_work`；`opsx-reviewer` 的子会话仍带 `report_auditor_progress`（goal-x 自带，不在本变更摄取面）。

### 3. 记录与清理

1. 每个 case 的证据目录留在 `/tmp`，最终报告给出**绝对路径**。
2. 只杀本次 tmux 会话名（`tmux kill-session -t <name> || true`），**绝不 `kill-server`**；host 上的其他会话必须存活。
3. 结束前后各记录一次真实仓库 `git status --porcelain=v1` 与用户 `settings.json`/`trust.json`/`models.json` 的哈希，确认 E2E 没有额外差异。

### 非对应角色面 —— 2026-10-11 手工 live（补 F12）

环境：`/tmp/e2e-or`（tmux `or1`），同一套五个 `-e` 入口与隔离变量；**普通会话**（无需 agent 模式）中用一条**极窄指令**驱动：

```
Call the subagent tool right now with exactly these arguments and nothing else:
{"agent":"oracle","task":"list the files under src/"}
```

证据（来自原生运行产物，非模型自述）：

| 证据面       | 内容                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| 原生运行目录 | `/tmp/e2e-or/native/async-subagent-runs/a6f97fd7-6f57-4f55-9a43-64c62552679d/`      |
| 角色         | `subagent-artifacts/a6f97fd7-…_oracle_meta.json` → `agent: "oracle"`，`exitCode: 0` |
| 真实工具调用 | `subagent-artifacts/a6f97fd7-…_oracle_transcript.jsonl` → **仅 `bash`**             |
| 上报工具     | 该 transcript 中 `report_*` 出现次数 = **0（NONE）**                                |

结论：**非对应角色（`oracle`）在真实运行上完全没有拿到三个上报工具中的任何一个**——与 D1「只有对应子角色各自加载自己的上报工具」一致。这是审计 F12 所指「未证明完整非对应角色面」的第一条直接证据。

取证说明：`oracle` 的规范会话以 **fork** 形态落在主会话目录下（`…/forks/<id>.jsonl`），本轮的断言实际取自 `subagent-artifacts` 的 transcript 与 meta（后者带 `agent` 字段，可用于把文件绑定到原生角色），因为只扫描 `run-*/session.jsonl` 会漏掉 fork 形态。`opsx-reviewer` 面仍未驱动。

### reviewer 面 —— 2026-10-11 手工 live（补 F12）

环境：`/tmp/e2e-rv`（tmux `rv1`），同一套入口与隔离变量；同样用极窄指令：

```text
Call the subagent tool right now with exactly these arguments and nothing else:
{"agent":"opsx-reviewer","task":"list the files under src/"}
```

| 证据面       | 内容                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| 角色         | `subagent-artifacts/f850a7b2-…_opsx-reviewer_meta.json` → `agent: "opsx-reviewer"`，`exitCode: 0` |
| 真实工具调用 | 同前缀 `_transcript.jsonl` → `report_auditor_progress, bash, read`                                |
| 三个上报工具 | `report_gap_analysis` / `report_plan_review` / `report_work` 出现次数 = **0（NONE）**             |

结论：**`opsx-reviewer` 在真实运行上不持有本变更隔离的三个上报工具，同时保留 goal-x 自带的 `report_auditor_progress`**——与 D1「reviewer 只保留 goal-x 进度工具、不获得三工具」一致，也划清了本变更与 goal-x 审计子代理的责任边界。

### 隔离矩阵小结（真实运行，2026-10-11）

| 角色               | 真实工具调用                                                 | 三工具           | 判定 |
| ------------------ | ------------------------------------------------------------ | ---------------- | ---- |
| `opsx-worker` ×3   | `read,bash[,edit],report_work`                               | 仅 `report_work` | ✓    |
| 写角色（非对应）   | `read,bash,edit`                                             | NONE             | ✓    |
| `oracle`（非对应） | `bash`                                                       | NONE             | ✓    |
| `opsx-reviewer`    | `report_auditor_progress,bash,read`                          | NONE             | ✓    |
| 主会话             | 全量（含 `implement-start`/`flow-binding`/`child-report-*`） | NONE             | ✓    |

**仍未闭环**：`opsx-gap-analysis` 与 `opsx-plan-review` 的 live 面（E2 曾在早期轮次取得，本轮未重跑）。

### 隔离矩阵（真实运行，2026-10-11，完整六面）

每个角色都用**极窄单工具调用**指令在**普通会话**中单独驱动（无需 agent 模式），断言取自 `subagent-artifacts/*_transcript.jsonl`（工具调用）与 `*_meta.json`（`agent` 字段把文件绑定到原生角色）：

| 角色                 | 原生证据 | 真实工具调用                        | 三个上报工具               |
| -------------------- | -------- | ----------------------------------- | -------------------------- |
| `opsx-worker` ×3     | bg2 / ro | `read,bash[,edit],report_work`      | 仅 `report_work` ✓         |
| 写角色（非对应）     | ro       | `read,bash,edit`                    | NONE ✓                     |
| `oracle`（非对应）   | or       | `bash`                              | NONE ✓                     |
| `opsx-reviewer`      | rv       | `report_auditor_progress,bash,read` | NONE ✓                     |
| `opsx-gap-analysis`  | ga       | `bash,ls,report_gap_analysis`       | 仅 `report_gap_analysis` ✓ |
| `opsx-plan-review`   | pr       | `ls,find,read,report_plan_review`   | 仅 `report_plan_review` ✓  |
| 主会话（agent 模式） | bg2      | 全量工具                            | NONE ✓                     |

结论：**每个对应角色只持有自己的那一个上报工具；非对应角色与 reviewer 一个都没有；主会话没有任何一个**——D1 的角色隔离在真实运行上对六个面全部成立，且 `opsx-reviewer` 仍保留 goal-x 自带的 `report_auditor_progress`。

证据目录：`/tmp/e2e-bg2`、`/tmp/e2e-ro`、`/tmp/e2e-or`、`/tmp/e2e-rv`、`/tmp/e2e-ga`、`/tmp/e2e-pr`（均保留，含各自 `sessions/subagent-artifacts`）。tmux 会话均已按纪律 `kill-session`（仅 host 存活）。

### 真实 executor「一成功一失败兄弟」—— 未能取得（2026-10-11）

审计 F11 要求用**真实 subagent executor** 复现「一个兄弟成功、另一个失败时，成功兄弟的证据不可达」，而不是只调用 `finalizeToolResult` 并传入伪造的 `Details`。

本轮用极窄指令驱动**真实双子工作流**，两次都被模型拒绝执行：

1. `{"tasks":[{"agent":"oracle",…},{"agent":"oracle",…,"timeoutMs":1}]}` → 模型只回复「1 ms 会立刻失败第二个子项」，未调用工具。
2. `{"tasks":[{"agent":"oracle",…},{"agent":"claude-code",…}]}` → 模型把调用改写成代码片段并请求许可（"Say the word and I'll run that instead"），同样未调用工具。

结论：**该场景无法通过手工 tmux 驱动取得**——模型会主动避免派发注定失败的兄弟。真实 sibling 证据只能靠不经模型的 SDK 会话（`createAgentSession` + 真实子运行，需要凭据与网络）产生，属确定性套件之外的一层；当前覆盖仍由直接调用 `finalizeToolResult`（传入与真实 `Details` 同形的载荷）承担，其强度低于真实 executor。

## E4/E5 复跑（2026-10-11，最新代码，手工 tmux）

环境 `/tmp/e2e-f8`：五扩展全部加载（`goal.ts, pi-openspec-x, pi-sandbox, pi-subagents, probe.ts`）、
模型 `deepseek-v4-flash • max`、沙箱 `10 domains, 5 write paths (opsx-agent)`、
fixture 为 2 个未勾选任务（1.1 → `src/value.cjs` 0→1、1.2 → `src/second.cjs` 0→2）、
`git init` 后未预暂存（`git status --porcelain=v1` 仅 `?? openspec/` 与 `?? src/`）、
计划批准台账随 fixture 携带（`.opsx-plan-review.jsonl` 的 `plan_approval` 为 1）。

**E4 相位 A — 无派发的完成申请被门拒绝 ✓**
会话 `/tmp/e2e-f8/sessions/2026-10-11T06-53-41-672Z_01a129bd-1ba6-77a8-be27-848cce529892.jsonl`
（goal `mv3gy0gk-zmahmh`）。模型真实调用 `update_goal_task`，参数为
`{"task_id":"1.1","status":"complete"}`（**没有任何 opsx-worker 派发**），
工具结果原文为：

> `Task 1.1 has no observed opsx-worker dispatch. Agent mode implements every task through a dispatch: dispatch opsx-worker for it, review the diff, then tick.`

即门在 `tool_call` 阶段拦下该请求、任务保持未完成、无 `task-ticked` 条目 ——
「缺报告的完成申请被真实拦截」这一子场景在最新代码上取得可复核证据 ✓。

后续相位（真实验证失败报告、新 resume 失败不复用旧成功、全有效批量原子成功、
缺 evidence 与父子任务约束的原生拒绝）在同一环境继续驱动，结果追加于本节。

**E4 相位 B — 真实验证失败的完成申请被门拒绝 ✓**

环境 `/tmp/e2e-f9`（同一五扩展与隔离形态；fixture 为 4 个任务，其中任务 1.3 的 verification
自相矛盾：任务文本要求 `src/third.cjs` 导出 3，而验证命令断言 `===99`，故任何诚实实现都无法通过）。
会话 `/tmp/e2e-f9/sessions/*.jsonl`（goal `mv3h96mv-wuexia`）。证据链：

1. worker 派发并完成 → `child-report-dispatch:v1` 1 条、`child-report-run:v1` 1 条；
2. `child-report-receipt:v1` 1 条且 `taskId=1.3`、`verificationPassed=false` —— 子代理**如实上报验证失败**；
3. 模型真实调用 `update_goal_task`，参数为 `{"task_id":"1.3","status":"complete","evidence":"src/third.cjs changed 0 -> 3; verification ..."}`；
4. 该调用返回原文：`The task's verification failed: exit=1 (FAILED). File content confirmed as module.exports = 3. Command asserts ===99, which does not match the required value 3, so it exits 1.. Fix and re-verify before ticking.`；
5. `pi-openspec-x/task-ticked` 条目为 **0** —— 任务 1.3 保持未完成 ✓。

即「真实验证失败的完成申请不被放行」这一子场景在最新代码上取得可复核证据 ✓。

边界（诚实）：该轮模型在识别出任务自相矛盾后自行暂停了目标，故同一环境的后续子场景
（新 resume 失败不复用旧成功、全有效批量原子成功、缺 evidence 与父子约束的原生拒绝）
需先 `/goal-resume` 或另建环境继续驱动，本节将在完成时补充。

**E4/E5 相位 B2 — 失败后新 attempt 与旧成功的关系（/tmp/e2e-f10，未捕获严格形态，无缺陷）**

会话 `/tmp/e2e-f10/sessions/*.jsonl`（goal `mv3hon3a-dixdud`，3 个任务）。驱动序列与结果：

| 事件                             | 证据                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| 派发 1.1 第一次（导出 0→1）      | `child-report-dispatch:v1` seq=1、run `f9609c34…#0:complete`                  |
| 其回执                           | `taskId=1.1 vp=true attemptId=762312ed`                                       |
| 派发 1.1 第二次（改为导出 9）    | dispatch seq=2、run `e7fc1695…#0:complete`                                    |
| 其回执                           | `taskId=1.1 vp=false attemptId=eb9b2a53`（**新 nonce**，与首次不同）          |
| 模型自行第三次派发（导出恢复 1） | dispatch seq=3、run `35e85f36…#0:complete`、回执 `vp=true attemptId=a26c1ec3` |
| 勾选                             | `1.1 complete. 1/3 tasks complete.`；`task-ticked` 含 1.1                     |
| 工作区                           | `src/value.cjs` 为 `module.exports = 1`                                       |

结论（诚实）：该轮**未**捕获「失败的新 attempt 之后立即勾选被拒绝」的严格形态——模型在第二次
worker 返回失败后**未经提示即自行发起第三次派发**并成功，勾选依据的是第三次的成功报告，
因此**未发现缺陷**。严格形态（失败后直接勾选必须被拦）的等价证据由 `E4 相位 B`（任务 1.3
自相矛盾 → `vp=false` → 勾选返回 `The task's verification failed … Fix and re-verify before ticking.`
且 `task-ticked` 为 0）提供；此外「新 attempt 不复用旧 nonce」已由本表两条回执的
`attemptId` 不同（`762312ed` vs `eb9b2a53`）直接证明。

**E5 混合批量整批拒绝（含正对照）— /tmp/e2e-f11**

环境 `/tmp/e2e-f11`（同一五扩展与隔离形态；fixture 三个任务：1.1 可验证、1.2 验证自相矛盾
（断言 `===99`）、1.3 可验证）。会话 `/tmp/e2e-f11/sessions/*.jsonl`，goal `mv3i2cow-3g3914`。

前置：两个 worker 各派发一次并完成 → `child-report-receipt:v1` 为
`1.1 vp=true attemptId=265e379e` 与 `1.2 vp=false attemptId=1f6e1d53`，`task-ticked` 为空。

| 步骤                                             | 真实调用                                                                                            | 真实返回                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 批量勾选 1.1+1.2（单次 `updates` 两项 complete） | `{"updates":[{"task_id":"1.1","status":"complete",...},{"task_id":"1.2","status":"complete",...}]}` | `The task's verification failed: stdout: EXIT_CODE=1 (no stderr). Exit code 1 because export is 2, not 99. … Fix and re-verify before ticking.` |
| 批量后状态                                       | —                                                                                                   | `task-ticked` 仍为空：**有效的 1.1 也未被勾选**（整批原子性）✓                                                                                  |
| 正对照：单独勾选 1.1                             | `{"task_id":"1.1","status":"complete",...}`                                                         | `1.1 complete. 1/3 tasks complete.` ✓                                                                                                           |

正对照是关键：它证明上一步的整批拒绝确实由 1.2 的失败验证引起，而非门控整体失效或与任务无关的
守卫误拦。这正面回应了审计 F16 对早期 E5 证据的批评——早期证据把「已完成的任务」与「失败任务」
配对，本次配对的是两个**都保持 pending** 的任务，且补上了正对照。

**E4/E5 新 attempt 失败不复用旧成功（严格形态）— /tmp/e2e-f11**

同环境、同会话内单条指令闭环（不给模型自行补派的窗口）：

1. 派发 1.3 第一次（导出 0→3）→ 回执 `1.3 vp=true attemptId=acd1d4ea`（**旧成功**，未勾选）；
2. 派发 1.3 第二次（改为导出 7）→ 回执 `1.3 vp=false attemptId=16c7ecdd`（**新 nonce**，失败）；
3. 立即勾选 1.3：调用 `{"task_id":"1.3","status":"complete","evidence":"src/third.cjs exports 7 (second 1.3 dispatch); ran node -e ..."}`；
4. 返回原文：`The task's verification failed: EXIT_CODE=1 (FAILED). No stdout/stderr output. The command checks for ===3, but the dispatch explicitly instructed export = 7, so the assertion fails by design.`；
5. `task-ticked` 仅含 `1.1`：1.3 保持 pending —— **旧的成功回执未被复用** ✓，且本轮模型未自行补派 ✓。

诚实边界：**goal-x 原生逻辑拒绝**（缺 evidence、父子约束）在报告无效时**不可达**——插件门控在
`tool_call` 阶段先行拦截（实测：不带 evidence 勾选 1.2 返回的仍是上述验证失败文案），故 goal-x
自身的拒绝只可能在「报告有效且门控放行」时出现。该矩阵已由确定性用例覆盖
（`test/implement-command-gate-integration.test.ts` 中缺 evidence、任务禁用、混合批量三项，
均以真实 goal-x 工具产出拒绝结果并带正对照），本轮不再另建环境重复。

### 本节来源说明

2026-10-11 本轮编辑 e2e.md 时误用了一次会先截断再读取的写入写法，导致文件此前内容被清空。
本节与「实际验证记录（实现期）」「实际验证记录（2026-10-10 / 10-11，手工 tmux 驱动真实 Pi）」
「下一轮 live 配方」各节均**按本会话记录中的原始写入逐条重放重建**（`write` 全量内容 +
各次 heredoc / python 追加），重建件在落盘前经 `prettier --check` 与
`openspec validate --strict` 通过；损坏时的 33 行残留副本留在 `/tmp/e2e-broken-backup.md`，
重建中间件留在 `/tmp/e2e-recovered.md` 以便核对。上面 E6 行的结论已按审计 F11/F13 的
JSONL 时间线更正。

## 范围与环境位移声明（审计第 5 轮 F15）

- **本次变更的实现范围**：仅 `packages/pi-openspec-x/` 与
  `openspec/changes/isolate-opsx-child-report-tools/`。工作树中其余路径的差异不属于本次实现。
- **实现期 HEAD 位移**：计划批准时的 HEAD 为 `61aa36d81`，实现与审计修复完成后为 `bf461ad3ec`；
  位移全部由本变更的既有提交构成，未重写历史、未提交新内容、未发布、未升版本。
- **peer 版本漂移**：实现期安装的 peer 由 `pi-goal-x 0.9.0 / pi-subagents 0.20.0` 升到
  `0.9.1 / 0.21.0`。本包对三者的声明是 `*`，协议兼容性由运行时校验承担
  （每个子运行 status 的 `lifecycleArtifactVersion` 必须等于受支持版本，否则拒绝该运行）。
- **不属于本 goal 的内容**：其他包、其他 change 目录以及审计 harness 自身的 manifest
  均不在本次实现范围内。

## 当前代码的真实运行冒烟（2026-10-11，print 模式）

审计关切之一是「留存的 live 证据早于最近的修复」。为此在**当前工作树代码**上重跑了一次真实
Pi 运行（print 模式，不需要 TUI，因此不需要人工按键）：

- 环境：`/tmp/e2e-verify`（`agent`/`sessions`/`goals`/`native`/`proj` 五目录，`PI_CODING_AGENT_DIR`
  与 `PI_SUBAGENTS_TEMP_ROOT` 与 `PI_GOAL_ROOT` 全部指向本次临时根；`models.json` 整份复制，
  凭据只走环境变量）。
- 启动：`direnv exec <repo> pi --no-extensions --no-skills --no-prompt-templates --no-themes
--no-context-files --session-dir /tmp/e2e-verify/sessions -e <pi-sandbox/index.ts>
-e <pi-subagents/index.ts> -e <pi-goal-x/extensions/goal.ts> -e <pi-openspec-x/index.ts>
-e <test/e2e/probe.ts> -p "Reply with exactly the word: pong"` → 退出码 0，回复 `pong`。
- 会话：`/tmp/e2e-verify/sessions/2026-10-11T09-39-31-869Z_01a12a54-ef9c-731e-a640-1aeec15a7adb.jsonl`
  含 3 条 `pi-openspec-x-e2e/surface:v1`（`session_start`/`before_agent_start`/`turn_end`）。
- 机器断言：3 个相位里主会话 `activeTools`（共 20 个注册工具）**都不含** `report_gap_analysis`、
  `report_plan_review`、`report_work`，且都**含** `opsx_plan_gap_analysis` 与 `opsx_plan_verdict`
  —— `VIOLATIONS: NONE`。

边界：这是隔离不变量在当前代码上的真实运行证据，**不替代** E4–E8 的完整 live 矩阵，也不覆盖
需要真实 `/opsx:plan` 流程与批准对话框的 F12 复核（那仍需手工 tmux 驱动）。

### 子代理上报链路的当前代码真机证据（2026-10-11，print 模式）

同一次 `/tmp/e2e-verify` 环境里，用极窄单工具指令让主模型派发一个真实 `opsx-worker`
（`{"agent":"opsx-worker","task":"[OPSX WORKER DISPATCH task=1.1] Change src/value.cjs …"}`）：

- 子会话 `<parent>/<childRunId>/run-0/session.jsonl` 含
  `pi-openspec-x/child-report-attempt:v1`：`version=1`、`agent=opsx-worker`、
  `attemptId=6b8c85ed-fd97-462d-ab40-a7e13df38b36`、`taskMarker=1.1`（D3 标记提取成立）。
- 子会话工具调用序列为 `bash → edit → bash → report_work`（只有它自己那一个上报工具，D1 隔离成立），
  四个结果 `isError` 全为 `false`。
- `report_work` 的调用参数与其结果 `details` 逐字一致，且 `details` 为
  `{version:1, attemptId:<与 attempt 相同的 nonce>, agent:"opsx-worker", report:<模型载荷>}`——
  即信封版本为 v1、nonce 与 attempt 绑定、元数据不由模型填写（D1/D2 契约成立）。
- 父会话只有 `subagent` 与 `bash` 调用，`report_*` 为 0 次。
- worker 真实改动了 `src/value.cjs`（`module.exports = 0;` → `module.exports = 1;`），
  并附上真实验证命令 `node -e "process.exit(require('./src/value.cjs')===1?0:1)"` 的结果。

边界：该证据证明**子侧上报契约与角色隔离在当前代码上仍成立**；它不覆盖摄取/门控侧
（那需要真实 `/opsx:plan` 或 `/opsx:implement` 流程与批准对话框），也不替代 E4–E8。

## E6 冷重启后使用恢复的旧回执（2026-10-12，`/tmp/e2e-e6`）

本次结果补上此前缺失的严格判据，并**取代** 2026-10-10/11 的未验证轮次：那些轮次的 tick
发生在重新派发和新回执之后，不能证明旧回执恢复。本次使用同一个 Pi 会话文件冷重启，不手造
binding/run/receipt metadata：

| 证据                 | 实测                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fixture 与冷启动     | `/tmp/e2e-e6/launch.sh`；原会话为 `/tmp/e2e-e6/sessions/2026-10-12T17-14-25-756Z_01a1311b-c45a-7594-8afd-a556384943d2.jsonl`；重启前 Pi PID `1148745`，用 `--session` 指向该精确文件重启后 PID `1151428`。                                                                                                                                           |
| 旧派发与回执         | task 1.1 只有一条派发（17:21:32.954Z），run `6ed989a2-c018-4052-8b7e-37fd0d365c7c` 于 17:21:48.515Z 完成；17:21:48.516Z 已写入同 task 的 `verificationPassed=true` receipt。                                                                                                                                                                         |
| 重启边界             | 同一 JSONL 在 17:24:27.382Z 记录重启后的会话活动；重启后没有第二条 task 1.1 dispatch/run/report。                                                                                                                                                                                                                                                    |
| 旧回执直接用于完成   | 17:27:08.826Z 的真实 `update_goal_task({task_id:'1.1',status:'complete',...})` 后，17:27:08.870Z 写入 `task-ticked` 1.1；它之前没有新的 task 1.1 派发或 receipt。后续 task 1.2 的派发直到 17:27:27.557Z 才发生。                                                                                                                                     |
| 持久化任务状态与验证 | `/tmp/e2e-e6/goals/active_goal_2026101301192472_mv5ioe9l-hx03j4.md` 中 1.1 为 `complete`，completedAt `2026-10-12T17:27:08.865Z`；`/tmp/e2e-e6/proj/openspec/changes/e2e-report-isolation/tasks.md` 为 `[x] 1.1`。重启后重新执行 `node -e "process.exit(require('./src/value.cjs')===1?0:1)"`，退出码 0，结果也作为 update_goal_task evidence 提交。 |
| pane 与清理          | `/tmp/e2e-e6/evidence/pane-after-cold-restart.txt` 保留同会话重开后的 pane 快照；本轮 evidence-only re-open 的 PID 为 `1160381`，随后已停止。`TMUX_TMPDIR=/tmp tmux ls` 仅剩 `host`。                                                                                                                                                                |

结论：PID 确实改变；同一分支中的旧 receipt 在冷重启后被恢复并足以让第一次 task 1.1 完成申请通过，且通过前没有重派发或新报告。这次事件序列满足 E6 的「恢复旧回执直接放行」判据，不再依赖模型口头声称或重启后的新派发。

## 2026-10-12 / 10-13 手工 live：E4 三相与 E5 批量（`/tmp/e2e-coverage`，当前工作树代码）

同一隔离环境（五目录、`git init` 后未预暂存、临时 agentHome、五个显式 `-e` 入口），主会话文件为
`/tmp/e2e-coverage/sessions/2026-10-12T19-18-15-071Z_01a1318d-211e-7129-abf2-73a8089a6c37.jsonl`。
fixture 目标为 `mv5my49q-wxmzh5`（6 个任务）。所有判据取自该 JSONL 的真实 `update_goal_task`
调用与结果、`task-ticked` 条目及目标文件，不采信 pane 文本或模型自述。

### E4-A：无派发的完成申请被拦（04:02:07.693Z）

| 项       | 实测                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实调用 | `update_goal_task {task_id:"1.4", status:"complete", evidence:"E4-A no-report probe"}`                                                                         |
| 真实拒绝 | `Task 1.4 has no observed opsx-worker dispatch. Agent mode implements every task through a dispatch: dispatch opsx-worker for it, review the diff, then tick.` |
| 副作用   | task 1.4 保持 pending；该调用之前 1.4 无任何 `child-report-dispatch`/`run`/`receipt`；`task-ticked` 增量 0                                                     |

### E4-B / E4-C：失败验证不放行、失败重试不复用旧成功

| 相位 | 时间          | 任务 | 真实调用                                      | 真实结果                                                                                                   |
| ---- | ------------- | ---- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| E4-B | 19:20:16.612Z | 1.2  | complete + `E4-B failing report probe`        | `The task's verification failed: exit code 1 (nonzero, as expected) … Fix and re-verify before ticking.`   |
| E4-C | 19:38:15.046Z | 1.1  | complete + `E4-C failed reattempt gate probe` | `The task's verification failed: FAILED as expected: EXIT=1 (nonzero) … Fix and re-verify before ticking.` |

E4-C 的关键点：task 1.1 在 19:25:23 已有一份 `verificationPassed=true` 回执（run `4711cecc`），
随后 19:38:08 的新派发产生 `verificationPassed=false`（run `68162667`）。19:38:15 的完成申请被拒，
说明同一任务的失败重试不会被更早的成功回执放行（D3 失效语义在真机成立）。

### E5-A：含失败成员的批量整批拒绝（04:08:20.313Z）

| 项       | 实测                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 真实调用 | `update_goal_task {updates:[{task_id:"1.1",status:"complete",…},{task_id:"1.4",status:"complete",…}]}`                  |
| 真实拒绝 | `The task's verification failed: FAILED as expected: EXIT=1 (nonzero) …`（1.1 的最新回执为 `verificationPassed=false`） |
| 原子性   | 两项**都没有**转换：截至 04:23 之前 `task-ticked` 始终为空，1.1 与 1.4 均为 pending                                     |

### E5-B：全有效批量原子成功（04:23:09.529Z）

前置：同一环境内为 1.1（run `c8cf4f74`，04:16:21，`verificationPassed=true`）与 1.4（run `6dfcdfa9`，
04:16:48，`verificationPassed=true`）各取得一份新的已验证回执。

| 项       | 实测                                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实调用 | `update_goal_task {updates:[{task_id:"1.1",status:"complete",evidence:"E5 stage B verified receipt (run c8cf4f74, verificationPassed=true)"},{task_id:"1.4",status:"complete",evidence:"E5 stage B verified receipt (run 6dfcdfa9, verificationPassed=true)"}]}` |
| 真实结果 | `1.1 complete; 1.4 complete. 2/6 tasks complete.`                                                                                                                                                                                                                |
| 原子性   | 同一批次内恰好写入两条 `task-ticked`：`{taskId:"1.1"}` 与 `{taskId:"1.4"}`（全会话 `task-ticked` 仅此两条）                                                                                                                                                      |
| 持久化   | 目标面板变为 `✓2 done · 4 open`，1.1 与 1.4 标记为 complete                                                                                                                                                                                                      |

### 本轮边界

- 已取得真机证据：E4-A、E4-B、E4-C、E5-A、E5-B（均为真实工具调用 + 真实结果 + 会话条目）。
- E5-B 中途出现过一次「目标已 paused 时提交批量」的协议性拒绝（04:20:17.374Z，
  `update_goal_task applies only to an active goal (current status: paused).`）；该次**不计**为判据，
  有效判据是 04:23:09 那次。
- 本节不覆盖：E1/E2/E3/E6/E7/E8 与 oracle/reviewer 非对应角色面——它们分别由本文件更早的小节
  （`/tmp/e2e-reload`、`/tmp/e2e-bg2`、`/tmp/e2e-or`、`/tmp/e2e-e6` 等）承载，此处不重复引用。
