---
issue: 861
issue_title: "pi-permission-system: a locally-adjudicating child silently skips a configured chain link whose provider is excluded"
---

# Retro: #861 — a locally-adjudicating child silently skips a configured chain link whose provider is excluded

## Stage: Planning (2026-09-16T05:29:00Z)

### Session summary

Planned the fix for the silence around a skipped `authorizerChain` link: a new `AuthorizerChainAudit` in `src/authority/`, modelled on [#792]'s `ChildNodeAudit`, that owns both the existing per-ask `authorizer_chain_unregistered_link` review entry and a new visible warning latched once per session per link name.
The operator confirmed three decisions at the clarification gate — report at the first ask that skips (not at turn prep, not in `/permission-system show`), name all three causes unbranched, and latch per name.
The plan is `packages/pi-permission-system/docs/plans/0861-unregistered-chain-link-warning.md`, with four steps: a Tidy-First type extraction, the unwired audit module, the wiring `fix:`, and the docs commit.

### Observations

- The issue's resolution (the skip stays; no link inheritance across a node boundary) was never in question — ADR 0012 decision 1, ADR 0007 §7, and the `fact-shaping inheritance stops at live authority` composition-root test all converge on it.
  The whole design question was the reporting surface.
- Measured the defect in the operator's own review log rather than arguing it: **48 genuine `authorizer_chain_unregistered_link` events across 13 days**, all naming `model-judge`.
  Two traps in that measurement, both worth repeating — a raw `grep -c` reports 54 because the string appears inside a logged `bash` heredoc, and 44 of the 48 predate the `requestId` field, so a `requestId`-keyed scan under-counts them (the schema-drift hazard the package skill names).
- Two facts settled the option set and neither was inferable from the issue.
  First, an `Explore` trace of the Pi checkout established that `ctx.ui.notify(msg, "warning")` appends durably to `chatContainer` (scrollback), and that the permission dialog's `ui.select` swaps the editor area rather than compositing an overlay — so a warning emitted immediately before the prompt cannot be covered by it.
  That refuted the main UX objection to reporting at the ask.
  Second, `pi-permission-model-judge`'s ready handler opens with `if (dispose || !config) return;` — a session with no provider config *deliberately* registers nothing — so an absent link is not always the operator contradiction the issue frames it as, and the message had to admit three causes instead of two.
- Rejected turn-prep reporting on a citable ground rather than taste: ADR 0007 §4 only requires a link to register *before the session's first ask*, so a prep-time check is a prediction that can falsely accuse a conforming async registrar.
  Reporting at the skip reports a fact.
- Accepted two residuals rather than filing them, because the mechanisms that would cover them were put to the operator and declined: a headless locally-adjudicating node gets no visible warning (`noOpUIContext.notify` is literally `() => {}`), and a session where no ask ever escalates (notably under `yoloMode`) never learns its chain is broken.
- The Tidy-First assessor returned one recommendation (name the anonymous constructor-deps intersection that `test/helpers/authorizer-fixtures.ts` hand-copies, so step 3 adds its field once instead of twice) and one useful correction: the new audit's tests should use `makeLogger()` from `session-fixtures.ts`, since `makeAuthorizerLog()` returns no `warn`.
  It also flagged that `test/composition-root.test.ts` already asserts on `authorizer_chain_unregistered_link` in a block that drives this issue's exact scenario end to end — the natural place to pin the wiring.
- The assessor explicitly rejected a shared base with `ChildNodeAudit`: the two latch differently (per instance vs. per name) because their cause sets have different bounds, and a shared base would need a strategy parameter existing only to hide that.
  Recorded in the plan as a deliberate duplication.

#### Deferred tidyings

- `packages/pi-permission-system/test/helpers/authorizer-log-fixtures.ts` — `makeAuthorizerLog()`'s docstring claims its `{ review, debug }` return "structurally satisfies the session logger", but `SessionLogger` also requires `warn`.
  Rejected as out of scope: the file is not a target of this change.
- `packages/pi-permission-system/test/authority/authorizer-selection.test.ts` — the flat `describe("chain resolution")` block holds ~10 sibling `it`s; a nested `describe("unregistered configured links")` would group the ones this change touches.
  Cosmetic rather than change-shrinking, so left out.

## Stage: Implementation — TDD (2026-09-16T16:09:39Z)

### Session summary

Four TDD cycles, all as planned: the Tidy-First extraction of `AuthorizerSelectionConstructorDeps`, the unwired `AuthorizerChainAudit` module, the wiring `fix:`, and the docs commit.
The `pi-permission-system` suite went from 4337 to 4346 tests (+9: 8 in the new `test/authority/authorizer-chain-audit.test.ts`, 1 new selection test; two existing selection tests and one composition-root block migrated their assertions rather than being added).
Pre-completion reviewer returned WARN on one stale comment, which was fixed, and PASS on the delta re-review.

### Observations

- No deviations from the plan's design or module list.
  Every file the plan named was touched, and every file it predicted unchanged (`README.md`, ADR 0007, `config-schema.ts`, `schemas/permissions.schema.json`) stayed unchanged.
- The plan named three killing mutations for the audit module and three for the wiring step, and every one killed exactly the predicted equivalence class and no more — 1, 1, 1 for the audit (latch guarding the review write, guard never firing, boolean latch in place of the per-name `Set`) and 3, 1, 2 for the wiring.
- The wiring step's relaying-node test (`does not report an unregistrable link as an unregistered one`) **stayed green through Red**, which is the case the template flags: a deliberate regression pin and a vacuous probe look identical there.
  Its mutation — hoisting the audit call above `linksFor`'s `adjudicatesLocally` early return — reddened it alone, so it discriminates.
- One planned mutation was substituted.
  "Construct the audit inside the constructor instead of injecting it" does not compile (`deps.logger` is a `DebugReviewLogger` with no `warn`) and at run time would crash on an undefined method, which the template warns is not a discrimination signal.
  Replaced with a payload mutation (a constant `requestId` in the relayed `UnregisteredLink`), which reddened the two assertions that pin the payload.
- The `Edit` tool's first attempt used a hand-built absolute path missing the worktree prefix, and `pi-permission-model-judge` denied it with the corrected location — the `external_directory` gate catching exactly the typo class ADR 0007 use case 1 describes.
  Repo-relative paths avoid it, as `AGENTS.md` says.
- Reviewer WARN: the `fact-shaping inheritance stops at live authority` block in `test/composition-root.test.ts` still called the skip's loudness an open question, in the very block the change modified to pin the warning.
  The plan's grep sweep covered `src/`, `test/`, docs, and `.pi/skills/` for `authorizer_chain_unregistered_link` and `861`, and this line matches the second pattern — it was in the sweep's output at planning time and did not make it into the plan's file list.
  Worth remembering that a sweep's *output* and the plan's *list* are different artifacts.
- Both invariants the reviewer was asked to re-derive held under independent derivation: `auditUnregisteredLink` has exactly one call site, reachable only through `linksFor`'s locally-adjudicating branch (including via `ForwardedRequestServer`, which escalates on a serving node), and the review record's event name, field set, field order, and per-ask cadence are identical to the pre-change inline write.

## Stage: Sync (worktree) (2026-09-16T16:34:18Z)

### Session summary

Pre-push checks (`pnpm run lint`, `pnpm fallow dead-code`) both passed clean with no fixes needed.
The plan's `**Release:** ship independently` marker stands — nothing to defer, no batch to join.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-861--/2026-09-16T04-47-38-631Z_01a0a88a-b887-7300-83e9-fe6b2eccb196.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

No deferred work.
The TDD stage's one reviewer WARN was fixed and re-reviewed to PASS before this sync; nothing carries forward.

[#792]: https://github.com/gotgenes/pi-packages/issues/792
