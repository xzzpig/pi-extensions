# Escape belongs to the open dialog

## Problem

While a goal turn is working, pi-goal-x registers a terminal-input handler
(`syncTerminalInputPause`) that claims Escape for the goal: it aborts a running
completion audit, collapses the expanded dashboard, or pauses an active goal.

That handler runs **before** the focused component sees the key (pi-tui
dispatches input listeners first). The handler already yields to a foreign
window in two cases: a goal-owned modal (`goalModalDepth`, entered around
`ctx.ui.custom` / questionnaire / task-confirmation dialogs) and a visible TUI
overlay (`tui.hasOverlay()` — the pi-subagents fleet inspector and other
overlay-based panels).

Both guards miss a whole class of blocking dialogs. `ctx.ui.select`,
`ctx.ui.confirm`, `ctx.ui.input`, `ctx.ui.editor`, and `ctx.ui.custom`
**without** `overlay: true` replace the editor instead of pushing an overlay,
so `hasOverlay()` is false and `goalModalDepth` is 0 (the dialog belongs to
another extension). The dialogs are still real, focused, Escape-closing
windows, so the user's Escape is delivered to the goal handler first and:

- cancels the completion audit that is currently running, or
- pauses the active goal and (because that branch deliberately returns
  `undefined` instead of `{ consume: true }`) also aborts the current turn.

In both cases the user only meant to close the other window.

## Intended behavior

Escape belongs to whatever dialog is open. While a blocking `ctx.ui.*` dialog
is open — from any extension, including pi-goal-x itself — the goal's
terminal-input handler stays inert: the dialog closes and the goal's audit
state, pause state, and current turn are untouched.

Once the dialog closes, Escape resumes its previous meaning unchanged: it
aborts a running audit, collapses the expanded dashboard, or pauses a live
auto-continue goal and passes the key back to pi.

The rule is uniform: an open blocking dialog owns every key, exactly like the
existing goal-owned-modal and TUI-overlay guards. The guard is not special
cased to Escape alone, because a focused dialog owning the keyboard is the
existing contract for the other two guards.

Nested dialogs need no extra handling: pi core opens a span for the outermost
`ctx.ui.*` call only, so a nested dialog never double-counts.

A side effect worth stating: pi-goal-x's own non-modal prompt (the evidence
`ctx.ui.input` shown when a task with a verification contract is completed from
the dashboard) is now covered by the same rule. Escape there cancels the input
only; pausing the goal requires a second Escape after the input closes.

## Known limitation (documented, not fixed here)

pi core's **own** selectors do not go through `ctx.ui.*`: `/model`, `/tree`,
`/settings`, the session picker, and friends render through the internal
`showSelector` path, which replaces the editor and neither pushes a TUI overlay
nor emits a `ui_prompt` span. Escape in those core panels therefore still
reaches the goal handler and pauses the goal / cancels the audit.

Closing that gap needs a pi-core change (core's own selectors should emit the
same `ui_prompt_start`/`ui_prompt_end` span as extension dialogs, or expose a
public "the editor is not focused" signal). It is out of scope here and is
recorded as a known residual gap.

## Out of scope

- pi core changes, including the core-selector gap above.
- pi-notify, the silent-span marker protocol, and pi-subagents' behaviour.
- Changing the semantics of goal-owned modals (`goalModalDepth` unchanged) or
  of `hasOverlay()`.
- Version bump and npm publication.

## Approved scope additions (dependency/test environment)

These are not user-visible behaviour changes; they were approved during
implementation because the goal's verification contract (typecheck 0 errors,
test suite 0 failures) could not be met otherwise. Each was proven
pre-existing against a clean `HEAD` worktree.

1. **`packages/pi-goal-x` depends on the workspace `pi-subagents`.**
   The registry `@xzzpig/pi-subagents@0.10.0` publishes raw `.ts` sources whose
   `exports` point at `./src/**/*.ts`; Node 24 refuses type stripping for files
   under `node_modules`, so 57 of 75 goal-x test files could not load at all.
   Switching to `workspace:*` (the pattern `pi-agent-role` already uses) links
   `packages/pi-subagents`, whose sources live outside `node_modules`.
   pnpm rewrites `workspace:*` to the real version at pack/publish time.
2. **`packages/pi-subagents` devDependencies** `@earendil-works/pi-ai`,
   `pi-agent-core`, `pi-tui`: `0.84.2` → `^0.85.1`. With the workspace link,
   goal-x's `tsc` follows pi-subagents' sources, which held two live `pi-ai`
   instances (0.84.2 direct, 0.84.4 nested under `pi-agent-core`) and produced
   `AssistantMessageEventStream has separate declarations of a private property
   'queue'`. `pnpm --filter @xzzpig/pi-subagents run typecheck` was already
   failing at `HEAD` for the same reason; the bump removes the duplicate and
   makes both packages typecheck clean. Only devDependencies change — the
   published peer ranges (`*`, `>=0.80.0`) and the released 0.13.0 artifact are
   untouched.
3. **`packages/pi-goal-x/tests/goal-settings.test.ts` global-layer isolation.**
   Two tests asserted default/unset semantics while `loadGoalSettings` read the
   real machine-global file (`~/.pi/agent/pi-goal-x-settings.json`, which sets
   `auditorTimeoutMs: 3600000` on this host). They now pass
   `PI_GOAL_GLOBAL_SETTINGS_FILE` pointing inside the temp dir, matching the
   existing isolation pattern in `tests/goal-layered-settings.test.ts`.
