## Purpose

Let users scope the context-cap guard to specific models and tune its budget through a JSON configuration file, with global and project levels and pi-consistent model matching.

## ADDED Requirements

### Requirement: Configuration file locations

The extension SHALL load configuration from a global file `context-cap.json` in the pi agent config directory and from a project file `.pi/context-cap.json` in the current project directory (resolved with the pi config directory name, not a hardcoded `.pi`). Project settings SHALL override global settings on a per-key basis. The project file SHALL only be read when the project is trusted.

#### Scenario: Project overrides global per key

- **WHEN** the global config sets `budget` to 200000 and the project config sets `budget` to 120000 while leaving `reserve` unset
- **THEN** the effective budget is 120000 and the effective reserve comes from the global config (or the default when unset)

#### Scenario: Untrusted project config ignored

- **WHEN** the project directory has a `.pi/context-cap.json` but the project is not trusted
- **THEN** the project file is ignored and only the global config and defaults apply

#### Scenario: Missing or invalid config files

- **WHEN** a config file does not exist, is unreadable, or is not valid JSON
- **THEN** the extension continues with the remaining configuration sources and reports an invalid file as a user-visible warning instead of failing

### Requirement: Model whitelist

The configuration SHALL accept a `models` array of glob patterns matched against `provider/modelId` (e.g. `openai-codex/*`) or a bare `modelId` (e.g. `claude-*`), consistent with pi's `scopedModels`/`enabledModels` matching (case-insensitive minimatch, where `*` does not cross `/`). The guard SHALL be active for a model only when that model matches at least one pattern. An absent or empty `models` list SHALL match all models.

#### Scenario: Model matches whitelist

- **WHEN** the whitelist contains `openai-codex/*` and the active model is `openai-codex/gpt-5.6-sol`
- **THEN** the guard is active for this model

#### Scenario: Model outside whitelist

- **WHEN** the whitelist contains `anthropic/*` and the active model is `openai-codex/gpt-5.6-sol`
- **THEN** the guard takes no action for this model

#### Scenario: Empty whitelist matches everything

- **WHEN** no `models` key is configured or the array is empty
- **THEN** the guard is active for every model

### Requirement: Configurable budget and reserve

The configuration files SHALL accept `budget` (positive integer token count) and `reserve` (positive integer token count) keys with the same semantics as the CLI flags, and both SHALL be validated: non-numeric or non-positive values are rejected with a user-visible warning, and `reserve` equal to or greater than `budget` SHALL be rejected as a configuration error that disables the guard. `budget` is optional: when neither the flag nor a config `budget` is present, the effective budget derives from the active model's configured context window (see the guard spec).

#### Scenario: Valid config values applied

- **WHEN** a config file sets `budget` to 150000 and `reserve` to 24000
- **THEN** compaction fires when usage exceeds 126000 tokens

#### Scenario: Invalid reserve rejected

- **WHEN** a config file sets `reserve` to a value greater than or equal to `budget`
- **THEN** the guard stays disabled for the session and the user is notified of the configuration error

#### Scenario: Omitted budget follows the model window

- **WHEN** a config file sets only `reserve` and the active model's `contextWindow` is 128000
- **THEN** the effective budget is 128000 and compaction fires when usage exceeds `128000 - reserve`

#### Scenario: JSON null values treated as unset

- **WHEN** a config file sets `budget`, `models`, or `reserve` to JSON `null` (a common placeholder in generated configs)
- **THEN** the key is treated exactly like an absent key with no warning, and the remaining configuration sources apply

#### Scenario: Malformed token values rejected without truncation

- **WHEN** a config file sets `budget` to a non-integer number or a suffix string such as `"200k"`
- **THEN** the value is rejected with a user-visible warning instead of being silently truncated to a wrong token count
