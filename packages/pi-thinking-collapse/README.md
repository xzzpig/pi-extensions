# pi-thinking-collapse

Keep Pi's thinking blocks readable while the model is working, then get them
out of the way once the answer lands.

- **Visible while streaming** — thinking content stays expanded during
  `message_update`, so you can watch the model reason.
- **Auto-collapsed on completion** — when the assistant message ends
  (`message_end`), the thinking block collapses to a single label, keeping the
  transcript readable without losing the thinking text.
- **`ctrl+t` still wins** — Pi's global thinking toggle overrides the
  auto-collapse behavior, and a custom collapsed label set through
  `setHiddenThinkingLabel` is preserved.
- **Clicking a block is Pi's own behavior** — since Pi 0.85 the renderer wraps
  each thinking block in a `MouseRegion`, so a click toggles that block's
  visibility natively. This package used to implement its own click handler;
  that duplicate was removed in 0.2.0. It registers no mouse handling and has
  no companion-extension requirement.

## Install

```bash
pi install npm:@xzzpig/pi-thinking-collapse
```

## How it works

The plugin patches `AssistantMessageComponent.prototype` (reload-safe, via a
`Symbol.for` registry): `updateContent` computes an effective collapse flag per
message — the global `hideThinkingBlock` flag from `ctrl+t` / settings wins,
streaming forces expanded, and completion defaults to collapsed. Pi's own
per-run click override (`thinkingVisibilityOverrides`, keyed by thinking-run
index) is read by the renderer before that flag, so a click on a block is
honored even while the automatic behavior keeps running.

The two layers are independent: this package owns _when_ a block collapses on
its own, Pi owns _the user's click_ on a specific block.

## Compatibility

- `pi-tool-display`'s `Thinking:` label prefix is a data-level decoration and
  is orthogonal: it shows when thinking is expanded and is hidden together
  with the thinking text when collapsed.
- `pi-vibeguard` redacts thinking _content_; collapse state never mutates
  message data, so the two do not interact.

## Development

```bash
pnpm --filter @xzzpig/pi-thinking-collapse run typecheck
pnpm --filter @xzzpig/pi-thinking-collapse test
```
