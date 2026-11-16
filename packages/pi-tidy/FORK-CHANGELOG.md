# Fork Changelog

Changes specific to `@xzzpig/pi-tidy` in this repository. Upstream history remains in
[`CHANGELOG.md`](./CHANGELOG.md).

## 0.1.4 — 降低长会话渲染开销

- 稳定回复复用代码块规则线与复制按钮布局，避免每帧扫描全部历史代码行；内容、宽度和相关选项变化时重新计算。
- 流式代码块仅保留当前有效 token 的派生缓存，释放已被替换的正文版本，保留各块最新复制原文。
- 色块识别使用当前位置匹配与分段输出，避免密集无效颜色候选触发平方级回扫；颜色格式与代码区域排除行为不变。
- agent 工作期间继续复用未变化的历史工具分组行，活动工具与后台任务仍正常刷新。
- 增加代码块缓存/复制/悬停、混合活动与历史分组交互回归，以及长代码、色块和折叠/展开历史组基准。

## 0.1.3 — Leave write rendering to the owner by default

- Add `tidy.writePreview` (default `false`). Leave write rendering to Pi or the owning extension
  unless explicitly enabled, avoiding duplicate content with pi-tool-display's result diff.
  `writeLines` only applies when this opt-in is enabled.

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
