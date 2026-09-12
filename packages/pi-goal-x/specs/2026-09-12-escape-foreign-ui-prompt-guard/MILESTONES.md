# MILESTONES — Escape belongs to the open dialog

Free-form implementation log (per `AGENTS.md`): decisions, setbacks, validation
notes, and evidence. Goal: `mty4e60x-kyalhx`.

## Requirement

During a completion audit, opening another window and pressing Escape to close
it still cancelled the audit. Fix: use pi core's `ui_prompt_start` /
`ui_prompt_end` span to detect an open dialog and let Escape belong to it.

## Implementation

1. `extensions/goal-state.ts`
   - `uiPromptDepth` counter with `enterUiPrompt()` / `exitUiPrompt()` /
     `resetUiPromptDepth()` (clamped at 0), exposed on `GoalCore` next to
     `goalModalDepth` (same getter/setter shape for tests).
2. `extensions/goal-events.ts`
   - Subscribes `pi.on("ui_prompt_start"/"ui_prompt_end")` at install time.
   - Resets the depth in `session_start` and `session_shutdown`.
3. `extensions/goal-widget.ts`
   - Single shared early-return guard is now
     `goalModalDepth > 0 || uiPromptDepth > 0 || goalTui.hasOverlay?.()`, so the
     audit-abort branch AND the live-goal pause branch both yield while a dialog
     owns the keyboard. Comment updated to name all three sources and the
     core-selector gap.
4. `package.json`
   - `@earendil-works/pi-coding-agent`: dev `^0.85.1`, peer `>=0.84.4`
     (also `pi-ai` / `pi-tui` aligned to `>=0.84.4` / `^0.85.1`).

### Design notes

- Core emits the span for the OUTERMOST `ctx.ui.*` call only and dispatches it
  from a microtask, so a plain counter cannot over-count nested dialogs and
  always settles before a human keypress.
- The span is runner-global, so foreign extensions' dialogs are covered
  (`pi-subagents`, `pi-ask`, `pi-permission-system`, `pi-sandbox`, …).
- `hasOverlay()` alone was insufficient: `ctx.ui.select/confirm/input/editor`
  and `custom` without `overlay: true` replace the editor and never appear in
  the overlay stack.

## Setbacks and environment blockers (all pre-existing, all proven against a clean `HEAD` worktree)

1. **goal-x's unit suite could not run at all.** `@xzzpig/pi-subagents@0.10.0`
   is installed as a registry copy whose `exports` point at `./src/**/*.ts`;
   Node 24 refuses type stripping under `node_modules`, so 57 of 75 test files
   failed to load (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Verified by
   `git worktree add /tmp/goalx-baseline HEAD` + `pnpm install
   --frozen-lockfile`: identical 57 failures on untouched `HEAD`.
   Decision (user-approved): depend on the workspace (`workspace:*`), as
   `pi-agent-role` already does.
2. **The workspace link surfaced a second pre-existing defect.**
   `packages/pi-subagents` held two live `pi-ai` instances (0.84.2 direct,
   0.84.4 nested under `pi-agent-core`), so `tsc` reported
   `AssistantMessageEventStream … separate declarations of a private property
   'queue'`. `pnpm --filter @xzzpig/pi-subagents run typecheck` was already
   failing on `HEAD` for the same reason. A goal-x-local `tsconfig` `paths` pin
   did NOT fix it. Decision (user-approved): bump that package's
   devDependencies (`pi-ai`, `pi-agent-core`, `pi-tui`) to `^0.85.1`; both
   packages now typecheck clean. Published peer ranges and the released 0.13.0
   artifact are untouched.
3. **Two `goal-settings` test failures came from real machine state**, not from
   the code: `/home/xzzpig/.pi/agent/pi-goal-x-settings.json` sets
   `auditorTimeoutMs: 3600000`, which leaked into tests that asserted unset
   defaults. Fixed by isolating the global layer via
   `PI_GOAL_GLOBAL_SETTINGS_FILE` (pattern already used in
   `tests/goal-layered-settings.test.ts`).
4. **Test-manifest drift.** `tests/.test-manifest.json` was already missing two
   test files, so `test:selfcheck` failed on `HEAD`. Regenerating the manifest
   registered the new test file and repaired that drift.
5. **Sandbox quirks during e2e** (worked around, not repo defects): tmux's
   default socket dir `/run/user/1000/tmux-1000` is read-only here
   (`TMUX_TMPDIR=/tmp/tmux-sock`), and the tmux daemon does not survive between
   tool calls, so start → drive → capture → stop had to run inside one shell.

## Validation

- `pnpm --filter @xzzpig/pi-goal-x run typecheck` → 0 errors.
- `pnpm --filter @xzzpig/pi-goal-x run lint` → clean.
- `pnpm --filter @xzzpig/pi-goal-x test` → 76 test files, exit 0, 0 failures.
- `pnpm --filter @xzzpig/pi-goal-x run test:selfcheck` → OK (76 unit + 1
  integration + 3 e2e entries match the manifest).
- Mutation check: removing `core.uiPromptDepth > 0` makes 4 of the 5 new tests
  fail (the no-dialog regression test correctly still passes).
- Real-runtime e2e (`E2E.md`, raw captures in `/tmp/pi-goalx-e2e-artifacts/`):
  with the audit running and a foreign `ctx.ui.confirm` open, Escape #1 closed
  the dialog only (audit 9s → 10s), Escape #2 cancelled the audit. Negative
  control with the guard clause removed: a single Escape cancelled the audit and
  left the foreign dialog open — the reported bug, reproduced live.

## Known limits (not fixed here)

- pi core's own editor-replacing selectors (`/model`, `/tree`, `/settings`,
  session picker) render through the internal `showSelector` path: no TUI
  overlay, no `ui_prompt` span. Escape in those panels still reaches the goal
  handler. Fixing it needs a pi core change (emit the span, or expose a public
  "editor not focused" signal).
- The live pause-branch variant (active + `autoContinue` goal) was not exercised
  in the e2e because it needs a continuation turn; it shares the same guard and
  is covered by unit tests.

## Incidental cleanups required by the repo lint gate

The pi-lens pipeline flagged pre-existing findings in the two files this change
touches and refused to let the turn pass until they were addressed. All of them
are dead-code or comment-only, with no behaviour change:

- `goal-widget.ts`: removed three unreachable debug helpers
  (`formatModeLabelDebug`, `formatSectionDebug` + its `formatPrefixedLinesDebug`
  helper, `renderDebugTaskLines`) — referenced nowhere in `extensions/` or
  `tests/` — and renamed `startMockAudit(ctx)` to `_ctx` (the caller still
  passes it, the body never used it).
- `goal-state.ts`: added two `SAFETY:` comments to pre-existing
  `as unknown as` assertions (`updateUI(ctx)`, the follow-up `details`), renamed
  the unused `abortAudit(ctx)` / `notifyUnfocusedIfNeeded(ctx)` parameters to
  `_ctx`, and removed the unused `pausedGoalId` local in `pauseActiveGoal`.

These are the only edits in the changed files unrelated to the guard itself.

## Scope additions beyond the original contract

`workspace:*` for `@xzzpig/pi-subagents`, the `packages/pi-subagents`
devDependency bump, and the test-manifest regeneration were approved during
implementation; they are recorded in `PRODUCT.md` ("Approved scope additions")
and `TECH.md` ("Test-environment prerequisites"). No version bump, no publish,
no commit (the fork release stays at 0.5.1).
