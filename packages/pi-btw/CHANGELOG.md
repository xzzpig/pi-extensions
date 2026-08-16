# Changelog

All notable changes to the `@xzzpig/pi-btw` fork are documented here. This
fork tracks [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw) via git
subtree; entries below describe only fork-specific deviations from upstream.

## 0.4.1

### Fixed

- **Fullscreen TUI mouse-mode conflict (scrolling broken after closing the BTW
  overlay).** In fullscreen (alt-screen) mode, `@earendil-works/pi-tui` owns
  terminal mouse-reporting modes (`?1000`/`?1006`/`?1002`/`?1004`) and enters
  them exactly once on start, never re-asserting them. The BTW overlay's
  constructor and `dispose()` wrote `?1000h ?1006h` / `?1000l ?1006l`
  unconditionally, so closing the overlay disabled the modes pi-tui relies on
  to parse wheel events and scroll the message view — leaving the transcript
  unscrollable for the rest of the session.

  The overlay now only opts in to mouse reporting when pi-tui is **not**
  managing it (`tui.mode !== "fullscreen"`), and `dispose()` only undoes the
  modes it actually enabled. In fullscreen mode pi-tui already forwards wheel
  events to a focused overlay, so the writes were unnecessary there anyway.
  `tui.mode` is read defensively so the code still compiles against pi-tui
  versions that predate the `mode` property.

### Fork metadata

- Initial fork of upstream `dbachelder/pi-btw` at tag `v0.4.1`
  (commit `4f858102706910ee9d520a9666832f3103631b61`), imported via
  `git subtree add --squash`.
- npm package name renamed from `pi-btw` to `@xzzpig/pi-btw` per the monorepo
  fork convention.
