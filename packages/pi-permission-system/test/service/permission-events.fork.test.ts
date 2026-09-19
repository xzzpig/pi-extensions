import { describe, expect, it, vi } from "vitest";

import type { PermissionForwardedDecisionEvent } from "#src/service/permission-events";
import { emitForwardedDecisionEvent } from "#src/service/permission-events";

// ── Minimal EventBus stub ──────────────────────────────────────────────────

function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
}

// Fork-only tests: the forwarded-decision event broadcast (upstream
// `permission-events.test.ts` covers the upstream event channels).

// ── emitForwardedDecisionEvent ────────────────────────────────────────────

describe("emitForwardedDecisionEvent", () => {
  function makeForwardedDecisionEvent(
    overrides: Partial<PermissionForwardedDecisionEvent> = {},
  ): PermissionForwardedDecisionEvent {
    return {
      requestId: "req-forwarded",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      forwarding: {
        requesterAgentName: "Worker",
        requesterSessionId: "child-session",
      },
      responderSessionId: "parent-session",
      result: "allow",
      resolution: "user_approved",
      respondedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  it("emits on the permissions:forwarded_decision channel", () => {
    const bus = makeEventBus();
    emitForwardedDecisionEvent(bus, makeForwardedDecisionEvent());
    expect(bus.emit).toHaveBeenCalledOnce();
    expect(bus.emit.mock.calls[0][0]).toBe("permissions:forwarded_decision");
  });

  it("forwards the correlated response payload unchanged", () => {
    const bus = makeEventBus();
    const event = makeForwardedDecisionEvent({
      result: "deny",
      resolution: "user_denied",
    });
    emitForwardedDecisionEvent(bus, event);
    expect(bus.emit.mock.calls[0][1]).toEqual(event);
  });

  it("swallows event bus errors because response delivery is already complete", () => {
    const bus = {
      emit: vi.fn(() => {
        throw new Error("listener failed");
      }),
      on: vi.fn().mockReturnValue(() => undefined),
    };

    expect(() =>
      emitForwardedDecisionEvent(bus, makeForwardedDecisionEvent()),
    ).not.toThrow();
  });
});
