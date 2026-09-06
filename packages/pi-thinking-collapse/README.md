# pi-thinking-collapse

Keep Pi's thinking blocks readable while the model is working, then get them
out of the way once the answer lands.

- **Visible while streaming** — thinking content stays expanded during
  `message_update`, so you can watch the model reason.
- **Auto-collapsed on completion** — when the assistant message ends
  (`message_end`), the thinking block collapses to a single label: `Thinking…
(click to expand)`, which doubles as a click affordance.
- **Click to toggle per message** — clicking the collapsed label expands
  that message's thinking; clicking the expanded thinking area collapses it
  again. The click protocol follows `pi-starline`'s click-to-expand tool
  boxes: the press is never consumed (selection anchors still work), the
  toggle happens on release on the same cell without motion.
- **`ctrl+t` still wins** — Pi's global thinking toggle keeps overriding the
  auto-collapse behavior, and the collapsed label text is preserved for
  extension-level `setHiddenThinkingLabel` customization.

Requires the `@xzzpig/pi-mouse-events` extension for the mouse part; without
it the auto-collapse behavior still works and the plugin degrades gracefully.

## Install

```bash
pi install npm:@xzzpig/pi-thinking-collapse
pi install npm:@xzzpig/pi-mouse-events
```

## How it works

The plugin patches `AssistantMessageComponent.prototype` (reload-safe, via a
`Symbol.for` registry): `updateContent` computes an effective collapse flag
per message — streaming forces expanded, completion defaults to collapsed,
an explicit click pins the choice, and the global `hideThinkingBlock` flag
from `ctrl+t` / settings wins over everything. Mouse handling is registered
through `pi-mouse-events`' `addMouseHandler`, resolving the clicked row to
the owning message component and its thinking rows through the layout tree
and a rendered component walk.

## Compatibility

- `pi-tool-display`'s `Thinking:` label prefix is a data-level decoration and
  is orthogonal: it shows when thinking is expanded and is hidden together
  with the thinking text when collapsed.
- `pi-vibeguard` redacts thinking _content_; collapse state never mutates
  message data, so the two do not interact.

## Development

```bash
pnpm --filter pi-thinking-collapse run typecheck
pnpm --filter pi-thinking-collapse test
```
