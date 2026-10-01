/**
 * Tests for the flow entries, the status snapshot, and the progress lines
 * (task 9.1).
 */
import { describe, expect, it } from "vitest";

import {
  appendFlowEntry,
  appendStatusSnapshot,
  createStatusSnapshotTurnEndHandler,
  OPSX_ENTRY_TYPES,
  registerFlowRenderers,
  renderFlowEntryText,
  renderStatusLine,
  restoreFlowState,
  type SessionEntryLike,
} from "../src/flow-entries.ts";

function createPi() {
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const renderers = new Map<string, unknown>();
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    registerEntryRenderer(customType: string, renderer: unknown) {
      renderers.set(customType, renderer);
    },
  };
  return { pi, entries, renderers };
}

describe("appendStatusSnapshot / restoreFlowState", () => {
  it("appends a snapshot and recovers the latest state", () => {
    const { pi, entries } = createPi();
    appendStatusSnapshot(pi as never, {
      mode: "plan",
      changeId: "change-a",
      phase: "design",
      round: 1,
      tasksTotal: 5,
      tasksDone: 2,
      lastVerdict: "ITERATE",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.customType).toBe(OPSX_ENTRY_TYPES.statusSnapshot);

    appendStatusSnapshot(pi as never, {
      mode: "agent",
      changeId: "change-a",
      phase: "implementing",
      tasksTotal: 5,
      tasksDone: 4,
    });
    const sessionEntries: SessionEntryLike[] = [
      {
        type: "custom",
        customType: OPSX_ENTRY_TYPES.statusSnapshot,
        data: entries[0]?.data,
      },
      { type: "message", customType: "ignored" },
      {
        type: "custom",
        customType: OPSX_ENTRY_TYPES.statusSnapshot,
        data: entries[1]?.data,
      },
    ];
    const restored = restoreFlowState(sessionEntries);
    expect(restored?.mode).toBe("agent");
    expect(restored?.tasksDone).toBe(4);
  });

  it("returns undefined without a snapshot and tolerates a broken append", () => {
    expect(restoreFlowState([])).toBeUndefined();
    expect(
      restoreFlowState([{ type: "custom", customType: "other" }]),
    ).toBeUndefined();

    const throwingPi = {
      appendEntry() {
        throw new Error("session closed");
      },
    };
    expect(() =>
      appendFlowEntry(throwingPi as never, OPSX_ENTRY_TYPES.modeEntered, {
        mode: "plan",
      }),
    ).not.toThrow();
  });

  it("recovers the state after a simulated compaction (snapshot survives)", () => {
    // A compaction drops the LLM-context entries but custom entries remain;
    // the snapshot is the recovery source.
    const { pi, entries } = createPi();
    appendStatusSnapshot(pi as never, {
      mode: "direct",
      changeId: "change-b",
      phase: "reviewing",
    });
    const afterCompaction: SessionEntryLike[] = [
      { type: "compaction" },
      {
        type: "custom",
        customType: OPSX_ENTRY_TYPES.statusSnapshot,
        data: entries[0]?.data,
      },
    ];
    expect(restoreFlowState(afterCompaction)?.phase).toBe("reviewing");
  });
});

describe("renderFlowEntryText", () => {
  it("renders each flow entry type as a compact line", () => {
    expect(
      renderFlowEntryText(OPSX_ENTRY_TYPES.modeEntered, {
        mode: "plan",
        changeId: "c",
      }),
    ).toContain("plan mode entered");
    expect(
      renderFlowEntryText(OPSX_ENTRY_TYPES.modeExited, { mode: "agent" }),
    ).toContain("mode exited");
    expect(
      renderFlowEntryText(OPSX_ENTRY_TYPES.phaseChanged, {
        phase: "tasks",
        changeId: "c",
      }),
    ).toBe("→ phase tasks (c)");
    expect(
      renderFlowEntryText(OPSX_ENTRY_TYPES.verdict, {
        verdict: "OKAY",
        round: 2,
        changeId: "c",
      }),
    ).toBe("⚖ OKAY round 2 (c)");
    expect(
      renderFlowEntryText(OPSX_ENTRY_TYPES.taskTicked, {
        taskId: "1.1",
        changeId: "c",
      }),
    ).toBe("☑ 1.1 (c)");
    expect(renderFlowEntryText("unknown", {})).toBeUndefined();
  });
});

describe("renderStatusLine", () => {
  it("summarizes mode, change, phase, round and task progress", () => {
    expect(
      renderStatusLine({
        mode: "agent",
        changeId: "change-a",
        phase: "implementing",
        round: 3,
        tasksTotal: 5,
        tasksDone: 2,
        lastVerdict: "ITERATE",
      }),
    ).toBe(
      "opsx · agent · change-a · implementing · round 3 · tasks 2/5 · last ITERATE",
    );
  });

  it("renders just the prefix for an empty state", () => {
    expect(renderStatusLine({})).toBe("opsx");
  });
});

describe("createStatusSnapshotTurnEndHandler", () => {
  it("appends the snapshot and sets the session status line each turn", () => {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const pi = {
      appendEntry(customType: string, data?: unknown) {
        appended.push({ customType, data });
      },
    };
    const handler = createStatusSnapshotTurnEndHandler(
      pi as never,
      (sessionId) =>
        sessionId === "s1"
          ? { mode: "agent", changeId: "change-a", phase: "implementing" }
          : undefined,
    );
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      ui: {
        setStatus(key: string, text: string | undefined) {
          statuses.push({ key, text });
        },
      },
    };

    handler({} as never, ctx as never);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe(OPSX_ENTRY_TYPES.statusSnapshot);
    expect(statuses[0]).toEqual({
      key: "opsx",
      text: "opsx · agent · change-a · implementing",
    });

    // A session with no active flow clears the status line instead of
    // leaving a stale mode/phase on the footer, and writes no snapshot.
    handler(
      {} as never,
      {
        ...ctx,
        sessionManager: { getSessionId: () => "other" },
      } as never,
    );
    expect(appended).toHaveLength(1);
    expect(statuses[1]).toEqual({ key: "opsx", text: undefined });
  });

  it("does not touch the UI when there is no UI", () => {
    const called: string[] = [];
    const handler = createStatusSnapshotTurnEndHandler(
      { appendEntry() {} } as never,
      () => undefined,
    );
    handler(
      {} as never,
      {
        hasUI: false,
        sessionManager: { getSessionId: () => "s1" },
        ui: {
          setStatus(key: string, text: string | undefined) {
            called.push(`${key}=${text}`);
          },
        },
      } as never,
    );
    expect(called).toEqual([]);
  });
});
describe("registerFlowRenderers", () => {
  it("registers one renderer per flow entry type that renders a line", () => {
    const { pi, renderers } = createPi();
    registerFlowRenderers(pi as never);
    expect(renderers.size).toBe(7);

    const renderer = renderers.get(OPSX_ENTRY_TYPES.phaseChanged) as (entry: {
      data: Record<string, unknown>;
    }) => { render(width: number): string[]; invalidate(): void } | undefined;
    const component = renderer({ data: { phase: "design", changeId: "c" } });
    expect(component?.render(80)).toEqual(["→ phase design (c)"]);
    component?.invalidate();

    const unknownRenderer = renderers.get(OPSX_ENTRY_TYPES.verdict) as (entry: {
      data: Record<string, unknown>;
    }) => unknown;
    expect(unknownRenderer({ data: {} })).toBeDefined();
  });
});

describe("status snapshot restore after a process restart (task 9.1)", () => {
  function handlerWith(entries: SessionEntryLike[]) {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const pi = {
      appendEntry(customType: string, data?: unknown) {
        appended.push({ customType, data });
      },
    };
    const handler = createStatusSnapshotTurnEndHandler(
      pi as never,
      () => undefined,
    );
    const ctx = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => entries,
      },
      ui: {
        setStatus(key: string, text: string | undefined) {
          statuses.push({ key, text });
        },
      },
    };
    handler({} as never, ctx as never);
    return { appended, statuses };
  }

  it("renders the last persisted snapshot instead of nothing", () => {
    const { appended, statuses } = handlerWith([
      {
        type: "custom",
        customType: OPSX_ENTRY_TYPES.statusSnapshot,
        data: { mode: "agent", changeId: "change-a", phase: "reviewing" },
      },
    ]);
    expect(statuses[0]).toEqual({
      key: "opsx",
      text: "opsx · agent · change-a · reviewing",
    });
    // Restoring is a read: no duplicate snapshot is appended.
    expect(appended).toEqual([]);
  });

  it("does not render a flow that already ended, and clears the footer", () => {
    const { statuses } = handlerWith([
      {
        type: "custom",
        customType: OPSX_ENTRY_TYPES.statusSnapshot,
        data: { changeId: "change-a", ended: true },
      },
    ]);
    expect(statuses).toEqual([{ key: "opsx", text: undefined }]);
  });

  it("prefers the live registry over the persisted snapshot", () => {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const pi = {
      appendEntry(customType: string, data?: unknown) {
        appended.push({ customType, data });
      },
    };
    const handler = createStatusSnapshotTurnEndHandler(pi as never, () => ({
      mode: "plan",
      changeId: "change-b",
    }));
    handler(
      {} as never,
      {
        hasUI: true,
        sessionManager: {
          getSessionId: () => "s1",
          getEntries: () => [
            {
              type: "custom",
              customType: OPSX_ENTRY_TYPES.statusSnapshot,
              data: { mode: "agent", changeId: "stale" },
            },
          ],
        },
        ui: {
          setStatus(key: string, text: string | undefined) {
            statuses.push({ key, text });
          },
        },
      } as never,
    );
    expect(appended).toHaveLength(1);
    expect(statuses[0]?.text).toBe("opsx · plan · change-b");
  });
});
