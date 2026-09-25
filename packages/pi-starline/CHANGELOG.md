# Changelog

All notable changes to the `@xzzpig/pi-starline` fork are documented here.
This fork tracks [`Andy8647/pi-starline`](https://github.com/Andy8647/pi-starline)
via git subtree; entries below describe only fork-specific deviations from
upstream.

## [0.5.0] — 2026-09-25 (fork release)

### Changed

- **Synced upstream v0.3.5 → v0.3.7** (upstream minor releases → fork minor bump). Upstream v0.3.6 fixes the user-message render patch to run `markdownTransformers`; upstream v0.3.7 removes `clickToExpandTools` because Pi 0.86.0+ toggles tool boxes natively. The fork keeps the feature, renamed to **`mouse.clickToToggleExpandable`** (default `on`), covering any collapsible box (tool boxes, bash boxes, skill/summary blocks, custom entries/messages). Old configs are migrated: a `fixedEditor`-era or `mouse`-era `clickToExpandTools` value carries over to the new key, and the new key wins when both are present.
- **Deleted the `handlesMouse()` bow-out predicate** (D1). It duck-typed `onMouse`, which never appears on real rows — the component-tree walk cannot descend into pi-tui's `MouseRegion` (singular `child`, not `children`), so the predicate never fired and the fork always resolved tool rows anyway. Resolution now decides by `setExpanded` capability alone: a row whose path reaches a set-expanded component toggles it, and a row with none (thinking blocks, plain messages) is left to Pi's native click handling.
- **Raised the Pi runtime floor to `@earendil-works/pi-tui`/`pi-coding-agent`/`pi-ai` `>=0.86.0 <0.88`** and consumes the `@xzzpig/pi-mouse-events` v2 contract (`pi-mouse-events.api.v2` key, `version: 2`). BREAKING: pi 0.84.x/0.85.x are no longer supported.
- `/starline` settings now shows the renamed **Click to toggle expandable** toggle and persists it under the new key.

### Added

- `mouse/index.ts` reads the new `clickToToggleExpandable` key in the feature gate and press guard; `config.ts` carries the rename through `MouseConfig`, `FIXED_EDITOR_KEY_MAP`, `defaultConfig`, `normalizeMouseConfig` (with old-key fallback) and `saveMousePatch`.

## [0.4.1] — 2026-09-19 (fork release)

### Changed

- **Conflict-surface refactor, no behavior change.** `package-lock.json` was restored to npm's native tab indentation and now carries the missing `@xzzpig/pi-mouse-events` devDependency entry, instead of a 5,069-line whole-file reindentation.

### Added

- `mouse/api-consumer.ts` rejects an API object whose contract `version` is not `1`, so a future contract major cannot surface a shape-mismatched API. The contract test now pins the slot-dispatch semantics (priority order, consume-on-first-handled, skip-throwing, fall-through) against the real implementation via the new `@xzzpig/pi-mouse-events/test-support` export.

## [0.4.0] — 2026-09-13 (fork release)

### Changed

- **Synced upstream v0.3.4 → v0.3.5** (upstream minor release → fork minor
  bump). Upstream v0.3.5 adds `extensionStatuses.placements[key]: "editor"`,
  which puts a third-party status on the editor's bottom-right metadata row
  (the slot the copy and paste hints already use) instead of the footer,
  plus the tests covering it rank 12 total. The local fork's mouse features
  remain on `@xzzpig/pi-mouse-events` as before; upstream's copy-handler
  refactor there does not apply to the fork's `pi-mouse-events` architecture.

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
