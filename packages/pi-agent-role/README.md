# @xzzpig/pi-agent-role

Session roles for the interactive Pi session.

Pi already lets a subagent run under a named sandbox profile
(`@xzzpig/pi-sandbox`) and a named permission profile
(`@xzzpig/pi-permission-system`), selected from its agent definition. This
extension brings the same idea to the session you are sitting in: adopt an agent
or pick a profile by hand, and the session's sandbox and permission policy follow.

## Install

```bash
pi install npm:@xzzpig/pi-agent-role
```

## Commands

| Command                      | What it does                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/role`                      | Open a picker of every discoverable agent (including agents other extensions register at runtime) and adopt one. Each row shows the profiles that agent declares. |
| `/role <agent>`              | Adopt `<agent>` directly, by name or alias.                                                                                                                       |
| `/role none`                 | Clear the agent role.                                                                                                                                             |
| `/sandbox-profile`           | Pick one of the global sandbox profiles, or `none` to clear it.                                                                                                   |
| `/sandbox-profile <name>`    | Select a sandbox profile directly.                                                                                                                                |
| `/permission-profile`        | Pick one of the global permission profiles, or `none` to clear it.                                                                                                |
| `/permission-profile <name>` | Select a permission profile directly.                                                                                                                             |

Pickers navigate with `↑`/`↓` or `j`/`k`, confirm with `Enter`, and cancel with
`Esc`/`Ctrl+C`. The current selection is marked with `●`.

The footer shows the current role while one is selected: an adopted agent by name
alone (`role: worker`), and when no agent is adopted the profiles you picked by
hand (`role: sandbox strict`, `role: perm locked`). Agent-declared profiles stay
out of the footer to keep it glanceable; the picker shows the full picture.
With no role the status line is cleared.

## How a role is applied

A role is a name and nothing else — no policy is copied anywhere. Each system
resolves the name itself, through the contract it already has:

| Channel                          | Used for                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session `active_agent` entry     | The agent identity `pi-permission-system` resolves agent-scoped rules and the agent's own `permission:` / `permission-profile:` frontmatter from. |
| `PI_SUBAGENT_PERMISSION_PROFILE` | The explicit permission profile, which that package reads on every decision.                                                                      |
| `SandboxService.setProfile()`    | The sandbox profile, resolved by `pi-sandbox` against its global registry.                                                                        |

Precedence is **explicit selection > agent declaration > nothing**: the profile
you picked by hand wins, otherwise the agent's own declaration applies. Adopting
an agent is a full re-dress, so explicit profile overrides are dropped at that
point — pick the agent first, then narrow with a profile if you want to.

Every problem is reported: a profile that could not be applied, a sandbox that is
disabled (the profile is recorded but no isolation is active), or a sandbox
installed without the extension available. Nothing fails silently.

## Session scope and trust

- A role is **session-scoped**: nothing is written to settings or configuration
  files, and a restart starts from no role. A stale `active_agent` identity left
  in the session file is cleared on the next start.
- Profile registries stay **global and operator-owned**: a project cannot define,
  replace, or remove a profile name, so selecting one never grants access the
  global configuration does not already describe.
- Adopting an agent that comes from the project (a project agent file or a
  project-scoped override) requires a trusted project. Selecting a profile by
  hand is not gated — the names available are the operator's.
- Subagents are unaffected: a child runs under the agent identity its launcher
  gave it, never under this session's role.

## Dependencies

Both integrations are optional, and each reports what is missing instead of
failing to load:

| Package                | Used for                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `@xzzpig/pi-subagents` | Listing agents (including ones other extensions register at runtime) |
| `@xzzpig/pi-sandbox`   | Applying the session sandbox profile through its `SandboxService`    |

`@xzzpig/pi-permission-system` is not a dependency either: this extension reads
that package's global configuration file to list the available names, and hands
the selected name over through the session `active_agent` entry and the profile
environment key. Turning that hand-over into effective rules is its own job.

Pair this package with builds that already speak those contracts:

| Package                | Minimum | Contract this extension uses                          |
| ---------------------- | ------- | ----------------------------------------------------- |
| `pi-subagents`         | 0.13.0  | The `./agents` export (`discoverAgentsWithRuntime`)   |
| `pi-sandbox`           | 0.6.0   | `SandboxService` (`getSandboxService` / `setProfile`) |
| `pi-permission-system` | 0.7.0   | Agent-scoped `permission-profile:` resolution         |
