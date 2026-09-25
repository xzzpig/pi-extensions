/**
 * `hitTest` — the informational "what is under the pointer" query.
 */
import { describe, expect, it } from "vitest";
import { hitTestReceiver } from "../extensions/geometry.ts";
import {
  makeOverlay,
  makeReceiver,
  MouseComponent,
  WIDTH,
  HEIGHT,
} from "./helpers.ts";

describe("hitTest", () => {
  it("answers the deepest layout component, whatever it is", () => {
    const receiver = makeReceiver();
    const target = new MouseComponent(["target"]);
    // No mouse method at all — hitTest answers "what is under the pointer"
    // and never filters on what the component can do.
    const plain = { render: () => ["plain"], invalidate: () => {} };
    receiver.currentLayout = {
      root: {
        component: plain,
        rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        children: [
          {
            component: target,
            rect: { x: 0, y: 4, width: 10, height: 2 },
            clip: { x: 0, y: 4, width: 10, height: 2 },
            children: [],
          },
        ],
      },
    };

    const hit = hitTestReceiver(receiver, 3, 5);

    expect(hit?.component).toBe(target);
    expect(hit).toMatchObject({ row: 1, col: 3, source: "layout" });
  });

  it("answers the frontmost overlay containing the point", () => {
    const receiver = makeReceiver();
    const overlay = new MouseComponent(["overlay"]);
    const under = new MouseComponent(["under"]);
    receiver.currentLayout = {
      root: {
        component: under,
        rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        children: [],
      },
    };
    receiver.overlayStack = [makeOverlay(overlay, { focusOrder: 1 })];

    // A default-width overlay in a 12-row terminal centers at row 5.
    const hit = hitTestReceiver(receiver, 16, 5);

    expect(hit?.component).toBe(overlay);
    expect(hit?.source).toBe("overlay");
  });

  it("returns undefined outside every box", () => {
    const receiver = makeReceiver();
    receiver.currentLayout = {
      root: {
        component: new MouseComponent(["root"]),
        rect: { x: 0, y: 0, width: 10, height: 5 },
        children: [],
      },
    };

    expect(hitTestReceiver(receiver, 15, 2)).toBeUndefined();
  });
});
