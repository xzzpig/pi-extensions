# Unfocused sessions

A session is **unfocused** when no goal in the selected pool is focused for it.
Other open goals may exist in `.pi/goals`; they belong to the pool, not to this
session.

## What an unfocused session does

- It is an ordinary conversation. The plugin adds **no** goal guidance to the
  model input: no open-goal count, no `[PI GOAL UNFOCUSED]` reminder, and no
  request to pick a goal before answering.
- It appends **no** hidden `pi-goal-steering-event` message. Nothing about other
  goals is injected on session load, reload, focus changes, or ordinary turns.
- It never selects, resumes, or switches focus. Focus is human-owned: only
  `/goal-focus`, `/goal-resume`, goal creation, and `/goal-unfocus` change it.
- The UI still tells you the pool state (`goal: unfocused [N open]` plus the
  widget) unless `hideUnfocusedBanner` is set.

## What still enforces the boundary

Removing the reminder does not hand goal control to the model:

- Tools and lifecycle operations that need a focused goal keep rejecting the
  call with an actionable error; they never fall back to "some open goal".
- A stale `<pi_goal_continuation>` checkpoint is still rejected at the scheduler
  boundary, with its own `[GOAL STALE …]` note.
- Once a goal is focused, its context, state snapshots, compaction recovery,
  budget gates, and completion audit behave exactly as before.

## Retired setting

`hideUnfocusedPrompt` is kept only for configuration compatibility. It is still
parsed, layered (project over global), and preserved when other settings are
saved, but it no longer changes model input and it is no longer offered in the
settings menu or the settings summary. Any stored value — `true`, `false`, or
absent — produces the same silent behavior, so no configuration migration is
needed.

`hideUnfocusedBanner` is unrelated and still controls only the unfocused widget
and status hint.

## Existing history

Conversations recorded before this change may contain the old reminder. Those
messages are replayed verbatim: the plugin does not rewrite, filter, or
duplicate them. Only newly generated request context and new steering messages
are affected. The contract lives in `openspec/specs/goal-lifecycle/spec.md`
(change `silence-unfocused-goal-prompts`).
