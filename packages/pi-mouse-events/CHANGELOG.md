# Changelog

## [0.2.0] — 2026-09-24

### Breaking

- **The `onMouse` component hook is gone; component clicks are Pi's native
  `handleMouse`.** Pi-tui 0.85.0 made `Component.handleMouse` and
  `MouseRegion` public, and the renderer dispatches them itself, so this
  package's own component-dispatch layer (`extensions/dispatch.ts`, the
  `Component` module augmentation, the overlay/layout target resolution it
  needed) was a second, competing contract for the same job. It is removed:
  a component that wants its own clicks implements `handleMouse`, and
  `MouseRegion` is what makes a whole block clickable. Nothing in this repo's
  packages implemented `onMouse`, so no consumer loses behavior — the hook was
  already unused.
- **Contract version 2, under a new key.** `MouseEventsApi.version` is `2` and
  the API is published at `Symbol.for("pi-mouse-events.api.v2")` instead of
  `…api.v1`. `api.ts` promises that fields are not removed or reshaped within
  a major version, and `MouseDispatchEvent.dispatched` — the component a
  dispatch consumed — no longer exists, so the key advances with the shape:
  a consumer reading the old key gets `undefined` and its existing
  `version` check reports "unavailable" rather than half-reading a new shape.
- **Pi 0.86.0 or newer.** The peer range is now `>=0.86.0 <0.88` (was
  `>=0.84.2 <0.85`) for both `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui`. Pi 0.84.x/0.85.x cannot satisfy the peer range and
  lack the component gesture state the restore path below relies on.

### Added

- **Pi's gesture and selection state is restored after a consumed release.**
  The click protocol this package serves never consumes the press (Pi's
  selection machinery anchors on it) but does consume the release — and the
  release branch is where Pi clears the state its press branch armed. Without
  the restore, a consumed release left `selectionPressActive` / `selectionAnchor`
  (and the component gesture fields) stale, so the next motion report looked
  like a drag and a selection survived that the user never made. Both reset
  methods are called when present, with a direct field reset as the backstop
  for a build that renamed them. Measured in a real TUI: with the fix a
  consumed release leaves `selectionPressActive=false` / `selectionAnchor=undefined`,
  matching the no-extension baseline. A consumer that consumes releases —
  pi-starline's transcript click routing is the one in this repo — gets this
  without any change of its own: the restore happens in the patch layer, below
  the handler that returned `{ handled: true }`.
- **`clearComponentMouseGesture` and `clearTextSelection` are pinned by the
  contract tests**, so a pi-tui release that moves them goes red here instead
  of silently leaving gestures unrestored.

### Changed

- **`addMouseHandler` runs on every parsed mouse event** rather than only when
  no component took it (there is no component dispatch to take it first), and
  the bus payload's `handled` reports only this extension's decision: an event
  it left unconsumed continues into Pi's built-ins — including the
  component-level `handleMouse` dispatch — which this package does not
  observe. `handled: false` therefore never means "nothing handled it".
- `hitTest`, `parseMouseEvent`, `isMouseSequence`, `addCopyHandler`,
  `liveReceiver`, and `refreshBus` are unchanged.
- The README now documents the two-layer model (native `handleMouse`/
  `MouseRegion` for a component's own box, `addMouseHandler` for decisions
  that must see every event) instead of presenting `onMouse` as the
  component-side entry point.

## [0.1.3] — 2026-09-24

### Fixed

- **Mouse events can no longer crash pi during a session replacement.** pi
  disposes the old session — invalidating its extension runtime — _before_ it
  builds the replacement runtime, and only that build re-runs extension
  factories. The 0.1.1 fix moved the bus handle on each factory run, but the
  prototype input wrapper is process-wide and the input path stays live across
  that gap, so a mouse report delivered between invalidation and the next
  factory run still reached the dead handle. Because the call happens inside
  an input callback, the throw surfaced as an `uncaughtException` that
  terminated pi (`pi exiting due to uncaughtException: Error: This extension
ctx is stale after session replacement or reload`, via
  `patchedViewportInput`). Emission now drops the event when the bus refuses
  it and remembers the refusal instead of retrying it, so dispatch, handler
  slots, and the built-in fall-through are untouched. There is no live bus to
  reach for in that window (`refreshBus` runs before `session_start`), and
  emission resumes with the next factory run — verified against pi 0.85.1 in
  a real TUI: 80 wheel reports during a widened replacement window, no crash,
  and bus events observed again afterwards.

## [0.1.2] — 2026-09-19

### Added

- **`pi-mouse-events/test-support` subpath export.** The slot-dispatch contract
  — registered handlers run in priority order (higher first, ties by
  registration order), the first `{ handled: true }` consumes and stops the
  chain, a throwing handler is skipped, none handled falls through — is now
  reachable as pure functions (`runMouseHandlersInPriorityOrder`,
  `runCopyHandlersInPriorityOrder`, `dispatchMouseEvent`) that the runtime
  patches themselves call, so consumer-side test shims (pi-starline) can pin
  these semantics against the real implementation instead of re-deriving them.

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
