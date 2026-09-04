# Changelog

All notable changes to the `@xzzpig/pi-starline` fork are documented here.
This fork tracks [`Andy8647/pi-starline`](https://github.com/Andy8647/pi-starline)
via git subtree; entries below describe only fork-specific deviations from
upstream.

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
