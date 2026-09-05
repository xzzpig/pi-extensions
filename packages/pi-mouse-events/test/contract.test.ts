/**
 * The pi-tui contract: the internals this dispatch depends on, pinned against
 * the installed package so an upgrade that moves them goes red here instead
 * of silently disabling mouse events for users.
 *
 * The prototype has no `#`-private fields today — TypeScript `private` is
 * erased — which is the fact the whole approach rests on. The source pins
 * below are the canary for that changing.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { isPatchable } from "../extensions/receiver.ts";

type AnyPrototype = Record<string, unknown>;
const prototype = TuiAltScreen.prototype as unknown as AnyPrototype;

const PATCHED_METHODS = [
  "handleViewportInput",
  "copyActiveSelectionToClipboard",
];
const READ_METHODS = [
  "parseWheelEvent",
  "parseSgrMouseEvent",
  "resolveOverlayLayout",
  "isOverlayVisible",
  "getSelectionBounds",
  "getSelectionColumns",
  "getCopyOnSelect",
  "hasActiveSelection",
  "flash",
  "hasOverlay",
  "requestRender",
];

describe("pi-tui 0.84.x contract", () => {
  it("exposes every method the dispatch patches or calls as a replaceable function", () => {
    for (const name of [...PATCHED_METHODS, ...READ_METHODS]) {
      expect(isPatchable(TuiAltScreen.prototype, name), name).toBe(true);
    }
  });

  it("carries the internals as plain prototype/instance members, not #private", () => {
    // A class using `#fields` cannot have them reached structurally; the
    // source of the methods we interoperate with must not reference any.
    const source = String(prototype.handleViewportInput);
    expect(source).not.toMatch(/this\.#/);
    // The dispatch wraps the input entry point and expects it to run the
    // parsers whose output it consumes.
    expect(source).toContain("parseWheelEvent");
    expect(source).toContain("parseSgrMouseEvent");
    // The overlay bookkeeping `compositeOverlays` performs is what the lazy
    // geometry math mirrors — the viewportStart slice-cancel included.
    const composite = String(
      (
        TuiAltScreen.prototype as unknown as {
          compositeOverlays?: () => unknown;
        }
      ).compositeOverlays ?? "",
    );
    expect(composite).toContain("viewportStart");
    expect(composite).toContain("overlayStack");
    // The wheel routing reads the frame the renderer stores per render — the
    // same frame the dispatch walks for layout targets.
    expect(String(prototype.routeWheel)).toContain("currentLayout");
  });
});
