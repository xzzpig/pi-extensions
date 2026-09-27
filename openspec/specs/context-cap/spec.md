# context-cap Specification

## Purpose

定义 `@xzzpig/pi-context-cap` fork 的轮中强制压缩能力：在工具循环内部（LLM 调用之间）按模型上下文窗口触发压缩，支持全局与项目级配置文件、模型白名单、可配置预算与保留量，并提供会话级三态开关与状态显示。

## Requirements

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

### Requirement: Mid-turn compaction trigger

The extension SHALL check estimated context usage at every `turn_end` event that carries tool results (i.e. whenever the tool loop would continue) and SHALL trigger a forced compaction when usage exceeds `budget - reserve`. It SHALL also check at `agent_settled` (run finished) and at `session_start` (a resumed session may already exceed the budget).

#### Scenario: Tool loop crosses the budget mid-turn

- **WHEN** an assistant turn produces tool results and the estimated context usage (including trailing tool-result tokens) exceeds `budget - reserve`
- **THEN** the extension starts a compaction, which aborts the running agent loop, and after the compaction completes it sends a follow-up prompt instructing the model to continue the task from the compaction summary

#### Scenario: Run settles over budget

- **WHEN** the agent run finishes (no continuation pending) and usage exceeds `budget - reserve`
- **THEN** the extension compacts quietly without sending a resume prompt

#### Scenario: Overhead below threshold

- **WHEN** estimated usage is at or below `budget - reserve`
- **THEN** the extension takes no action on that event

### Requirement: Re-entrancy and failure guards

The extension MUST NOT start a second compaction while one is in flight. After a failed compaction, it SHALL require at least 20k tokens of growth before firing again, and SHALL disable itself for the rest of the session after two consecutive compaction failures, notifying the user.

#### Scenario: Overlapping trigger suppressed

- **WHEN** a compaction is already in flight and another trigger event fires while usage is over budget
- **THEN** no second compaction is started

#### Scenario: Repeated compaction failures

- **WHEN** two consecutive triggered compactions fail
- **THEN** the extension disables itself for the session and reports the failure via a user-visible notification

### Requirement: Model context window is not modified

The extension MUST NOT change `model.contextWindow` or any model registration; the budget lives only inside the extension. The active model's `contextWindow` is read (not written) at each event so budget derivation and window clamping follow the model's configured context length and pick up model switches immediately.

#### Scenario: Model registration unchanged

- **WHEN** the extension is active and enforcing a budget
- **THEN** the active model's `contextWindow` value is the same as it would be without the extension

#### Scenario: Model switch recomputes the budget

- **WHEN** the active model switches from a 1048576-token window to a 128000-token window mid-session
- **THEN** the effective budget drops from 1048576 to 128000 without a restart, and the trigger point drops to `128000 - reserve`

### Requirement: Budget configuration precedence

The effective budget and reserve SHALL resolve from, in ascending precedence: built-in defaults (200,000 / 16,384), configuration files, and CLI flags `--context-cap` / `--context-cap-reserve` (highest). The `/context-cap <tokens>` command SHALL override the budget for the current session only. When no explicit budget is configured (no flag, no config `budget`, no session command), the budget SHALL equal the active model's configured context window — the compaction point is then `contextWindow - reserve`, mirroring pi's native compaction threshold but enforced mid-loop. The 200,000 default SHALL apply only when the model does not expose a configured window.

#### Scenario: CLI flag overrides default

- **WHEN** pi is started with `--context-cap 150000`
- **THEN** compaction fires when usage exceeds 150000 minus the effective reserve

#### Scenario: Session command overrides budget

- **WHEN** the user runs `/context-cap 150000` mid-session
- **THEN** the budget for the current session becomes 150000 and the change does not persist to later sessions

#### Scenario: Budget follows the model window

- **WHEN** no explicit budget is configured and the active model has `contextWindow` 128000
- **THEN** the effective budget is 128000 and compaction fires when usage exceeds `128000 - reserve`

#### Scenario: Unknown window falls back to the default

- **WHEN** no explicit budget is configured and the active model does not expose a `contextWindow`
- **THEN** the effective budget is the 200000 default and compaction fires when usage exceeds `200000 - reserve`

### Requirement: Compaction point clamped inside the model window

The compaction point SHALL never exceed the active model's configured `contextWindow` minus a 4096-token safety margin (matching pi-ai's `CONTEXT_SAFETY_TOKENS`), regardless of any explicit budget. The guard SHALL be inactive when the model window is too small to host the safety margin (`contextWindow <= 4096`) or too small to host the configured reserve; the reason SHALL be surfaced in the status output and when the session starts.

#### Scenario: Trigger point clamped below the window

- **WHEN** the budget is 150000 with a 16384 reserve (raw trigger 133616) but the active model's window is 100000
- **THEN** the trigger point is clamped to `100000 - 4096 = 95904`, and compaction fires once usage exceeds 95904

#### Scenario: Window too small for the safety margin

- **WHEN** the active model's `contextWindow` is 3000 (below the 4096 safety margin)
- **THEN** the guard stays inactive and the status shows the window-too-small reason

#### Scenario: Window too small for the reserve

- **WHEN** the model window derives a budget of 5904 (window 10000 minus 4096) while the reserve is 16384
- **THEN** the guard stays inactive for that model and the status shows the reason

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
