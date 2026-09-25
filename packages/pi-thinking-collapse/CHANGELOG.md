# Changelog

## [0.2.0] — 2026-09-24

### Breaking

- **Click-to-toggle was removed; that feature is Pi's own.** Pi 0.85.0 made
  `MouseRegion` public and the renderer now wraps every thinking block in one,
  flipping a per-run entry in the component's own `thinkingVisibilityOverrides`
  map. This package shipped a second implementation of the same gesture — a
  `pi-mouse-events` handler that resolved the clicked row back to its message
  component and pinned it — which meant two handlers competing for the same
  click. The click protocol (`src/click.ts`), its row-resolution walk
  (`src/ownership.ts`), the per-message pin state, and the
  `installClickHandling` retry loop are gone; clicking a block is handled
  natively again. The prototype patches and the automatic behavior are
  unchanged.
- **`@xzzpig/pi-mouse-events` is no longer a dependency.** It was needed only
  for the click handler. This package now installs standalone — no companion
  extension, no load-order retry.
- **Pi 0.86.0 or newer.** The peer range is now `>=0.86.0 <0.88` (was
  `>=0.84.2 <0.85`) for both `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` — the versions whose renderer owns the native click
  path this package now defers to.

### Kept

- **Automatic collapse, which is what Pi does not do.** Thinking stays visible
  while the message is streaming and collapses once it completes; `ctrl+t` /
  settings still override everything, and a custom collapsed label set through
  `setHiddenThinkingLabel` is still honored. The `updateContent` and
  `setHideThinkingBlock` patches, the per-component global-flag recording, and
  the reload-safe `Symbol.for` patch registry are untouched.

### Verified

- The native click and the automatic collapse do not fight. Asserted against
  real `AssistantMessageComponent` instances on pi-tui 0.87.1: after the
  package auto-collapses a message, Pi's click (`overrides.set(runIndex,
false)` — the exact write the `MouseRegion` handler performs) expands the
  block, a later automatic pass leaves that choice intact (the renderer reads
  `overrides.get(runIndex) ?? hideThinkingBlock`), and `ctrl+t` still hides
  everything by clearing the overrides.

## [0.1.0] — 2026-09-12

Initial release.

- Thinking content stays expanded during `message_update` and collapses once
  the assistant message ends, driven by a patched
  `AssistantMessageComponent.prototype.updateContent` that computes an
  effective per-message collapse flag (the global `hideThinkingBlock` flag
  from `ctrl+t` / settings wins, streaming forces expanded, completion
  defaults to collapsed).
- Per-message click-to-toggle through a `pi-mouse-events` mouse handler, using
  the click-on-shell protocol (the press is never consumed so selection
  anchors survive; the toggle happens on release on the same cell without
  motion), with the choice pinned per message object so a session rebuild keeps
  it.
- Reload-safe prototype patching via a `Symbol.for` registry, so repeated
  factory runs and multiple copies of the package wrap `updateContent` exactly
  once.
