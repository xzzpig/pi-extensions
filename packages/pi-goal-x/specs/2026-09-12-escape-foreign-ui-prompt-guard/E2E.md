# E2E evidence — Escape belongs to the open dialog (pi-goal-x)

Skill: `.pi/skills/pi-plugin-e2e-test`. Date: 2026-09-12. pi: 0.85.1.

## What was validated

Real pi runtime, real TUI, real blocking dialog, real goal completion audit:

1. A completion audit is in flight and a foreign extension's blocking
   `ctx.ui.confirm` dialog is open at the same time.
2. **Escape #1** (the user closing the other window) closes only that dialog;
   the running audit survives.
3. **Escape #2** (no dialog open) restores the goal's normal behaviour and
   cancels the audit.

## Launch (exact)

```bash
cd /tmp/pi-e2e-escguard && pi \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --no-context-files --session-dir /tmp/pi-e2e-escguard/sessions \
  -e /tmp/pi-goalx-e2e-src/goal-e2e.ts \
  -e /tmp/pi-goalx-e2e-src/foreign-dialog.ts
```

`goal-e2e.ts` loads the repository's real
`packages/pi-goal-x/extensions/goal.ts` with an injected slow
`runCompletionAuditor` (settles only when its audit `AbortSignal` aborts, with
the real terminal `Auditor aborted.` error) and adds `/e2e-audit`, which runs
`runGoalCompletionFlow` in the background. `foreign-dialog.ts` registers
`/foreign-dialog` (a real `ctx.ui.confirm`).

Both sources are kept in `ext-sources/`; the runner scripts that produced every
capture are `pi-goalx-e2e-run.sh` (fixed) and `pi-goalx-e2e-negative.sh`
(negative control).

Startup evidence (`01-startup.txt`): `[Extensions] foreign-dialog.ts,
goal-e2e.ts` (the `one-dark` theme fallback line is the documented cosmetic
artifact of `--no-themes`).

## Fixture

`/tmp/pi-e2e-escguard/.pi/goals/active_goal_e2e_escape.md` — a seeded v3 goal
(`status: active`, `autoContinue: false` so no continuation turn is needed),
focused with `/goal-focus` (exactly one open goal, so no selector dialog).

## Sequence and observations (fixed build)

| capture | observation |
| --- | --- |
| `02-focused.txt` | `Focused goal: active - E2E fixture: …`; widget renders the goal card. |
| `02b/02c-model-turn.txt` | one trivial model turn (`Reply with exactly: pong`) so pi writes the session JSONL. |
| `03-audit-running.txt` | `/e2e-audit` → real audit starts. |
| `04-foreign-dialog-open.txt` | **Audit running (6s, `Esc: stop audit`) AND the foreign dialog open** (`Foreign dialog / Escape closes THIS dialog only / escape/ctrl+c cancel`). |
| `05-after-esc1.txt` | `foreign-dialog: closed (confirmed=false)` **and** `Independent completion audit … 10s` still on screen → Escape #1 closed the dialog and did **not** cancel the audit. |
| `06-after-esc2.txt` | `Audit interrupted by Escape (continue = default)` escape dialog → Escape #2 cancelled the audit; the goal is still `active` (17s). |

## Negative control (guard clause removed)

Same launcher, same fixture, `core.uiPromptDepth > 0` removed from
`goal-widget.ts` (restored immediately afterwards):

| capture | observation |
| --- | --- |
| `04-foreign-dialog-open.txt` | audit running (4s) + foreign dialog open. |
| `05-after-esc1.txt` | a **single** Escape produced `Audit interrupted by Escape` **and the foreign dialog is still on screen** — the goal consumed the key (`{consume:true}`), cancelled the audit, and never let the dialog process it. This is the reported bug, reproduced live. |

## Authoritative records

- Session JSONL (fixed run): `session-fixed.jsonl` (`07-entries.txt` map):
  `session`, `model_change`, `thinking_level_change`,
  `pi-goal-steering-event unfocused`, `(custom) pi-goal-focus selected`,
  `msg role=user`, `pi-goal-state-event state len=807`,
  `msg role=assistant stop=stop`, `pi-goal-audit-event len=109`.
- Goal ledger (fixed run) `ledger-fixed.jsonl`:
  `goal_focused` → `completion_requested` → `audit_started`.
  No abort/skip event is expected: pi was stopped while the Escape dialog was
  awaiting the user's choice, and the completion flow appends exactly one
  canonical outcome only after that choice (by design).
- Goal ledger (negative control) `ledger-negative.jsonl`: same chain.

## Kept artifacts

- `/tmp/pi-goalx-e2e-artifacts/` — captures, sources, scripts, session, ledgers.
- `/tmp/pi-e2e-escguard/` — env dir of the fixed run (seeded goal + ledger).
- `/tmp/pi-e2e-escneg/` — env dir of the negative control.

## Honest limits

- The audit was driven by an injected auditor, not the real pi-subagents
  delegation: the point under test is the terminal-input guard and the core
  `ui_prompt_*` span, not the auditor's own behaviour (that path is covered by
  the existing suite).
- The live pause branch (active + `autoContinue` goal, Escape with a foreign
  dialog open) was not exercised live — it would require a continuation turn.
  It shares the same single early-return guard and is covered by
  `tests/goal-escape-ui-prompt.test.ts`.
- pi core's own editor-replacing selectors (`/model`, `/tree`, `/settings`)
  emit no `ui_prompt_*` span and remain a documented residual gap; the e2e
  therefore uses an extension-owned `ctx.ui.confirm` as the foreign window.
