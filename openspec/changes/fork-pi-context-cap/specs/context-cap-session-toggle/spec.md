## Purpose

Give the user a per-session switch that can force the guard on or off regardless of the model whitelist, without persisting anything beyond the current session.

## ADDED Requirements

### Requirement: Session override command

The `/context-cap` command SHALL accept `on` and `off` arguments that set a session-scoped override state with three values: default (follow the whitelist), on (force active), off (force inactive). The override SHALL reset to default when the session ends and SHALL NOT be written to any config file.

#### Scenario: Force enable outside whitelist

- **WHEN** the active model does not match the whitelist and the user runs `/context-cap on`
- **THEN** the guard becomes active for the rest of the session even though the model is not whitelisted

#### Scenario: Force disable

- **WHEN** the user runs `/context-cap off`
- **THEN** the guard takes no action for the rest of the session regardless of usage or whitelist

#### Scenario: Override expires with the session

- **WHEN** a session with `/context-cap on` ends and a new session starts
- **THEN** the new session starts in the default state and the guard activity again follows the whitelist

### Requirement: Status reflects effective state

The `/context-cap` status output SHALL show the effective activity state (active/inactive), the reason for it (whitelisted model, session override, or failure shutdown), the current budget and computed threshold, and the current usage.

#### Scenario: Status explains whitelist inactivity

- **WHEN** the guard is inactive because the model is not whitelisted and the user runs `/context-cap` with no arguments
- **THEN** the output shows an inactive state with the whitelist as the reason, plus budget, threshold, and usage
