# pi-sentinel E2E verification (task 5.4)

Real-runtime validation of `@xzzpig/pi-sentinel` following the
`pi-plugin-e2e-test` skill. Unit tests (15 files, 120 cases) already cover the
engine; this run proves the plugin works against the real pi process, real TUI,
real model turns, and real session persistence.

## Environment

- pi `v0.87.1`, model `new-api/deepseek-ai/DeepSeek-V4-Flash`.
- Isolated agent dir `/tmp/pi-e2e-agent` (copy of the user's `auth.json`,
  `models.json`, and `settings.json` with `defaultProjectTrust: "always"`),
  selected with `PI_CODING_AGENT_DIR`.
- Throwaway project `/tmp/pi-e2e-sentinel`, sessions under
  `/tmp/pi-e2e-sentinel/sessions`.
- Launch (tmux, `TMUX_TMPDIR=/tmp`):

  ```bash
  PI_CODING_AGENT_DIR=/tmp/pi-e2e-agent cd /tmp/pi-e2e-sentinel && pi \
    --no-extensions --no-skills --no-prompt-templates --no-themes \
    --no-context-files --session-dir /tmp/pi-e2e-sentinel/sessions \
    -e <repo>/packages/pi-sentinel/extensions/index.ts
  ```

- Config: two rules (`test-gate` blocking `tool_call` on `bash`, `turn-warn`
  background `turn_end`), both with prompts that force a fixed verdict so the
  gate and injection paths are deterministic.

## Level 1 — print-mode smoke

```bash
pi <isolation flags> -e .../extensions/index.ts -p "Reply with exactly the word: pong"
# => pong
# EXIT=0
```

Extension loads, registers, and the model round-trip works.

## Level 2 — interactive TUI

| Check                                 | Observed evidence                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension load + config load          | `/sentinel:list` printed `test-gate [tool_call [bash]] blocking idle (project)` and `turn-warn [turn_end] background idle (project)`                      |
| `/sentinel:test` dry run (real audit) | `pi-sentinel 试运行：规则 "test-gate"` / `裁决：fail` / `说明：blocked-by-e2e` / `模型：new-api/deepseek-ai/DeepSeek-V4-Flash` / `耗时：1530ms`           |
| Blocking gate                         | Prompting `Run this bash command ...: echo hi` produced `[pi-sentinel] 规则 "test-gate" 拦截本次调用：blocked-by-e2e`; the tool did not execute           |
| Background injection + renderer       | The same turn injected `[pi-sentinel][WARN] turn-warn` (renderer badge), and the agent reasoned about `warn-by-e2e`                                       |
| `/sentinel:fleet` overlay             | Listed `> test-gate ... idle` and `turn-warn ... idle` with a `── 详情 ──` panel; `s` on an idle rule showed `steer：无可引导的进行中审计`; `q` closed it |
| Inline management (`/sentinel:list`)  | Selecting `test-gate` → `禁用` printed `pi-sentinel: 已禁用规则 "test-gate"`                                                                              |
| Session-level persistence (resume)    | Relaunch with `--continue` + same `--session-dir` → `/sentinel:list` showed `test-gate ... disabled (project)`; transcript replayed the finding           |
| Session switch reset                  | `/new` → `/sentinel:list` showed `test-gate ... idle (project)` (session-level disable not carried over; runtime state reset, context 0.0%)               |

Session JSONL evidence (authoritative record):

```text
  9 pi-sentinel-finding        audit        len=46
 11 (custom) pi-sentinel-session-config
```

Entry 9 is the persisted background finding; entry 11 is the session-level
disable op that was replayed on resume.

## Coverage notes

- Session switching was exercised live via `/new`; aborting an in-flight audit
  on `session_before_switch` and tree-navigation op-log replay are covered by
  `test/session-lifecycle.test.ts` (live driving of those races is not
  deterministic in a fast-model TUI).
- `maxConcurrent` saturation, overlap matrices, cooldown, and cache behavior
  are covered by `test/runner.test.ts` and `test/cache.test.ts`.
- The `/sentinel:configure` dialog was exercised live in a second run (see
  below); the unit tests in `test/configure-dialog.test.ts` cover the branches
  (invalid draft, 继续调整, 放弃, failed write) that were not replayed live.

## Level 3 — live `/sentinel:configure` dialog (second run)

Environment identical to Level 2, with a project config holding one rule
(`turn-warn`) and `defaults.cache: false`.

| Check                             | Observed evidence                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background start                  | `/sentinel:configure 添加一条 blocking 规则 rm-guard：…` printed `pi-sentinel: 配置对话已在后台开始（用 /sentinel:fleet 查看进展）` and returned to the editor immediately                                                                |
| Fleet visibility of the dialog    | `/sentinel:fleet` listed `configure-k8hurg7q [configure] - running`; selecting it showed `配置对话 configure-k8hurg7q：running` plus `第 11 轮 · 草稿 (无) · 最近交互 …` (turn counter, draft, last interaction)                          |
| Draft preview                     | `pi-sentinel 配置草稿预览 / 变更：新增规则 "rm-guard" (blocking/tool_call)` with `写入 / 继续调整 / 放弃`                                                                                                                                 |
| 继续调整 branch                   | Choosing `继续调整` prompted `请描述调整要求`; entering `同时检查 FIXME 关键字` produced a refreshed preview                                                                                                                              |
| Scope selection                   | After `写入`, a `写入作用域` select offered `global / project / session`                                                                                                                                                                  |
| Project write + hot effect        | Choosing `project` wrote `rm-guard` (with the templated `{{input.command}}` prompt) into `/tmp/pi-e2e-sentinel/.pi/sentinel.json`; `/sentinel:list` then showed `rm-guard [tool_call [bash]] blocking model=(会话模型) idle (project)`    |
| Live blocking gate on a new rule  | Prompting `请执行这个 bash 命令：rm -rf /tmp/nonexistent-e2e-target` produced `[pi-sentinel] 规则 "rm-guard" 拦截本次调用：命令确实包含 rm -rf，属于递归强制删除…`; the tool never ran                                                    |
| Overlay auto-close before preview | The preview and scope selects always rendered with no fleet overlay on screen after a submit, even though the overlay had been opened while the dialog was drafting; `test/audit-fixes.test.ts` pins the same behavior at the index level |
| Abandoned drafts write nothing    | Drafts abandoned with `escape` left the project config at exactly `["turn-warn", "rm-guard"]`                                                                                                                                             |

## Level 4 — audit-fix verification (2026-09-29)

Isolation recipe identical to Level 2/3 (`PI_CODING_AGENT_DIR=/tmp/pi-e2e-agent`,
project `/tmp/pi-e2e-sentinel`, tmux with `TMUX_TMPDIR=/tmp`, extension loaded
with `-e .../packages/pi-sentinel/extensions/index.ts`). Project config:

```json
{
  "defaults": { "cache": false },
  "rules": [
    {
      "name": "turn-warn",
      "trigger": { "type": "turn_end" },
      "mode": "background",
      "prompt": "…verdict=warn，message 必须恰好为 warn-fixed-e2e。",
      "timeoutMs": 90000
    },
    {
      "name": "other-rule",
      "trigger": { "type": "tool_call", "tools": ["edit"] },
      "mode": "background",
      "prompt": "总是返回 pass。",
      "timeoutMs": 60000
    },
    {
      "name": "bad-model",
      "trigger": { "type": "tool_call", "tools": ["bash"] },
      "mode": "blocking",
      "model": "new-api/does-not-exist",
      "prompt": "总是返回 pass。",
      "timeoutMs": 20000
    }
  ]
}
```

`bad-model` deliberately fails model resolution, which is the cheapest
deterministic audit failure (no LLM round trip) and therefore the sharpest probe
for the negative cooldown.

| Check (fix)                                                | Observed evidence                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension load + list fields                               | `/sentinel:list` showed `turn-warn [turn_end] background model=(会话模型) idle (project) 最近=warn`, `other-rule … disabled`, `bad-model [tool_call [bash]] blocking model=new-api/does-not-exist idle (project)`                                                                                                                                                                                        |
| Dedupe cooldown survives an unrelated config change (P2-2) | Turn 1 injected `[pi-sentinel][WARN] turn-warn (1512ms)`; `grep -c pi-sentinel-finding sessions/*.jsonl` = **1**. Turn 2 (identical finding) still **1**. Then `other-rule` was disabled inline (`pi-sentinel: 已禁用规则 "other-rule"`, a rebuild) and turn 3 produced still **1** — the cooldown was not wiped. Before the fix the rebuild recreated the injector and turn 3 injected a second finding |
| Single failure notification (P3-1)                         | `Run this bash command: echo hi` produced exactly one `Warning: sentinel 审计失败（规则 "bad-model"）：模型未找到: new-api/does-not-exist`; the command still ran (fail-open)                                                                                                                                                                                                                            |
| Negative cooldown is active (P3-3 baseline)                | Pane failure-notification count 1 → **2** on a trigger; a second trigger ~19 s later left it at **2** — inside the 30 s window no new audit was started                                                                                                                                                                                                                                                  |
| Session switch clears the negative cooldown (P3-3)         | `/new` (screen cleared, count → 0) followed by the same bash prompt produced a **fresh** failure notification (count → **1**), i.e. a real audit was attempted again; with a surviving cooldown the trigger would have been short-circuited and no notification would appear (count 0)                                                                                                                   |

Reproduction: the commands above are the complete recipe; the isolated agent dir
and throwaway project were deleted afterwards because they contain a copy of
`auth.json` and `models.json` (no credentials are stored in the repository).

### Per-path live coverage (auditor follow-up)

Raw captures for the checks below are stored in `e2e-evidence/` (verbatim tmux
captures and grep output; no credentials).

| Affected path (objective) | Live evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Artifact                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 并发上限混跑 (P2-1)       | With `defaults.maxConcurrent = 1` and three blocking rules matching one `bash` call, the footer status showed only `▶1` in 7 of 18 captures (never `▶2`/`▶3`) and the gate took `Took 16.1s` (three audits serialized). The post-rebuild reuse scenario is pinned by `test/p2p3-fixes.test.ts` ("a rule added mid-flight cannot bypass the shared cap")                                                                                                                                                                        | `e2e-evidence/01-concurrency-mixing.txt`  |
| 判重冷却保留 (P2-2)       | Turn 1 injected one finding (`pi-sentinel-finding` count = 1), turn 2 stayed at 1, then `other-rule` was disabled inline (a rebuild) and turn 3 stayed at 1 — the cooldown survived                                                                                                                                                                                                                                                                                                                                               | `e2e-evidence/05-dedupe-and-cooldown.txt` |
| 遮蔽提示 (P2-3)           | `/sentinel:configure` produced the draft preview for a **session** rule named `shadow-target` while the project config already had a file rule of that name; after 写入 → `session`, `/sentinel:list` showed `shadow-target … idle (session)` and the project file was unchanged (shadowing). The notice text itself is asserted end-to-end through the real runtime (real `fileConfig` → `getFileRules` → `shadowNotice`, no fake host) by `test/p2p3-fixes.test.ts` ("a session write over a real file rule reports shadowing") | `e2e-evidence/04-shadow-notice.txt`       |
| 树导航轻量重置 (P3-2)     | `/tree` → `Up` → `Enter` printed `Navigated to selected point` while three audits were in flight; the status still showed `▶1` afterwards and the gate ran to completion (no abort, no cache clear, no dialog abort). The cooldown/dedupe-preservation and in-flight-audit assertions are pinned by three cases in `test/p2p3-fixes.test.ts`                                                                                                                                                                                     | `e2e-evidence/03-tree-navigation.txt`     |
| 负冷却跨会话清除 (P3-3)   | Failure notification count 1 → 2 on a trigger, still 2 after a second trigger ~19 s later (cooldown active), then `/new` + the same prompt produced a fresh failure notification (count 0 → 1): the session switch cleared the cooldown                                                                                                                                                                                                                                                                                           | `e2e-evidence/05-dedupe-and-cooldown.txt` |
| @root 诊断 (P3-9)         | With a rule whose prompt contains `{{@root}}` and `{{unknownVar}}`, the fleet detail panel of the running audit showed `未解析变量：unknownVar` and **not** `@root`                                                                                                                                                                                                                                                                                                                                                               | `e2e-evidence/02-root-diagnostics.txt`    |

Deterministic-only coverage (stated explicitly): the exact interleaving of a
rebuild with an in-flight audit (P2-1) and the marker/watermark re-anchoring
arithmetic (P3-4) are pinned by `test/p2p3-fixes.test.ts`, because a fast-model
TUI cannot drive those interleavings reproducibly; the live runs above cover the
same code paths end to end at the granularity the TUI allows.

## Result

All listed checks passed in a real pi runtime. `pnpm --filter @xzzpig/pi-sentinel
run typecheck`, `run test` (17 files, 141/141), `pnpm run verify`, and
`openspec validate add-pi-sentinel --strict` are green.
