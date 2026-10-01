/**
 * Tests for the lifecycle bus events and the pi-notify bridge (tasks 9.3/9.4).
 */
import { describe, expect, it } from "vitest";

import {
  emitSilentUiSpan,
  NOTIFY_NODE_EVENT_ID,
  notifyFlowNode,
  OPSX_LIFECYCLE_CHANNEL,
  PI_NOTIFY_PUBLISH_CHANNEL,
  PI_NOTIFY_SOURCE,
  PI_NOTIFY_UI_SPAN_SILENT_CHANNEL,
  publishLifecycle,
  publishNotify,
  type OpsxLifecycleEventType,
} from "../src/lifecycle.ts";

function createBus() {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    bus: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };
}

describe("publishLifecycle", () => {
  it("emits one versioned payload on the single lifecycle channel", () => {
    const { bus, emitted } = createBus();
    const payload = publishLifecycle(bus, {
      type: "phase_changed",
      change: "add-pi-openspec-x",
      mode: "plan",
      phase: "design",
      at: "2026-09-30T00:00:00.000Z",
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.channel).toBe(OPSX_LIFECYCLE_CHANNEL);
    expect(emitted[0]?.data).toEqual(payload);
    expect(payload).toMatchObject({
      version: 1,
      type: "phase_changed",
      change: "add-pi-openspec-x",
      mode: "plan",
      phase: "design",
      at: "2026-09-30T00:00:00.000Z",
    });
  });

  it("stamps a timestamp and never throws on a broken bus", () => {
    const payload = publishLifecycle(
      {
        emit() {
          throw new Error("bus down");
        },
      },
      { type: "plan_started", change: "c" },
    );
    expect(payload.at).toBeTruthy();
    expect(payload.version).toBe(1);
  });

  it("delivers a full flow sequence in order", () => {
    const { bus, emitted } = createBus();
    const sequence: OpsxLifecycleEventType[] = [
      "plan_started",
      "phase_changed",
      "review_verdict",
      "approval_wait",
      "plan_approved",
      "implement_started",
      "task_dispatched",
      "task_completed",
      "final_verdict",
      "flow_completed",
      "mode_exited",
    ];
    for (const type of sequence) {
      publishLifecycle(bus, { type, change: "c" });
    }
    expect(
      emitted.map((entry) => (entry.data as { type: string }).type),
    ).toEqual(sequence);
    expect(
      emitted.every((entry) => entry.channel === OPSX_LIFECYCLE_CHANNEL),
    ).toBe(true);
  });
});

describe("pi-notify bridge", () => {
  it("publishes notifications by literal channel with the source", () => {
    const { bus, emitted } = createBus();
    const payload = publishNotify(bus, {
      eventId: "input-required",
      label: "Plan approval",
    });
    expect(emitted[0]?.channel).toBe(PI_NOTIFY_PUBLISH_CHANNEL);
    expect(emitted[0]?.data).toEqual({
      eventId: "input-required",
      source: PI_NOTIFY_SOURCE,
      label: "Plan approval",
    });
    expect(payload.source).toBe(PI_NOTIFY_SOURCE);
  });

  it("claims a silent UI span before a blocking dialog", () => {
    const { bus, emitted } = createBus();
    emitSilentUiSpan(bus, "plan approval dialog");
    expect(emitted[0]?.channel).toBe(PI_NOTIFY_UI_SPAN_SILENT_CHANNEL);
    expect(emitted[0]?.data).toEqual({ reason: "plan approval dialog" });

    emitSilentUiSpan(bus);
    expect(emitted[1]?.data).toEqual({});
  });

  it("maps flow nodes to the agreed event ids", () => {
    expect(NOTIFY_NODE_EVENT_ID).toEqual({
      approval_wait: "input-required",
      flow_completed: "task-completed",
      gate_error: "integration-error",
    });
    const { bus, emitted } = createBus();
    notifyFlowNode(bus, "flow_completed", "done");
    expect(emitted[0]?.data).toMatchObject({
      eventId: "task-completed",
      source: PI_NOTIFY_SOURCE,
      label: "done",
    });
  });

  it("is a no-op when pi-notify is absent (no listener, no throw)", () => {
    const { bus } = createBus();
    expect(() =>
      publishNotify(bus, { eventId: "task-completed" }),
    ).not.toThrow();
    expect(() => emitSilentUiSpan(bus)).not.toThrow();
  });
});
