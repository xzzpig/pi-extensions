# Fork Changelog

Changes specific to `@xzzpig/pi-tidy` in this repository. Upstream history remains in
[`CHANGELOG.md`](./CHANGELOG.md).

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
- Guard the group-boundary renderer against nested installs: only the outermost wrapper restyles a
  component and inner wrappers pass through. `pi-group-collapse` installs its render projection
  between pi-tidy's load-time and `before_agent_start` boundary installs; without the guard both
  wrappers remap the same rows and a retry error draws its `error ×2` frame twice.
