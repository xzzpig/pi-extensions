# Changelog

## 0.2.2 — 2026-11-05

- Require Pi 1.5.0 or newer and build tool parameter schemas with
  `@earendil-works/pi-schema` instead of TypeBox. Preserve existing required
  fields, bounds, and open/closed-object validation semantics.

## 0.2.1

- Support Pi 1.2+ custom-message wakeups in child report handlers. A wakeup
  retains the current user-dispatch attempt without allowing an unverified
  message to authorize a report; a new user dispatch creates a fresh attempt.
- Include the extension's generated public type declaration in the package.

## 0.2.0

Child report tools are now scoped to the subagents that own them, and the
parent session no longer transcribes reports.

- **Breaking:** `report_gap_analysis`, `report_plan_review` and `report_work`
  are no longer registered in the main session. Each is loaded only by its own
  opsx child extension (`subagentOnlyExtensions`), so a parent session sees
  neither the tools nor their prompt rules.
- Child reports are received by the plugin from native subagent results, the
  canonical v3 session record and the native `status.json`, and are bound to a
  specific flow, run and attempt nonce. No parent-side review tool is required.
- Completion gating reads the accepted ready receipt of the task's latest run
  rather than anything the parent model restates, so a failed, superseded or
  stale-attempt report cannot authorize a tick.
- A cold restart restores the flow, the gate and its dispatch observations from
  the branch, so previously earned receipts keep working after a restart.
- A new dispatch invalidates the task's earlier receipt; ordinary goals keep
  their original behaviour and `--direct` flows keep their own completion
  events without worker conditions.

## 0.1.0

Initial release.

- Official-track skills extracted from the installed OpenSpec CLI, cached by
  CLI version under `<agentDir>/cache/pi-openspec-x/skills/<version>/`.
- `/opsx:plan`: planner sandbox mode, append-only per-artifact instruction
  injection, gap analysis, plan review gate, user approval gate.
- `/opsx:implement`: agent (opsx-agent + opsx-worker dispatches) and direct
  main-session modes on a pi-goal-x execution base, with a final completion
  audit pointing at the read-only opsx-reviewer.
- Runtime-registered opsx subagents and structured reporting tools.
- Versioned lifecycle bus events and a literal pi-notify bridge.
