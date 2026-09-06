/**
 * Reload safety: pi re-evaluates extension entry points on every session
 * replacement, and more than one copy of this package can be loaded in the
 * same process. The registry must make patching idempotent (the prototype is
 * wrapped exactly once), let the newest registration's behavior win, restore
 * the pristine method only when cleanup is safe, and degrade without throwing
 * when the patched structure no longer exists.
 */

import { describe, expect, test } from "vitest";

import {
  THINKING_COLLAPSE_PATCH_REGISTRY,
  installPrototypePatch,
  type PrototypeLike,
  type PatchBehavior,
} from "../src/registry.ts";
import { getThinkingCollapseRuntime } from "../src/controller.ts";

function behaviorOf(tag: string): PatchBehavior {
  return ({ receiver, args, predecessor }) => {
    const calls = (receiver as { calls?: string[] }).calls ?? [];
    calls.push(tag);
    (receiver as { calls?: string[] }).calls = calls;
    return predecessor.apply(receiver, args);
  };
}

class Dummy {
  calls: string[] = [];
  greet(name: string): string {
    this.calls.push("original");
    return `hello ${name}`;
  }
}

function prototypeOf(instance: Dummy): PrototypeLike {
  // SAFETY: tests reach into the class prototype through the documented
  // PrototypeLike shape; only the method under test is touched.
  return Object.getPrototypeOf(instance) as PrototypeLike;
}

describe("prototype patch registry", () => {
  test("wraps the prototype exactly once across repeated installs", () => {
    const instance = new Dummy();
    const target = prototypeOf(instance);
    const original = target.greet;

    const cleanup1 = installPrototypePatch(
      target,
      "greet",
      "test-adapter",
      behaviorOf("first"),
    );
    const cleanup2 = installPrototypePatch(
      target,
      "greet",
      "test-adapter",
      behaviorOf("second"),
    );

    // Still a single wrapper; the newest behavior wins.
    expect(target.greet).not.toBe(original);
    expect(instance.greet("pi")).toBe("hello pi");
    expect(instance.calls).toEqual(["second", "original"]);
    expect(typeof cleanup1).toBe("function");
    expect(typeof cleanup2).toBe("function");

    cleanup1(); // stale cleanup: must not tear the newer registration
    expect(instance.greet("again")).toBe("hello again");
    expect(instance.calls).toEqual([
      "second",
      "original",
      "second",
      "original",
    ]);
    expect(target.greet).not.toBe(original);

    cleanup2();
    expect(target.greet).toBe(original);
    expect(instance.greet("restored")).toBe("hello restored");
    expect(instance.calls).toEqual([
      "second",
      "original",
      "second",
      "original",
      "original",
    ]);
  });

  test("a later registration after cleanup re-wraps from the pristine method", () => {
    const instance = new Dummy();
    const target = prototypeOf(instance);
    const original = target.greet;

    const cleanup1 = installPrototypePatch(
      target,
      "greet",
      "test-adapter",
      behaviorOf("first"),
    );
    cleanup1();
    expect(target.greet).toBe(original);

    const cleanup2 = installPrototypePatch(
      target,
      "greet",
      "test-adapter",
      behaviorOf("second"),
    );
    expect(target.greet).not.toBe(original);
    cleanup2();
    expect(target.greet).toBe(original);
    expect(instance.greet("x")).toBe("hello x");
    expect(instance.calls).toEqual(["original"]);
  });

  test("the registry record disappears from the target after full cleanup", () => {
    const instance = new Dummy();
    const target = prototypeOf(instance);
    const cleanup = installPrototypePatch(
      target,
      "greet",
      "test-adapter",
      behaviorOf("once"),
    );
    expect(
      (target as Record<symbol, unknown>)[THINKING_COLLAPSE_PATCH_REGISTRY],
    ).toBeInstanceOf(Map);
    cleanup();
    expect(
      (target as Record<symbol, unknown>)[THINKING_COLLAPSE_PATCH_REGISTRY],
    ).toBeUndefined();
  });

  test("missing structure degrades without throwing", () => {
    const target = {} as PrototypeLike;
    const cleanup = installPrototypePatch(
      target,
      "missing",
      "test-adapter",
      behaviorOf("x"),
    );
    expect(typeof cleanup).toBe("function");
    expect(cleanup()).toBeUndefined(); // no-op, no crash
    expect(target.missing).toBeUndefined();
  });

  test("non-function predecessor degrades without throwing", () => {
    const target = { greet: "not-a-function" } as PrototypeLike;
    const cleanup = installPrototypePatch(
      target,
      "greet",
      "test-adapter",
      behaviorOf("x"),
    );
    expect(typeof cleanup).toBe("function");
    expect(target.greet).toBe("not-a-function");
  });
});

describe("runtime reload safety", () => {
  test("install is idempotent across repeated factory runs", () => {
    const first = getThinkingCollapseRuntime();
    first.install();
    first.install(); // same session, double factory run
    const second = getThinkingCollapseRuntime();
    second.install(); // a fresh copy of the entry point, same process

    expect(second.collapse).toBe(first.collapse);
    // Repeated installs neither throw nor replace the process-global runtime.
    expect(second.collapse.install).toBeTypeOf("function");
  });
});
