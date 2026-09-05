# Changelog

All notable changes to the `@xzzpig/pi-starline` fork are documented here.
This fork tracks [`Andy8647/pi-starline`](https://github.com/Andy8647/pi-starline)
via git subtree; entries below describe only fork-specific deviations from
upstream.

## [0.3.0] — 2026-09-06 (fork release)

### Changed

- **Click-to-expand toggles from any row, both directions.** A plain click
  anywhere on an expandable component — tool/bash box, skill block, branch or
  compaction summary, custom entry or message — toggles just that one; the
  click no longer has to land on the `… ctrl+o to expand` hint row. The
  direction comes from the hint row when one is rendered and from the
  component's own expansion state otherwise, so boxes that drop their hint
  once expanded (read/grep/ls/write/find results, the summaries) can finally
  be closed by clicking them. The toggle happens on the release of a click
  (press and release on the same cell, no drag): the press itself is never
  consumed, so dragging across a box still selects and copies its text, a
  double-click still word-selects, and a click on an OSC 8 link still opens
  the link. A component whose path declares `onMouse` keeps its clicks.
- **The mouse feature set no longer patches `TuiAltScreen.prototype`.** All
  mouse handling moved on top of the new
  [`@xzzpig/pi-mouse-events`](https://www.npmjs.com/package/@xzzpig/pi-mouse-events)
  extension (optional peer dependency): it owns the prototype patches, dispatches
  `onMouse` events to components before the built-in scrollbar/selection
  handling, and exposes handler slots that Starline's wheel routing,
  click-to-expand, click-to-caret, range delete and clean copies register
  with. If that extension is not installed, the mouse features are all off —
  there is no patch-based fallback. The keyboard half of click-to-caret (range
  delete) now rides `ctx.ui.onTerminalInput`, and the selection and
  external-editor hints are derived at render time instead of being refreshed
  from a viewport-input patch.

## 0.1.0

## [0.2.0] — 2026-09-05 (fork release)

### Changed

- **Synced upstream v0.3.2 → v0.3.4** (breaking upstream changes → fork minor
  bump per the 0.x fork convention). Upstream v0.3.3 adopts Pi 0.84.4's
  native select-without-copy: the selection stays highlighted and the copy
  key is now `app.message.copy` (default `ctrl+x`) instead of `ctrl+c`,
  which always interrupts again; peer ranges for `@earendil-works/pi-ai`,
  `pi-coding-agent`, and `pi-tui` rise to `>= 0.84.4`. Upstream v0.3.4
  drops Starline's own path-aware word selection (`mouse.pathAwareWords`
  removed and ignored in old configs) because Pi 0.84.4 natively keeps `/`
  and `-` inside double-clicked words. The mouse-install contract fake now
  implements `copyActiveSelectionToClipboard` per the new TUI interface.
  Fork divergence preserved: git probes in the statusline refresh still
  pass `--no-optional-locks` to avoid `.git/index.lock` churn.

## [0.1.1] — 2026-08-24 (fork release)

### Changed

- **Synced upstream v0.3.1 → v0.3.2.** Upstream raised peer ranges for
  `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` to `>= 0.84.0`
  and added a `TuiAltScreen` missing-guard (readable warning instead of a
  startup crash on older Pi bundles). Adopted as-is on top of the fork.

- **Git status no longer churns `.git/index.lock`.** Every git probe in the
  statusline refresh (`git status --porcelain=2`, `git diff --numstat`, and the
  `stash list` / `describe` / `rev-parse` / `remote get-url` companions) now
  passes `--no-optional-locks`, so git never takes the index lock for optional
  stat refresh. The statusline refreshes on a 30s interval plus nearly every Pi
  event (message/tool completion, compaction, session tree, agent start/end),
  and a stale index used to make each `git status` rewrite the index — constant
  `index.lock` create/delete cycles and occasional "Unable to create
  index.lock: File exists" collisions with concurrent git processes.

### Changed

- Initial fork of `Andy8647/pi-starline` v0.3.1, published as
  `@xzzpig/pi-starline`.
