---
issue: 1033
issue_title: "pi-permission-system: a session grant on one unit of a bash chain approves its sibling asking units"
---

# A session grant on one unit approves only that unit

## Release Recommendation

**Release:** ship independently

This issue's roadmap step in `docs/architecture/architecture.md` (Phase 15, Track D, `#### [#1033] A session grant on one unit approves only that unit`) is tagged `Release: independent` and belongs to no release batch.

## Problem Statement

A user who allowed `sudo rm y` for the session later sees `sudo rm y && git push origin main` run with no prompt, though `git push *` is an `ask` rule.
The review log records it as `permission_request.session_approved` with `sessionApprovalPattern: "<indirection-bash-wrapper>"`, a floor sentinel rather than the grant the user gave.
Reversing the chain (`git push origin main && sudo rm y`) prompts, so the outcome depends on unit order.
No rule is needed at all: `sudo rm y && sudo rm z` with a grant for `sudo rm y` alone runs `sudo rm z` unprompted, because both are floored wrappers.
In a subagent the same fast path approves locally, so the ask is never forwarded either.

The cause is the wrapper and unparsed-subtree floors.
`floorToAsk` spreads the resolved check, so a session-granted `allow` comes back `ask` with `source: "session"`.
`pickMostRestrictive` is first-wins on ties, so that result beats a later rule-raised `ask`, and `GateRunner` tests `source === "session"` before the state and approves the whole tool call.

## Goals

- A session grant approves only the unit it names: a chain still asks when any other unit asks, whatever the unit order.
- A session-granted unit is never floored, so it stays `allow` with `source: "session"` and the floors never produce an `ask` with `source: "session"`.
- A single session-granted unit, and a chain whose units are all session-granted or rule-allowed, still take `GateRunner`'s session fast path or allow as today.
- `GateRunner` takes the session fast path only for a session `allow`, so a session-sourced `ask` or `deny` would reach the deny/ask/allow gate (fail closed).
- Not breaking: what a single unit does is unchanged, and the chains that newly prompt were the bypass.

## Non-Goals

- Changing how session grants are recorded (`SessionRules` keeps recording only `allow` rules) or what pattern a prompt offers for the session.
- `pickMostRestrictive`'s tie rule: with no `ask`/`session` result left, the first-wins tie between real asks stays as it is (option B of the gate, a non-session tie-break, was declined).
- The serving node: `honorChildFloor` in `src/policy/serving-policy.ts` already skips the floor for a session-sourced `allow`, and this change makes the child match it; that file does not change.
- The bash path and external-directory gates: they raise no floor and never produce a session-sourced `ask`; `bash-path.ts` and `external-directory-policy.ts` do not change.
- Rewriting history records (`docs/architecture/history/phase-14-capability-axis.md` keeps its account of the original exemption).

## Background

- `resolveBashCommandCheck` (`src/handlers/gates/bash-command.ts`) resolves each `BashCommand` unit through `resolveCommandUnit`, then selects the winner with `pickMostRestrictive` and decorates it with `withChainFloor` ([#1029]) and `withAskingUnits` ([#1030]).
- `resolveCommandUnit` floors a wrapper unit's `allow` through `resolveWrapperUnit` → `floorToAsk`, unless the enumerator marked a floor exemption, in which case the inner command's own rule decides.
  It then passes the result to `floorUnparsedUnit`, which floors a `parseUnresolved` unit's `allow` to `<unparsed-bash-subtree>`, naming the whole command.
- Both floors spread the resolved check on purpose; the doc comments on `floorUnparsedUnit` and `floorToAsk` say the spread keeps a session grant alive to `GateRunner`'s session fast path.
  `test/handlers/gates/bash-command.test.ts` pins it (`carries a session grant through the floor`, line ~651), and so does `test/handlers/gates/runner.test.ts` (`honours a session grant that survived the unparsed-subtree floor`, line ~226).
- `SessionRules.approve` (`src/session/session-rules.ts`) records only `action: "allow"`, and `deriveSource` in `src/policy/permission-manager.ts` stamps `source: "session"` on any match from the session layer.
  So the floors' spread is the only producer of an `ask`/`session` check in the package.
- `withChainFloor` and `withAskingUnits` each filter `result.source !== "session"`, on the premise that a session-granted unit is an `ask` that must be left out.
- `isUnconditionalDeny` (`src/handlers/gates/descriptor.ts`) excludes a session-sourced `deny`, with a comment that the runner's fast path allows any session-sourced check; `test/handlers/gates/descriptor.test.ts` pins it (`rejects a session-sourced deny, which the runner's fast path allows`).
- `resolveBashCommandCheck` is shared with the advisory service check (`src/service/bash-advisory-check.ts`), so the published service's `bash` answer changes the same way and stays at parity with the gate.
- Principle 3 of the architecture doc ("session approvals are just more rules") governs matching, not what the gate does with a matched rule: this change adds no matcher and no pre-check.

### Reproduction

The planner reproduced the defect through the real parser (`BashProgram.parseSync`), the real `PermissionResolver`, an in-memory `PermissionManager` over `{"*": "allow", "git push *": "ask"}`, and a real session ruleset built with `sessionRule("bash", "sudo rm y")`, in a disposable spike test (measured, then deleted):

| command                             | today                                                                      | with the fix (spiked)                                       |
| ----------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `sudo rm y && git push origin main` | `ask`, `source: "session"`, `command: "sudo rm y"`                         | `ask`, `source: "bash"`, `command: "git push origin main"`  |
| `git push origin main && sudo rm y` | `ask`, `source: "bash"`                                                    | unchanged                                                   |
| `sudo rm y`                         | `ask`, `source: "session"`, `matchedPattern: "<indirection-bash-wrapper>"` | `allow`, `source: "session"`, `matchedPattern: "sudo rm y"` |
| `sudo rm y && sudo rm z`            | `ask`, `source: "session"`, `command: "sudo rm y"`                         | `ask`, `source: "bash"`, `command: "sudo rm z"`             |

With both guards in place the full suite showed 1 red of 5665: the test that pins the old `ask`/`session` shape (measured).
With the two `source !== "session"` filters also removed, `test/handlers/gates` and `test/composition-root.test.ts` stayed green apart from that test (measured).
With the runner hardened as well, the suite showed 2 reds: the bash-command test above and the runner test named in Background (measured).

The local review log holds 113 `permission_request.session_approved` entries whose session pattern is a floor sentinel out of 11501 `session_approved` matches (measured with `grep` on `~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`); each is this shape, and after the fix such an entry names the grant's own pattern.

## Design Overview

The decision taken at the `Decide` gate: a session grant is exempt from the floors (option A), and the runner's fast path requires a session `allow` (hardening).

### The floors skip a session grant

A floor exists because the parse cannot vouch for what an `allow` covers.
A session grant was given for that exact command after the user saw it, so the floor has no reason to hold, and the serving node's `honorChildFloor` already reasons the same way.
Each floor guards its own input, because the two read different values:

- The wrapper branch in `resolveCommandUnit` reads `base` (the unit's own rule): `cmd.wrapperKind && base.state === "allow" && !isSessionGrant(base)`.
- `floorUnparsedUnit` reads `resolved`, which can be the inner-rule result of `resolveWrapperUnit`'s exemption branch and so can itself be a session grant: `if (!cmd.parseUnresolved || resolved.state !== "allow" || isSessionGrant(resolved)) return resolved;`.

A single early return in `resolveCommandUnit` was considered and rejected: a return on `base` misses a session-granted exempt inner command, and a return on the floored value comes after `floorToAsk` has already run.
A guard inside `floorToAsk` was rejected too: it would change a clamp's contract, and `floorUnparsedUnit` would still replace a session `allow`'s `command` with the whole line.

```typescript
/** A check the session layer decided, which only ever records an `allow`. */
function isSessionGrant(check: PermissionCheckResult): boolean {
  return check.source === "session";
}
```

`isSessionGrant` is private to `bash-command.ts`, placed below its callers.

### The chain combiner needs no session knowledge

With no session-sourced `ask` left, `pickMostRestrictive` ranks a session-granted unit as the `allow` it is, so any rule-raised or floored `ask` beats it regardless of order.
The `source !== "session"` filters in `withChainFloor` and `withAskingUnits` become dead: a session-granted unit has no `floor` and is not an `ask`.
They are removed, and their doc comments drop the session sentence; the existing tests `leaves out a floored unit the session already granted` and `leaves out a unit the session already granted` keep pinning the outcome through the state.

Edge cases, each tested in Step 1:

- A lone session-granted wrapper resolves `allow`/`session` with the grant's pattern, and takes the fast path.
- A chain whose units are all session-granted resolves `allow`/`session` (the first unit wins the tie), which is the roadmap step's Constraint.
- A chain mixing a session-granted unit with a rule-allowed one resolves `allow`; which unit is reported follows `pickMostRestrictive`'s first-wins tie, as it already does for an unwrapped session grant.
  The review log for `ls && sudo rm y` therefore records a rule allow rather than `session_approved`: an observable provenance change, consistent with how an unwrapped grant is logged today.
- A `parseUnresolved` unit whose own text is session-granted resolves `allow`/`session`, keeping the unit's `command` (no whole-line rewrite, since no floor ran).
- A session-granted wrapper beside a second, ungranted wrapper asks for the second, naming its floor.

### The runner takes the fast path only for a session allow

`GateRunner.runDescriptor`'s step 2 becomes `if (check.source === "session" && check.state === "allow")`.
After the floors change no input reaches the runner as a session-sourced `ask` or `deny`, so this changes nothing reachable; it means a future floor that spreads a grant again prompts instead of approving.

`isUnconditionalDeny`'s `check.source !== "session"` clause rests on the old runner precedence ("a session-sourced check is allowed there").
Under the hardened runner a session-sourced `deny` reaches `applyPermissionGate` and blocks, so it is unconditional; the clause is removed and the comment rewritten, keeping the predicate correct on its own terms.

## Module-Level Changes

- `src/handlers/gates/bash-command.ts`
  - Add private `isSessionGrant`; guard the wrapper branch of `resolveCommandUnit` and `floorUnparsedUnit` with it.
  - Rewrite the doc comments of `floorUnparsedUnit` and `floorToAsk` (the "spread carries a session grant to the fast path" sentences) to say a session grant is never floored.
  - Remove the `source !== "session"` filters from `withChainFloor` and `withAskingUnits`, and the session sentences from their doc comments.
- `src/handlers/gates/runner.ts`: the session fast path requires `state === "allow"`; update the step-2 comment.
- `src/handlers/gates/descriptor.ts`: `isUnconditionalDeny` drops its session clause and rewrites the paragraph about the runner's precedence.
- `docs/architecture/architecture.md`
  - The `bash-command.ts` module-tree entry (line ~982): replace "the result spreads the resolved check, so a `source: "session"` grant reaches `GateRunner`'s session fast path, which tests the source before the state (#840)" with the session-grant exemption, and drop "and is not session-granted" / "and was not session-granted" from the `withChainFloor` / `withAskingUnits` sentences.
  - The `descriptor.ts` entry (line ~971): rewrite the `isUnconditionalDeny` constraint.
  - Mark the `#### [#1033]` step heading and its `S1033` Mermaid node `✅`, reword its `Target:` bullet to the floors (the tie is no longer the mechanism), and add its `Landed:` note.
- Predicted unchanged:
  - `src/policy/serving-policy.ts`: `honorChildFloor`'s session clause is about the serving node's own grants, and its comment ("the local gate honors through its session fast path") stays true for a session `allow`.
  - `src/policy/restrictiveness.ts`: its tie rule is not changed.
  - `src/handlers/gates/tool.ts`: `floorFact` / `askingUnitsFact` read whatever the result carries.
  - `.pi/skills/package-pi-permission-system/SKILL.md`: grepped for "fast path" and "session grant", with no passage on this mechanism.
  - `README.md` and `docs/*.md`: grepped for the same terms; there is no prose on the floor's session exemption.

### Tests

- `test/handlers/gates/bash-command.test.ts`: new chain tests over the real resolver (`decide`), and the `carries a session grant through the floor` test rewritten.
- `test/handlers/gates/runner.test.ts`: the `honours a session grant that survived the unparsed-subtree floor` test is rewritten to assert that a session `ask` escalates.
- `test/handlers/gates/descriptor.test.ts`: the `rejects a session-sourced deny` test flips to accept it.

## Test Impact Analysis

1. Newly possible tests: none at a new seam.
   The `decide` helper (real parse, manager, resolver, session ruleset) already reaches the defect, and Step 1 adds the observed scenario there.
2. Redundant tests: none removed.
   The two `leaves out … the session already granted` tests keep their assertions and now pass through the state rather than the filters.
3. Tests that stay as-is because they exercise the layer: the `#1029` floor tests and the `#1030` asking-units tests in `bash-command.test.ts`, and the forwarding tests that consume `askingUnits`, all of which stay green in the spike.

## Invariants at risk

- [#1029] Outcome: a floor raised on any asking unit rides the chain-level `floor`, and a session-granted unit's floor is left out.
  Pinned by `stamps the floored unit's sentinel on the rule-asking winner` and `leaves out a floored unit the session already granted` (real resolver; opened, neither mocks the combiner).
- [#1030] Outcome: `askingUnits` lists every unit the child left asking, excluding child-allowed and session-granted units.
  Pinned by `names each unit's own floor` and `leaves out a unit the session already granted` (real resolver).
  Constituency: the serving node, which judges exactly those units; a session-granted unit still stays home, now because it is an `allow`.
- [#840] Outcome: a session grant the user gave for a command survives the unparsed-subtree floor.
  The rewritten `carries a session grant through the floor` test keeps pinning it, now as `allow`/`session`, and the fast path still approves it.
- The advisory service check stays at parity with the gate: it calls the same `resolveBashCommandCheck`, so no separate test is needed; its answer for a session-granted wrapper moves from `ask` to `allow`, matching what the gate does.

## TDD Order

1. **`fix(pi-permission-system): a session grant on one bash unit no longer approves the chain's other asking units`**
   - Red: in `bash-command.test.ts`, add a `describe("a session grant covers only the unit it names")` under the real resolver with these tests:
     - `sudo rm y && git push origin main` with grant `sudo rm y` → `ask`, `source: "bash"`, `command: "git push origin main"`.
     - `sudo rm y && sudo rm z` with grant `sudo rm y` → `ask`, `command: "sudo rm z"`, `floor: "<indirection-bash-wrapper>"`.
     - A lone `sudo rm y` with its grant → `allow`, `source: "session"`, `matchedPattern: "sudo rm y"`, no `floor`.
     - `sudo rm y && sudo rm z` with both granted → `allow`, `source: "session"`.
   - Rewrite `carries a session grant through the floor` (the `parseUnresolved` unit with a session `allow`) to expect `allow`, `source: "session"`, and `command` equal to the unit text, not the whole command.
   - Green: add `isSessionGrant` and the two guards; remove the `source !== "session"` filters from `withChainFloor` and `withAskingUnits`; rewrite the four doc comments.
   - Killing mutations:
     - Delete `&& !isSessionGrant(base)` from the wrapper branch: the first, second, third, and fourth new tests go red.
     - Delete `|| isSessionGrant(resolved)` from `floorUnparsedUnit`: the rewritten unparsed test goes red.
   - Verify: the full package suite, `pnpm --filter @gotgenes/pi-permission-system run check`, and `lint`.
2. **`refactor(pi-permission-system): take the session fast path only for a session allow`**
   - Red: rewrite the runner test `honours a session grant that survived the unparsed-subtree floor` as `escalates a session-sourced ask instead of approving it`: a resolved `ask`/`source: "session"` reaches `deps.escalate`, and no `permission_request.session_approved` entry is written.
     Flip the descriptor test to `accepts a session-sourced deny, which the runner blocks`.
   - Green: add `&& check.state === "allow"` to the runner's session fast path and update its comment; drop `isUnconditionalDeny`'s session clause and rewrite its paragraph.
   - Killing mutations:
     - Revert the runner condition to `check.source === "session"`: the rewritten runner test goes red.
     - Restore `&& check.source !== "session"` in `isUnconditionalDeny`: the flipped descriptor test goes red.
   - Typed `refactor:` because no reachable input changes after Step 1, so it carries no changelog entry.
3. **`docs(pi-permission-system): record that a session grant is exempt from the bash floors`**
   - The `architecture.md` module-tree entries for `bash-command.ts` and `descriptor.ts`.
   - The `#### [#1033]` step: `✅` on the heading and the `S1033` Mermaid node, a reworded `Target:` bullet, and a `Landed:` note naming Steps 1 and 2.
   - Verify: `pnpm exec rumdl check packages/pi-permission-system/docs/architecture/architecture.md`.

## Risks and Mitigations

- **A session grant on a wrapper is now trusted without its floor, under any width.**
  It already was: the fast path approved the floored `ask`/`session` for a lone unit, so the set of single-unit commands a grant approves is unchanged (spiked: the lone `sudo rm y` row).
- **Review-log provenance shifts for mixed chains.**
  A chain of one rule-allowed and one session-granted unit can now log a rule allow where it logged `session_approved`; this matches how an unwrapped grant is already logged, and the Design Overview records it.
- **A hidden second producer of `ask`/`session`.**
  Searched `src/` for `"session"`: `SessionRules` records only `allow`, and the only spreading clamp is `floorToAsk`; Step 2's hardening makes any producer this search missed fail closed rather than approve.
- **Hardening removes a fast path something relied on.**
  The spike with the floor guards, the filter removal, and the runner condition showed exactly two reds, both tests of the `ask`/`session` shape this plan removes.
  The `isUnconditionalDeny` change was not spiked; its only pin is the descriptor test Step 2 flips.

## Open Questions

None.

[#1029]: https://github.com/gotgenes/pi-packages/issues/1029
[#1030]: https://github.com/gotgenes/pi-packages/issues/1030
