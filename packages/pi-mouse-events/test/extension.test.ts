/**
 * The extension entry: publishes the API once, publishes it under the same
 * `Symbol.for` key every module copy reads, and stays out of the way when
 * already installed.
 *
 * The entry keeps module-level install state, so every test re-imports it
 * through `vi.resetModules()` — the same fresh-module condition a second
 * extension copy would meet under Pi's loader.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOUSE_EVENTS_API_KEY,
  MOUSE_EVENT_CHANNEL,
  getMouseEventsApi,
} from "../api.ts";
import { makePi, makeReceiver, type ReceiverWithWrites } from "./helpers.ts";

const prototype = TuiAltScreen.prototype as unknown as Record<string, unknown>;
const originalViewportInput = prototype.handleViewportInput;
const originalCopy = prototype.copyActiveSelectionToClipboard;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY];
  prototype.handleViewportInput = originalViewportInput;
  prototype.copyActiveSelectionToClipboard = originalCopy;
});

async function loadExtension() {
  const module = await import("../extensions/index.ts");
  return module.default;
}

describe("extension entry", () => {
  it("publishes the API and patches the prototype", async () => {
    const extension = await loadExtension();
    const { pi } = makePi();
    extension(pi);

    const api = getMouseEventsApi();
    expect(api).toBeDefined();
    expect(api?.version).toBe(1);
    expect(api?.eventChannel).toBe(MOUSE_EVENT_CHANNEL);
    expect(api?.copySlotAvailable).toBe(true);
    expect(prototype.handleViewportInput).not.toBe(originalViewportInput);
  });

  it("is a no-op when the API is already published", async () => {
    const extension = await loadExtension();
    const { pi } = makePi();
    extension(pi);
    const afterFirst = prototype.handleViewportInput;

    extension(pi);

    expect(prototype.handleViewportInput).toBe(afterFirst);
  });

  it("hands the event bus to each new session's pi on a factory re-run", async () => {
    // pi re-runs extension factories on every session replacement and
    // invalidates the runtime that produced the previous `pi` — a mouse event
    // emitted through the old handle throws. A re-run must therefore move the
    // published patches' bus to the new session's pi before anything else.
    const extension = await loadExtension();
    const first = makePi();
    extension(first.pi);

    // The fresh-module condition pi's loader produces for the replacement
    // session: a new module copy, the published API still on `globalThis`.
    vi.resetModules();
    const reloaded = await loadExtension();
    const second = makePi();
    reloaded(second.pi);

    // A mouse event after the switch is emitted on the NEW session's bus.
    // The event goes unconsumed here, so the built-in fall-through runs and
    // reads the screen the constructor would have filled in.
    const receiver = makeReceiver() as ReceiverWithWrites & {
      previousScreen: string[];
      handleViewportInput: (data: string) => unknown;
    };
    receiver.previousScreen = Array.from({ length: 12 }, () => "");
    receiver.handleViewportInput("\x1b[<0;3;6M");

    expect(second.emitted).toHaveLength(1);
    expect(second.emitted[0]?.channel).toBe(MOUSE_EVENT_CHANNEL);
    expect(first.emitted).toHaveLength(0);
  });

  it("publishes under the shared Symbol.for key", async () => {
    const extension = await loadExtension();
    const { pi } = makePi();
    extension(pi);
    expect(
      (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY],
    ).toBeDefined();
  });

  it("exposes the documented parsing rules", async () => {
    const extension = await loadExtension();
    const { pi } = makePi();
    extension(pi);
    const api = getMouseEventsApi()!;

    expect(api.isMouseSequence("\x1b[<0;5;6M")).toBe(true);
    expect(api.isMouseSequence("\x1b[A")).toBe(false);
    expect(api.parseMouseEvent("\x1b[<0;5;6M")).toMatchObject({
      kind: "down",
      button: 0,
      x: 4,
      y: 5,
      release: false,
    });
    expect(api.parseMouseEvent("\x1b[<0;5;6m")).toMatchObject({
      kind: "up",
      release: true,
    });
    expect(api.parseMouseEvent("\x1b[<64;5;6M")).toMatchObject({
      kind: "wheel",
      wheel: -1,
    });
    expect(api.parseMouseEvent("\x1b[<65;5;6M")).toMatchObject({
      kind: "wheel",
      wheel: 1,
    });
    expect(api.parseMouseEvent("hello")).toBeUndefined();
  });

  it("degrades with a warning when the input entry point cannot be patched", async () => {
    const extension = await loadExtension();
    const { pi } = makePi();
    // Remove the method the way an incompatible build would lack it:
    // isPatchable walks the chain and finds nothing, so the install declines.
    delete (prototype as Record<string, unknown>).handleViewportInput;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      extension(pi);
      expect(getMouseEventsApi()).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      prototype.handleViewportInput = originalViewportInput;
      warn.mockRestore();
    }
  });
});
