# Changelog

## [0.2.0] - 2026-09-11

### Added

- **Generic UI-prompt adapter (`ui_prompt_start` / `ui_prompt_end`).** Every
  blocking `ctx.ui.*` dialog is routed to the semantic events while an agent
  run is active: permission-confirmation contexts yield `permission-required`
  (with a Herdr label carrying the forwarded requester name), active pi-ask
  flows yield `input-required` with the sanitized question title as the Herdr
  label, and all other spans yield `input-required` with the fixed copy. The
  dialog span is the single notification source and the single Herdr
  bookkeeper; labeled ask/permission bus events only feed span classification.
  Requires pi `>= 0.84.4` (declared in `peerDependencies`).
- **Silent span marker protocol.** Plugins opening non-agent-waiting dialogs
  (monitoring panels, admin forms) may emit `pi-notify:ui_span_silent`
  (`{ reason?: string }`) synchronously before the blocking `ctx.ui.*` call;
  the next span is then registered without a notification and without a Herdr
  wait entry while still being tracked for `ui_prompt_end` pairing. Markers
  are one-shot, invalid payloads are ignored, and unconsumed markers are
  cleared on session reset. `PI_NOTIFY_UI_SPAN_SILENT_EVENT` and
  `UiSpanSilentPayload` are exported from the package API. Emitters must not
  depend on this package (use the literal event name).

### Changed

- `InteractionRoutingTracker` (ask/permission deduplication) removed: the
  dialog span now deduplicates naturally via core nesting.
- `peerDependencies`: `@earendil-works/pi-coding-agent` raised from `*` to
  `>= 0.84.4`.

## [0.1.0] - 2026-08-29

- Initial release: OSC terminal notifications, ntfy push channel, seven
  semantic Pi events, pi-ask / pi-permission-system adapters, Herdr blocked
  state, cross-plugin `pi-notify:publish` protocol.
