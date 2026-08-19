# Changelog

All notable changes to the `@xzzpig/pi-starline` fork are documented here.
This fork tracks [`Andy8647/pi-starline`](https://github.com/Andy8647/pi-starline)
via git subtree; entries below describe only fork-specific deviations from
upstream.

## 0.1.0

### Fixed

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
