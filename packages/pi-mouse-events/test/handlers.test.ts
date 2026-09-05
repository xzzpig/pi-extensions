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
  it("runs when no component handled the event, and consumes on { handled: true }", () => {
    const { api, predecessor } = install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"], () => undefined);
    layoutWithTarget(receiver, target, { rows: 6 });
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

  it("does not run when a component already handled the event", () => {
    const { api } = install();
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]); // handles everything
    layoutWithTarget(receiver, target, { rows: 6 });
    const handler = vi.fn(() => undefined);
    api.addMouseHandler(handler);

    input(receiver, "\x1b[<64;1;6M");

    expect(target.events).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("orders by priority descending, then registration order", () => {
    const { api } = install();
    const receiver = makeReceiver();
    layoutWithTarget(
      receiver,
      new MouseComponent(["target"], () => undefined),
      { rows: 6 },
    );
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
    layoutWithTarget(
      receiver,
      new MouseComponent(["target"], () => undefined),
      { rows: 6 },
    );
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
    layoutWithTarget(
      receiver,
      new MouseComponent(["target"], () => undefined),
      { rows: 6 },
    );
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
    // A declining target: nothing consumes the press, so the bus sees the
    // unhandled outcome.
    layoutWithTarget(
      receiver,
      new MouseComponent(["target"], () => undefined),
      { rows: 6 },
    );

    // Unhandled press: handled false, no dispatched component.
    input(receiver, "\x1b[<0;3;6M");
    const unhandled = lastEvent();
    expect(unhandled).toMatchObject({ kind: "down", handled: false });
    expect(unhandled.dispatched).toBeUndefined();

    // Handler-consumed event carries no dispatched component — the slot ate
    // it, not a component.
    const unsubscribe = api.addMouseHandler(() => ({ handled: true }));
    input(receiver, "\x1b[<0;3;6M");
    const handled = lastEvent();
    expect(handled.handled).toBe(true);
    expect(handled.dispatched).toBeUndefined();
    unsubscribe();

    // Component-handled event names the component.
    const target = new MouseComponent(["target"]);
    layoutWithTarget(receiver, target, { rows: 6 });
    input(receiver, "\x1b[<0;3;6M");
    const byComponent = lastEvent();
    expect(byComponent.dispatched?.component).toBe(target);
    expect(byComponent.dispatched?.source).toBe("layout");
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

  it("throws a stale bus error straight through — emission is never swallowed", () => {
    // Deliberate fail-fast: pi's runtime invalidates a session's extension
    // runtime on replacement, and a throw reaching the input loop surfaces
    // the contract violation instead of silently dropping events. The entry
    // point's refreshBus is what keeps the happy path working.
    const { api } = install();
    const receiver = makeReceiver();
    api.refreshBus({
      events: {
        emit: () => {
          throw new Error("This extension ctx is stale.");
        },
      },
    } as never);

    expect(() => input(receiver, "\x1b[<0;3;6M")).toThrow(
      "This extension ctx is stale.",
    );
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
