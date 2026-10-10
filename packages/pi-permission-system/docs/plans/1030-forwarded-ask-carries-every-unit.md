---
issue: 1030
issue_title: "pi-permission-system: a forwarded bash ask carries only the chain's winning unit, so the serving node approves commands it never judged"
---

# A forwarded bash ask carries every unit the child left unresolved

## Release Recommendation

**Release:** ship independently

This issue's roadmap step in `docs/architecture/architecture.md` (Phase 15, Track D) is tagged `Release: independent`, and it belongs to no release batch.

## Problem Statement

A subagent's bash gate resolves each command unit of a chain and returns the most restrictive one, first-wins on ties.
When that ask is forwarded, `describeToolGate` puts only the winner's `command` on the wire, and the serving node resolves that one value.
Its answer approves the whole tool call, so every other unit of the line runs without the serving node's policy having judged it.

[#1029] closed the floored variant (a wrapper floor on a non-winning unit now rides the chain-level `floor`).
The plain-rule variant stays open, and the issue's comment adds a second one: a serving session grant covering the winner approves the chain even when a sibling unit carries a floor.

## Goals

- The serving node judges every unit the child left unresolved (an `ask` that is not session-granted), each with its own floor, and the most restrictive answer decides.
- A serving `deny` on any forwarded unit auto-denies the forwarded ask.
- A serving session grant answers only the unit it covers; a sibling unit still decides for itself.
- [#1029]'s per-floor outcomes hold per unit: a rule `allow` on a floored unit escalates, while a `deny`, a serving session grant, and the serving node's yolo still decide.
- A request with no per-unit facts (an older child) keeps today's single-value resolution, and an older serving node reading a newer child's request keeps today's behavior.
- The per-unit shape names the unit's `command` the way `BashCommandAccessIntent` does, so [#1019]'s `spellings` can join the same object.
- Non-breaking: `fix:`, as the roadmap step records.
  The change only adds asks or denies, and only where the serving node's policy covers a unit it never saw before.

## Non-Goals

- **Re-judging units the child allowed** (operator decision).
  A unit whose child rule resolved to `allow` runs on the child without asking anyone, and forwarding it would let the parent veto a command the child never asked about.
  Only the units the child left unresolved travel, which is what ADR 0008 §3 means by "the child carries no judgment upward".
- **The local session-tie bypass** ([#1033], operator decision: file separately, and a new Phase 15 step directly after this one).
  A session-granted floored unit that wins the tie takes `GateRunner`'s session fast path and approves sibling asking units locally.
  When that happens the child never forwards anything, so this plan's per-unit facts never come into play.
  This plan excludes session-granted units from the forwarded set; that premise holds per unit, and [#1033] makes it hold for the chain.
- **Forwarding a unit's spellings** ([#1019]).
  The per-unit object is shaped so `spellings` can be added later, and the serving node already resolves each unit as a `bash-command` intent (with `spellings: []`).
- **Retiring the chain-level `floor` or the top-level `matchValues` summary.**
  An older serving node reads them, and the `forwarded_permission.prompted` entry still logs the chain floor.
- **ADR 0008's illustrative schema block.**
  The ADR records the decision; `docs/architecture/architecture.md` describes the current wire.
- **The model-judge link.**
  `pi-permission-model-judge`'s `typo-reviewer.ts` reads `accessIntent.matchValues` as a path alias set only, so the bash summary it never consults is unchanged.

## Background

- `resolveBashCommandCheck` (`src/handlers/gates/bash-command.ts`) resolves every unit through `resolveCommandUnit`, picks the winner with `pickMostRestrictive`, and then `withChainFloor` carries a non-winning asking unit's floor onto an asking winner.
  The per-unit `results` array exists only inside that function; the returned `PermissionCheckResult` is the winner alone.
- `PermissionCheckResult` (`src/types.ts`) already carries the chain-level `floor?: string` from [#1029].
- `describeToolGate` (`src/handlers/gates/tool.ts`) builds a non-path ask's facts as `{ ...accessFactsFromValue(gateSurface, decisionValue), ...floorFact(check) }`.
- `ForwardedAccessFacts` (`src/authority/permission-forwarding.ts`) is the child-fixed fact schema; `ParentAuthorizer` spreads it onto the request unchanged.
- `asForwardedAccessIntent` (`src/authority/forwarding-io.ts`) is an allowlist reader: an unknown field is dropped, and a present-but-malformed `floor` rejects the whole intent, which escalates.
- `toAccessFacts` (`src/authority/forwarded-request-server.ts`) projects the wire intent onto the escalated ask field by field, with an explicit return type, as a disclosure boundary; a new `ForwardedAccessFacts` field is a compile error there until it is projected or withheld.
- `ResolverServingPolicy` (`src/policy/serving-policy.ts`) resolves `buildResolvedIntentFromMatchValues(surface, matchValues, agentName)`, whose bash branch builds a `tool` intent from `matchValues[0]` alone, then applies `honorChildFloor(check, intent.floor, yolo)`.
- `PermissionResolver.resolve` accepts a `bash-command` intent (`AccessIntent`), which the manager evaluates through `normalizeBashCommand(command, spellings)`; the gate's own `resolveOnBashSurface` emits exactly that intent per unit.
- `mostRestrictiveOf` / `pickMostRestrictive` (`src/policy/restrictiveness.ts`) sit in the same `policy/` zone as `serving-policy.ts`, so the serving policy gains no cross-zone edge.
  `authority/permission-forwarding.ts` gains a type-only import from the root `src/types.ts`, which `authority/forwarded-request-server.ts` already imports.

### Reproduction

A disposable spike (deleted before the plan commit) used the real `warmBashParser` + `parseBashCommandsSync`, the real `resolveBashCommandCheck` over an in-memory `PermissionManager` + `PermissionResolver` for the child, and the real `ResolverServingPolicy` over a second in-memory manager and a real `SessionRules` for the serving node.
Each row ran once; the path is deterministic (no cache, no model), so n = 1 is the result.
Measured on `main` at the planning commit:

| child `bash`                          | serving `bash`                                 | command                             | child forwards                                             | serving answer             |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | -------------------------- |
| `{"*": "ask"}`                        | `{"*": "ask", "ls*": "allow"}`                 | `ls && rm -rf /tmp/x`               | `ls`                                                       | allow `ls*`                |
| `{"*": "ask"}`                        | `{"*": "ask", "ls*": "allow", "rm *": "deny"}` | `ls && rm -rf /tmp/x`               | `ls`                                                       | allow `ls*`                |
| `{"*": "allow", "git push *": "ask"}` | `{"*": "allow"}` + session grant `git push *`  | `git push origin main && sudo rm y` | `git push origin main`, floor `<indirection-bash-wrapper>` | allow, `source: "session"` |

The second row is the sharpest: the parent's explicit `rm *` deny never sees `rm`.

The local review log (`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`, 2026-08-18 → 2026-10-05) joins each `forwarded_permission.auto_approved` entry with `decidedBy.surface == "bash"` to the child's `permission_request.waiting` by `requestId`, and parses the child's command with the real parser.
Measured: 74 such approvals, all floored (the class [#1029] closed); 2 were multi-unit lines, both `<unparsed-bash-subtree>`; 0 were plain-rule chains.
On this operator's log, the fix adds no prompts; its value is the parent policy that no longer gets skipped, not prompt volume.

## Design Overview

The child's per-unit verdicts are child-fixed facts (ADR 0008): only the child's parse knows the units, and only its policy knows which ones it left unresolved.
So each asking unit rides the facts with its own floor, and the serving node runs the child's combiner over its own rules: resolve each unit, honor that unit's floor, most restrictive wins.

### The fact on the child

`src/types.ts` gains a unit type and one optional field:

```typescript
/**
 * One unit of a bash chain the gate left asking, as the serving node of a
 * forwarded ask needs it: the unit as typed, and the floor that raised it.
 */
export interface AskingBashUnit {
  command: string;
  floor?: string;
}

// on PermissionCheckResult:
/**
 * Every unit of the bash chain that resolved to `ask` and was not
 * session-granted, in chain order, each with its own floor. Set only on an
 * asking chain winner; the serving node of a forwarded ask judges each one.
 */
askingUnits?: readonly AskingBashUnit[];
```

`resolveBashCommandCheck` stamps it after `withChainFloor`:

```typescript
const winner = pickMostRestrictive(results) ?? resolveOnBashSurface(…);
return withAskingUnits(withChainFloor(winner, results), results);

function withAskingUnits(winner, results) {
  if (winner.state !== "ask") return winner;
  const askingUnits = results
    .filter((r) => r.state === "ask" && r.source !== "session")
    .map((r) => ({ command: r.command ?? "", ...(r.floor === undefined ? {} : { floor: r.floor }) }));
  return askingUnits.length === 0 ? winner : { ...winner, askingUnits };
}
```

Edge cases, each pinned in Step 2:

- A `deny` winner carries no units (a deny is never forwarded).
- An all-`allow` chain carries none.
- The empty-parse sentinel and trivially-empty paths return before `results` exists, so they carry none and the serving node falls back to the single value, which is the whole command there.
- An unparsed unit's `command` is the **whole** command (`floorUnparsedUnit` replaces it), so that is what is forwarded and judged, which matches what the local prompt names.
- A chain whose only asking units are session-granted gets no `askingUnits` (the local fast path approves it; [#1033] narrows that).
- Duplicate entries (two unparsed units both naming the whole command) are not deduplicated; resolving the same value twice is idempotent.

### The fact on the wire

`ForwardedAccessFacts` gains `askingUnits?: AskingBashUnit[]`.
`describeToolGate`'s value branch adds it with a conditional spread beside `floorFact`, so a non-bash or unit-less ask's facts keep their exact current shape.
`asForwardedAccessIntent` keeps a well-formed array and rejects the whole intent when the field is present and malformed.
Malformed means not an array, an empty array, an entry whose `command` is not a string, or an entry whose `floor` is present and not a string.
Rejecting falls to the version-skew escalation (no intent → `ask`), which is the fail-safe direction; a malformed unit list never reads as "no units".
`toAccessFacts` projects `askingUnits` with a conditional spread, so a link judging the escalated ask sees the same units the local gate's ask carried.

### The judgment on the serving node

```typescript
resolve(intent: ForwardedAccessIntent): PermissionCheckResult {
  const [first, ...rest] = intent.askingUnits ?? [];
  if (first === undefined) return this.resolveValue(intent);   // legacy single value
  const judge = (unit: AskingBashUnit) => this.resolveUnit(unit, intent.principal.agentName);
  return mostRestrictiveOf([judge(first), ...rest.map(judge)]);
}

private resolveUnit(unit, agentName): PermissionCheckResult {
  const check = this.resolver.resolve({ kind: "bash-command", surface: "bash", command: unit.command, spellings: [], agentName });
  return honorChildFloor(check, unit.floor, this.isYoloEnabled());
}
```

`resolveValue` is today's body (Step 1 extracts it).
With units present, the chain-level `intent.floor` and `matchValues` are not consulted: each unit's own floor is the finer fact.
That keeps [#1029]'s outcomes per unit, and it closes the comment's case: the session grant answers `git push origin main`, and the floored `sudo rm y` clamps the parent's `*` allow to `ask`.
`ForwardedRequestServer` is unchanged: it still auto-approves a non-`ask`, auto-denies a `deny` with that unit's rule as `decidedBy`, and escalates an `ask`.
The `decidedBy` of an auto-answer names the winning unit's rule (first-wins on ties), as the local gate's review entry names the winning unit's.

### Outcomes by serving resolution (units present)

| serving resolution across the forwarded units                         | outcome                                  |
| --------------------------------------------------------------------- | ---------------------------------------- |
| any unit `deny`                                                       | auto-deny, that unit's rule              |
| no `deny`; any unit `ask` (rule, or floor clamping a rule `allow`)    | escalate                                 |
| every unit `allow` by rule, none floored                              | auto-approve                             |
| a floored unit's only `allow` is a serving session grant              | that unit approves; siblings decide      |
| a floored unit under serving yolo                                     | that unit approves with `origin: "yolo"` |
| request carries no `askingUnits` (older child, or a single-value ask) | today's single-value path                |
| `askingUnits` present and malformed                                   | intent dropped → escalate                |

Each row is pinned in a named step: the first five in Step 4, the legacy row in Step 4's control test, the malformed row in Step 3.

### Version skew

- Older child → this serving node: no `askingUnits`, so `resolveValue` runs, exactly as today.
- This child → a serving node at [#1029]'s release: its reader drops `askingUnits` and applies the chain-level `floor` to the winner, as it does today.
- This child → a serving node before [#1029]: it drops both, as it does today.
- Both nodes in one process load the same package, so the window is an out-of-process child across an upgrade.

## Module-Level Changes

- `src/policy/serving-policy.ts` — Step 1: extract `resolveValue(intent)` from `resolve` unchanged.
  Step 4: `resolve` branches on `askingUnits`; new private `resolveUnit`; imports `mostRestrictiveOf` and `AskingBashUnit`; the class doc names the per-unit judgment.
- `src/types.ts` — `AskingBashUnit` and `PermissionCheckResult.askingUnits` (Step 2).
- `src/handlers/gates/bash-command.ts` — `withAskingUnits` beside `withChainFloor`, called from `resolveBashCommandCheck`; the function's doc names it (Step 2).
- `src/authority/permission-forwarding.ts` — `ForwardedAccessFacts.askingUnits?: AskingBashUnit[]` with its doc (Step 3).
- `src/handlers/gates/tool.ts` — `describeToolGate` spreads an `askingUnitsFact(check)` beside `floorFact` (Step 3).
- `src/authority/forwarding-io.ts` — `asForwardedAccessIntent` keeps or rejects `askingUnits` through a small well-formedness predicate (Step 3).
- `src/authority/forwarded-request-server.ts` — `toAccessFacts` projects `askingUnits` (Step 3); the `ServingPolicy` doc names the per-unit judgment (Step 4).
- `docs/configuration.md` — after the forwarded-floor paragraph (line ~541), one sentence: the parent judges each command of a forwarded chain that the subagent's policy left asking, so its `deny` or `ask` on any one of them decides (Step 5).
- `docs/subagent-integration.md` § Permission Forwarding — the "A parent `allow`/`deny` rule governs a child's escalation directly" sentence gains that it governs every command of the line the child left asking, not only the first (Step 5).
- `docs/architecture/architecture.md` — Step 5:
  - the `bash-command.ts` entry (`withAskingUnits`, and its constraint that the units are the child-fixed facts the serving node judges);
  - the `permission-forwarding.ts` entry (`askingUnits` on the facts);
  - the `forwarded-request-server.ts` entry (projects `askingUnits`);
  - the `serving-policy.ts` entry (per-unit judgment, `resolveValue` as the single-value fallback);
  - the roadmap step `#### [#1030]` heading gains `✅` and a `Landed:` note; the Mermaid node `S1030` gains `✅`; re-read the Mermaid block after the edit.
- `.pi/skills/package-pi-permission-system/SKILL.md` — predicted unchanged: it names neither `ServingPolicy`, `ForwardedAccessFacts`, nor the forwarded floor (Step 5 greps `ServingPolicy|askingUnits|ForwardedAccessFacts|withChainFloor` over it to confirm).
- `src/index.ts` — predicted unchanged: it constructs `new ResolverServingPolicy(resolver, isYoloEnabled)`, whose constructor does not change.
- `src/authority/approval-escalator.ts` — predicted unchanged: `buildForwardedRequest` spreads `facts.accessIntent`, so `askingUnits` reaches the request; Step 3's composition-root test pins that.
- `src/service/bash-advisory-check.ts` — predicted unchanged; `PermissionsService.checkPermission`'s bash result gains the optional `askingUnits` field additively, as it gained `floor`.
- `src/handlers/gates/runner.ts` — predicted unchanged; it reads neither field.

### Tests

- `test/policy/serving-policy.test.ts` — Step 1 (unchanged, the extraction's guard); Step 4 adds `describe("ResolverServingPolicy judges every unit the child left asking")`, lifting `servingPolicyOver` from the floor describe to file scope so both describes share it.
- `test/handlers/gates/bash-command.test.ts` — Step 2 lifts `resolverOver`/`decide` from `describe("resolveBashCommandCheck: the floor that raised an ask")` to file scope and adds `describe("resolveBashCommandCheck: the units a chain leaves asking")`.
- `test/handlers/gates/tool.test.ts` — Step 3.
- `test/authority/forwarding-io.test.ts` — Step 3, a nested `describe("askingUnits")` inside `readForwardedPermissionRequest — accessIntent field`, copying the floor cases' template.
- `test/authority/forwarded-request-server.test.ts` — Step 3 (projection).
- `test/composition-root.test.ts` — Step 3 (a child's forwarded chain request file carries `accessIntent.askingUnits`).
- Predicted unchanged: every existing `toEqual` on bash access facts (`tool.test.ts` lines ~169/325/380/399, `forwarded-request-server.test.ts`'s `details.accessIntent`, `forwarding-io.test.ts`'s round trip), because their checks carry no `askingUnits` and every addition is a conditional spread.

## Test Impact Analysis

1. New tests the change enables: the serving node's per-unit judgment is tested against a real `PermissionResolver` over an in-memory manager and a real `SessionRules`, including the session-grant and yolo rows; nothing stubs the policy.
2. Redundant tests: none.
   [#1029]'s `honorChildFloor` tests still pin the single-value path, which stays live for older children and unit-less asks.
3. Tests that stay: every `ForwardedRequestServer` test that stubs `policy` still exercises the server's branch on the policy's result, which this change does not alter.
   The [#1029] composition-root floor test (`sudo rm x` carries `accessIntent.floor`) stays green and now also carries a one-unit `askingUnits`, which it does not assert on.

## Invariants at risk

- **[#1029]'s outcomes** (Phase 15 `Landed:`: a serving rule `allow` on a floored ask escalates; `deny`, a serving session grant, and serving yolo still decide).
  On the single-value path, pinned by the existing `ResolverServingPolicy honors the floor the child raised` describe (opened: it constructs the real class over an in-memory manager, so it pins the class).
  On the unit path, Step 4 re-pins each row per unit.
- **ADR 0008 §4: a request without facts escalates.**
  Pinned by the existing `processInbox` tests that send no `accessIntent`; Step 3 extends it (a malformed `askingUnits` drops the intent, so it escalates).
- **A deny never becomes approvable** ([#712]).
  Step 4's deny row: a serving deny on a non-winning unit denies.
- **`toAccessFacts` is a disclosure boundary** ([#635]): `requesterCwd`/`principal` stay off the ask.
  Pinned by the existing child-fixed-facts `toEqual`; Step 3 extends it with a units case.
- **The session-fast-path parity on the child** ([#840]): a floored session-granted unit keeps `source: "session"`.
  This plan reads that source to exclude the unit; it does not change it.
  Pinned by the existing `carries a session grant through the floor` test.
- **Constituencies.**
  The parent's user is served by the stricter judgment.
  The child's agent loses nothing a plain run would have given it, since only asking units travel.
  An older peer keeps today's behavior.

## TDD Order

1. **refactor: name the serving policy's single-value resolution** (`test/policy/serving-policy.test.ts`, unchanged).
   Prepares Step 4's friction: `resolve` will branch between per-unit judgment and today's path, and today's body is three inline calls.
   Extract the body into a private `resolveValue(intent)`; `resolve` returns `this.resolveValue(intent)`.
   Verify: `serving-policy.test.ts` and `forwarded-request-server.test.ts` green, `pnpm --filter @gotgenes/pi-permission-system run check`.
   Commit: `refactor(pi-permission-system): name the serving policy's single-value resolution`.
2. **refactor: the child records every unit it left asking** (`test/handlers/gates/bash-command.test.ts`).
   Lift `resolverOver` and `decide` to file scope (test-only move), then add `describe("resolveBashCommandCheck: the units a chain leaves asking")`.
   Tests (each asserting `askingUnits` with `toStrictEqual`, or `not.toHaveProperty("askingUnits")` for absence, since `toEqual` cannot pin a key's absence):
   - `ls && rm -rf /tmp/x` under `{"*": "ask"}` → `[{command: "ls"}, {command: "rm -rf /tmp/x"}]`;
   - `ls && rm -rf /tmp/x` under `{"*": "ask", "ls*": "allow"}` → `[{command: "rm -rf /tmp/x"}]` (a child-allowed unit stays home);
   - `git push origin main && sudo rm y` under `{"*": "allow", "git push *": "ask"}` → `[{command: "git push origin main"}, {command: "sudo rm y", floor: "<indirection-bash-wrapper>"}]`;
   - the same with a session grant for `sudo rm y` → `[{command: "git push origin main"}]`;
   - the `rm x (` unparsed-unit input from the floor describe → `[{command: "rm x (", floor: "<unparsed-bash-subtree>"}]` (the whole command);
   - a deny winner (`sudo touch y && rm x` under `{"*": "allow", "rm *": "deny"}`) → no `askingUnits`;
   - an all-allow chain → no `askingUnits`;
   - the empty-parse `( rm x )` with no units → no `askingUnits`.
   Killing mutations:
   - make `withAskingUnits` return `winner` unconditionally (kills the first four and the unparsed case);
   - drop `r.state === "ask"` from the filter (kills the child-allowed case);
   - drop `r.source !== "session"` (kills the session case);
   - drop the floor spread in the map (kills the `sudo rm y` case);
   - drop the `winner.state !== "ask"` guard (kills the deny case: `sudo touch y` is floored and would be listed).
   No consumer reads `askingUnits` yet, hence `refactor:`.
   Commit: `refactor(pi-permission-system): record every unit a bash chain leaves asking`.
3. **refactor: the asking units ride the wire** (`tool.test.ts`, `forwarding-io.test.ts`, `forwarded-request-server.test.ts`, `composition-root.test.ts`).
   Add `ForwardedAccessFacts.askingUnits`, the `describeToolGate` spread, the reader, and the `toAccessFacts` projection.
   Tests:
   - `describeToolGate` with an `askingUnits`-carrying check emits them on `promptDetails.accessIntent` (`toStrictEqual` of the whole facts), and one without leaves the key absent (`toStrictEqual` of the three-field shape);
   - the reader round-trips a well-formed list (including a floored entry), and returns no `accessIntent` for each malformed shape: `askingUnits: "ls"`, `[]`, `[{command: 42}]`, `[{command: "ls", floor: 42}]`;
   - `toAccessFacts` projects `askingUnits` onto `details.accessIntent` (`toEqual` of the four fields);
   - a composition-root child under global `{"*": "allow", bash: {"*": "ask"}}` firing `bash` `ls && rm -rf /tmp/x` writes a request whose `accessIntent.askingUnits` is `[{command: "ls"}, {command: "rm -rf /tmp/x"}]`, answered with `approveForwardedRequest` as in the [#1029] floor test.
   Killing mutations: drop the spread in `describeToolGate` (kills the tool and composition-root tests); drop `askingUnits` from the reader's return (kills the round trip); make the reader ignore a malformed list instead of rejecting (kills the four malformed cases); drop the empty-array clause (kills `[]`); drop `askingUnits` from `toAccessFacts` (kills the projection test).
   The serving node still ignores the units, hence `refactor:`.
   Commit: `refactor(pi-permission-system): carry a bash chain's asking units onto the forwarded request`.
4. **fix: the serving node judges every unit the child left asking** (`test/policy/serving-policy.test.ts`).
   Lift `servingPolicyOver` to file scope, then add `describe("ResolverServingPolicy judges every unit the child left asking")`, each test a `bash` intent built with `makeForwardedAccessIntent` whose `matchValues` is the child's winner:
   - the issue's row: `{"*": "ask", "ls*": "allow"}`, units `ls`, `rm -rf /tmp/x` → `ask`, `matchedPattern: "*"`;
   - `{"*": "ask", "ls*": "allow", "rm *": "deny"}`, same units → `deny`, `matchedPattern: "rm *"`;
   - `{"*": "allow"}`, units `ls`, `rm -rf /tmp/x` → `allow` (no over-blocking);
   - the comment's row: `{"*": "allow"}`, session grant `git push *`, units `git push origin main`, `sudo rm y` (floored) → `ask`, `matchedPattern: "<indirection-bash-wrapper>"`;
   - the floor is per unit: `{"*": "allow"}`, session grant `sudo rm y`, chain-level `floor: "<indirection-bash-wrapper>"`, units `ls`, `sudo rm y` (floored) → `allow` (the single-value path would clamp `ls` with the chain floor to `ask`);
   - serving yolo, `{"*": "allow"}`, units `ls`, `sudo rm y` (floored) → `allow`, `origin: "yolo"`;
   - the control: the issue's row without `askingUnits` → `allow`, `matchedPattern: "ls*"` (today's single-value path, the version-skew contract).
   Killing mutations:
   - make `resolve` always call `resolveValue` (kills the issue, deny, comment, per-unit, and yolo rows; the control stays green);
   - judge only `first` instead of every unit (kills the issue and deny rows);
   - pass `intent.floor` instead of `unit.floor` to `honorChildFloor` (kills the per-unit row);
   - drop `honorChildFloor` from `resolveUnit` (kills the comment row).
   Commit: `fix(pi-permission-system): a subagent's forwarded bash line is judged command by command on the parent`.
5. **docs** — `docs/configuration.md`, `docs/subagent-integration.md`, and the `docs/architecture/architecture.md` entries and roadmap marks listed in Module-Level Changes, plus the skill grep.
   Commit: `docs(pi-permission-system): a forwarded bash line carries every asking command`.

## Risks and Mitigations

- **A floored session grant stops sticking on the serving node.**
  Step 4's per-unit row pins that a serving session grant still approves the floored unit it names.
- **A serving node over-blocks a line the child allowed in part.**
  Only asking units travel (Step 2's child-allowed case), so a child-allowed `ls` is never re-judged; Step 4's all-allow row pins that the parent still auto-approves when every forwarded unit is allowed.
- **A malformed or adversarial unit list reads as "no units"** and falls back to the narrower winner-only judgment.
  The reader rejects it instead, which escalates (Step 3's four malformed cases).
- **Drift between the child's unit text and the serving resolution.**
  The serving node resolves `unit.command` as the same `bash-command` intent the child's `resolveOnBashSurface` emitted for it, minus spellings ([#1019]); a child-side spelling match that the serving node misses is the pre-existing [#1019] residual, now per unit rather than for the winner only.
- **A conditional spread written as a bare assignment** (`askingUnits: check.askingUnits`) adds an `undefined`-valued key that `toEqual` ignores.
  Step 3's absence test uses `toStrictEqual`, which catches it.

## Open Questions

- Whether the `forwarded_permission.prompted` entry should name which forwarded unit raised the escalation, rather than only the chain floor.
  Defer until a review-log reader asks for it; the child's own `permission_request.waiting` entry already names the winner.

[#635]: https://github.com/gotgenes/pi-packages/issues/635
[#712]: https://github.com/gotgenes/pi-packages/issues/712
[#840]: https://github.com/gotgenes/pi-packages/issues/840
[#1019]: https://github.com/gotgenes/pi-packages/issues/1019
[#1029]: https://github.com/gotgenes/pi-packages/issues/1029
[#1033]: https://github.com/gotgenes/pi-packages/issues/1033
