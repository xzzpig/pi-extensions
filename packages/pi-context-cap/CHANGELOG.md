# Changelog

## 0.1.2

- Fixed a spurious `compaction failed` error when pi's native auto-compaction won a race with the guard. `ctx.compact()` aborts the running agent before compacting, and that run-end moment lets pi's own auto-compaction check fire; with the default window-derived budget the two thresholds are identical (`contextWindow - 16384`), so pi could compact first and leave the manual pass nothing to do (`Nothing to compact (session too small)` / `Already compacted`).
- Compaction failures are now classified by outcome instead of error text: if a compaction entry appeared on the session branch since the trigger, the failure is reported as info (`context was already compacted; nothing to do`) rather than an error, is not counted towards the two-failure disable, and the 20k retry guard is reset so the guard keeps working as the context regrows. pi continues the run itself in this case, so no follow-up resume prompt is sent.

## 0.1.1

- Window-derived budget now follows the model's `contextWindow` directly: with no explicit budget the guard acts as pi's native compaction threshold (`contextWindow - reserve`) enforced mid-loop, and the 200000 default only applies when the model does not expose a window. Previously the derived budget was capped at 200000 (`min(200000, window - 4096)`). `status` annotates the budget source (`(model window)` / `(default)`).
- Fixed a crash in `/context-cap status` when the active model does not expose a `contextWindow`.
- Fixed a false-positive warning for JSON `null` config values: `"budget": null` (and `models`/`reserve`) is now treated as unset, the same as an absent key. Generated configs that use null placeholders (e.g. home-manager) no longer trigger `must be a positive token count`.
- Fixed the doubled `context-cap: context-cap:` prefix in config warnings.
- Config-load warnings no longer leak into the `off (model not whitelisted; …)` status reason; only invalid whitelist patterns (which genuinely affect matching) appear there.
- Whitelist matching is now case-insensitive, matching pi's `scopedModels` convention (`minimatch` with `nocase: true`).
- Strict token parsing: non-integer numbers and suffix strings like `"200k"` are rejected with a warning instead of being silently truncated (`"200k"` used to parse as 200).
- Invalid `--context-cap` / `--context-cap-reserve` flag values now warn instead of silently falling back to the defaults.
- verify.mjs isolates every test from the developer's real `~/.pi/agent` config (46 checks).

## 0.1.0 (fork @xzzpig/pi-context-cap)

- Renamed npm package to `@xzzpig/pi-context-cap` (local fork of lukeramsden/pi-context-cap v1.0.1, imported as a git subtree).
- Added `extensions/config.ts`: two-level `context-cap.json` config (global `~/.pi/agent/` + project `.pi/`, key-level merge, project-trusted guard), with validation (`reserve >= budget` disables the guard; invalid JSON/types warn and skip).
- Added `extensions/whitelist.ts`: model whitelist via minimatch against `provider/modelId` or bare `modelId` (empty = all models); invalid patterns warn and treat as non-matching.
- Budget aligns with the model's configured context window: when no explicit budget is set it derives as `min(200000, contextWindow - 4096)`, and the compaction point is always clamped to `contextWindow - 4096` (pi-ai `CONTEXT_SAFETY_TOKENS`). Models with windows too small to host the safety margin or the reserve disable the guard with a reason in `status`. `model.contextWindow` is read, never modified; model switches take effect immediately.
- Reworked session control to a tri-state override: `/context-cap on|off|default` forces the guard independently of the whitelist for the current session; `status` reports the effective state and its reason. Reset at `session_start`, never persisted.
- Added `extensions/index.ts` entry point; extended `scripts/verify.mjs` with fork coverage (whitelist, tri-state toggle, config files, merge precedence, window-derived budget, window clamping, model switching).
