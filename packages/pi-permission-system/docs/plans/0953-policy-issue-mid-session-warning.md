---
issue: 953
issue_title: "pi-permission-system: a policy-file issue that appears mid-session is never shown"
---

# A policy-file issue that appears mid-session reaches the operator

## Release Recommendation

**Release:** ship independently

`docs/architecture/architecture.md`'s open-issue sweep records [#953] as "filed by [#933]'s planning; out of scope for the roadmap", so it belongs to no numbered step and no `Release: batch`.
It is a notification-lifecycle defect in `config/`, `policy/`, and `handlers/`, and it cuts its own `fix:` release.

## Problem Statement

The policy side's issue list, `PermissionManager.getConfigIssues(agentName?)`, is reported at exactly one site: an unlatched `logger.warn` loop in `SessionLifecycleHandler.handleSessionStart`.
Policy is re-read from file mtimes whenever it is consulted, so a policy file broken mid-session is rejected fail-closed.
Its `allow` rules become `ask`, and the operator is never told why.

Planning measured a second defect in the same list, which [#933] introduced.
`FilePolicyLoader` runs `loadUnifiedConfig` over the same global and project `config.json` files `ConfigStore` loads, and it accumulates their per-file schema issues into the policy list.
Before [#933], `ConfigStore`'s copy of those strings was swallowed at session start, so the policy loop was what delivered them.
Since [#933] un-swallowed it, every per-file schema error present at session start is shown **twice**.

### What the operator sees (measured)

The reproduction ran through the real composition root (`makeFakePi` + `piPermissionSystemExtension`, a `makeTuiCtx` capturing `ui.notify`, global `{"permission": {"*": "ask"}}`, trusted project `{"permission": {"demo": "allow"}}`).
The spike test was reverted after measuring.

| Scenario                                                                    | `ui.notify` messages                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project file valid at start; `bogusKey: 1` added; two `before_agent_start`s | `Unrecognized config key 'bogusKey'.` once (from `ConfigStore`'s reporter); the fail-closed notice **0 times**                                                                                             |
| Project file already carries `bogusKey: 1` at `session_start`               | `Unrecognized config key 'bogusKey'.` **twice**, then `Invalid project configuration detected — failing closed: 'allow' rules are clamped to 'ask' for this session until the configuration is corrected.` |

The message that explains the clamp is the one lost mid-session, and the one the operator can already see is the one duplicated at start.

## Goals

- The fail-closed notice and the MCP tool-key port notice are reported the way a config issue is after [#933]: once when they first appear, on the next turn when they appear mid-session, and not again while they persist.
- A per-file schema error is shown once, not twice, because each fact has exactly one reporter.
  `ConfigStore` (through `ConfigIssueReporter`) owns per-file errors; the policy side owns only what composing policy reveals.
- The policy report uses the agent name resolved for the turn, including one carried only by the `<active_agent>` system-prompt tag (a pi-subagents child), so an agent-scope clamp is reported on the first turn.
- The policy side's method is named for what it answers: `getPolicyIssues`, on `PermissionResolver` and `ScopedPermissionManager`/`PermissionManager`.

Not breaking.
No config key, schema field, default, or output shape changes.
The observable deltas are a missing warning that now arrives and a duplicate that no longer does; the warning strings themselves are unchanged.

## Non-Goals

- **Unifying the two reads of `config.json`.**
  `ConfigStore` and `FilePolicyLoader` still each parse and validate the same files on different cadences (per turn vs. per mtime).
  This plan removes the duplicated *reporting*, not the duplicated *parsing*.
  Filed as [#1028] (dispositioned out of scope for Phase 15), including an unverified divergence: `loadAndMergeConfigs` merges the legacy policy files and `FilePolicyLoader` does not read them.
- **A shared latch primitive.**
  `PolicyIssueReporter` repeats `ConfigIssueReporter`'s five-line replace-set latch.
  The Tidy-First assessor recommended duplicating at two callers: the policy source is parameterized by agent name, and the latch, once shared, would need to know that.
  Recorded under the retro's `#### Deferred tidyings`.
- **Headless delivery.**
  Unchanged from [#933]: with no UI, `ctx.ui` is Pi's no-op context and the debug log is the only record.
  A pi-subagents child's `logger.warn` reaches its own `ctx.ui`, which this plan does not route anywhere else.
- **A review-log record for policy issues.**
  The [#933] Open Question (a durable record alongside the warning) applies equally here and stays open.
- **Reshaping `AgentPrepHandler` into a deps object.**
  It reaches seven positional deps, which is the `src/handlers/` convention; the assessor declined the bag conversion as scope creep.
- **`docs/architecture/v3-architecture.md:226`** ("config issue accumulation") and **`docs/architecture/history/phase-4-constructibility.md:106`** (`getConfigIssues`).
  Both are historical records of earlier designs, not current-behavior docs.
- **No change to which notices `PermissionManager` computes**, to the fail-closed floor itself (#646), or to `loadUnifiedConfig`'s issue strings.

## Background

### The modules

| Module                                | Role in this change                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/policy-loader.ts`         | `FilePolicyLoader` loads each scope; `accumulateConfigIssues` (L199-205) keeps every per-file issue for the loader's lifetime; `getConfigIssues` (L207) |
| `src/policy/permission-manager.ts`    | `getConfigIssues(agentName?)` (L161) = the loader's accumulation + the fail-closed notice + the port notice; the latter two recomputed per resolve      |
| `src/policy/permission-resolver.ts`   | `getConfigIssues(agentName?)` (L142) relays to the manager                                                                                              |
| `src/config/config-issue-reporter.ts` | [#933]'s `ConfigIssueReporter`: latch per issue, deliver one joined message per report, replace the set each report                                     |
| `src/handlers/lifecycle.ts`           | `handleSessionStart` resolves the agent name (L86) and warns each policy issue (L87-90); `resolver` is used nowhere else                                |
| `src/handlers/before-agent-start.ts`  | `AgentPrepHandler.handle` runs `turnPrep.prepare` (L100), then resolves the agent name from ctx entries or the `<active_agent>` tag (L107)              |
| `src/handlers/session-turn-prep.ts`   | Drives `ConfigIssueReporter` every turn; untouched here                                                                                                 |

### Why the loader's issues are a pure duplicate

`FilePolicyLoader.loadGlobalConfig` (L219) and `loadProjectConfig` (L240) call `loadUnifiedConfig` on `getGlobalConfigPath(agentDir)` and the project config path.
`loadAndMergeConfigs` (`config-loader.ts` L371, L391) calls `loadUnifiedConfig` on the same two paths and pushes the same `issues`.
Both are built from the same `agentDir` in `index.ts` (L116, L128), and both withhold the project path when the project is untrusted (#644).
Agent and project-agent `.md` files never contribute an issue string: a read or parse failure sets only `invalid: true` (`policy-loader.ts` L294-298).
So every string in the loader's accumulation is one `ConfigStore` already holds; the policy side's unique information is the two derived notices.

`git log -S'accumulateConfigIssues'` traces the accumulation to `5a2d3634` (2026-06-04), predating both `ConfigStore` and [#933].

### Where the agent name comes from

`PermissionSession.resolveAgentName(ctx, systemPrompt?)` reads `active_agent` session entries first, then the `<active_agent name=…>` system-prompt tag, then the last known name.
`@gotgenes/pi-subagents` names a child only through the tag (`packages/pi-subagents/src/session/prompts.ts`, `<active_agent name="${agentName}"/>`).
So at a child's `session_start` the name is `null`, and only `AgentPrepHandler` (which holds the prompt) can name the agent for its first turn.
Turn prep runs before that resolution (`before-agent-start.ts` L100 vs. L107).

### AGENTS.md and package constraints that apply

- **Keep scope tight:** the double parse is filed as [#1028], not folded.
- **Directory vocabulary:** the reporter's subject is configuration issues delivered to the operator, so it goes in `config/` beside `config-issue-reporter.ts`.
  Its source seam is structural, so `config/` imports nothing from `policy/`; `pnpm --silent fallow guard` shows `handlers/` may import `config/`, which is the only new edge.
- **Same-directory `./`, cross-directory `#src/`:** lint-enforced.

## Design Overview

### The policy side answers only what it alone knows

`PermissionManager.getPolicyIssues(agentName?)` drops `...this.loader.getConfigIssues()` and returns the fail-closed notice and the port notice.
Both are recomputed on every resolve, so the list is *current*: it empties when the file is fixed.
That is what makes [#933]'s replace-set latch behave correctly on it.
The loader's accumulation never forgot an issue, so a fixed-then-rebroken file was never re-announced.
`PolicyLoader.getConfigIssues`, `FilePolicyLoader.accumulatedConfigIssues`, and `accumulateConfigIssues` are deleted; `loadUnifiedConfig`'s `issues` still decide `invalid`.

### The reporter

```ts
// src/config/policy-issue-reporter.ts

/** The policy seam this reads (ISP): the notices composing policy produced for an agent. */
export interface PolicyIssueSource {
  getPolicyIssues(agentName?: string): readonly string[];
}

/** The seam the session-start and agent-prep handlers drive. */
export interface PolicyIssueReporting {
  report(agentName: string | undefined): void;
}

export class PolicyIssueReporter implements PolicyIssueReporting {
  private reported: ReadonlySet<string> = new Set();

  constructor(
    private readonly source: PolicyIssueSource,
    private readonly log: ConfigIssueWarner, // type-only, from ./config-issue-reporter
  ) {}

  report(agentName: string | undefined): void {
    const current = this.source.getPolicyIssues(agentName);
    const unreported = current.filter((issue) => !this.reported.has(issue));
    if (unreported.length > 0) this.log.warn(unreported.join("\n"));
    this.reported = new Set(current);
  }
}
```

`PermissionResolver` satisfies `PolicyIssueSource` structurally; `report` uses the one method it reads.
The argument is the agent name, not a ctx or a prompt, so the reporter cannot reach through to resolve it.

### Latch semantics

The same as [#933]'s, over a source keyed by agent:

| Reports                                                        | Warned                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `[F]`                                                          | `F`                                                                       |
| `[F]`, `[F]`                                                   | `F` once                                                                  |
| `[F, P]`                                                       | one message, `F\nP`                                                       |
| `[F]`, `[F, P]`                                                | `F`, then `P` only                                                        |
| `[F]`, `[]`, `[F]`                                             | `F`, then `F` again (fixed, then broken again)                            |
| `[]`                                                           | nothing                                                                   |
| `report("a") → [Fa]`, `report("b") → []`, `report("a") → [Fa]` | `Fa`, then `Fa` again: switching back into a broken agent re-announces it |

The fail-closed notice names scopes, not agents ("Invalid project, agent configuration detected…"), so a project-scope clamp produces the same string for every agent and is not re-announced by an agent switch.

### Call sites

```ts
// src/handlers/lifecycle.ts — handleSessionStart (replaces the loop at L86-90)
const agentName = this.session.resolveAgentName(ctx);
this.policyIssues.report(agentName ?? undefined);
```

```ts
// src/handlers/before-agent-start.ts — handle, right after L107
const agentName = this.session.resolveAgentName(ctx, systemPrompt);
this.policyIssues.report(agentName ?? undefined);
```

```ts
// src/index.ts — after resolver (L193) and logger exist
const policyIssueReporter = new PolicyIssueReporter(resolver, logger);
// SessionLifecycleHandler: replaces `resolver`; AgentPrepHandler: seventh dep
```

`SessionLifecycleHandler` keeps seven deps; `resolver` leaves and `policyIssues` takes its place.
`AgentPrepHandler` goes from six to seven.

### Ordering

At `session_start` the order stays config report → untrusted-project warning → policy report.
At `before_agent_start` the config report runs inside `turnPrep.prepare`, ahead of `announceReady`, and the policy report runs after both.
ADR 0012 decision 3's "announce last" governs node *state* a ready consumer reads; a warning is not state, so a policy report after the announce does not touch that contract.
`session-turn-prep.test.ts` "announces the node as ready, on the same ctx" and its report-before-announce ordering test are unaffected.

### Edge cases and the step that pins each

| Edge case                                           | Behavior                                                           | Pinned in                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| Schema error in the project file at start           | Shown once (was twice); fail-closed notice once                    | Step 2                                                    |
| Schema error in the global file                     | Shown once by `ConfigStore`; global is never clamped, so no notice | Step 2 (manager test: a rejected global file yields `[]`) |
| Project file broken mid-session                     | Fail-closed notice on the next turn, once across further turns     | Step 4                                                    |
| Agent named only by the prompt tag                  | `report` receives the tag's name on the first turn                 | Step 4                                                    |
| Agent switch away from and back into a broken agent | Re-announced                                                       | Step 3                                                    |
| Untrusted project                                   | Neither loader reads the project file, so nothing to report (#644) | Unchanged; existing #644 tests                            |

## Module-Level Changes

### Added

- **`src/config/policy-issue-reporter.ts`:** `PolicyIssueReporter`, `PolicyIssueSource`, `PolicyIssueReporting`.
  Its doc comment states that it reads only the derived notices (per-file errors are `ConfigIssueReporter`'s), the latch semantics, and why the agent name is an argument.
- **`test/config/policy-issue-reporter.test.ts`:** the semantics table.

### Changed

- **`src/policy/permission-manager.ts`:**
  - Step 1: `getConfigIssues` → `getPolicyIssues` on `ScopedPermissionManager` (L95) and `PermissionManager` (L161); `{@link getConfigIssues}` at L65 and L70.
  - Step 2: drop `...this.loader.getConfigIssues()` (L165); doc comment says the list is the derived notices only.
- **`src/policy/permission-resolver.ts`:** step 1, `getConfigIssues` → `getPolicyIssues` (L142-144).
- **`src/config/config-store.ts`:** step 1, the L104 doc comment naming `PermissionResolver.getConfigIssues(agentName?)`.
- **`src/config/policy-loader.ts`:** step 2 deletes `PolicyLoader.getConfigIssues` (L96-97), `accumulatedConfigIssues` (L175), `accumulateConfigIssues` + `getConfigIssues` (L197-209), and the two `this.accumulateConfigIssues(issues)` calls (L220, L241).
- **`src/handlers/lifecycle.ts`:**
  - Step 1: the L87 call site and the L44 doc bullet.
  - Step 4: `resolver` → `policyIssues: PolicyIssueReporting` (constructor and doc bullet); the loop becomes one `report` call; drop the `PermissionResolver` import.
- **`src/handlers/before-agent-start.ts`:** step 4, seventh dep `policyIssues: PolicyIssueReporting`, the `report` call after `resolveAgentName`, and a doc bullet.
- **`src/index.ts`:** step 4 constructs `PolicyIssueReporter(resolver, logger)` and passes it to both handlers.
- **`test/helpers/session-fixtures.ts`:** step 1, the fake manager's `getConfigIssues` (L113) → `getPolicyIssues`.
- **`test/helpers/manager-harness.ts`:** step 2 deletes the in-memory loader's `getConfigIssues` (L47) and its `issues` variable (L36, no other reader).
- **`test/helpers/handler-fixtures.ts`:** step 4 adds `makePolicyIssueReporter()` (`{ report: vi.fn<(agentName: string | undefined) => void>() }`), unannotated like `makeConfigIssueReporter`.
- **`test/policy/permission-resolver.test.ts`:** step 1 renames the L533-541 delegation test.
- **`test/policy/permission-manager-fail-closed.test.ts`:** step 1 renames L103, L114.
  Step 2 adds a filesystem-backed test where a project file carrying an unknown key yields exactly `[failClosedNotice]`, and a rejected global file yields `[]`.
- **`test/policy/permission-manager-unified.test.ts`:** step 1 renames L1675, L2909-2930, L3944-3969.
- **`test/config/policy-loader.test.ts`:** step 2 deletes `FilePolicyLoader.getConfigIssues` (L233-255) and "config issue accumulation" (L625-670).
  The `invalid`-marking tests (L122-147, L199-213) stay and still pin that a rejected file fails closed.
- **`test/handlers/lifecycle.test.ts`:**
  - Step 1: the L35 mock rename.
  - Step 4: `makeSetup` builds `makePolicyIssueReporter()` instead of a resolver and drops its `configIssues` option; "notifies each policy issue" and "does not warn when there are no policy issues" become "drives the policy-issue report with the resolved agent name".
- **`test/handlers/before-agent-start.test.ts`:** step 4 adds the seventh arg at L111 and tests that `report` receives the tag-derived name.
- **`test/composition-root.test.ts`:** steps 2 and 4 add pins beside [#933]'s `a config issue present at session start` block (L2492).
- **`docs/architecture/architecture.md`:**
  - Step 1: L335 and L904 (`getConfigIssues` → `getPolicyIssues`); L905 the resolver's owned-method list.
  - Step 2: L904 states the derived-notices-only list.
  - Step 4: the L963 `lifecycle.ts` entry (`resolver` → `policyIssues`); the L964 `before-agent-start.ts` entry (seventh dep and the report); a new `config/` tree entry for `policy-issue-reporter.ts` beside L886.
- **`.pi/skills/package-pi-permission-system/SKILL.md`:**
  - Step 1: L119 "appends a fail-closed notice to `getConfigIssues`" → `getPolicyIssues`.
  - Step 4: the `handler-fixtures.ts` bullet gains `makePolicyIssueReporter`.

### Predicted unchanged, with the claim each rests on

| File                                                                                            | Claim                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config/config-issue-reporter.ts`, `test/config/config-issue-reporter.test.ts`              | The latch is duplicated, not extracted; `PolicyIssueReporter` imports only the `ConfigIssueWarner` type                              |
| `src/handlers/session-turn-prep.ts`, `test/handlers/session-turn-prep.test.ts`                  | The policy report runs in `AgentPrepHandler`, not turn prep (assessor-confirmed: `AgentPrepHandler` holds no `ConfigIssueReporting`) |
| `src/config/config-loader.ts`, `src/config/config-schema.ts`, `schemas/permissions.schema.json` | No config surface or issue string changes                                                                                            |
| `README.md`, `docs/configuration.md`                                                            | No command, key, or user-facing feature changes; measured, neither names `getConfigIssues` or the accumulation                       |
| `docs/architecture/architecture.md` Mermaid blocks                                              | Measured: no node names `getConfigIssues`, `lifecycle`, or a policy-issue flow                                                       |
| `docs/architecture/architecture.md` L893 (`policy-loader.ts` entry)                             | It never mentioned issue accumulation, so deleting it leaves the entry accurate                                                      |
| [#933]'s three composition-root pins (L2492-2575)                                               | They count config-detector strings `FilePolicyLoader` never produced, so removing the policy duplicate leaves their counts at 1      |

## Test Impact Analysis

**New tests the change enables.**
The policy latch is directly testable with a two-method fake, the same way [#933] made the config latch testable.
The agent-keyed row (switch away and back) is testable only once the name is an argument.
The manager's derived-only list becomes testable as an exact `toEqual` on a filesystem-backed project file, because it no longer drags in the loader's lifetime accumulation.

**Tests that become redundant.**
`policy-loader.test.ts`'s accumulation tests (L233-255, L625-670) pin behavior that no longer exists.
What they protected for the operator is that a malformed file's error is surfaced, and that is now `ConfigStore`'s job: `config-store.test.ts` "getConfigIssues()" and `config-loader.test.ts`'s `loadUnifiedConfig` issue tests already pin it.
`lifecycle.test.ts`'s two per-issue `logger.warn` tests become one delegation test; latch and delivery move down to `policy-issue-reporter.test.ts`.

**Tests that must stay as-is.**

- `permission-manager-fail-closed.test.ts` (in-memory loader, `project: { invalid: true }`) and `permission-manager-unified.test.ts`'s port-notice block: renamed only.
  They pin the two notices' content, which this change does not touch.
- `policy-loader.test.ts`'s `invalid` tests: a rejected file must still fail closed after its issues stop being stored.
- [#933]'s composition-root pins.

## Invariants at risk

| Invariant                                                                                                                              | Pinned by                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#646**: a rejected non-global scope floors `allow`→`ask`; global excluded                                                            | `permission-manager-fail-closed.test.ts` (unchanged), `policy-loader.test.ts` `invalid` tests (kept); the floor reads `invalid`, which step 2 does not touch                      |
| **[#933]**: a config issue at start is shown once, by `session_start` alone, and once across turns; a mid-session one on the next turn | `composition-root.test.ts` L2492-2575; predicted green, since those strings come only from `loadAndMergeConfigs`'s detectors                                                      |
| **#644**: an untrusted project's scope is withheld                                                                                     | `lifecycle.test.ts` "withholds the project scope…", `config-store.test.ts`; both loaders withhold, so no reporter sees the project file                                           |
| **ADR 0012 decision 3**: `permissions:ready` is announced last in turn prep                                                            | `session-turn-prep.test.ts`, unchanged; the policy report lives outside turn prep                                                                                                 |
| Per-file schema errors still reach the operator                                                                                        | `composition-root` step 2 pin (exactly one `Unrecognized config key` notification; baseline measured **2**)                                                                       |
| The MCP port notice still reaches the operator                                                                                         | Was delivered at start by the loop; after step 4 by the reporter at start and per turn. `permission-manager-unified.test.ts` pins its content; `lifecycle.test.ts` pins the drive |

Constituencies: the operator reads the notification (UI sessions only); whoever reads the debug log after the fact keeps `config.loaded`'s `warning`, which this change does not touch.

## TDD Order

1. **`refactor:` name the policy side's issue query `getPolicyIssues`.**
   This is the assessor's recommended preparation.
   Without it, steps 2-4 change behavior under a name `ConfigStore` and `PolicyLoader` also use for something else, and every diff carries rename churn.
   Rename on `ScopedPermissionManager`, `PermissionManager`, and `PermissionResolver`, plus the call site, fixtures, tests, doc comments (`permission-manager.ts` L65/L70, `lifecycle.ts` L44, `config-store.ts` L104), `architecture.md` L335/L904/L905, and the skill's L119.
   Do **not** rename `PolicyLoader.getConfigIssues`, which step 2 deletes.
   No new tests: `tsc` and the renamed tests are the check.
   Verify: `grep -rn "getConfigIssues(agentName\|resolver.getConfigIssues\|permissionManager.getConfigIssues\|manager.getConfigIssues" packages/pi-permission-system/src packages/pi-permission-system/test` returns nothing.
   Commit: `refactor(pi-permission-system): name the policy issue query getPolicyIssues`

2. **`fix:` a broken config file's error is shown once at session start.**
   - Red:
     - `composition-root.test.ts`: a trusted project file carrying `bogusKey: 1` before `session_start` yields exactly one `Unrecognized config key 'bogusKey'.` notification and exactly one fail-closed notice (baseline measured: 2 and 1).
     - `permission-manager-fail-closed.test.ts`: via `createManagerWithProject`, a project file with an unknown key makes `getPolicyIssues()` equal `[failClosedNotice]`, and a global file with an unknown key yields `[]`.
   - Green:
     - Drop the loader spread in `getPolicyIssues`, then delete the loader accumulation and its interface member.
     - Delete the in-memory loader's member and `issues` variable, and the two obsolete loader-test blocks.
     - Re-check `policy-loader.test.ts`'s imports for orphans.
     - Update `architecture.md` L904.
   - **Killing mutation:** before deleting the loader method, restore `const issues = [...this.loader.getConfigIssues()]` in `getPolicyIssues`.
     The composition pin's schema-error count must return to 2, and the manager test's `toEqual` must fail on the extra string.
     Delete the method only after both go red.
   - Commit: `fix(pi-permission-system): show a broken config file's error once, not twice, at session start`

3. **`refactor:` a policy-issue reporter keyed by agent.**
   - Red: `test/config/policy-issue-reporter.test.ts`, the seven rows of the semantics table, including "`report` passes the agent name to the source".
   - Green: `src/config/policy-issue-reporter.ts`.
     No consumer references it yet, so it is `refactor:`.
     Re-read the copied latch against `code-design` before committing: it is a copy of `ConfigIssueReporter`'s.
   - **Killing mutations:**
     - (a) Delete the `!this.reported.has(issue)` filter: reddens "`[F]`, `[F]` warns once" and "`[F]`, `[F, P]` warns only `P`".
     - (b) Accumulate into `reported` instead of replacing it: reddens "fixed then broken again" and the agent-switch row.
     - (c) Call `this.source.getPolicyIssues()` with no argument: reddens "passes the agent name to the source".
   - Commit: `refactor(pi-permission-system): add a policy-issue reporter that warns what is new for the agent`

4. **`fix:` a policy file that fails closed mid-session is reported on the next turn.**
   - Red:
     - `composition-root.test.ts`, mid-session pin: valid project file at start, then `bogusKey: 1` written, then two `before_agent_start` fires; the fail-closed notice arrives exactly once (baseline measured: 0).
     - `before-agent-start.test.ts`: with `systemPrompt: '<active_agent name="reviewer"/>'` and no session entry, `policyIssues.report` is called with `"reviewer"`.
     - `lifecycle.test.ts`: "drives the policy-issue report with the resolved agent name" (session entry naming an agent → `report("<name>")`; none → `report(undefined)`).
   - Green:
     - `makePolicyIssueReporter()`.
     - `SessionLifecycleHandler`: swap `resolver` for `policyIssues`, collapse the loop, drop the import.
     - `AgentPrepHandler`: the seventh dep and the call after L107.
     - `index.ts` construction and wiring; the `before-agent-start.test.ts` L111 arity.
     - Doc comments on both handler classes; `architecture.md` L963/L964 and the new `config/` tree entry; the skill's `handler-fixtures` bullet.
   - **Killing mutations:**
     - (a) Delete the `report` call in `AgentPrepHandler.handle`: reddens the mid-session pin.
     - (b) Pass `undefined` instead of `agentName ?? undefined` there: reddens the tag-name test.
     - (c) Delete the `report` call in `handleSessionStart`: reddens step 2's start-time pin (fail-closed count 1 → 0) and the lifecycle delegation test.
       Count the reds: the start-time pin fires only `session_start`, so turn prep cannot mask this one (the [#933] lesson).
   - Commit: `fix(pi-permission-system): report a policy file that fails closed mid-session`

Steps 1 and 3 are `refactor:` (no observable change); steps 2 and 4 each change what the operator sees and reach the changelog.
Step 1 is the Tidy First preparation; the implementing session runs no second assessment.
No `Co-authored-by:` trailer: the issue and its design are the operator's own.

## Risks and Mitigations

| Risk                                                                                                                     | Mitigation                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Absent duplicate channel:** some per-file issue reaches the policy loader but not `ConfigStore`, so step 2 silences it | Enumerated both loaders' inputs (Background): same paths, same `agentDir`, same trust withholding; agent `.md` failures add no string. Step 2's composition pin asserts the schema error still arrives exactly once, which is the absence spike run as a test |
| **Absent latch:** the reporter re-warns the fail-closed notice every turn                                                | Step 3 mutation (a); step 4's mid-session pin counts across two turns, not one                                                                                                                                                                                |
| **The agent name lags a turn** for a tag-only agent                                                                      | The report runs in `AgentPrepHandler` after the tag is read; step 4's tag-name test and mutation (b)                                                                                                                                                          |
| **A policy notification per turn is costlier** than one at start: `getPolicyIssues` triggers `resolvePermissions`        | The resolve is cached by mtime stamp per agent, and `AgentPrepHandler` already resolves for the same agent through `isToolFullyDenied` on the same turn, so the cache is warm                                                                                 |
| **Two notifications at start** (config issue, then fail-closed notice) where there were three                            | Two distinct facts from two owners. Merging them into one message would need a shared reporter, which the latch-sharing Non-Goal declines                                                                                                                     |

## Open Questions

- Should either reporter write a durable review-log record?
  Carried over from [#933]; still new behavior nobody has asked for.
- [#1028]: whether `ConfigStore` and `FilePolicyLoader` should derive from one read, and whether legacy policy files reach enforced policy at all.

[#933]: https://github.com/gotgenes/pi-packages/issues/933
[#953]: https://github.com/gotgenes/pi-packages/issues/953
[#1028]: https://github.com/gotgenes/pi-packages/issues/1028
