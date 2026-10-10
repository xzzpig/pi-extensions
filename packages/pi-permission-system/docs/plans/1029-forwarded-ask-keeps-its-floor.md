---
issue: 1029
issue_title: "pi-permission-system: a forwarded bash ask loses the wrapper floor and auto-approves under a permissive catch-all"
---

# A forwarded bash ask keeps the floor that raised it

## Release Recommendation

**Release:** ship independently

This issue's roadmap step in `docs/architecture/architecture.md` (Phase 15, Track D) is tagged `Release: independent`, and it belongs to no release batch.

## Problem Statement

A subagent's gate raises a bash `ask` through a synthetic floor rather than through a rule.
The floor is one of four sentinels: the indirection wrapper floor (`sudo`, `xargs`, `find -exec`, …), the opaque-payload floor (`bash -c`, `eval`), the partial-parse floor (`<unparsed-bash-subtree>`), or the empty-parse sentinel (`<unparseable-bash-command>`).
The child has no UI, so it forwards that ask to its parent.
The forwarded request carries only `matchValues: [command]`, and the parent resolves that value against its own rules.
A parent `bash: *` allow therefore auto-approves the very ask the floor exists to raise, and the command runs without anyone seeing it.

The issue's observed case was a `pre-completion-reviewer` subagent running `time find . -delete` and `time rm x`.
The review log recorded `permission_request.waiting` with `matchedPattern: <indirection-bash-wrapper>`, followed by `forwarded_permission.auto_approved` with `decidedBy: {kind: rule, surface: bash, pattern: "*", origin: global}`.

## Goals

- A forwarded bash ask that a floor raised on the child is escalated to the serving node's `Authorizer` instead of being approved by a serving-node `allow` rule.
- The floor travels when **any** asking unit of the chain was floored, not only the winning unit, so `git push x && sudo rm y` keeps the floor even when the `git push *: ask` unit wins the tie.
- A serving-node `deny` still auto-denies, and an explicit serving `ask` still escalates.
- A serving-node **session grant** still auto-approves, as a floored session grant does locally, so "approve for the whole serving session" keeps working for floored commands.
- A serving node in `yoloMode` still auto-approves the forwarded floored ask, as yolo approves every floored ask locally (`docs/configuration.md` § the synthetic-ask paragraph).
- The serving review log records the floor on the `forwarded_permission.prompted` entry, so an escalation that would once have auto-approved is auditable to its reason.
- Non-breaking: `fix:` (operator decision).
  The change restores the documented floor contract across the forwarding wire.

## Non-Goals

- **The serving node judging only the winning unit** — `ls && rm -rf /tmp/x` under a child `*: ask` and a parent `ls*: allow` forwards `ls` alone, and the parent approves the whole line.
  It is filed as [#1030] and placed as the next Phase 15 step; this plan closes only the floored variant of it.
- **Forwarding a unit's spellings** ([#1019]).
  It is the same wire losing a different child-fixed fact, and [#1030]'s per-unit wire shape is its natural home.
- **Splitting yolo per node** ([#1031]).
  A parent in yolo approving a child's forwarded floored ask is today's meaning of yolo; setting it for a child separately from its parent is a feature.
- **Lifting the floor for a rule that pins the inner command** (third-party PR [#971]).
  If it lands, the child stops raising the floor for that shape, so it stops stamping one too; nothing here needs to change for it.
- **Exposing the floor to the bounded-delegation checkpoint.**
  `bash` is not a delegation-excluded surface, and a link judging a floored ask locally already sees the same ask; the floor is projected onto the ask details so a link may read it, but no checkpoint branches on it.
- **ADR 0008's illustrative schema block.**
  The ADR records the decision; `docs/architecture/architecture.md` describes the current wire.
- **A version-skewed pair.**
  An older child sends no floor, and an older serving node drops it in its allowlist reader; either way the pair behaves as it does today.
  Both nodes in one process load the same package, so the window is an out-of-process child across an upgrade.

## Background

- `resolveBashCommandCheck` (`src/handlers/gates/bash-command.ts`) resolves each command unit on the `bash` surface and returns the most restrictive (`pickMostRestrictive`, first-wins on ties).
  The four synthetic asks are raised there: `resolveWrapperUnit`'s floored branch (`WRAPPER_SENTINEL`), `floorUnparsedUnit` (`UNPARSED_SUBTREE_SENTINEL`), and the inline `<unparseable-bash-command>` literal.
  The wrapper and unparsed floors spread the resolved check, so a `source: "session"` grant survives to `GateRunner`'s session fast path (`src/handlers/gates/runner.ts`), which tests the source before the state.
- `describeToolGate` (`src/handlers/gates/tool.ts`) builds the child-fixed facts with `accessFactsFromValue(gateSurface, decisionValue)`, and `decisionValue` is the winning unit's `command`.
- `ParentAuthorizer` (`src/authority/approval-escalator.ts`) spreads `facts.accessIntent` into the wire `ForwardedAccessIntent`, so a new facts field reaches the request without an edit there.
- `asForwardedAccessIntent` (`src/authority/forwarding-io.ts`) is an allowlist reader that rebuilds the intent field by field, so a field it does not name is dropped on read.
- `ForwardedRequestServer.resolveDecision` (`src/authority/forwarded-request-server.ts`) calls `policy.resolve(request.accessIntent)`.
  A non-`ask` result auto-approves or auto-denies with a `decidedBy: {kind: "rule", …}`; an `ask` escalates through `escalateAsk`.
  `toAccessFacts` projects the wire intent onto the escalated ask field by field, with an explicit return type, as a disclosure boundary.
- `ServingPolicy` is implemented inline in `src/index.ts` as `buildResolvedIntentFromMatchValues` plus `resolver.resolve`.
  The `ServingPolicy resolves a forwarded request against real recorded authority` block in `test/authority/forwarded-request-server.test.ts` rebuilds that lambda by hand "exactly as `index.ts` wires it", so a drift between the two is invisible.
- `resolveYoloGrant` (`src/handlers/gates/helpers.ts`) approves a synthetic `ask` under yolo locally; the serving node never consults yolo today, except through the rule rewrite that turns an `ask` rule into an `allow` of `origin: "yolo"`.
- Zone constraints, checked with `pnpm --silent fallow guard`: `authority/` may **not** import `policy/`, while `policy/` may import `access-intent/` and import `authority/` type-only.
  So the serving policy implementation lives in `policy/`, not `authority/`.

### Reproduction

A disposable spike (deleted) used the real `warmBashParser` + `parseBashCommandsSync`, the real `resolveBashCommandCheck` over an in-memory `PermissionManager` + `PermissionResolver` for the child, and the serving node's real composition (`buildResolvedIntentFromMatchValues` + `PermissionResolver.resolve`).
With the child at `{"*": "allow", "git push *": "ask"}` and the serving node at `{"*": "allow"}`, measured:

| command                             | child                                            | serving (today) |
| ----------------------------------- | ------------------------------------------------ | --------------- |
| `sudo rm x`                         | ask `<indirection-bash-wrapper>`                 | allow `*`       |
| `bash -c 'rm x'`                    | ask `<opaque-bash-wrapper>`                      | allow `*`       |
| `xargs rm < list`                   | ask `<indirection-bash-wrapper>`                 | allow `*`       |
| `git push origin main && sudo rm x` | ask `git push *`, command `git push origin main` | allow `*`       |

The local review log (`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`, 2026-07-13 → 2026-10-05) joins `forwarded_permission.auto_approved` with `decidedBy.surface == "bash"` to the child's `permission_request.waiting` by `requestId`.
Measured: 74 of 74 such auto-approvals were floored asks — 60 `<indirection-bash-wrapper>`, 12 `<opaque-bash-wrapper>`, 2 `<unparsed-bash-subtree>`.
So the fix turns about 74 silent parent approvals over three months into parent prompts (measured on one operator's log).

## Design Overview

The floor is a child-fixed fact (ADR 0008): only the child's parse knows a unit was a wrapper or failed to parse, and the serving node cannot recompute it.
So it rides the facts, and the serving node applies it to its own judgment exactly as the child applied it to its own: an `allow` is clamped to `ask`.

### The fact on the child

`PermissionCheckResult` gains one optional field:

```typescript
/**
 * The synthetic pattern of a floor that raised this ask on the chain — on the
 * deciding unit, or on another asking unit of the same command (#1029).
 * The serving node of a forwarded ask clamps its own `allow` with it.
 */
floor?: string;
```

The four synthetic sites stamp it with their sentinel.
After `pickMostRestrictive`, when the winner is an `ask` with no floor of its own, the winner takes the floor of the first other asking unit that has one and whose `source` is not `"session"`.
A session-sourced floored unit is excluded because the user already approved that unit exactly.

```typescript
const winner = pickMostRestrictive(results) ?? resolveOnBashSurface(…);
return withChainFloor(winner, results);

function withChainFloor(winner, results) {
  if (winner.state !== "ask" || winner.floor !== undefined) return winner;
  const floored = results.find((r) => r.floor !== undefined && r.source !== "session");
  return floored ? { ...winner, floor: floored.floor } : winner;
}
```

A `deny` winner carries no floor (a deny is never forwarded), and the whole-command `deny` path returns before any unit is resolved.
A wrapper the enumerator exempts (`floorExemption`) is resolved by its inner command's rule and raises no floor, so it stamps none.

### The fact on the wire

`ForwardedAccessFacts` gains `floor?: string`.
`describeToolGate`'s value branch adds it with a conditional spread, so a non-floored ask's facts keep their exact current shape:

```typescript
: { ...accessFactsFromValue(gateSurface, decisionValue), ...floorFact(check) };
```

`asForwardedAccessIntent` keeps `floor` when it is a string and rejects the whole intent when it is present and not a string.
Rejecting falls to the version-skew floor (no intent → escalate), which is the fail-safe direction; a malformed floor never reads as "no floor".
`toAccessFacts` projects `floor` with a conditional spread, so `details.accessIntent` keeps its current three-field shape for an unfloored ask.

### The judgment on the serving node

A new `ResolverServingPolicy` class (`src/policy/serving-policy.ts`) implements `ServingPolicy` and replaces the `index.ts` lambda:

```typescript
export class ResolverServingPolicy implements ServingPolicy {
  constructor(
    private readonly resolver: Pick<PermissionResolver, "resolve">,
    private readonly isYoloEnabled: () => boolean,
  ) {}

  resolve(intent: ForwardedAccessIntent): PermissionCheckResult {
    const check = this.resolver.resolve(
      buildResolvedIntentFromMatchValues(intent.surface, intent.matchValues, intent.principal.agentName),
    );
    return honorChildFloor(check, intent.floor, this.isYoloEnabled());
  }
}

function honorChildFloor(check, floor, yoloEnabled) {
  if (floor === undefined || check.state !== "allow" || check.source === "session") return check;
  return yoloEnabled
    ? { ...check, origin: "yolo", matchedPattern: floor }
    : { ...check, state: "ask", matchedPattern: floor };
}
```

`index.ts`'s call site becomes one line, `new ResolverServingPolicy(resolver, isYoloEnabled)`, and `ForwardedRequestServer`'s deps bag does not grow.
The yolo branch mirrors `resolveYoloGrant`'s second arm: the floor's sentinel stays the reported pattern, and `origin: "yolo"` records why it was granted.
On the server, that result logs `forwarded_permission.auto_approved` with `decidedBy: {kind: "rule", surface: "bash", pattern: "<indirection-bash-wrapper>", origin: "yolo"}`.
That is the serving node's existing convention for a yolo grant, which already reports a rewritten `ask` rule as `kind: "rule"` with `origin: "yolo"`.

`ForwardedRequestServer.resolveDecision` is otherwise unchanged; it adds `floor` to the `forwarded_permission.prompted` details when `request.accessIntent?.floor` is set.

### Outcomes by serving-node rule

| serving resolution of the forwarded value                    | floor absent (today, and unfloored asks) | floor present                                   |
| ------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------- |
| `deny`                                                       | auto-deny                                | auto-deny                                       |
| `ask` rule                                                   | escalate                                 | escalate                                        |
| `allow` rule, yolo off                                       | auto-approve                             | **escalate**                                    |
| `allow` rule or yolo-rewritten rule, yolo on                 | auto-approve                             | auto-approve, `origin: "yolo"`, pattern = floor |
| session grant (`source: "session"`)                          | auto-approve                             | auto-approve                                    |
| request carries no `accessIntent` (skew, or malformed floor) | escalate                                 | escalate                                        |

Each row is pinned in a named step: the `allow`/`deny`/`ask`/session/yolo rows in Step 4, the malformed-floor row in Step 3.

## Module-Level Changes

- `src/handlers/gates/bash-command.ts` — Step 1: name `UNPARSEABLE_COMMAND_SENTINEL`, and route the wrapper and unparsed floors through one `floorToAsk(resolved, sentinel)` helper.
  Step 2: the three sites stamp `floor`, and `withChainFloor` aggregates a non-winning unit's floor onto an `ask` winner.
- `src/types.ts` — `PermissionCheckResult.floor?: string` (Step 2).
- `src/policy/serving-policy.ts` — **new**: `ResolverServingPolicy` (Step 3 extracts it unchanged; Step 4 adds `honorChildFloor`).
- `src/index.ts` — the `servingPolicy` lambda becomes `new ResolverServingPolicy(resolver, isYoloEnabled)` (Step 3); the `buildResolvedIntentFromMatchValues` import moves out (Step 3).
- `src/authority/permission-forwarding.ts` — `ForwardedAccessFacts.floor?: string` with its doc (Step 3).
- `src/handlers/gates/tool.ts` — `describeToolGate` carries `check.floor` onto the value-branch facts (Step 3).
- `src/authority/forwarding-io.ts` — `asForwardedAccessIntent` keeps or rejects `floor` (Step 3).
- `src/authority/forwarded-request-server.ts` — `toAccessFacts` projects `floor` (Step 3); `resolveDecision` logs it on `forwarded_permission.prompted` (Step 4); the `ServingPolicy` doc names the floor (Step 4).
- `docs/configuration.md` — the synthetic-ask paragraph (line ~535) gains a sentence: a subagent's floored ask keeps its floor when forwarded; the parent's `allow` rule does not answer it, while its `deny`, a whole-session grant, and yolo do (Step 5).
- `docs/subagent-integration.md` § Permission Forwarding — the "A parent `allow`/`deny` rule governs a child's escalation directly" sentence gains the floor exception (Step 5).
- `docs/architecture/architecture.md` — Step 5:
  - module-tree entries for `bash-command.ts` (floor stamping and chain aggregation), `permission-forwarding.ts` (the facts' `floor`), and `forwarded-request-server.ts` (projects `floor`, logs it on `prompted`, `ServingPolicy` honors it);
  - a new `serving-policy.ts` entry under `policy/`;
  - the `permission-resolver.ts` entry's sentence naming the `ServingPolicy resolves a forwarded request against real recorded authority` block in `test/authority/forwarded-request-server.test.ts`, which moves to `test/policy/serving-policy.test.ts`;
  - the roadmap step `#### [#1029]` heading gains `✅`, plus a `Landed:` note; the Mermaid node `S1029` gains `✅`.
- `.pi/skills/package-pi-permission-system/SKILL.md` — predicted unchanged.
  It names neither `ServingPolicy` nor the floor wire (grep `ServingPolicy|buildResolvedIntentFromMatchValues|floor` over the skill at Step 5 to confirm).
- `src/authority/approval-escalator.ts` — predicted unchanged: `buildForwardedRequest` spreads `facts.accessIntent`, so `floor` reaches the request; Step 3's composition-root test pins that.
- `src/handlers/gates/helpers.ts` — predicted unchanged: `accessFactsFromValue`'s other callers (`skill-input.ts`, `skill-read.ts`) never floor, so it takes no `floor` parameter.
- `src/service/bash-advisory-check.ts` — predicted unchanged; `PermissionsService.checkPermission`'s bash result gains the optional `floor` field additively.

### Tests

- `test/handlers/gates/bash-command.test.ts` — Step 2 (floor stamping, chain aggregation).
- `test/policy/serving-policy.test.ts` — **new**: Step 3 moves the `ServingPolicy resolves a forwarded request against real recorded authority` block here, constructing `ResolverServingPolicy` instead of the hand-built lambda; Step 4 adds the floor rows.
- `test/authority/forwarded-request-server.test.ts` — Step 3 drops the moved block and adds the `toAccessFacts` projection test; Step 4 adds the `prompted` log test.
- `test/handlers/gates/tool.test.ts` — Step 3 (floor on the facts; unfloored shape unchanged).
- `test/authority/forwarding-io.test.ts` — Step 3 (`readForwardedPermissionRequest — accessIntent field` gains the floor cases).
- `test/composition-root.test.ts` — Step 3 (a child's forwarded `sudo rm x` request file carries `accessIntent.floor`).

## Test Impact Analysis

1. New tests the extraction enables: `ResolverServingPolicy` is the real serving composition, so the floor rows are tested against a filesystem-backed `PermissionManager` and a real `SessionRules` (session-grant row) rather than a stubbed `policy`.
2. Redundant tests: the hand-built `servingPolicyOver` lambda in `forwarded-request-server.test.ts` duplicated `index.ts`; it is replaced by the class, not kept beside it.
3. Tests that stay: every `processInbox` test that stubs `policy` still exercises the server's branch on the policy's result; only the `prompted` log gains a floor case.
   Existing exact-equality assertions on an unfloored ask (`tool.test.ts` "carries the single decision value…", `forwarded-request-server.test.ts` line ~602 `details.accessIntent` `toEqual`, `forwarding-io.test.ts` round-trip `toEqual(accessIntent)`) stay green because every addition is a conditional spread.
   A bare `floor: check.floor` turns them red, which is the check that the spread is conditional.

## Invariants at risk

- **ADR 0008 §4 — a request without facts escalates.**
  Pinned by the existing `processInbox — recorded-authority resolution` tests that send no `accessIntent`; Step 3's malformed-floor reader test extends it (a non-string floor drops the intent, so it escalates).
- **The surface-family fold reaches the serving node** (#712, #806, the `permission-resolver.ts` constraint).
  Pinned by the block Step 3 moves; after the move it runs against the class `index.ts` actually constructs, which strengthens it.
- **A deny never becomes approvable** (#712).
  Step 4's deny row with a floor present.
- **`toAccessFacts` is a disclosure boundary** (#635): `requesterCwd`/`principal` stay off the ask.
  Pinned by the existing `processInbox — child-fixed access facts on the escalated ask` test's `toEqual`, which Step 3 extends with a floored case.
- **#963's execution-modifier exemption** (Phase 15 `Outcome:`): `time rm x` resolves by `rm`'s own rule.
  An exempt wrapper raises no floor, so it stamps none; Step 2 pins that an exempt unit's result has no `floor`.

## TDD Order

1. **refactor: one helper for the bash floors** (`test/handlers/gates/bash-command.test.ts`, unchanged).
   Prepares Step 2's friction: the four sentinels are two named constants and an inline literal, and Step 2 must stamp `floor` at every site; a site that sets `matchedPattern` without `floor` silently reopens the hole.
   Add `UNPARSEABLE_COMMAND_SENTINEL`; extract `floorToAsk(resolved, sentinel)` (state `ask`, `matchedPattern: sentinel`, the rest spread) and use it in `resolveWrapperUnit`'s floored branch and `floorUnparsedUnit` (which still overrides `command`).
   Verify: `bash-command.test.ts`, `bash-advisory-check.test.ts` green.
   Commit: `refactor(pi-permission-system): raise every bash floor through one helper`.
2. **refactor: the child stamps the floor that raised an ask** (`test/handlers/gates/bash-command.test.ts`, new `describe("floor")`).
   Tests:
   - `sudo rm x`, `bash -c 'rm x'`, a partial parse, and an empty-parse command each yield `floor` equal to their `matchedPattern` under a `*` allow;
   - `git push origin main && sudo rm x` under `{"*": "allow", "git push *": "ask"}` yields `command: "git push origin main"`, `matchedPattern: "git push *"`, `floor: "<indirection-bash-wrapper>"`;
   - a chain whose floored unit is session-sourced yields no `floor`;
   - a `deny` winner yields no `floor`;
   - an exempt `time rm x` yields no `floor`;
   - a plain rule `ask` yields no `floor`.
   Killing mutations: delete the `floor` assignment in `floorToAsk` (kills the wrapper and unparsed cases); delete it from the unparseable literal (kills the empty-parse case); make `withChainFloor` return `winner` unconditionally (kills the chain case); drop the `source !== "session"` clause (kills the session case).
   No user-observable change yet (nothing reads `floor`), hence `refactor:`.
   Commit: `refactor(pi-permission-system): record which floor raised a bash ask`.
3. **refactor: the floor rides the wire, and the serving policy becomes a class** (`tool.test.ts`, `forwarding-io.test.ts`, `forwarded-request-server.test.ts`, `serving-policy.test.ts`, `composition-root.test.ts`).
   Extract `ResolverServingPolicy` from the `index.ts` lambda unchanged (no floor yet), and move the `ServingPolicy resolves…` block to `test/policy/serving-policy.test.ts` against the class.
   Add `ForwardedAccessFacts.floor`, the `describeToolGate` spread, the reader, and the `toAccessFacts` projection.
   Tests:
   - `describeToolGate` with a `floor`-carrying check emits it on `promptDetails.accessIntent`;
   - the reader keeps a string floor, and returns no `accessIntent` for `floor: 42`;
   - `toAccessFacts` projects a floor onto `details.accessIntent` (`toEqual` four fields);
   - a composition-root child under `{"*": "allow"}` firing `bash` `sudo rm x` writes a request whose `accessIntent.floor` is `<indirection-bash-wrapper>`, with the parent answered by `approveForwardedRequest` (the gate parses asynchronously, so no parser warm-up is needed).
   Killing mutations: drop the spread in `describeToolGate` (kills the tool and composition-root tests); drop `floor` from the reader's return (kills the reader test); make the reader ignore a non-string floor instead of rejecting (kills `floor: 42`); drop `floor` from `toAccessFacts` (kills the projection test).
   The serving node still ignores the floor, hence `refactor:`.
   Commit: `refactor(pi-permission-system): carry a bash ask's floor onto the forwarded request`.
4. **fix: the serving node honors the child's floor** (`test/policy/serving-policy.test.ts`, `test/authority/forwarded-request-server.test.ts`).
   Tests, each over a filesystem-backed manager, a floored `bash` intent `sudo rm x`, and `ResolverServingPolicy`:
   - `{"*": "allow"}` → `ask`, `matchedPattern: "<indirection-bash-wrapper>"`;
   - `{"*": "allow", "sudo *": "deny"}` → `deny`;
   - `{"*": "ask"}` → `ask` with the rule's own pattern;
   - a `SessionRules` grant for `sudo rm x` → `allow`, `source: "session"`;
   - yolo on under `{"*": "allow"}` → `allow`, `origin: "yolo"`, `matchedPattern: "<indirection-bash-wrapper>"`;
   - the same intent without `floor` under `{"*": "allow"}` → `allow` `*` (the control).
   Server: a floored request whose stubbed policy returns `ask` logs `forwarded_permission.prompted` with `floor`.
   Killing mutations: make `honorChildFloor` return `check` unconditionally (kills the allow row; the control stays green); drop the `source === "session"` clause (kills the session row); drop the yolo branch (kills the yolo row); drop the `check.state !== "allow"` guard so a deny is rewritten (kills the deny row); drop `floor` from the `prompted` details (kills the server test).
   Commit: `fix(pi-permission-system): a subagent's floored bash ask prompts on the parent instead of riding its allow rule`.
5. **docs** — `docs/configuration.md`, `docs/subagent-integration.md`, and the `docs/architecture/architecture.md` entries and roadmap marks listed in Module-Level Changes.
   Re-read the Mermaid block after marking `S1029`.
   Commit: `docs(pi-permission-system): a forwarded ask keeps its floor`.

## Risks and Mitigations

- **A floored session grant on the serving node starts escalating**, which would break "approve for the whole serving session" for exactly the commands most likely to repeat (`sudo …`).
  Step 4's session row pins it, against a real `SessionRules`.
- **A non-winning floored unit is lost** (the `git push … && sudo rm` row).
  Step 2's chain test pins the aggregation; the general non-floor case is [#1030].
- **A conditional spread written as a bare assignment** changes the shape of every unfloored ask and breaks exact-equality tests across three files.
  Those tests stay as the guard (Test Impact Analysis item 3).
- **More parent prompts.**
  About 74 forwarded floored asks over three months on the operator's log (measured) now prompt.
  That is the floor contract the README and `docs/configuration.md` already describe; yolo and whole-session grants remain the levers.
- **Drift between `index.ts` and the tested serving composition.**
  Step 3 removes the hand-built replica; the test constructs the class `index.ts` constructs.
  The remaining unpinned edit is `index.ts` passing the wrong yolo reader, which is a one-line review item.

## Open Questions

- Whether [#1030]'s per-unit wire shape subsumes `ForwardedAccessFacts.floor` (a floor per unit) — settle in its plan; this field is the chain-level answer until then.

[#971]: https://github.com/gotgenes/pi-packages/pull/971
[#1019]: https://github.com/gotgenes/pi-packages/issues/1019
[#1030]: https://github.com/gotgenes/pi-packages/issues/1030
[#1031]: https://github.com/gotgenes/pi-packages/issues/1031
