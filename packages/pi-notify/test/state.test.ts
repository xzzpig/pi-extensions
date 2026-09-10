import { describe, expect, it } from "vitest";

import { createInteractionState } from "../extensions/state.js";

function collectEmitted(): Array<{ channel: string; data: unknown }> {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return emitted;
}

function createEmitter(emitted: Array<{ channel: string; data: unknown }>) {
  return {
    emit: (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    },
  };
}

describe("createInteractionState", () => {
  it("emits blocked on the first span and unblocked when it completes", () => {
    const emitted = collectEmitted();
    const state = createInteractionState(createEmitter(emitted));

    expect(state.activeCount()).toBe(0);
    expect(state.startUiPrompt("span-1", "Waiting for input")).toBe(true);
    expect(emitted).toEqual([
      {
        channel: "herdr:blocked",
        data: { active: true, label: "Waiting for input" },
      },
    ]);
    expect(state.activeCount()).toBe(1);

    expect(state.completeUiPrompt("span-1")).toBe(true);
    expect(emitted).toEqual([
      {
        channel: "herdr:blocked",
        data: { active: true, label: "Waiting for input" },
      },
      { channel: "herdr:blocked", data: { active: false } },
    ]);
    expect(state.activeCount()).toBe(0);
  });

  it("stays blocked until every concurrent span completes", () => {
    const emitted = collectEmitted();
    const state = createInteractionState(createEmitter(emitted));

    state.startUiPrompt("span-1", "First");
    state.startUiPrompt("span-2", "Second");
    // One blocked raise for the whole concurrent set; the second start does
    // not re-emit while blocked.
    expect(emitted).toHaveLength(1);
    expect(state.activeCount()).toBe(2);

    expect(state.completeUiPrompt("span-1")).toBe(true);
    expect(emitted).toHaveLength(1);

    expect(state.completeUiPrompt("span-2")).toBe(true);
    expect(emitted[1]).toEqual({
      channel: "herdr:blocked",
      data: { active: false },
    });
  });

  it("ignores duplicate span ids and unknown completions", () => {
    const emitted = collectEmitted();
    const state = createInteractionState(createEmitter(emitted));

    expect(state.startUiPrompt("span-1", "First")).toBe(true);
    expect(state.startUiPrompt("span-1", "Second")).toBe(false);
    expect(emitted).toHaveLength(1);

    expect(state.completeUiPrompt("unknown-span")).toBe(false);
    expect(emitted).toHaveLength(1);
  });

  it("clears every span on shutdown and releases the blocked state", () => {
    const emitted = collectEmitted();
    const state = createInteractionState(createEmitter(emitted));

    state.startUiPrompt("span-1", "First");
    state.startUiPrompt("span-2", "Second");
    state.shutdown();

    expect(state.activeCount()).toBe(0);
    expect(emitted).toEqual([
      { channel: "herdr:blocked", data: { active: true, label: "First" } },
      { channel: "herdr:blocked", data: { active: false } },
    ]);
    // A shutdown on an idle machine emits nothing.
    state.shutdown();
    expect(emitted).toHaveLength(2);
  });

  it("swallows emitter failures observationally", () => {
    const state = createInteractionState({
      emit: () => {
        throw new Error("observer exploded");
      },
    });

    expect(() => state.startUiPrompt("span-1", "First")).not.toThrow();
    expect(() => state.completeUiPrompt("span-1")).not.toThrow();
    expect(() => state.shutdown()).not.toThrow();
    expect(state.activeCount()).toBe(0);
  });

  it("emits a fresh blocked label after a full cycle", () => {
    const emitted = collectEmitted();
    const state = createInteractionState(createEmitter(emitted));

    state.startUiPrompt("span-1", "First");
    state.completeUiPrompt("span-1");
    state.startUiPrompt("span-2", "Second");

    expect(emitted[2]).toEqual({
      channel: "herdr:blocked",
      data: { active: true, label: "Second" },
    });
  });
});
