/**
 * The registered-handler slots: ordering, consumption, error isolation, and
 * the copy path.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOUSE_EVENT_CHANNEL, type MouseDispatchEvent } from "../api.ts";
import {
  installMousePatches,
  type InstalledPatches,
} from "../extensions/patch.ts";
import {
  layoutWithTarget,
  makePi,
  makeReceiver,
  MouseComponent,
  type ReceiverStub,
} from "./helpers.ts";

type TuiAltScreenPrototype = {
  handleViewportInput: (data: string) => { consume: boolean } | undefined;
  copyActiveSelectionToClipboard: () => Promise<boolean>;
};
const prototype = TuiAltScreen.prototype as unknown as TuiAltScreenPrototype;
const originalViewportInput = prototype.handleViewportInput;
const originalCopy = prototype.copyActiveSelectionToClipboard;

let installed: InstalledPatches | undefined;
let emitted: Array<{ channel: string; data: unknown }> = [];

function install() {
  const { pi, emitted: sink } = makePi();
  emitted = sink;
  const predecessor = vi.fn(() => undefined);
  prototype.handleViewportInput = predecessor;
  // Captured BEFORE installing: after installMousePatches the prototype
  // property is the patch wrapper, and the spy is its predecessor.
  const copyPredecessor = vi.fn(async () => false);
  prototype.copyActiveSelectionToClipboard = copyPredecessor;
  installed = installMousePatches(pi, TuiAltScreen.prototype);
  expect(installed).toBeDefined();
  return {
    predecessor,
    copyPredecessor,
    api: installed!.state,
  };
}

function input(receiver: object, data: string) {
  return (receiver as unknown as TuiAltScreenPrototype).handleViewportInput(
    data,
  );
}

function lastEvent(): MouseDispatchEvent {
  const last = emitted.at(-1);
  expect(last?.channel).toBe(MOUSE_EVENT_CHANNEL);
  return last!.data as MouseDispatchEvent;
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

describe("mouse handler slot", () => {
  it("runs on every parsed mouse event and consumes on { handled: true }", () => {
    const { api, predecessor } = install();
    const receiver = makeReceiver();
    layoutWithTarget(receiver, new MouseComponent(["target"]), { rows: 6 });
    const handler = vi.fn((_context: unknown) => ({ handled: true }));
    api.addMouseHandler(handler);

    const result = input(receiver, "\x1b[<64;1;6M");

    expect(result).toEqual({ consume: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      (handler.mock.calls[0][0] as { event: unknown }).event,
    ).toMatchObject({
      kind: "wheel",
      button: 64,
      x: 0,
      y: 5,
      wheel: -1,
    });
    expect(predecessor).not.toHaveBeenCalled();
  });

  it("runs ahead of the built-in path, where component handling lives", () => {
    const { api, predecessor } = install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]);
    layoutWithTarget(receiver, target, { rows: 6 });
    const handler = vi.fn(() => undefined);
    api.addMouseHandler(handler);

    input(receiver, "\x1b[<64;1;6M");

    // The slot ran and declined, so the event continued to the built-ins.
    // The component never sees it: this extension does not dispatch to
    // components — Pi's own `handleMouse` path does, one layer down.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(target.events).toHaveLength(0);
    expect(predecessor).toHaveBeenCalledTimes(1);
  });

  it("orders by priority descending, then registration order", () => {
    const { api } = install();
    const receiver = makeReceiver();
    layoutWithTarget(receiver, new MouseComponent(["target"]), { rows: 6 });
    const calls: string[] = [];
    api.addMouseHandler(() => {
      calls.push("registered-first");
      return undefined;
    });
    api.addMouseHandler(
      () => {
        calls.push("high-priority");
        return undefined;
      },
      { priority: 10 },
    );
    api.addMouseHandler(() => {
      calls.push("consumer");
      return { handled: true };
    });

    input(receiver, "\x1b[<64;1;6M");

    // The high-priority handler jumps the queue; the two default-priority
    // handlers run in registration order, and the consumer stops the chain.
    expect(calls).toEqual(["high-priority", "registered-first", "consumer"]);
  });

  it("a handler error does not take the dispatch down", () => {
    const { api, predecessor } = install();
    const receiver = makeReceiver();
    layoutWithTarget(receiver, new MouseComponent(["target"]), { rows: 6 });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    api.addMouseHandler(() => {
      throw new Error("boom");
    });
    api.addMouseHandler(() => ({ handled: true }));

    const result = input(receiver, "\x1b[<64;1;6M");

    expect(result).toEqual({ consume: true });
    expect(predecessor).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("unsubscribe removes the handler", () => {
    const { api } = install();
    const receiver = makeReceiver();
    layoutWithTarget(receiver, new MouseComponent(["target"]), { rows: 6 });
    const handler = vi.fn(() => ({ handled: true }));
    const unsubscribe = api.addMouseHandler(handler);
    unsubscribe();

    const result = input(receiver, "\x1b[<64;1;6M");

    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("emits the dispatch outcome on the bus", () => {
    const { api } = install();
    const receiver = makeReceiver();
    layoutWithTarget(receiver, new MouseComponent(["target"]), { rows: 6 });

    // Declined: the bus reports it as unhandled, and the built-ins went on to
    // act on it. The bus only ever reports this extension's own outcome.
    input(receiver, "\x1b[<0;3;6M");
    const unhandled = lastEvent();
    expect(unhandled).toMatchObject({ kind: "down", handled: false });

    // Consumed: the slot ate it, so the built-ins never ran for it.
    const unsubscribe = api.addMouseHandler(() => ({ handled: true }));
    input(receiver, "\x1b[<0;3;6M");
    const handled = lastEvent();
    expect(handled).toMatchObject({ kind: "down", handled: true });
    unsubscribe();
  });
});

describe("liveReceiver", () => {
  it("is undefined before the first viewport input", () => {
    const { api } = install();
    expect(api.liveReceiver()).toBeUndefined();
  });

  it("binds on the first input, keystroke or mouse alike", () => {
    const { api, predecessor } = install();
    const receiver = makeReceiver();

    // A keystroke passes through untouched but still names its renderer.
    input(receiver, "x");
    expect(predecessor).toHaveBeenCalled();
    expect(api.liveReceiver()).toBe(receiver);

    // A later session's renderer replaces the earlier one.
    const next = makeReceiver();
    input(next, "\x1b[<0;1;1M");
    expect(api.liveReceiver()).toBe(next);
  });

  it("binds from the copy path too", async () => {
    const { api, copyPredecessor } = install();
    const receiver = makeReceiver() as unknown as {
      copyActiveSelectionToClipboard: () => Promise<boolean>;
    };
    await receiver.copyActiveSelectionToClipboard();
    expect(copyPredecessor).toHaveBeenCalled();
    expect(api.liveReceiver()).toBe(receiver);
  });
});

describe("event-bus handle", () => {
  it("emits on the newest bus after refreshBus — the stale one is left alone", () => {
    const { api } = install();
    const receiver = makeReceiver();
    const fresh = makePi();

    // Session replacement: the entry point hands the patches the new
    // session's pi, whose runtime is the only live one.
    api.refreshBus(fresh.pi);
    input(receiver, "\x1b[<0;3;6M");

    expect(fresh.emitted).toHaveLength(1);
    expect(fresh.emitted[0]?.channel).toBe(MOUSE_EVENT_CHANNEL);
    expect(emitted).toHaveLength(0);
  });

  it("drops the event when the bus goes stale instead of crashing the process", () => {
    // Regression: pi invalidates a session's extension runtime as soon as that
    // session is replaced, but the replacement's extension factories (and thus
    // `refreshBus`) only run after the old runtime is gone. This input
    // wrapper is process-wide and the input path stays live across that
    // window, so a mouse report — or any later one — used to reach the dead
    // handle and throw from inside the input callback, which pi surfaces as an
    // uncaughtException and exits. Nothing can consume such an event yet, so it
    // is dropped; the next `refreshBus` restores emission.
    const { api, predecessor } = install();
    const receiver = makeReceiver();
    const stale = {
      events: {
        emit: () => {
          throw new Error("This extension ctx is stale.");
        },
      },
    } as never;
    api.refreshBus(stale);

    expect(() => input(receiver, "\x1b[<0;3;6M")).not.toThrow();
    // The event still fell through to the built-in handling; only the bus
    // emission is skipped.
    expect(predecessor).toHaveBeenCalledTimes(1);

    // A dead handle is not retried on every subsequent event either.
    expect(() => input(receiver, "\x1b[<0;3;6M")).not.toThrow();

    // The entry point's refreshBus clears the refusal, so emission resumes.
    const fresh = makePi();
    api.refreshBus(fresh.pi);
    input(receiver, "\x1b[<0;3;6M");
    expect(fresh.emitted).toHaveLength(1);
    expect(fresh.emitted[0]?.channel).toBe(MOUSE_EVENT_CHANNEL);
  });
});

describe("copy handler slot", () => {
  it("lets a handler answer the copy and skips the original", async () => {
    const { api, copyPredecessor } = install();
    const receiver = makeReceiver();
    const handler = vi.fn((_context: unknown) => ({ handled: true }));
    api.addCopyHandler(handler);

    const receiverWithCopy = receiver as unknown as TuiAltScreenPrototype;
    const result =
      await receiverWithCopy.copyActiveSelectionToClipboard.call(receiver);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as { tui: unknown }).tui).toBe(receiver);
    expect(copyPredecessor).not.toHaveBeenCalled();
  });

  it("falls through to the original when no handler takes it", async () => {
    const { api, copyPredecessor } = install();
    const receiver = makeReceiver();
    api.addCopyHandler(() => undefined);

    const result = await (
      receiver as unknown as TuiAltScreenPrototype
    ).copyActiveSelectionToClipboard.call(receiver);

    expect(result).toBe(false);
    expect(copyPredecessor).toHaveBeenCalledTimes(1);
  });

  it("reports copySlotAvailable and degrades to a warning without the method", async () => {
    const { pi } = makePi();
    const receiver = makeReceiver();
    // Hide the copy method the way an older pi-tui would.
    const original = prototype.copyActiveSelectionToClipboard;
    delete (prototype as { copyActiveSelectionToClipboard?: unknown })
      .copyActiveSelectionToClipboard;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const patches = installMousePatches(pi, TuiAltScreen.prototype);
      expect(patches).toBeDefined();
      expect(patches!.state.copySlotAvailable).toBe(false);
      // Handlers can still be registered; the wrapper simply never fires.
      const handler = vi.fn(() => ({ handled: true }));
      patches!.state.addCopyHandler(handler);
      expect(handler).not.toHaveBeenCalled();
      expect(receiver.written).toEqual([]);
    } finally {
      prototype.copyActiveSelectionToClipboard = original;
      warn.mockRestore();
    }
  });
});

describe("gesture restore after a consumed release", () => {
  /** A receiver whose Pi-side reset methods are observable. */
  function receiverWithResets() {
    const receiver = makeReceiver();
    const clearComponentMouseGesture = vi.fn();
    const clearTextSelection = vi.fn();
    receiver.clearComponentMouseGesture = clearComponentMouseGesture;
    receiver.clearTextSelection = clearTextSelection;
    return { receiver, clearComponentMouseGesture, clearTextSelection };
  }

  it("restores Pi's state when the release is consumed and its press was not", () => {
    const { api } = install();
    const { receiver, clearComponentMouseGesture, clearTextSelection } =
      receiverWithResets();
    // The click protocol: the press goes through to Pi (so its selection
    // machinery anchors on it), the release is consumed.
    api.addMouseHandler(({ event }) =>
      event.release ? { handled: true } : undefined,
    );

    input(receiver, "\x1b[<0;3;6M");
    expect(clearComponentMouseGesture).not.toHaveBeenCalled();

    input(receiver, "\x1b[<0;3;6m");
    expect(clearComponentMouseGesture).toHaveBeenCalledTimes(1);
    expect(clearTextSelection).toHaveBeenCalledTimes(1);
  });

  it("leaves Pi's state alone when the press was consumed too", () => {
    const { api } = install();
    const { receiver, clearComponentMouseGesture } = receiverWithResets();
    // Both halves consumed: Pi never armed anything, so there is nothing to
    // restore — and a reset here would clobber a gesture of its own.
    api.addMouseHandler(() => ({ handled: true }));

    input(receiver, "\x1b[<0;3;6M");
    input(receiver, "\x1b[<0;3;6m");

    expect(clearComponentMouseGesture).not.toHaveBeenCalled();
  });

  it("leaves Pi's state alone when the release falls through", () => {
    const { api } = install();
    const { receiver, clearComponentMouseGesture } = receiverWithResets();
    // The built-in release branch is what normally clears the state; running
    // the restore as well would reset a selection Pi is still finishing.
    api.addMouseHandler(({ event }) =>
      event.release ? undefined : { handled: true },
    );

    input(receiver, "\x1b[<0;3;6M");
    input(receiver, "\x1b[<0;3;6m");

    expect(clearComponentMouseGesture).not.toHaveBeenCalled();
  });

  it("resets the fields directly when Pi's reset methods are absent", () => {
    const { api } = install();
    const receiver = makeReceiver() as ReceiverStub & {
      selectionPressActive?: unknown;
      selectionAnchor?: unknown;
      mousePressTarget?: unknown;
    };
    // An older or renamed build: no reset methods, so the backstop writes the
    // fields both resets would have cleared.
    receiver.selectionPressActive = true;
    receiver.selectionAnchor = { row: 1, col: 1 };
    receiver.mousePressTarget = { component: {} };
    api.addMouseHandler(({ event }) =>
      event.release ? { handled: true } : undefined,
    );

    input(receiver, "\x1b[<0;3;6M");
    input(receiver, "\x1b[<0;3;6m");

    expect(receiver.selectionPressActive).toBe(false);
    expect(receiver.selectionAnchor).toBeUndefined();
    expect(receiver.mousePressTarget).toBeUndefined();
  });
});
