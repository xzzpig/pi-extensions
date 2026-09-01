## Purpose

Guard against unbounded context growth during a single agent turn: while the tool loop is still running, force a compaction once estimated context tokens exceed a configured budget minus reserve, then resume the interrupted task automatically.

## ADDED Requirements

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
