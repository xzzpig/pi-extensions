# Changelog

## 0.1.0

### Added

- **Session roles for the interactive session.** `/role` adopts an agent (from
  the merged `pi-subagents` discovery view, including agents other extensions
  register at runtime), `/sandbox-profile` and `/permission-profile` select a
  named profile, and every command offers `none` to clear. Pickers navigate with
  `↑↓`/`jk`, confirm with `Enter`, cancel with `Esc`/`Ctrl+C`, and mark the
  current selection.
- **Three-channel application.** A role is applied by name only: the session
  `active_agent` identity entry (agent scope and agent-declared profiles),
  `PI_SUBAGENT_PERMISSION_PROFILE` (explicit permission profile), and
  `pi-sandbox`'s `SandboxService` (sandbox profile). Precedence is explicit
  selection over the agent declaration, and adopting an agent drops explicit
  profile overrides.
- **Footer status.** The current role is shown in the footer — an adopted agent by
  name alone, or the hand-picked profiles when no agent is adopted — and the
  status is cleared when there is no role.
- **Fail-loud reporting.** A rejected profile, a disabled sandbox (selection
  recorded, no isolation active), or an unavailable `pi-sandbox` is reported
  instead of silently leaving the session unprotected.
- **Project-scoped adoption gate.** Adopting an agent that comes from the
  project requires a trusted project; selecting a profile by hand is not gated
  because profile registries are global and operator-owned.

Roles are session-scoped: nothing is written to settings or configuration files,
and a restart starts from no role.
