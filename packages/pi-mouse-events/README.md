# @xzzpig/pi-mouse-events

Mouse event dispatch for [Pi](https://github.com/earendil-works/pi)'s
fullscreen TUI. Pi's renderer swallows every mouse report (wheel notches and
SGR clicks) in its own viewport listener before extensions can observe them,
which is why extension UI cannot scroll or click in fullscreen mode. This
package opens that path and adds an integration surface around it.

## What it does

- **Global mouse events** — every parsed mouse event is emitted on the shared
  extension event bus under `pi-mouse-events:mouse` (`MOUSE_EVENT_CHANNEL`)
  after the handler decision, with `kind`, screen coordinates, and `handled`.
  Listen with `pi.events.on` (`pi.on`
  cannot carry custom event names). **The bus is session-scoped**: pi
  invalidates a session's extension runtime when the session is replaced
  (`/new`, fork, switch, reload) and drops that session's bus subscriptions,
  so subscribe from a `session_start` handler — pi re-runs extension
  factories on every session replacement, which is also how this extension
  keeps its own emission pointed at the live session's bus. That replacement
  is not instantaneous, and the input path stays live throughout it, so a
  mouse event arriving before the replacement's runtime exists has no bus to
  reach: it is handed to the handlers as usual but its bus emission is dropped
  rather than allowed to throw out of the input loop and terminate pi. Emission
  resumes with the next factory run.
- **Handler slots** — `getMouseEventsApi()` returns a process-global API
  (v2 contract):
  - `addMouseHandler(handler, { priority })` — runs on every parsed mouse
    event, before Pi's built-ins; `{ handled: true }` consumes it, anything
    else lets it through to the built-ins unchanged. This is the only way to
    see a mouse event _before_ Pi acts on it: `ctx.ui.onTerminalInput` cannot
    (the alt-screen registers its viewport listener first and consumes every
    mouse report).
  - `addWheelHandler?.(handler, { priority })` — receives wheel events after
    Pi has offered them to native components and overlays, and receives Pi's
    calculated signed `wheelDelta` before default scroll routing. A handled
    event skips the default router and requests a repaint. The optional slot is
    absent on older v2 publishers or when Pi's router cannot be patched.
  - `addCopyHandler(handler)` — runs in front of
    `TuiAltScreen.copyActiveSelectionToClipboard` (Pi's copy key, default
    ctrl+x); `{ handled: true }` answers the copy yourself.
  - `addAsyncCopyHandler?.(handler, { priority })` — allows a handler to await
    a native clipboard write. Synchronous and asynchronous handlers share one
    priority order; rejected handlers are skipped and Pi's copy runs if none
    handles the request. Older v2 publishers lack this optional method.
  - `hitTest(tui, x, y)` — the component under a screen cell, overlay or
    layout, whatever it is.
  - `parseMouseEvent(data)` / `isMouseSequence(data)` — the same SGR and
    legacy X10 parsing pi-tui applies.
  - `liveReceiver()` — the renderer instance the input wrapper last ran
    against, from the first keystroke or mouse report of the session onward.
    The hook render-time consumers need to read renderer state without waiting
    for a mouse event; inside a handler prefer the per-event `ctx.tui`.
  - `requestPointerShape?.("pointer" | "text" | "default")` — request the
    shared terminal pointer shape while Pi dispatches a hover. The last request
    in dispatch order wins; an unclaimed hover, session replacement, or process
    exit restores the default. Outside a hover the call is ignored. The method
    is optional because earlier v2 publishers do not provide it.
- **Selection rendering compatibility** — when Pi exposes a patchable
  `applySelection`, duplicate caret markers on each rendered selection row are
  removed while the first marker and all other text are preserved. This is an
  internal workaround, not a public rendering hook.
- **Consumer-side types** — import from `@xzzpig/pi-mouse-events/api`. The
  module is dependency-free; the API is read through `Symbol.for`, so it
  works across Pi's per-extension module isolation whether or not your
  extension declares this package as a dependency.

## Coordinating pointer shapes

A component can request a pointer shape from its native `handleMouse` callback:

```ts
const api = getMouseEventsApi();
if (event.type === "move") api?.requestPointerShape?.("pointer");
```

Requests are coordinated through the same process-global v2 API even when
extensions load in isolated modules. The capability is optional so a new
consumer remains safe with an older `pi-mouse-events` installation. Pointer
shapes use OSC 22; unsupported terminals ignore them, and terminal multiplexers
may not report hover at all. This does not replace native component clicks or
change mouse event consumption.

## Component-level clicks are Pi's own API

Components that want to handle their own clicks implement Pi's native
`handleMouse` (pi-tui ≥ 0.85); the fullscreen renderer dispatches to it, and
wrapping a component in `MouseRegion` is what makes a whole block clickable.
This package deliberately does not duplicate that path — an earlier version
shipped a competing `onMouse` hook, removed in 0.2.0 so there is one contract
instead of two.

The two layers compose in the obvious order: `handleMouse`/`MouseRegion` for
a component's own box, `addMouseHandler` for decisions that need to see every
event (global click routing, hit-testing the transcript, consuming a release
after looking at the layout).

## Example

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MouseRegion } from "@earendil-works/pi-tui";
import {
  getMouseEventsApi,
  MOUSE_EVENT_CHANNEL,
  type MouseEventsApi,
} from "@xzzpig/pi-mouse-events/api";

export default function (pi: ExtensionAPI) {
  // 1. A custom overlay whose whole block toggles on a click — Pi's own
  //    component API, no registration needed.
  let open = false;
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.custom(
      (tui, theme) =>
        new MouseRegion(
          {
            render: (width) => (open ? detailLines(width) : ["[closed]"]),
            invalidate: () => {},
          },
          (event) => {
            if (event.type !== "click" || event.button !== "left")
              return undefined;
            open = !open;
            return { handled: true, render: true };
          },
        ),
      { overlay: true },
    );
  });

  // 2. Observe every mouse event without affecting it.
  pi.events.on(MOUSE_EVENT_CHANNEL, (data) => {
    const event = data as {
      kind: string;
      x: number;
      y: number;
      handled: boolean;
    };
  });

  // 3. Decide before Pi's built-in selection handling, and optionally
  //    consume — the only layer that can.
  const api: MouseEventsApi | undefined = getMouseEventsApi();
  api?.addMouseHandler(({ event, tui }) => {
    if (event.release) return undefined;
    const target = api.hitTest(tui, event.x, event.y);
    // … decide, act, and consume or pass.
    return undefined;
  });
}
```

## Scope and behavior notes

- Fullscreen mode only (`TuiAltScreen`): pi-tui's regular (non-fullscreen)
  mode never enables mouse tracking, so there is nothing to dispatch there.
- The bus reports what this extension's handlers decided. An event they left
  unconsumed continues into Pi's built-in handling — including the
  component-level `handleMouse` dispatch — and this extension does not
  observe what happens there, so `handled: false` never means "nothing
  handled it".
- A handler that consumes a _release_ while its press went through to Pi
  leaves Pi mid-gesture: the press branch arms Pi's gesture and selection
  state and the release branch clears it, so the skipped branch is what this
  extension restores (`clearComponentMouseGesture` + `clearTextSelection`,
  with a direct field reset as the backstop) before returning `consume`.
  Consuming a release therefore costs Pi nothing beyond the click itself.
- Overlay geometry is resolved lazily per event against the running
  renderer's own `resolveOverlayLayout`, and overlays are ordered by
  `focusOrder` descending (paint order).
- `addCopyHandler` requires `copyActiveSelectionToClipboard`
  (pi-tui ≥ 0.84.3); `api.copySlotAvailable` reports whether it installed on
  the running build. It covers the copy-key path only — Pi's copy-on-select
  release uses a different method and is not intercepted.
- The input path needs `handleViewportInput`, `parseWheelEvent`,
  `parseSgrMouseEvent`, `overlayStack`, `currentLayout`,
  `resolveOverlayLayout`, `clearComponentMouseGesture`, and
  `clearTextSelection` on the running build; the contract tests pin this
  surface and everything degrades to a warning if a future build moves it.

## Requirements

Pi 0.86.0 or newer (`@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui`), where the renderer carries the component mouse
gesture state this extension restores and `MouseRegion` is public.

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
