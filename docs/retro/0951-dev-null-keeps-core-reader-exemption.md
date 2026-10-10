---
issue: 951
issue_title: "pi-permission-system: a `2>/dev/null` redirect withholds the core-reader wrapper exemption"
---

# Retro: #951 — pi-permission-system: a `2>/dev/null` redirect withholds the core-reader wrapper exemption

## Stage: Planning (2026-10-06T14:51:24Z)

### Session summary

Reproduced the defect through the real `BashProgram.parse(...).commands()`: `rg -l x | xargs ls -1t 2>/dev/null` loses `core-reader`, as do the hosted (`2>/dev/null xargs …`) and `>/dev/null 2>&1` forms.
Planned a three-step fix: an `isDiscardDevice` predicate in `src/path/safe-system-paths.ts`, a guard in `redirectMayWriteFile`'s loop, and an architecture-doc update.
Classified as a non-breaking `fix:` that implements ADR 0013 §11's "no real output redirect" wording; ships independently.

### Observations

- Operator decisions: only `/dev/null` clears the refusal; `/dev/std{in,out,err}` stay write-proving.
  On Linux, opening one for write reopens the descriptor's file with `O_TRUNC`, so `xargs cat < f > /dev/stdin` would truncate `f` under the exemption (Linux procfs semantics, not measured on this macOS host).
- The token collector (`redirectEffectForDestination`) is deliberately unchanged, so `path_write` keeps seeing `/dev/null` as a write token; tests already pin that.
- The guard compares the raw `child.text`, with no node-type check and no target-index check.
  Quoting changes the raw text, so a type check would be unkillable, and `getParser` reattaches trailing words ([#977]), so the target is the only non-descriptor child in production.
- Measured with `getGrammarParser`: `cat <> /dev/null` parses as `[<, ERROR, word]`, unresolved, so it refuses twice over.
  A first draft named it as a killer for a guard-ordering mutation; it isn't one, and the plan now says so.
- The Tidy-First assessor recommended nothing; its optional `DISCARD_DEVICE` constant is folded into step 1.
- Open PR #971 touches the wrapper floor in other files; it does not overlap and is not a close target.

## Stage: Implementation — TDD (2026-10-06T16:47:44Z)

### Session summary

Completed all three plan steps, each its own commit: the `isDiscardDevice` predicate, the `redirectMayWriteFile` guard with unit and program-level rows, and the architecture-doc update.
Added 30 tests: 8 in `safe-system-paths.test.ts`, 15 in `redirect-analysis.test.ts`, and 7 in `program.test.ts`.
The full suite, `check`, root `lint`, and `fallow dead-code` are green.

### Observations

- No deviations from the plan.
  Every named killing mutation killed exactly the predicted rows.
  Deleting the guard killed 10, swapping in `isSafeSystemPath` killed 3, and `includes("/dev/null")` killed 5.
  The step 1 mutation (`SAFE_SYSTEM_PATHS.has`) killed the 3 stream-device rows.
- Process slip in step 1: the Red run and the implementing `Write` went out in the same tool batch and ran concurrently, so the "red" run saw green.
  Red was re-derived by temporarily restoring the HEAD source: 8 new tests failed.
  Keep Red runs in their own batch.
- Pre-completion reviewer: PASS.
  Its re-derivation spike put 90 of its own inputs through `BashProgram.parse`, including near-miss spellings, brace and glob expansions, `/dev/fd/1`, sibling real redirects, and compound and heredoc hosts.
  It found no input that clears the refusal while a real file is written.

## Stage: Sync (worktree) (2026-10-06T16:50:01Z)

### Session summary

Root `pnpm run lint` and `pnpm fallow dead-code` pass on the branch.
The plan's marker is `**Release:** ship independently`, and no follow-ups were filed.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-951--/2026-10-06T06-43-22-637Z_01a10ff3-dd8c-7169-98a3-cf2456aacd4c.jsonl` \- read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

The reviewer returned PASS with no open warnings or operator decisions.
One process slip is recorded in the TDD stage: a Red run batched with its implementing `Write`.

## Stage: Final Retrospective (2026-10-06T16:59:49Z)

### Session summary

The issue ran in four sessions: planning, TDD and sync in one peer worktree session, and ship plus this retro at the root.
The fix landed as one `refactor:`, one `fix:` and one `docs:` commit, CI passed on the first push, and the release cut `pi-permission-system-v40.0.1`.
No operator correction was needed after the planning gate.

### Observations

#### What went well

- Planning reproduced the defect through `BashProgram.parse(...).commands()` with a throwaway spike before proposing anything.
  The gate then asked about two concrete axes (which devices, and whether the token collector changes), each with measured rows.
- A second spike during planning measured `cat <> /dev/null` and corrected a draft claim that it was a killing row for a guard-ordering mutation.
  The plan was fixed before it was committed, so the TDD stage inherited no false prediction.
- Every named killing mutation killed exactly its predicted row count (3, 10, 3, 5).
  The `/tmp/green-ra.ts` copy was taken in the Green verification call, as `/tdd-plan` now prescribes, and survived a mid-step disconnect: the resumed session checked it with `cmp` before committing.
- The ship ran with no stops: the ff-merge predicted clean, lint and `fallow dead-code` passed on the merged tree, and the release succeeded on its first dispatch.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — in TDD step 1 the Red `vitest run` and the implementing `Write` went out in one tool batch, ran concurrently, and the "red" run saw green.
  Impact: about 2 extra tool calls to re-derive Red by swapping the HEAD source back in; no rework.
  This is the same failure class as the green-copy `cp` batched with a mutating `Edit` ([#609], [#999], [#1006]) and a repair `Edit` batched with its `git commit` ([#1015]).
  `/tdd-plan` names the hazard only for the green-copy `cp`, so the rule is scoped narrower than the failure.

#### What caused friction (user side)

- None.
  The operator's only interventions were the planning gate's two decisions and a reconnect after a disconnect.

### Diagnostic details

- Model-performance correlation: planning and TDD ran on `anthropic/claude-opus-5-5`; sync switched to `anthropic/claude-sonnet-5-5`, which is a reasonable fit for that mechanical stage.
  The `tidy-first-assessor` and `pre-completion-reviewer` were the only subagent dispatches.
- Feedback-loop: TDD ran the affected test files at each Red, Green and mutation, `pnpm run check` before each code commit, and the full suite only at the end.

### Changes made

1. `.pi/prompts/tdd-plan.md`: the Red step now says to run Red in its own tool call, before the implementing `Edit`/`Write`, since calls in one batch run concurrently.

[#609]: https://github.com/gotgenes/pi-packages/issues/609
[#999]: https://github.com/gotgenes/pi-packages/issues/999
[#1006]: https://github.com/gotgenes/pi-packages/issues/1006
[#1015]: https://github.com/gotgenes/pi-packages/issues/1015

[#977]: https://github.com/gotgenes/pi-packages/issues/977
