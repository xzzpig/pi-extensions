/**
 * The dispatch, driven end to end through the patched
 * `handleViewportInput` on the REAL `TuiAltScreen.prototype`.
 *
 * The predecessor is replaced with a spy before installing, so "the built-in
 * handling did / did not run" is a direct observation, and the real pi-tui
 * method body is never needed (its state machine is far beyond what a stub
 * receiver can feed). The real parsers and the real `resolveOverlayLayout`
 * run — geometry claims are never assumed from the plan, only read off the
 * installed pi-tui's own math.
 */
import { TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installMousePatches,
  type InstalledPatches,
} from "../extensions/patch.ts";
import {
  HEIGHT,
  layoutWithTarget,
  makePi,
  makeReceiver,
  MouseComponent,
  WIDTH,
} from "./helpers.ts";

type TuiAltScreenPrototype = {
  handleViewportInput: (data: string) => { consume: boolean } | undefined;
  copyActiveSelectionToClipboard: () => Promise<boolean>;
};
const prototype = TuiAltScreen.prototype as unknown as TuiAltScreenPrototype;
const originalViewportInput = prototype.handleViewportInput;
const originalCopy = prototype.copyActiveSelectionToClipboard;

let installed: InstalledPatches | undefined;

/** Install the patch with a spy predecessor; returns the spy. */
function install(): ReturnType<typeof vi.fn> {
  const predecessor = vi.fn(() => undefined);
  prototype.handleViewportInput = predecessor;
  installed = installMousePatches(makePi().pi, TuiAltScreen.prototype);
  expect(installed).toBeDefined();
  return predecessor;
}

/** The patched method, reached through the receiver like production does. */
function input(receiver: object, data: string) {
  return (receiver as unknown as TuiAltScreenPrototype).handleViewportInput(
    data,
  );
}

afterEach(() => {
  try {
    installed?.dispose();
  } finally {
    installed = undefined;
    prototype.handleViewportInput = originalViewportInput;
    prototype.copyActiveSelectionToClipboard = originalCopy;
  }
});

describe("component dispatch through handleViewportInput", () => {
  it("delivers a wheel event to a docked component and consumes it before the built-ins", () => {
    const predecessor = install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]);

    // Wheel up at row 6 (1-based) of a 6-row terminal — the docked target.
    // (helpers lay the transcript + target out for real)
    layoutWithTarget(receiver, target, { rows: 6 });

    const result = input(receiver, "\x1b[<64;1;6M");

    expect(result).toEqual({ consume: true });
    expect(target.events).toHaveLength(1);
    expect(target.events[0]).toMatchObject({
      button: 64,
      x: 0,
      y: 5,
      wheel: -1,
      release: false,
    });
    expect(predecessor).not.toHaveBeenCalled();
  });

  it("delivers box-relative coordinates", () => {
    install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["first", "second"]);
    layoutWithTarget(receiver, target, { rows: 8 });

    // 8 rows: the transcript takes 0..5 and the two-line target 6..7, so
    // 1-based row 8 (y=7) is the target's second line; col 5 (x=4) is past
    // its first character.
    input(receiver, "\x1b[<65;5;8M");

    expect(target.events[0]?.row).toBe(1);
    expect(target.events[0]?.col).toBe(4);
    expect(target.events[0]?.wheel).toBe(1);
  });

  it("falls through to the predecessor when no component handles the event", () => {
    const predecessor = install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"], () => undefined);
    layoutWithTarget(receiver, target, { rows: 6 });

    const result = input(receiver, "\x1b[<64;1;6M");

    expect(result).toBeUndefined();
    expect(target.events).toHaveLength(1);
    expect(predecessor).toHaveBeenCalledTimes(1);
    expect(predecessor).toHaveBeenCalledWith("\x1b[<64;1;6M");
  });

  it("delivers press and release as separate events", () => {
    install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]);
    layoutWithTarget(receiver, target, { rows: 6 });

    input(receiver, "\x1b[<0;3;6M");
    input(receiver, "\x1b[<0;3;6m");

    expect(target.events).toHaveLength(2);
    expect(target.events[0]).toMatchObject({ button: 0, release: false });
    expect(target.events[1]).toMatchObject({ button: 0, release: true });
  });

  it("prefers the deepest layout box containing the pointer", () => {
    install();
    const receiver = makeReceiver();
    const outer = new MouseComponent(["outer"], () => undefined);
    const inner = new MouseComponent(["inner"]);
    receiver.overlayStack = [];
    receiver.currentLayout = {
      root: {
        component: outer,
        rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        children: [
          {
            component: inner,
            rect: { x: 0, y: 0, width: 10, height: 2 },
            clip: { x: 0, y: 0, width: 10, height: 2 },
            children: [],
          },
        ],
      },
    };

    input(receiver, "\x1b[<0;3;1M");

    expect(inner.events).toHaveLength(1);
    expect(outer.events).toHaveLength(0);
    expect(inner.events[0]?.row).toBe(0);
  });

  it("honours the clip so scrolled-out boxes cannot claim a cell", () => {
    install();
    const receiver = makeReceiver();
    const scrolledOut = new MouseComponent(["hidden"]);
    const visible = new MouseComponent(["visible"]);
    receiver.currentLayout = {
      root: {
        component: new VStack([]),
        rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        children: [
          {
            component: scrolledOut,
            rect: { x: 0, y: -5, width: 10, height: 2 },
            clip: { x: 0, y: 0, width: 10, height: 0 },
            children: [],
          },
          {
            component: visible,
            rect: { x: 0, y: 0, width: 10, height: 2 },
            clip: { x: 0, y: 0, width: 10, height: 2 },
            children: [],
          },
        ],
      },
    };

    input(receiver, "\x1b[<0;3;1M");

    expect(visible.events).toHaveLength(1);
    expect(scrolledOut.events).toHaveLength(0);
  });

  it("delivers to the frontmost overlay before the layout beneath it", () => {
    install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]);
    layoutWithTarget(receiver, target, { rows: 8 });
    const overlay = new MouseComponent(["overlay"]);
    // A 10-wide one-line overlay in an 8-row, 40-column terminal: the real
    // resolver centers it at col 15, row 3.
    receiver.overlayStack = [
      {
        component: overlay,
        hidden: false,
        focusOrder: 1,
        options: { width: 10 },
      },
    ];

    input(receiver, "\x1b[<0;16;4M");

    expect(overlay.events).toHaveLength(1);
    expect(overlay.events[0]).toMatchObject({ row: 0, col: 0 });
    expect(target.events).toHaveLength(0);
  });

  it("orders overlays by focusOrder, frontmost first", () => {
    install();
    const receiver = makeReceiver();
    const bottom = new MouseComponent(["bottom"], () => undefined);
    const top = new MouseComponent(["top"]);
    // Default-width overlays in an 8-row terminal center at row 3, col 0.
    receiver.terminal.rows = 8;
    receiver.overlayStack = [
      { component: bottom, hidden: false, focusOrder: 1 },
      { component: top, hidden: false, focusOrder: 2 },
    ];

    // The higher focusOrder is painted last and dispatched first.
    input(receiver, "\x1b[<0;16;4M");

    expect(top.events).toHaveLength(1);
    expect(bottom.events).toHaveLength(0);
  });

  it("lets an unhandled overlay's event fall through to the layout beneath", () => {
    install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]);
    layoutWithTarget(receiver, target, { rows: 8 });
    const overlay = new MouseComponent(["overlay"], () => undefined);
    // Park the overlay exactly over the target's line (absolute row/col, as
    // OverlayOptions allows) so the layout beneath it has an onMouse
    // component to fall through to.
    receiver.overlayStack = [
      {
        component: overlay,
        hidden: false,
        focusOrder: 1,
        options: { width: 10, row: 7, col: 15 },
      },
    ];

    // A press over the transcript where nothing implements onMouse: nobody
    // handles it, and the event falls through to the predecessor.
    input(receiver, "\x1b[<0;16;4M");
    expect(target.events).toHaveLength(0);
    expect(overlay.events).toHaveLength(0);

    // A press inside the overlay reaches the overlay first; it declines, and
    // the event then reaches the layout beneath — PR fall-through semantics.
    // The target's own box starts at x=0, so its col is 15 even though the
    // overlay's was 0: the coordinates are relative to each receiver's box.
    input(receiver, "\x1b[<0;16;8M");
    expect(overlay.events).toHaveLength(1);
    expect(overlay.events[0]).toMatchObject({ row: 0, col: 0 });
    expect(target.events).toHaveLength(1);
    expect(target.events[0]).toMatchObject({ row: 0, col: 15 });
  });

  it("passes keyboard data through untouched", () => {
    const predecessor = install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]);
    layoutWithTarget(receiver, target);

    const result = input(receiver, "hello");

    expect(result).toBeUndefined();
    expect(predecessor).toHaveBeenCalledTimes(1);
    expect(target.events).toHaveLength(0);
  });
});
