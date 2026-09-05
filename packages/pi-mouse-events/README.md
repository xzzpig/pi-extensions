# @xzzpig/pi-mouse-events

Mouse event dispatch for [Pi](https://github.com/earendil-works/pi)'s
fullscreen TUI. Pi's renderer swallows every mouse report (wheel notches and
SGR clicks) in its own viewport listener before extensions can observe them,
which is why extension UI cannot scroll or click in fullscreen mode — the
same problem [pi-tui PR #8037](https://github.com/earendil-works/pi/pull/8037)
proposed to fix in core. This package implements that proposal as an
extension, and adds an integration surface PR did not have.

## What it does

- **`Component.onMouse`** — any component in the fullscreen TUI may implement
  an optional `onMouse(event)` method. Mouse events are dispatched to it
  before Pi's built-in scrollbar, selection, and viewport handling:
  frontmost visible overlay first, then the deepest layout box containing the
  pointer. Return `{ handled: true }` to consume the event; return nothing to
  let it fall through to the built-ins, so a component that ignores a wheel
  notch leaves transcript scrolling intact. The hook is duck-typed — no
  registration — and this package declares the TypeScript augmentation for
  pi-tui's `Component` interface.
- **Global mouse events** — every parsed mouse event is emitted on the shared
  extension event bus under `pi-mouse-events:mouse` (`MOUSE_EVENT_CHANNEL`)
  after the dispatch decision, with `kind`, screen coordinates, `handled`,
  and the component that consumed it. Listen with `pi.events.on` (`pi.on`
  cannot carry custom event names). **The bus is session-scoped**: pi
  invalidates a session's extension runtime when the session is replaced
  (`/new`, fork, switch, reload) and drops that session's bus subscriptions,
  so subscribe from a `session_start` handler — pi re-runs extension
  factories on every session replacement, which is also how this extension
  keeps its own emission pointed at the live session's bus.
- **Handler slots** — `getMouseEventsApi()` returns a process-global API
  (v1 contract):
  - `addMouseHandler(handler, { priority })` — runs when no component handled
    the event, before the built-ins; `{ handled: true }` consumes it.
  - `addCopyHandler(handler)` — runs in front of
    `TuiAltScreen.copyActiveSelectionToClipboard` (Pi's copy key, default
    ctrl+x); `{ handled: true }` answers the copy yourself.
  - `hitTest(tui, x, y)` — the component under a screen cell, overlay or
    layout, no `onMouse` required.
  - `parseMouseEvent(data)` / `isMouseSequence(data)` — the same SGR and
    legacy X10 parsing pi-tui applies.
  - `liveReceiver()` — the renderer instance the input wrapper last ran
    against, from the first keystroke or mouse report of the session onward.
    The hook render-time consumers need to read renderer state without waiting
    for a mouse event; inside a handler prefer the per-event `ctx.tui`.
- **Consumer-side types** — import from `@xzzpig/pi-mouse-events/api`. The
  module is dependency-free; the API is read through `Symbol.for`, so it
  works across Pi's per-extension module isolation whether or not your
  extension declares this package as a dependency.

## Example

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getMouseEventsApi,
  MOUSE_EVENT_CHANNEL,
  type MouseEventsApi,
} from "@xzzpig/pi-mouse-events/api";

export default function (pi: ExtensionAPI) {
  // 1. A custom overlay that scrolls with the wheel.
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.custom(
      (tui, theme) => ({
        render: (width) => lines,
        invalidate: () => {},
        onMouse(event) {
          if (event.wheel === undefined) return undefined;
          scrollBy(event.wheel);
          return { handled: true };
        },
      }),
      { overlay: true },
    );
  });

  // 2. Intercept every click in the transcript.
  pi.events.on(MOUSE_EVENT_CHANNEL, (data) => {
    const event = data as {
      kind: string;
      x: number;
      y: number;
      handled: boolean;
    };
  });

  // 3. Consume clicks before the built-in selection handling.
  const api: MouseEventsApi | undefined = getMouseEventsApi();
  api?.addMouseHandler(({ event, tui }) => {
    if (event.kind !== "down") return undefined;
    const target = api.hitTest(tui, event.x, event.y);
    // … decide, act, and consume or pass.
    return undefined;
  });
}
```

## Scope and behavior notes

- Fullscreen mode only (`TuiAltScreen`): pi-tui's regular (non-fullscreen)
  mode never enables mouse tracking, so there is nothing to dispatch there.
- Overlay geometry is resolved lazily per event against the running
  renderer's own `resolveOverlayLayout`, and overlays are ordered by
  `focusOrder` descending (paint order) — a deliberate deviation from PR
  #8037's stack reversal.
- While an overlay has keyboard focus, mouse events still dispatch through
  `onMouse` first (PR semantics); only unhandled events defer to the
  overlay's `handleInput`.
- `addCopyHandler` requires `copyActiveSelectionToClipboard`
  (pi-tui ≥ 0.84.3); `api.copySlotAvailable` reports whether it installed on
  the running build. It covers the copy-key path only — Pi's copy-on-select
  release uses a different method and is not intercepted.
- The input dispatch needs `handleViewportInput`, `parseWheelEvent`,
  `parseSgrMouseEvent`, `overlayStack`, `currentLayout`, and
  `resolveOverlayLayout` on the running pi-tui 0.84.x build; the contract
  tests pin this surface and everything degrades to a warning if a future
  build moves it.

## Install

```bash
pi install npm:@xzzpig/pi-mouse-events
```

## Development

```bash
pnpm --filter @xzzpig/pi-mouse-events run typecheck
pnpm --filter @xzzpig/pi-mouse-events test
```

MIT
