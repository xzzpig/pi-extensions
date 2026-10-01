/**
 * Tests for the plan approval gate (task 7.3): the fail-closed decision, the
 * pi-ask detection, and the requestPlanApproval wiring.
 */
import { describe, expect, it } from "vitest";

import {
  canEnterImplementation,
  detectPiAsk,
  PI_ASK_TOOL_NAME,
  requestPlanApproval,
  type PlanApproval,
} from "../src/approval-gate.ts";

function piWithTools(names: string[]) {
  return {
    getAllTools: () => names.map((name) => ({ name })),
  };
}

function approval(
  decision: PlanApproval["decision"],
  changeId = "change-a",
): PlanApproval {
  return { changeId, decision, at: "2026-09-30T00:00:00.000Z", via: "select" };
}

describe("detectPiAsk", () => {
  it("detects the ask_user tool and tolerates a throwing host", () => {
    expect(detectPiAsk(piWithTools([PI_ASK_TOOL_NAME]))).toBe(true);
    expect(detectPiAsk(piWithTools(["read", "bash"]))).toBe(false);
    expect(
      detectPiAsk({
        getAllTools: () => {
          throw new Error("host not ready");
        },
      }),
    ).toBe(false);
  });
});

describe("canEnterImplementation (fail-closed)", () => {
  it("unlocks only an approved decision for the same change", () => {
    expect(canEnterImplementation(approval("approved"), "change-a")).toBe(true);
    expect(
      canEnterImplementation(approval("approved", "change-b"), "change-a"),
    ).toBe(false);
    expect(canEnterImplementation(approval("revise"), "change-a")).toBe(false);
    expect(canEnterImplementation(approval("rejected"), "change-a")).toBe(
      false,
    );
    expect(canEnterImplementation(approval("pending"), "change-a")).toBe(false);
    expect(canEnterImplementation(undefined, "change-a")).toBe(false);
  });
});

describe("requestPlanApproval", () => {
  it("degrades to a pending plain-text decision without a UI", async () => {
    const result = await requestPlanApproval(
      piWithTools([]),
      {
        hasUI: false,
      } as never,
      "change-a",
    );
    expect(result).toMatchObject({
      changeId: "change-a",
      decision: "pending",
      via: "text",
    });
  });

  it("records an approved selection through the host selector", async () => {
    const result = await requestPlanApproval(
      piWithTools([]),
      {
        hasUI: true,
        ui: { select: async () => "Approve the plan" },
      } as never,
      "change-a",
    );
    expect(result.decision).toBe("approved");
    expect(result.via).toBe("select");
  });

  it("records the pi-ask via when the tool is present", async () => {
    const result = await requestPlanApproval(
      piWithTools([PI_ASK_TOOL_NAME]),
      { hasUI: true, ui: { select: async () => "Request changes" } } as never,
      "change-a",
    );
    expect(result.decision).toBe("revise");
    expect(result.via).toBe("pi-ask");
  });

  it("bridges the blocking approval to the lifecycle and pi-notify channels", async () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const events = {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    };
    const result = await requestPlanApproval(
      piWithTools([]),
      { hasUI: true, ui: { select: async () => "Approve the plan" } } as never,
      "change-a",
      events,
    );
    expect(result.decision).toBe("approved");
    const channels = emitted.map((entry) => entry.channel);
    expect(channels).toContain("pi-notify:ui_span_silent");
    expect(channels).toContain("pi-notify:publish");
    expect(channels).toContain("pi-openspec-x:lifecycle:v1");
    expect(
      emitted.find((entry) => entry.channel === "pi-notify:publish")?.data,
    ).toMatchObject({ eventId: "input-required", source: "pi-openspec-x" });
    expect(
      emitted
        .filter((entry) => entry.channel === "pi-openspec-x:lifecycle:v1")
        .map((entry) => (entry.data as { type: string }).type),
    ).toEqual(["approval_wait", "plan_approved"]);
  });

  it("stays pending when the dialog fails or is dismissed", async () => {
    const failed = await requestPlanApproval(
      piWithTools([]),
      {
        hasUI: true,
        ui: {
          select: async () => {
            throw new Error("dialog exploded");
          },
        },
      } as never,
      "change-a",
    );
    expect(failed.decision).toBe("pending");

    const dismissed = await requestPlanApproval(
      piWithTools([]),
      {
        hasUI: true,
        ui: { select: async () => undefined },
      } as never,
      "change-a",
    );
    expect(dismissed.decision).toBe("pending");
  });
});
