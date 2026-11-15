# Fork Changelog

Changes specific to `@xzzpig/pi-tidy` in this repository. Upstream history remains in
[`CHANGELOG.md`](./CHANGELOG.md).

## 0.1.2 — Preserve native streaming thinking visibility

- Keep native thinking visibility untouched during rendering. Previously `nativeThinking: true`
  still seeded per-run collapsed overrides before returning native rows, so the first redraw
  collapsed streaming reasoning and defeated `pi-thinking-collapse`'s expand-while-streaming rule.
  Regression coverage now renders, invalidates, and updates the streaming component repeatedly
  before checking automatic collapse on completion.

## 0.1.1 — Native thinking and renderer switch fixes

- Add fork-only `nativeThinking` (default `true`): leave thinking to Pi and `pi-thinking-collapse`
  instead of drawing pi-tidy's own row; set `false` to restore the upstream thinking row. The
  framed final reply still keeps completed thinking outside its border.
- Initialize the renderer switches even when tool framing is off. `groupTools: false` reached the
  boundary renderer only through the disabled tool-frame patch, so it kept the default `true` and
  treated a thinking + tool-use assistant as a group carrier: the thinking row vanished when the
  first tool call arrived. The fork now publishes `groupTools`, `icons`, `thinkingColor` and the
  native-thinking switch itself when `frameTools` is off.
- Guard the group-boundary renderer against nested installs: only the outermost wrapper restyles a
  component and inner wrappers pass through. `pi-group-collapse` installs its render projection
  between pi-tidy's load-time and `before_agent_start` boundary installs; without the guard both
  wrappers remap the same rows and a retry error draws its `error ×2` frame twice.

## 0.1.0 — Initial fork

Forked from Andy8647/pi-tidy v0.9.6.

- Add omission-only fork runtime defaults in `fork/defaults.ts`; upstream `src/config.ts` and its
  `DEFAULTS` remain unchanged.
- Add fork-only `frameTools` (default `false`), preserving shared hover tracking for code-block
  copy controls while leaving tool-frame ownership to `pi-tool-display`.
- Enable `frameMessages` so the selected `userMessageStyle: "frame"` renders. The upstream shares
  this switch with compaction, branch, skill and custom message boxes, so those frames are enabled
  by default too. Keep turn folding, tool grouping, split diffs, bash highlighting, background jobs,
  per-tool colors, and clean-copy disabled by default; users can opt into them with `tidy.*`.
- Keep user-message style at `frame`; retain the upstream defaults for error deduplication, hex
  swatches, final-reply framing, and code-block sections.
- Preserve `pi-thinking-collapse`'s completed thinking row outside pi-tidy's final-reply frame, with
  Pi's native click-to-expand/re-collapse behavior intact.
- Do not modify `pi-tool-display` defaults. When both packages are installed, users who want pi-tidy
  to own user-message rendering must set `enableNativeUserMessageBox` to `false` in
  `~/.pi/extensions/pi-tool-display/config.json`.
- Do not restore the tool-frame path-copy chip; it lives on a frame that this fork disables by
  default.
