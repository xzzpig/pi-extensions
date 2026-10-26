/**
 * Patch registry tests (change task 1.3).
 *
 * The registry is the recoverable seam every host adaptation goes through,
 * so its lifecycle is pinned here: no wrapper stacking across factory
 * re-runs, reload-safe re-registration, non-destructive cleanup under an
 * outer patch, capability probing with deduplicated degradation notices,
 * and full call-chain fidelity (predecessor, receiver, arguments).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  GROUP_COLLAPSE_PATCH_REGISTRY,
  installPrototypePatch,
  probeCapability,
  resetUnavailableReports,
  setUnavailableListener,
} from "../src/patch-registry.ts";

type Prototype = Record<PropertyKey, unknown>;

class Widget {
  calls = 0;
  render(width: number): string[] {
    this.calls += 1;
    return [`widget:${width}`];
  }
}

beforeEach(() => {
  resetUnavailableReports();
});

describe("installPrototypePatch", () => {
  test("wraps exactly once across duplicate factory calls", () => {
    const prototype = Widget.prototype as unknown as Prototype;
    const original = prototype.render;
    const first = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `first:${predecessor.apply(receiver, args)}`,
    );
    expect(first.available).toBe(true);

    // A second factory run for the same adapter reuses the wrapper.
    const second = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `second:${predecessor.apply(receiver, args)}`,
    );
    expect(prototype.render).toBe(first ? prototype.render : undefined);
    const widget = new Widget();
    expect(widget.render(10)).toBe("second:widget:10");
    // One wrapper layer: the predecessor ran exactly once.
    expect(widget.calls).toBe(1);

    first.cleanup();
    second.cleanup();
    expect(prototype.render).toBe(original);
  });

  test("re-install after cleanup (reload) restores the original between runs", () => {
    const prototype = Widget.prototype as unknown as Prototype;
    const original = prototype.render;

    const first = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `one:${predecessor.apply(receiver, args)}`,
    );
    first.cleanup();
    expect(prototype.render).toBe(original);

    const second = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `two:${predecessor.apply(receiver, args)}`,
    );
    const widget = new Widget();
    expect(widget.render(5)).toBe("two:widget:5");
    second.cleanup();
    expect(prototype.render).toBe(original);
  });

  test("cleanup does not clobber a plugin that wrapped on top", () => {
    const prototype = Widget.prototype as unknown as Prototype;
    const original = prototype.render;
    const ours = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `ours:${predecessor.apply(receiver, args)}`,
    );
    const ourWrapper = prototype.render;

    // Another plugin wraps while we are installed.
    const theirPredecessor = prototype.render as (
      this: unknown,
      ...args: unknown[]
    ) => unknown;
    const theirWrapper = function (this: unknown, ...args: unknown[]): unknown {
      return `theirs:${theirPredecessor.apply(this, args)}`;
    };
    prototype.render = theirWrapper;

    ours.cleanup();
    // Their wrapper stays in place; ours became a pass-through underneath.
    expect(prototype.render).toBe(theirWrapper);
    expect(prototype.render).not.toBe(ourWrapper);
    expect(new Widget().render(3)).toBe("theirs:widget:3");

    prototype.render = original;
    expect(prototype.render).toBe(original);
  });

  test("an in-place foreign wrapper becomes the predecessor, not a victim", () => {
    const prototype = Widget.prototype as unknown as Prototype;
    const original = prototype.render;
    const foreign = function (this: unknown, ...args: unknown[]): unknown {
      return `foreign:${(original as (...a: unknown[]) => unknown).apply(
        this,
        args,
      )}`;
    };
    prototype.render = foreign;

    const ours = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `ours:${predecessor.apply(receiver, args)}`,
    );
    expect(new Widget().render(7)).toBe("ours:foreign:widget:7");
    ours.cleanup();
    // The foreign wrapper is restored exactly as it was found.
    expect(prototype.render).toBe(foreign);
    expect(new Widget().render(7)).toBe("foreign:widget:7");

    prototype.render = original;
  });

  test("missing capability degrades with a no-op cleanup and a deduplicated notice", () => {
    const reports: { method: string; adapter: string }[] = [];
    setUnavailableListener((info) =>
      reports.push({ method: info.method, adapter: info.adapter }),
    );
    try {
      const bare = {} as Prototype;
      expect(probeCapability(bare, "render")).toBe(false);
      const result = installPrototypePatch(bare, "render", "adapter", () => {
        throw new Error("must not run");
      });
      expect(result.available).toBe(false);
      expect(() => result.cleanup()).not.toThrow();

      // Repeated installs keep degrading silently after one report.
      installPrototypePatch(bare, "render", "adapter", () => undefined);
      expect(reports).toEqual([{ method: "render", adapter: "adapter" }]);

      // A different adapter still gets its own single report.
      installPrototypePatch(bare, "render", "other", () => undefined);
      expect(reports).toEqual([
        { method: "render", adapter: "adapter" },
        { method: "render", adapter: "other" },
      ]);
    } finally {
      setUnavailableListener(undefined);
    }
  });

  test("behavior observes receiver, arguments, and predecessor result", () => {
    const prototype = Widget.prototype as unknown as Prototype;
    const seen: { receiver: unknown; args: unknown[]; result: unknown }[] = [];
    const cleanup = installPrototypePatch(
      prototype,
      "render",
      "observer",
      ({ predecessor, receiver, args }) => {
        const result = predecessor.apply(receiver, args);
        seen.push({ receiver, args, result });
        return ["wrapped"];
      },
    ).cleanup;
    const widget = new Widget();
    expect(widget.render(42)).toEqual(["wrapped"]);
    expect(seen).toEqual([
      { receiver: widget, args: [42], result: ["widget:42"] },
    ]);
    cleanup();
  });

  test("the registry lives on the target under the shared symbol", () => {
    const prototype = Widget.prototype as unknown as Prototype;
    const cleanup = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        predecessor.apply(receiver, args) as unknown,
    ).cleanup;
    expect(prototype[GROUP_COLLAPSE_PATCH_REGISTRY]).toBeInstanceOf(Map);
    cleanup();
    expect(prototype[GROUP_COLLAPSE_PATCH_REGISTRY]).toBeUndefined();
  });

  test("out-of-order cleanup of a superseded registration is a no-op", () => {
    const prototype = Widget.prototype as unknown as Prototype;
    const original = prototype.render;
    const first = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `first:${predecessor.apply(receiver, args)}`,
    );
    const second = installPrototypePatch(
      prototype,
      "render",
      "adapter",
      ({ predecessor, receiver, args }) =>
        `second:${predecessor.apply(receiver, args)}`,
    );
    // The stale registration no longer owns the behavior slot.
    first.cleanup();
    expect(new Widget().render(1)).toBe("second:widget:1");
    expect(prototype.render).not.toBe(original);

    second.cleanup();
    expect(prototype.render).toBe(original);
  });
});

describe("setUnavailableListener", () => {
  test("notices are suppressed until the listener is cleared", () => {
    const listener = vi.fn();
    setUnavailableListener(listener);
    try {
      const bare = {} as Prototype;
      installPrototypePatch(bare, "missing", "a", () => undefined);
      resetUnavailableReports();
      setUnavailableListener(undefined);
      installPrototypePatch(bare, "missing", "b", () => undefined);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ adapter: "a" }),
      );
    } finally {
      setUnavailableListener(undefined);
    }
  });
});
