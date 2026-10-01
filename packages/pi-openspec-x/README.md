# @xzzpig/pi-openspec-x

把 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的规范驱动流程接进 pi coding agent：从**当前安装的 openspec CLI** 现场提取官方 skill，并提供 `/opsx:plan`（深度计划 + 缺口分析 / 计划审查门）与 `/opsx:implement`（代理实现 / 主会话直实现 + 最终整体审查门）两条增强流程。

```bash
pi install npm:@xzzpig/pi-openspec-x
```

## 双轨

| 轨道   | 入口                            | 说明                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方轨 | `openspec-*` 五个同名 skill     | 会话启动时按已安装 CLI 的版本生成（`--version` / `schemas --json` / `templates --json`），内容与 CLI 一致，执行期再经 `openspec instructions <artifact> --change <id> --json` 现取权威指令；按 CLI 版本缓存于 `<agentDir>/cache/pi-openspec-x/skills/<version>/`，同版本不重复调用 CLI，升级在下一个会话生效。 |
| 增强轨 | `/opsx:plan`、`/opsx:implement` | 在官方轨之上叠加流程纪律：计划态写权限收敛、缺口分析、计划审查、用户审批；实现阶段以持久目标为底座，worker 派发 + 逐文件审查，最终以 goal 完成审计收口。两条轨互不干扰。                                                                                                                                       |

官方轨的 skill 集合在一个会话内**冻结**：插件只追加消息，不改写系统提示、不中途增删 skill，以保住提示词前缀缓存。

## 安装与静态文件迁移

1. `pi install npm:@xzzpig/pi-openspec-x`，重启会话即可获得官方轨 skill（首次自动生成缓存）。
2. 若项目里已有 `openspec init` 生成的静态 `.pi/skills/openspec-*`，插件会检测并提示移除它们（同名双供会互相遮蔽）。**插件不会替你删除文件**——按提示手动移除即可，之后由插件按 CLI 版本动态提供。

可选依赖：

- `@eko24ive/pi-ask`：在场时审批走结构化提问，缺失时降级为纯文本。
- `@xzzpig/pi-agent-role`：**不需要**。受限模式的角色切换由插件自身的 `/opsx:*` 命令经 `active_agent` 条目 + pi-sandbox profile 双通道完成。

必需 peer：`@xzzpig/pi-sandbox`（受限模式门控）、`@xzzpig/pi-subagents`（子 agent 注册与委派）、`@xzzpig/pi-goal-x`（实现底座）。

## 沙箱 profile：无需手动配置

插件在扩展初始化时通过 pi-sandbox 的编程注册接口（`registerSandboxProfiles`）会话级注册三个 profile，**不会写入你的 `sandbox.json`**：

| profile         | 可写                                                                                         | 用途                |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| `opsx-planner`  | `openspec/**`                                                                                | `/opsx:plan` 计划态 |
| `opsx-agent`    | `openspec/**` + 构建产物（`node_modules/**`、`dist/**`、`coverage/**`、`.cache/**`，可配置） | 代理实现态主 agent  |
| `opsx-reviewer` | 空（只读）                                                                                   | 最终整体审查者      |

解析顺序是**用户配置优先**：若你在 `sandbox.json` 里定义了同名 profile，以你的定义为准，插件注册不会覆盖。

fail-closed：pi-sandbox 缺失时，`/opsx:plan` 与代理实现态会被拒绝并说明原因；官方轨 skill 与主会话直实现模式不受影响。pi-goal-x 缺失时 `/opsx:implement` 会被拒绝；pi-sandbox 缺失时计划态与代理实现态会被拒绝。

## `/opsx:plan <change-id>`

1. 进入 `opsx-planner` 受限模式（写权限收敛到 `openspec/`），追加一条模式契约消息。
2. 按 change 的 artifact 依赖顺序逐阶段追加指令块（现场取 `openspec instructions <artifact> --change <id> --json`；CLI 报错或 change 未创建时降级为内置骨架并提示）。每阶段只追加一次，均为 append-only。
3. 可派发只读的 `opsx-gap-analysis` 做缺口分析，发现需被吸收进计划产物。
4. 计划成品后派发只读的 `opsx-plan-review` 审查，裁决 `OKAY/ITERATE/REJECT`；非 OKAY 修订重审，`ITERATE` 连续 2 轮或 `REJECT` 重复同一 blocker 时升级用户接管。
5. `OKAY` 后请求用户审批。**未获批准不得进入实现**。TUI 会话恒有 UI，审批走阻塞对话框并落台账；无 UI 会话降级为纯文本并记录 `pending`——此时实现仍锁死，需在有 UI 的会话重审或将批准人工写回台账（插件不监听自由文本答复）。

计划阶段的门控事件（缺口分析发现、计划审查裁决与轮次、派发用量）以 append-only JSONL 记录在 change 目录的 `.opsx-plan-review.jsonl`，并投影为人读的 `reviews.md`（见下）。

## `/opsx:implement [--agent|--direct] <change-id>`

模式二选一（命令参数或结构化提问），未选定不动作；同一会话已有进行中的实现流程时拒绝二次进入并指引恢复/结束。

计划态与代理实现态的写收敛由 pi-sandbox 的受限 profile 强制（fail-closed）：越界写被沙箱层拒绝并给出原因，读取不受限；进入受限模式前插件发出的模式契约已预先指明可写范围并把写入指引收敛回 `openspec/`。

- **`--direct` 主会话直实现**：不切角色、不收紧权限；按 `tasks.md` 顺序实现、自行验证、验证通过才勾选，终点同样接最终审查门。
- **`--agent` 代理实现**：进入 `opsx-agent` 受限模式（源码只读、构建产物可写），逐任务派发全写权限的 `opsx-worker`。派发提示词固定六段（任务 / 预期产出 / 所需工具 / 必须做 / 禁止做 / 上下文）；派发返回后逐文件核对 diff 与 `report_work` 声明、运行验证，**通过才勾选 tasks.md**，并同步 goal 任务树。

  “未审查不得勾选”是**强制门**：插件监听 `subagent`（`agent=opsx-worker`）、`report_work` 与 `update_goal_task` 三类工具流量，在 `update_goal_task status=complete` 的 `tool_call` 阶段拦截——没有观测到派发、没有对应的 `report_work`、报告声明与窗口 delta 不一致（漏报或多报文件）、或记录的验证明显失败时，勾选被 block 并返回具体原因。因此代理模式下**必须先 `report_work`（taskId / changedFiles / 验证命令与结果）再勾选**。同一任务反复派发且既无报告也无改动会被判为空转并提示一次。门拦的是 goal 任务树镜像的 `update_goal_task`；直接以 bash/write 改 `tasks.md` 复选框本身不被硬拦，由「goal 任务树不完整 → goal-x 完成事务拒绝」兜底，最终语义一致。直实现模式不设此门（无派发可核）。

两种模式都以持久目标为执行底座：插件把 `tasks.md` 组装成 objective（`Steps` + `Boundaries`/`Don'ts` + `Verification contract:`）交给 goal-x 的 `create_goal`（代理模式 `sisyphus`，直实现模式普通 autoContinue），任务清单经 `set_goal_tasks` 单向镜像。`tasks.md` 是任务权威源，goal 任务树上的手工改动不回流。

### 最终整体审查门

完成 = goal-x 完成事务内建的独立审计：插件为**该 opsx 目标**设置 per-goal auditor 覆盖，把审计执行者指向只读的 `opsx-reviewer`（审查计划符合度、代码质量、验证证据、scope 保真，审查范围为执行窗口 delta）。普通 `/goal` 目标不受影响，仍走默认审计 agent。

任务全勾而审计 `disapproved` 时目标保持未完成 → 修复（代理模式派 worker / 直实现主会话修）→ 重审，直到 `approved` 才达成完成。完成后插件只**引导**归档，绝不代执行。

审计 `disapproved` 只是**拒绝完成**，不会自动撤销已写下的代码。要放弃这次执行并回滚工作树，用：

```
/opsx:rollback <change-id>
```

回滚严格按「先计划、备份落盘、后动工作树」三步执行，逻辑全部委托给 goal-x 的 `goal-change-rollback`（与 `/goal-clear` 同一实现，插件与底座永不漂移）：

1. 读该目标的 baseline 与执行窗口 delta，产出待处理动作清单（**不触碰任何文件**）；
2. 把将被丢弃的文件以可回放的补丁复制到 `.pi/goals/archived/rollback_<时间戳>_<goalId>/`（`.patch` 可 `git apply` 回放，另写 `manifest.json`；备份失败即中止，**仍不触碰工作树**）；
3. 才修改工作树：窗口内被修改/删除的文件用 `git checkout <baseline stash> -- <path>` 恢复到窗口前内容，窗口内新增的文件被删除，重命名按「删新路径 + 恢复旧路径」撤销。

回滚范围**只有执行窗口 delta**——窗口开始前就已经存在的未提交改动不在 delta 内，因此永不被回滚。**不提供按任务回滚**（任务粒度的偏差由修复循环承担）。非 git 仓库、未诞生 HEAD 或无 baseline 时降级为「不可用」并**不改动任何文件**。备份目录会打印在结果里，随时可从其中还原被丢弃的内容。

放弃执行还需你自己用 goal-x 的 `/goal-clear` 清掉底座目标（插件不会代你做这一步）；只清目标不撤销工作区改动，撤销工作区改动就是上面的 `/opsx:rollback`。

### 恢复

实现流程跑在持久目标上：崩溃或压缩后，目标（objective、任务树、账本）仍在磁盘。新会话启动时，若底座里存在未完结的 opsx 目标，插件会给出一次性提示，指引你运行 goal-x 的 `/goal-resume` 重新接管（或 `/goal-clear` 放弃）。若底座目标被手动清除/暂停，插件检测到分叉并给出选项；诊断只读，任何修复都需要你确认。

## `reviews.md` 格式

`reviews.md` 是 `.opsx-plan-review.jsonl` 的人读投影，由记录生成，可随时重新生成。结构：

```markdown
# Plan review record

Projected from `.opsx-plan-review.jsonl` (append-only).

## Gap analysis — <ISO 时间>

<summary>
- <finding>

## Plan review verdict — round <N> — <OKAY|ITERATE|REJECT> — <ISO 时间>

<summary>
- Blocker: <blocker>
Usage: input <n>, output <n>, turns <n>

## Plan approval — <approved|revise|rejected> — <ISO 时间>

Requested via: <pi-ask|select|text>

## Escalation — <ISO 时间>

- <reason>

## Delegation usage (total)

input <n>, output <n>, cacheRead <n>, cacheWrite <n>, turns <n>
```

## lifecycle 事件字典

插件在关键节点向扩展总线发布版本化事件，单通道 `pi-openspec-x:lifecycle:v1`，payload 结构（TS 类型由插件导出）：

```ts
interface OpsxLifecyclePayload {
  version: 1;
  type:
    | "plan_started"
    | "phase_changed"
    | "review_verdict"
    | "approval_wait"
    | "plan_approved"
    | "implement_started"
    | "task_dispatched"
    | "task_completed"
    | "final_verdict"
    | "flow_completed"
    | "mode_exited";
  change: string; // 所属 openspec change
  at: string; // ISO 时间
  mode?: "plan" | "agent" | "direct";
  phase?: string;
  round?: number;
  verdict?: string;
  taskId?: string;
  message?: string;
}
```

每个类型实际由谁在什么时机发出：

| type                | 触发点                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| `plan_started`      | `/opsx:plan <change-id>` 进入计划模式后                                             |
| `phase_changed`     | 计划阶段注入某个 artifact 的 phase 块；实现流程切到 `reviewing`                     |
| `review_verdict`    | 记录一次计划审查裁决（含轮次）                                                      |
| `approval_wait`     | 打开审批对话框之前                                                                  |
| `plan_approved`     | 审批决策为 approved                                                                 |
| `implement_started` | `/opsx:implement` 启动实现流程                                                      |
| `task_dispatched`   | 观察到一次 `opsx-worker` 派发（`subagent` 工具，`agent=opsx-worker`）               |
| `task_completed`    | 观察到 `update_goal_task status=complete` 成功                                      |
| `final_verdict`     | 观察到 `update_goal status=complete`：成功为 `approved`，被审计拒绝为 `disapproved` |
| `flow_completed`    | 底座目标被 goal-x 归档（完成或清除）时结束流程                                      |
| `mode_exited`       | 同上结束实现流程时；以及 `/opsx:implement` 接管时结束计划模式                       |

`task_dispatched` / `task_completed` / `final_verdict` 是插件对主代理工具流量的观察，不是 goal-x 的推送；goal-x 缺失或流程未启动时不会发出。`final_verdict` 的 approved/disapproved 由该工具结果的 `isError` 推断（显示层启发式；权威裁决以 goal-x 的审计结果为准）。子代理内部的 `report_*` 调用不产生主会话事件，进度投影只覆盖主会话可见的上报。

pi-sentinel 可直接以 `event:` 触发器订阅：

```jsonc
// .pi/sentinel.json（示意）
{
  "rules": [
    {
      "id": "opsx-audit",
      "event": "pi-openspec-x:lifecycle:v1",
      "prompt": "当事件 type 为 final_verdict 且 verdict 为 disapproved 时，提醒我查看 findings。",
    },
  ],
}
```

### pi-notify 桥接

按**字面 channel 名**发送，不 import pi-notify；pi-notify 不在场时零影响：

- 打开阻塞式 UI（模式选择、审批）前：`pi-notify:ui_span_silent`（`{ reason }`）。
- 审批等待：`pi-notify:publish` `{ eventId: "input-required", source: "pi-openspec-x" }`。
- 流程完成：`task-completed`；门控异常：`integration-error`。

## 与 `/role` 的关系

pi-subagents 的运行时 agent 注册表按 **owner ExtensionAPI 键控**，pi-agent-role 的 `/role` 枚举视图**看不到**本插件运行时注册的 `opsx-*` agent（实现期已验证）。因此本插件**不宣传** `/role` 互操作；受限模式的切换完全由 `/opsx:*` 命令经 `active_agent` 条目 + pi-sandbox profile 完成，不依赖 pi-agent-role。

## 许可

MIT。
