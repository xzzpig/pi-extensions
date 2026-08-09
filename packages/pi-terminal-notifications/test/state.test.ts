import { describe, expect, it, vi } from "vitest";

import { createInteractionState } from "../extensions/state.js";

function createState() {
  const emit = vi.fn();
  return { emit, state: createInteractionState({ emit }) };
}

describe("interaction state", () => {
  it("does not clear Herdr while another interaction remains active", () => {
    const { emit, state } = createState();

    expect(state.startAsk("ask-1", "Question")).toBe(true);
    expect(state.startPermission("permission-1", "Permission required")).toBe(
      true,
    );
    expect(state.completeAsk("ask-1")).toBe(true);
    expect(state.activeCount()).toBe(1);
    expect(emit).toHaveBeenLastCalledWith("herdr:blocked", {
      active: true,
      label: "Permission required",
    });

    expect(state.resolvePermission("permission-1")).toBe(true);
    expect(state.activeCount()).toBe(0);
    expect(emit).toHaveBeenLastCalledWith("herdr:blocked", { active: false });
  });

  it("ignores duplicate lifecycle events and emits one shutdown clear", () => {
    const { emit, state } = createState();

    expect(state.startAsk("ask-1", "Question")).toBe(true);
    expect(state.startAsk("ask-1", "Question")).toBe(false);
    expect(state.completeAsk("missing")).toBe(false);
    state.shutdown();
    state.shutdown();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, "herdr:blocked", {
      active: true,
      label: "Question",
    });
    expect(emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
  });

  it("does not allow an event bus failure to escape", () => {
    const state = createInteractionState({
      emit: () => {
        throw new Error("listener failed");
      },
    });

    expect(() =>
      state.startPermission("permission-1", "Permission required"),
    ).not.toThrow();
    expect(() => state.resolvePermission("permission-1")).not.toThrow();
  });
});
