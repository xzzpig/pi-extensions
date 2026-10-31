# Validation — silence-unfocused-goal-prompts

实施证据记录。基线在**任何实现改动之前**采集；历史失败豁免（`subtrees/pi-goal-x.json` 中
`minimize-goal-model-telemetry` 的 9 个 integration 失败与 context gate 漂移）**未被沿用为本次验收许可**，
仅作为“改动前后是否新增失败”的对照基线记录。

## 1. 实施前基线（改动前工作树）

工作树状态：仅 `.pi/pi-goal-x-settings.json`（用户自有修改，未触碰）与
`openspec/changes/silence-unfocused-goal-prompts/`（本变更提案）为未提交改动。

### 1.1 Fork 分歧分类

```text
$ .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --inventory pi-goal-x
pi-goal-x: checked=757 noise=7 deleted=1 submodule=0 declared=8 undeclared=0 stale=0
exit=0
```

本变更涉及文件的分类（由 `--inventory` 派生，不写入 metadata）：

| 文件                                  | 分类                                          |
| ------------------------------------- | --------------------------------------------- |
| `extensions/goal-events.ts`           | upstream 文件，fork 修改                      |
| `extensions/goal-state.ts`            | upstream 文件，fork 修改                      |
| `extensions/goal-settings.ts`         | upstream 文件，fork 修改                      |
| `extensions/goal-commands.ts`         | upstream 文件，fork 修改                      |
| `extensions/prompts/goal-prompts.ts`  | upstream 文件，fork 修改                      |
| `tests/goal-unfocus.test.ts`          | upstream 文件，fork 修改                      |
| `tests/goal-unfocused-banner.test.ts` | upstream 文件，fork 修改                      |
| `tests/goal-prompts.test.ts`          | upstream 文件，fork 修改（已有 `noise` 声明） |
| `tests/goal-settings.test.ts`         | upstream 文件，fork 修改                      |
| `tests/goal-layered-settings.test.ts` | upstream 文件，fork 修改                      |

Fork-only（upstream 无此文件，改动不产生同步冲突）：`tests/goal-unfocused-prompt-silence.test.ts`
（本次新建）、`docs/` 下 fork-only 说明、`CHANGELOG.md` fork 段。

基线噪声：`noise=7` 全部已声明（`DECLARED`），`deleted=1` 为 `package-lock.json`（已声明），
`undeclared=0`、`stale=0`。

### 1.2 Typecheck 基线

```text
$ direnv exec . pnpm --filter @xzzpig/pi-goal-x run typecheck
$ tsc --noEmit
exit=0
```

### 1.3 聚焦测试基线（改动前）

```text
$ cd packages/pi-goal-x && node --experimental-strip-types --test \
    tests/goal-unfocus.test.ts tests/goal-unfocused-banner.test.ts tests/goal-prompts.test.ts
tests 57 / suites 3 / pass 57 / fail 0
exit=0
```

基线中直接断言旧行为的用例（实现时必须按 delta 更新，且只更新这些）：

- `goal-unfocus.test.ts`：`/goal-unfocus` 用例尾部断言请求携带 `[PI GOAL UNFOCUSED]`；
  `hideUnfocusedPrompt suppresses the model-facing reminder…`、`hideUnfocusedPrompt takes effect on the next request…`
  两个 #72 用例整体描述旧开关语义。
- `goal-unfocused-banner.test.ts`：`hideUnfocusedPrompt setting (#72)` 三个解析/分层/往返用例；
  `model-facing safety invariant (PR #29 §39)` 用例。
- `goal-prompts.test.ts`：`unfocusedOpenGoalsPrompt` 的两个文本用例。

### 1.4 `test:all` 基线（改动前，含 9 个既有失败）

```text
$ direnv exec . pnpm run test:all
exit=1
unit:        tests 1585 / pass 1585 / fail 0
integration: fail 9（全部位于 tests/integration/extension.test.ts）
sdk:         tests 10 / pass 10 / fail 0
e2e:         tests 38 / pass 38 / fail 0
```

既有 9 个失败（`subtrees/pi-goal-x.json` 已声明为 `kind: test` 债务，与本次改动无关）：

1. `tasks-disabled settings install the three-core profile`
2. `goal-settings menu toggles the disabled switch through the registered handler`
3. `goal-settings menu editing persists a field without stack overflow`
4. `displays every persisted settings row and reflects file values`
5. `toggles every boolean row directly and persists each value`
6. `edits and clears provider and model text fields`
7. `accepts every thinking level and rejects unknown values`
8. `toggling tasks off, on, and off in one menu session reinstalls the correct fixed profile each time`
9. `environment overrides take precedence in the profile-reinstall decision`

本次验收口径：改动后 `test:all` 的失败集合必须与上述集合**完全相同**（不多于 9 个、名称一致），
任何新增失败必须修复或明确报告为阻塞。

## 2. 规格场景证据

（实现完成后按 delta 每个场景填写：场景 → 测试文件/用例名 → 结果。）

## 3. 场景证据（实现后）

新 fork-only 测试文件：

- `packages/pi-goal-x/tests/goal-unfocused-prompt-silence.test.ts`（10 个用例，hook 级）
- `packages/pi-goal-x/tests/e2e/fork-unfocused-silence-sdk.test.ts` +
  `packages/pi-goal-x/tests/unfocused-silence-sdk-worker.mjs`（真实 Pi SDK，本地 fixture provider 捕获出站请求体）

命令：`cd packages/pi-goal-x && direnv exec . node --experimental-strip-types --test <file>`
结果：silence 10/10 pass；e2e 1/1 pass。

| delta 场景                                                      | 证据                                                                                                                                                                                                                                                                                                                      | 结果 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 一次性引导通道 / 首次出现未聚焦目标时发送一次                   | `silence: one open goal adds no reminder on load, repeated requests, or a tool loop`、`multiple open goals stay silent and never pick a focus`（`steeringMessages()` 为空、`sentMessages` 为 0）                                                                                                                          | pass |
| 一次性引导通道 / 同一情形不重复发送                             | 同上用例的 3 次连续请求与工具循环分支                                                                                                                                                                                                                                                                                     | pass |
| 一次性引导通道 / 情形解除后可再次发送                           | `silence: focus to unfocus to focus cycles never emit a reminder`（focus → unfocus → focus 全程 `steeringMessages()` 为空）                                                                                                                                                                                               | pass |
| 一次性引导通道 / 写入失败不影响会话                             | 本包内该一次性引导的唯一生产者已移除；通道本身未改动，其他 steering 用途的 try/catch 语义保持。无新生产者，故该场景无新增可触发路径                                                                                                                                                                                       | 保持 |
| 主模型保留执行和压缩恢复语义 / 压缩后继续执行                   | 既有 `tests/goal-compaction.test.ts`、`tests/e2e/goal-context-system-sdk.test.ts`（unit/e2e 全绿）                                                                                                                                                                                                                        | pass |
| 主模型保留执行和压缩恢复语义 / 暂停与审计拒绝不被绕过           | 既有 `tests/goal-budget.test.ts`、`tests/goal-audit-lifecycle-*.test.ts`、`tests/goal-auditor.test.ts`                                                                                                                                                                                                                    | pass |
| 主模型保留执行和压缩恢复语义 / 无焦点与过期 checkpoint 保护保持 | `silence: a stale checkpoint is still rejected while no goal is focused`；`goal-unfocus: the retired reminder setting never suppresses stale-checkpoint rejection`                                                                                                                                                        | pass |
| 未聚焦会话不自动提供其他目标的模型引导 / 多次普通请求           | `silence: one open goal …`、`every legacy reminder value …`；真实 SDK phase 1：3 次出站请求（工具循环 2 + 第二轮 1），均不含 `PI GOAL UNFOCUSED` / `open pi goal` / `pi_goal_continuation` / `PI GOAL ACTIVE`，且 tool call 与 tool result 在同一请求内配对                                                               | pass |
| 未聚焦会话不自动提供其他目标的模型引导 / 载入与取消聚焦         | hook 级：`silence: one open goal … session load`、`retired reminder state is not cached across sessions`、`focus to unfocus …`；真实 SDK phase 4：先聚焦（请求含 `[PI GOAL ACTIVE goalId=…]`）→ `/goal-unfocus` → 下一请求既无 ACTIVE 也无提醒，goal 保持 active 且正常记账                                               | pass |
| 未聚焦会话不自动提供其他目标的模型引导 / 已有历史提醒保持原样   | hook 级：`silence: pre-existing history keeps an old reminder verbatim …`（前 3 条消息逐字节相等，标记仍出现 1 次）；真实 SDK phase 2/3：带旧提醒的 compaction summary 经恢复与 `SessionManager.open` 重载后，出站请求中的 summary 文本与写入值逐字节相等、标记各出现 1 次，未重放 `pi-goal-steering-event`，也未追加副本 | pass |
| 未聚焦会话不自动提供其他目标的模型引导 / 用户显式查询不受影响   | 既有 `tests/goal-status.test.ts`（unfocused panel）、`tests/goal-widget.test.ts`、`tests/goal-features.test.ts` 全绿；`silence: the settings menu no longer offers the retired reminder row` 证明设置入口仍可用                                                                                                           | pass |
| 未聚焦提示设置仅保留旧配置兼容 / 旧键取值均不注入               | `silence: every legacy reminder value keeps the model input silent`（缺省/true/false）、`editing the legacy key on disk never changes model input`；`goal-unfocused-banner: hideUnfocusedPrompt setting (#72)` 解析/分层/往返                                                                                             | pass |
| 未聚焦提示设置仅保留旧配置兼容 / 设置入口与 UI 提示分离         | `silence: the settings menu no longer offers the retired reminder row`（仍含 `hideUnfocusedBanner`）、`saving an unrelated setting keeps the legacy reminder key on disk`；`goal-unfocused-banner` UI 用例                                                                                                                | pass |
| 未聚焦执行权限由运行时保持 / 无焦点调用需要目标的工具           | `silence: a goal tool refuses to act without a focused goal`（`update_goal` 返回既有 `No goal is set.`，目标文件与归档不变）                                                                                                                                                                                              | pass |
| 未聚焦执行权限由运行时保持 / 未聚焦时收到过期续跑               | `silence: a stale checkpoint is still rejected …`（`abortCount === 1`，`[GOAL STALE goalId=ghost-goal]`）                                                                                                                                                                                                                 | pass |
| 未聚焦执行权限由运行时保持 / 显式聚焦后正常执行                 | `silence: focus to unfocus to focus cycles …`（重新聚焦后 `PI GOAL ACTIVE` 恢复）；真实 SDK phase 4 聚焦轮次仍正常记账（`tokensUsed > 0`、status active、不归档）；既有审计/预算/完成 gate 测试全绿                                                                                                                       | pass |

### 3.1 被修改的上游测试（仅限 delta 明确替代的断言）

- `tests/goal-unfocus.test.ts`：`/goal-unfocus is idempotent …` 的请求断言改为“无提醒 + 无 steering”；
  `hideUnfocusedPrompt suppresses …` / `takes effect on the next request …` 两个 #72 用例合并为
  `hideUnfocusedPrompt no longer changes the model-facing reminder (#72 retired)`；
  `hideUnfocusedBanner alone does not suppress …` 改为 `hideUnfocusedBanner never changes model input`；
  `restoring default-pool focus …` 的“有提醒”代理断言改为“无 ACTIVE 上下文”；两处 `PI GOAL UNFOCUSED` 代理断言同步替换。
  其余用例（幂等、暂停、过期 checkpoint、审计、任务确认、多会话、tree 切换）未改语义。
- `tests/integration/extension.test.ts`：仅 1 行——设置行列表断言由“必须出现 `hideUnfocusedPrompt` 行”改为“不得出现”。
  `git diff -U0` 证明该文件只有这一个 hunk；同文件 L141/L195 的空 catch 是 upstream 原始行，
  已在 `subtrees/pi-goal-x.json` 以 `kind: lint` 声明，按分歧纪律保持原字节，未修改。

## 4. 最终 gate

```text
$ direnv exec . pnpm --filter @xzzpig/pi-goal-x run typecheck        exit=0
$ pnpm run test:selfcheck                                          OK (123 unit + 4 integration + 12 e2e)
$ direnv exec . pnpm run test:all                                   exit=1（与基线同一失败集）
    unit:        tests 1596 / pass 1596 / fail 0
    integration: tests 35   / pass 26   / fail 9（= 基线 9 个既有失败）
    sdk:         tests 10   / pass 10   / fail 0
    e2e:         tests 39   / pass 39   / fail 0
$ diff <基线失败集> <本次失败集>                                    无差异
$ .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh pi-goal-x
    checked=757 noise=7 deleted=1 submodule=0 declared=8 undeclared=0 stale=0   exit=0
$ openspec validate silence-unfocused-goal-prompts --strict         valid   exit=0
$ git diff --check                                                  exit=0
$ pnpm exec prettier --check openspec/changes/silence-unfocused-goal-prompts   exit=0
```

结论：无新增测试失败、无未声明 fork 分歧、无空白噪音；`.pi/pi-goal-x-settings.json` 与任何真实 goal 未被触碰，
未执行 commit / push / 发布 / 归档。

## 5. 审计反馈后的补充证据

首次 completion 请求被独立审计拒绝，理由与处理如下：

1. **`test:all` 退出码为 1（9 个既有 integration 失败）**：与改动前基线集合完全相同，未新增。
   该问题不是本次实现引入，但超出“全部通过”的字面要求；按 goal 契约中的 blocker 规则
   交回用户决策，不自行扩大范围去修 `tests/integration/extension.test.ts` 的 settings/profile 用例。
2. **真实 SDK 覆盖不足（任务 4.1）**：`tests/unfocused-silence-sdk-worker.mjs` 已扩展为四个阶段，
   全部断言实际出站请求体：
   - phase 1 全新未聚焦会话：工具循环 + 第二轮，共 3 次请求，均无提醒 / steering / checkpoint / ACTIVE；
   - phase 2 从历史恢复（含旧提醒的 compaction summary）：summary 逐字节相等，标记仅 1 次，未重放 steering；
   - phase 3 `SessionManager.open` 真实重载同一 session 文件：仍静默、summary 仍逐字节相等、标记仍 1 次；
   - phase 4 聚焦 → `/goal-unfocus`：聚焦请求含 `[PI GOAL ACTIVE goalId=…]`，取消聚焦后请求既无 ACTIVE
     也无提醒，goal 保持 active 且正常记账，未归档。
     e2e 入口断言 `providerRequests=7`、`phases={fresh:3,history:1,reload:1,focusCycle:2}`、
     `reminderOccurrences={history:1,reload:1}`。
3. **历史/恢复证据不足（任务 2.2）**：压缩摘要 fixture 与真实 reload 重放已由上面的 phase 2/3 覆盖；
   hook 级测试继续覆盖“历史消息逐字节不变、不新增副本”。

结论：第 2、3 项已补齐可核验证据；第 1 项按契约交由用户决定。

### 用户决策（test:all 口径）

**可核验原话**：本次会话中，执行者通过 `ask_user` 工具提交了单选问题
“test:all 退出码为 1：integration 组有 9 个既有失败（改动前后失败集完全相同，与本变更无关）。如何验收？”，
用户选择的选项为：

```text
Gate: 视为范围外（无新增失败）
```

（选项 `value: "out_of_scope"`，`recommended: true`；另两个未被选择的选项为
`fix_now`（扩大范围修好）与 `pause`（先暂停 goal）。）

针对上面第 1 项，用户在本次会话中明确选择：**视为范围外，按“无新增失败”验收**。

- 依据：9 个失败在本次改动之前就存在（`subtrees/pi-goal-x.json` 已按 `kind: test` 声明），
  改动前后失败集逐条相同，`git diff -U0` 显示本变更对
  `tests/integration/extension.test.ts` 只有 1 行断言改动（设置行不再展示）。
- 因此本次验收口径为：`test:all` 的失败集合必须与基线完全相同（已验证），不要求这 9 个用例转绿；
  不修改其基线、不改写这些用例的期望值来“消除”失败。
- 该决定不授权修改 settings/profile 相关实现或测试；如需修复，应由用户另开范围。
