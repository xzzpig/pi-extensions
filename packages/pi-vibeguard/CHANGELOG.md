# Changelog

## 0.2.3

### Fixed

- Include the fork-only runtime modules `fork-commands.ts` and `suspension-state.ts` in the npm package files allowlist. Version 0.2.2 omitted them, so the published `index.ts` imported files absent from the tarball and Pi failed to load the extension. The package archive is now checked for both transitive modules and the installed package entry is smoke-tested.

## 0.2.2

### Changed

- **Conflict-surface refactor, no behavior change.** The session-scoped suspension state moved to fork-only `suspension-state.ts` and the six `/vibeguard:*` commands to fork-only `fork-commands.ts`; `index.ts` now registers them with one `registerVibeguardCommands(pi, deps)` call.

### Fixed

- Each `/vibeguard:*` command is registered exactly once. A leftover `vibeguard:list`/`vibeguard:stats` registration in `index.ts` duplicated the fork-commands registration; tests that stored commands in a `Map` could not see it, so `tests/command-registration.test.ts` now counts registrations.

## 0.2.1

### Changed

- **Conflict-surface refactor, no behavior change.** The Mapping View and Category Picker UI moved to fork-only `mapping-view.ts` and `category-picker.ts` (`index.ts` keeps imports and command registrations, halving its diff); the suspension skip-threading through `redactText`/`redactDeep`/`redactMessageContent` was replaced by a call-site `filterPatternSet` in fork-only `suspension-filter.ts`, leaving the redaction engine byte-identical to upstream; the upstream standalone `test-engine.ts` script is no longer type-checked.

## 0.2.0

- **Session-scoped temporary suspension** (global or per rule category):
  - `/vibeguard:disable [category]` — suspend redaction of NEW content (whole extension without a category, or a single category, e.g. `/vibeguard:disable API_KEY`); unknown categories warn with the available list.
  - `/vibeguard:enable [category]` — full resume or resume one category; no-arg enable clears global suspension and every suspended category.
  - `/vibeguard:status` — reports active / suspended state (e.g. `整体挂起` or `挂起类别：EMAIL, MAC`).
  - `/vibeguard:categories` — interactive TUI multi-select picker (Space/Enter toggle, ↑/↓ j/k navigate, q/Esc close; row 0 = global toggle).
  - Suspension semantics: only NEW content stops producing placeholders; historical placeholders created earlier in the session are still restored on both restore paths (before tool execution and after assistant output). State is in-memory and session-scoped — resets after a pi restart / new session; the on-disk config file is never modified.
  - Status bar reflects the state: `VibeGuard[OFF]` / `VibeGuard[OFF:EMAIL,MAC]` / `VibeGuard[ON]`.
  - TUI notifications / status markers render locally only and never enter the LLM context.
- Added real-runtime e2e validation (Level 1 print-mode smoke + Level 2 tmux interaction) covering plaintext-to-model while suspended, resume, historical-placeholder restore under suspension (both tool args and assistant output), per-category suspension, the category picker, and restart reset.

## 0.1.0 (fork @xzzpig/pi-vibeguard)

- Renamed npm package to `@xzzpig/pi-vibeguard` (local fork of aizigao/pi-vibeguard v0.1.2, imported as a git subtree).
- Added `/vibeguard:list` and `/vibeguard:stats` mapping-viewer commands (custom TUI overlay; masked originals with `r` to reveal; TTL remaining; stats by category).
- Added `@earendil-works/pi-tui` as a peer dependency for the viewer UI; added vitest unit + extension-level tests under `tests/`.

## 0.1.1
- Config lookup (first match wins):
  1. `PI_VIBEGUARD_CONFIG` env var
  2. `./vibeguard.config.json` (project root)
  3. `./.pi/vibeguard.config.json` (project .pi dir)
  4. `~/.pi/agent/vibeguard.config.json` (global)

## 0.1.0

- Initial release: pi-vibeguard extension
- Replace sensitive strings with VibeGuard-compatible placeholders before LLM requests
- Restore placeholders before tool execution
- Config format compatible with opencode-vibeguard
- Built-in patterns: email, china_phone, china_id, uuid, ipv4, mac
- Support for keyword and regex patterns with exclude list
- Placeholder format: `__VG_<CATEGORY>_<hash12>__` (HMAC-SHA256)
- Session-specific random secret ensures placeholders are irreversible to the provider
- Zero external dependencies (node: built-ins only)
