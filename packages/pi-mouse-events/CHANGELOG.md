# Changelog

## [0.1.1] — 2026-09-06

### Fixed

- **A session replacement (`/new`, fork, session switch, reload) no longer
  crashes pi on the next mouse event.** pi invalidates a session's extension
  runtime when that session is replaced, so `pi.events.emit` through the
  `pi` captured at extension load throws — and the prototype patch is
  process-wide, outliving sessions. pi re-runs extension factories on every
  session replacement; the entry point now hands each new session's `pi` to
  the published patches (`refreshBus` on the API), and emission rides the
  newest handle. Emission stays deliberately unguarded: a throw is a real
  contract violation that propagates rather than being swallowed.

## [0.1.0] — 2026-09-06

Initial release.

- **`onMouse` opt-in for any component.** Pi's fullscreen (`TuiAltScreen`)
  renderer dispatches `Component.onMouse(event)` — replicating upstream
  [PR #8037](https://github.com/earendil-works/pi/pull/8037) as an extension:
  visible overlays frontmost-first, then the layout tree's deepest box, with
  `{ handled: true }` consuming the event before the built-in scrollbar,
  selection, and viewport handling. The package publishes the TypeScript
  augmentation that adds the optional `onMouse` to pi-tui's `Component`.
- **Global mouse event channel.** Every parsed mouse event is emitted on the
  shared extension event bus under `pi-mouse-events:mouse` after the dispatch
  decision — `kind` (`wheel`/`down`/`up`/`motion`), screen coordinates, wheel
  direction, `handled`, and the component that consumed it. Observe with
  `pi.events.on`; to influence consumption, register a handler instead.
- **Handler slots on the published API** (`getMouseEventsApi()`, v1 contract
  under `Symbol.for("pi-mouse-events.api.v1")`, read-safe across Pi's
  per-extension module isolation):
  - `addMouseHandler(handler, { priority })` — runs when no component handled
    the event, before the built-ins; `{ handled: true }` consumes it.
  - `addCopyHandler(handler)` — runs in front of
    `TuiAltScreen.copyActiveSelectionToClipboard` (pi-tui ≥ 0.84.3;
    `copySlotAvailable` reports whether the slot exists on this build).
  - `hitTest(tui, x, y)`, `parseMouseEvent(data)`, `isMouseSequence(data)`,
    `liveReceiver()` — the component under a screen cell, SGR/X10 parsing on
    Pi's own rules, and the renderer instance the input wrapper last ran
    against (the hook render-time consumers need to read renderer state).
- Deliberate deviations from upstream PR #8037 are documented in the README:
  overlay dispatch follows paint order (focusOrder descending), overlay
  geometry is resolved lazily, and the event channel + handler slots + API are
  additions the PR does not have.
