import { describe, expect, test } from "vitest";
import {
  EventSubscriptionRegistry,
  type BusSubscriber,
  type CoreSubscriber,
  type EventDispatch,
} from "../extensions/event-subscriptions.ts";

interface DispatchCall {
  name: string;
  payload: unknown;
  ctx: unknown;
  /** Argument count observed by the injected dispatch (bus events omit ctx). */
  argCount: number;
}

function recordDispatch(): { dispatch: EventDispatch; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const dispatch: EventDispatch = (...args: [string, unknown, unknown?]) => {
    calls.push({
      name: args[0],
      payload: args[1],
      ctx: args[2],
      argCount: args.length,
    });
  };
  return { dispatch, calls };
}

function fakeCoreSubscriber() {
  const calls: string[] = [];
  const handlers = new Map<
    string,
    { handler: (event: unknown, ctx: unknown) => void; unsubscribes: number }
  >();
  // Tracked outside `handlers` so the count survives the entry's deletion.
  const unsubscribeCounts = new Map<string, number>();
  const subscribe: CoreSubscriber = (name, handler) => {
    calls.push(name);
    const entry = { handler, unsubscribes: 0 };
    handlers.set(name, entry);
    return () => {
      entry.unsubscribes += 1;
      unsubscribeCounts.set(name, (unsubscribeCounts.get(name) ?? 0) + 1);
      handlers.delete(name);
    };
  };
  return {
    subscribe,
    calls,
    unsubscribeCount: (name: string) => unsubscribeCounts.get(name) ?? 0,
    emit(name: string, event: unknown, ctx?: unknown) {
      handlers.get(name)?.handler(event, ctx);
    },
  };
}

function fakeBusSubscriber() {
  const calls: string[] = [];
  const handlers = new Map<
    string,
    { handler: (data: unknown) => void; unsubscribes: number }
  >();
  const unsubscribeCounts = new Map<string, number>();
  const subscribe: BusSubscriber = (channel, handler) => {
    calls.push(channel);
    const entry = { handler, unsubscribes: 0 };
    handlers.set(channel, entry);
    return () => {
      entry.unsubscribes += 1;
      unsubscribeCounts.set(channel, (unsubscribeCounts.get(channel) ?? 0) + 1);
      handlers.delete(channel);
    };
  };
  return {
    subscribe,
    calls,
    unsubscribeCount: (channel: string) => unsubscribeCounts.get(channel) ?? 0,
    emit(channel: string, data: unknown) {
      handlers.get(channel)?.handler(data);
    },
  };
}

function makeRegistry() {
  const core = fakeCoreSubscriber();
  const bus = fakeBusSubscriber();
  const { dispatch, calls } = recordDispatch();
  const registry = new EventSubscriptionRegistry(
    core.subscribe,
    bus.subscribe,
    dispatch,
  );
  return { registry, core, bus, calls };
}

describe("event subscription registry", () => {
  test("new names subscribe once, routed by prefix with core: stripped", () => {
    const { registry, core, bus, calls } = makeRegistry();
    const ctx = { session: "ctx-1" };

    registry.reconcile(["core:session_compact", "pi-subagents:done"]);

    // The host routes pi.on by bare event names; only the bus sees raw names.
    expect(core.calls).toEqual(["session_compact"]);
    expect(bus.calls).toEqual(["pi-subagents:done"]);
    expect(registry.subscribedNames()).toEqual([
      "core:session_compact",
      "pi-subagents:done",
    ]);

    core.emit("session_compact", { reason: "手动压缩" }, ctx);
    expect(calls).toEqual([
      {
        name: "core:session_compact",
        payload: { reason: "手动压缩" },
        ctx,
        argCount: 3,
      },
    ]);

    bus.emit("pi-subagents:done", { ok: true });
    expect(calls[1]).toEqual({
      name: "pi-subagents:done",
      payload: { ok: true },
      ctx: undefined,
      argCount: 2,
    });
  });

  test("the same event name shares a single subscription across reconciles", () => {
    const { registry, core, bus, calls } = makeRegistry();

    registry.reconcile(["core:session_compact", "pi-subagents:done"]);
    registry.reconcile(["core:session_compact", "pi-subagents:done"]);
    registry.reconcile(["core:session_compact"]);

    expect(core.calls).toEqual(["session_compact"]);
    expect(bus.calls).toEqual(["pi-subagents:done"]);

    core.emit("session_compact", { n: 1 }, undefined);
    expect(calls).toEqual([
      {
        name: "core:session_compact",
        payload: { n: 1 },
        ctx: undefined,
        argCount: 3,
      },
    ]);
  });

  test("a name that disappears unsubscribes exactly once and stops dispatching", () => {
    const { registry, core, bus, calls } = makeRegistry();
    const ctx = { session: "ctx-1" };

    registry.reconcile(["core:session_compact", "kept-channel"]);
    registry.reconcile(["kept-channel"]);

    expect(core.unsubscribeCount("session_compact")).toBe(1);
    expect(bus.unsubscribeCount("kept-channel")).toBe(0);
    expect(registry.subscribedNames()).toEqual(["kept-channel"]);

    // Reconciling without the name again must not double-unsubscribe.
    registry.reconcile(["kept-channel"]);
    expect(core.unsubscribeCount("session_compact")).toBe(1);

    core.emit("session_compact", { reason: "late" }, ctx);
    expect(calls).toEqual([]);

    // A removed name can be subscribed again later.
    registry.reconcile(["core:session_compact", "kept-channel"]);
    expect(core.calls).toEqual(["session_compact", "session_compact"]);
    core.emit("session_compact", { reason: "again" }, ctx);
    expect(calls).toEqual([
      {
        name: "core:session_compact",
        payload: { reason: "again" },
        ctx,
        argCount: 3,
      },
    ]);
  });

  test("clear() unsubscribes every name exactly once", () => {
    const { registry, core, bus, calls } = makeRegistry();

    registry.reconcile([
      "core:session_compact",
      "pi-subagents:done",
      "other-channel",
    ]);
    registry.clear();

    expect(core.unsubscribeCount("session_compact")).toBe(1);
    expect(bus.unsubscribeCount("pi-subagents:done")).toBe(1);
    expect(bus.unsubscribeCount("other-channel")).toBe(1);
    expect(registry.subscribedNames()).toEqual([]);

    bus.emit("pi-subagents:done", { x: 1 });
    expect(calls).toEqual([]);

    // A second clear() is a no-op, not a double unsubscribe.
    registry.clear();
    expect(core.unsubscribeCount("session_compact")).toBe(1);
    expect(bus.unsubscribeCount("pi-subagents:done")).toBe(1);
  });

  test("renaming an event unsubscribes the old name and subscribes the new one", () => {
    const { registry, bus, calls } = makeRegistry();

    registry.reconcile(["a"]);
    registry.reconcile(["b"]);

    expect(bus.calls).toEqual(["a", "b"]);
    expect(bus.unsubscribeCount("a")).toBe(1);
    expect(registry.subscribedNames()).toEqual(["b"]);

    bus.emit("a", "old");
    bus.emit("b", "new");
    expect(calls.map((call) => [call.name, call.payload])).toEqual([
      ["b", "new"],
    ]);
  });
});
