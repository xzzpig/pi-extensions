---
issue: 1011
issue_title: 'pi-permission-system: review log labels config/default-covered external_directory bypasses as "session_approved"'
---

# Retro: #1011 — pi-permission-system: review log labels config/default-covered external_directory bypasses as "session_approved"

## Stage: Planning (2026-10-03T04:10:13Z)

### Session summary

Reproduced the third-party report through the real `PermissionManager` + `PermissionResolver` with the reporter's literal `head -1 /etc/hostname`: both `{"*": "allow"}` and a config `external_directory` allow produce a `session_approval` bypass.
The operator chose to match `GateRunner` (a policy allow writes no review entry) and to keep `session_approved` when at least one path is session-covered, listing only those paths.
The plan has three steps: a type rename, the `fix:` with tests, and docs.

### Observations

- `GateRunner` writes no review entry for any config/default allow, and `bash-path.ts`'s sibling bypass already requires `allSessionCovered`, so this gate was the outlier.
  That is why the issue's alternative (a new `policy_allowed` event / `kind: "rule"` bypass) was rejected: it would have made this the only gate that logs a policy allow.
- Measured in the operator's review log: 10472 bash-bypass `session_approved` entries against 169 `approved_for_session` external-directory grants.
  Most of the 10472 are probably mislabeled config coverage (an estimate: one grant can cover many calls).
- Classified as non-breaking: the bypass never emitted a `permissions:decision` event, so only review-log lines change.
- `Co-authored-by:` for the reporter (`alkrusz`, id 10740345) is recorded in the plan's step 2.
  The session branch adopts their "stamp only when a session-layer rule matched" mechanism.
- The Tidy-First assessor recommended one preparatory rename (`UncoveredExternalPaths` → `ExternalPathCoverage`) and confirmed `selectUncoveredExternalPaths` has a single `src/` consumer.

#### Deferred tidyings

- `test/handlers/gates/bash-external-directory.test.ts` / `external-directory-policy.test.ts`: duplicated local `makeCheckResult` helpers could lift into `test/helpers/gate-fixtures.ts`.

## Stage: Implementation — TDD (2026-10-03T04:26:38Z)

### Session summary

All three plan steps landed: the `ExternalPathCoverage` rename, the `fix:` (a `sessionCovered` output on the selector, and the gate returning `null` when no session grant covered a path), and the docs.
The `pi-permission-system` suite went from 5362 to 5370 tests (+8: 4 selector, 2 gate unit, 2 real-resolver).

### Observations

- Each planned killing mutation produced the predicted reds.
  Dropping the `source === "session"` test killed 8 tests.
  Deleting the `null` return killed 4.
  Building `externalPaths` from all accesses killed the mixed-coverage test.
- The real-resolver session test was already green during Red, as a pin.
  Making the `null` branch unconditional killed it, along with the two other bypass tests.
- The first `fix:` commit was rejected by ESLint (`no-unnecessary-condition` / `prefer-nullish-coalescing` on a `Record` lookup in the new selector test).
  Switching to a `Map` fixed it.
  That attempt also used `git commit -F -` with a heredoc, which AGENTS.md lists as a permission deny rule; the retry used repeated `-m` arguments.
- No deviations from the plan.
- Pre-completion reviewer: PASS.

## Stage: Sync (worktree) (2026-10-03T04:35:19Z)

### Session summary

Root `pnpm run lint` and `pnpm fallow dead-code` both passed before the rebase.
The plan's marker is `**Release:** ship independently`; the `fix:` commit carries the reporter's `Co-authored-by:` trailer, and no follow-up issues were filed.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1011--/2026-10-03T03-51-45-770Z_01a0ffe3-ab6a-713d-b07b-e833d5798c43.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

Nothing new beyond the TDD stage note.
