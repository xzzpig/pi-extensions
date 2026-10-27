import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMouseEventsApi } from "../extensions/api-registry.ts";
import {
  installMousePatches,
  type InstalledPatches,
} from "../extensions/patch.ts";
import {
  dedupeCursorMarkers,
  installSelectionMarkerDedupe,
} from "../extensions/selection-markers.ts";
import { makePi } from "./helpers.ts";

const hover = "\x1b[<35;3;4M";
const drag = "\x1b[<32;3;4M";
const press = "\x1b[<0;3;4M";
const osc = (shape: string) => `\x1b]22;${shape}\x1b\\`;
let installed: InstalledPatches | undefined;
afterEach(() => {
  installed?.dispose();
  installed = undefined;
});

function setup() {
  const { pi } = makePi();
  const under = vi.fn();
  const prototype = {
    handleViewportInput: under,
    applySelection: (rows: string[]) => rows,
  };
  installed = installMousePatches(pi, prototype);
  expect(installed).toBeDefined();
  const api = createMouseEventsApi(installed!);
  const written: string[] = [];
  const receiver = Object.assign(Object.create(prototype), {
    terminal: { write: (data: string) => written.push(data) },
  }) as typeof prototype;
  return { api, under, receiver, written, prototype };
}

describe("shared pointer coordinator", () => {
  it("honors a component request during Pi dispatch and restores on an unclaimed hover", () => {
    const { api, under, receiver, written } = setup();
    under.mockImplementation(() => api.requestPointerShape?.("pointer"));
    receiver.handleViewportInput(hover);
    receiver.handleViewportInput(hover);
    expect(written).toEqual([osc("pointer")]);
    under.mockImplementation(() => {});
    receiver.handleViewportInput(hover);
    expect(written).toEqual([osc("pointer"), osc("default")]);
  });

  it("accepts requests from handlers, but not outside hover or on press/drag", () => {
    const { api, receiver, written } = setup();
    api.requestPointerShape?.("text");
    receiver.handleViewportInput(press);
    api.addMouseHandler(() => {
      api.requestPointerShape?.("pointer");
    });
    receiver.handleViewportInput(drag);
    expect(written).toEqual([]);
    receiver.handleViewportInput(hover);
    expect(written).toEqual([osc("pointer")]);
  });

  it("coordinates multiple consumers in dispatch order without intercepting Pi", () => {
    const { api, under, receiver, written } = setup();
    api.addMouseHandler(() => {
      api.requestPointerShape?.("pointer");
    });
    under.mockImplementation(() => api.requestPointerShape?.("text"));
    receiver.handleViewportInput(hover);
    expect(under).toHaveBeenCalledOnce();
    expect(written).toEqual([osc("text")]);
  });

  it("resets the old terminal on session replacement and disposal", () => {
    const { api, under, receiver, written } = setup();
    under.mockImplementation(() => api.requestPointerShape?.("pointer"));
    receiver.handleViewportInput(hover);
    api.refreshBus(makePi().pi);
    expect(written).toEqual([osc("pointer"), osc("default")]);
    receiver.handleViewportInput(hover);
    installed!.dispose();
    installed = undefined;
    expect(written).toEqual([
      osc("pointer"),
      osc("default"),
      osc("pointer"),
      osc("default"),
    ]);
  });

  it("does not restore an old hover after a session reset during dispatch", () => {
    const { api, under, receiver, written } = setup();
    under.mockImplementation(() => {
      api.requestPointerShape?.("pointer");
      api.refreshBus(makePi().pi);
    });
    receiver.handleViewportInput(hover);
    expect(written).toEqual([]);
  });

  it("does not swallow Pi's error or fail when terminal writes throw", () => {
    const { api, under, receiver } = setup();
    const bad = Object.assign(Object.create(Object.getPrototypeOf(receiver)), {
      terminal: {
        write: () => {
          throw new Error("closed");
        },
      },
    }) as typeof receiver;
    under.mockImplementation(() => api.requestPointerShape?.("pointer"));
    expect(() => bad.handleViewportInput(hover)).not.toThrow();
    under.mockImplementation(() => {
      throw new Error("Pi error");
    });
    expect(() => bad.handleViewportInput(hover)).toThrow("Pi error");
  });
});

describe("selection marker workaround", () => {
  it("retains the first caret marker and all other row content", () => {
    const line = `a${CURSOR_MARKER}b${CURSOR_MARKER}c`;
    expect(dedupeCursorMarkers([line, "plain"])).toEqual([
      `a${CURSOR_MARKER}bc`,
      "plain",
    ]);
  });

  it("cleans selection results, forwards arguments and restores the method", () => {
    const original = vi.fn((_screen: string[]) => [
      `a${CURSOR_MARKER}b${CURSOR_MARKER}c`,
    ]);
    const prototype = { applySelection: original };
    const dispose = installSelectionMarkerDedupe(prototype);
    expect(prototype.applySelection(["input"])).toEqual([
      `a${CURSOR_MARKER}bc`,
    ]);
    expect(original).toHaveBeenCalledWith(["input"]);
    dispose?.();
    expect(prototype.applySelection).toBe(original);
    expect(installSelectionMarkerDedupe({})).toBeUndefined();
  });

  it("passes unexpected host results through unchanged", () => {
    const result = { unexpected: true };
    const prototype = { applySelection: () => result };
    const dispose = installSelectionMarkerDedupe(prototype);
    expect(prototype.applySelection()).toBe(result);
    dispose?.();
  });
});
