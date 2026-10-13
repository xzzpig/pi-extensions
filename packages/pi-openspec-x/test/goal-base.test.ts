/**
 * Tests for the goal-base reader and the session-start recovery notice
 * (task 6.4). Uses a fake goal-x storage facet over real files, so the reader's
 * listing/filtering is exercised without importing the optional peer.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createOpsxRecoverySessionStartHandler,
  readArchivedGoals,
  readFocusedGoalSnapshot,
  readGoalBaseSummaries,
  readGoalTaskTree,
  refreshGoalRecordByPath,
  resetRecoveryStateForTests,
  type GoalXFocusFacet,
  type GoalXStorageFacet,
} from "../src/goal-base.ts";
import type { GoalTaskLike } from "../src/task-sync.ts";

const roots: string[] = [];

afterEach(() => {
  resetRecoveryStateForTests();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-openspec-x-goal-base-"),
  );
  roots.push(root);
  return root;
}

function writeGoalFile(root: string, name: string, value: unknown): void {
  fs.writeFileSync(
    path.join(root, name),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function facetFor(root: string): GoalXStorageFacet {
  return {
    goalStorageRoot: () => root,
    parseGoalFile: (filePath: string) => {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
          id: string;
          status: string;
          objective: string;
          taskList?: { tasks?: GoalTaskLike[] };
        };
        return {
          id: raw.id,
          status: raw.status,
          objective: raw.objective,
          ...(raw.taskList ? { taskList: raw.taskList } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}

describe("readGoalBaseSummaries", () => {
  it("reads only active goal files and tolerates malformed entries", async () => {
    const root = makeRoot();
    writeGoalFile(root, "active_goal_20260101_g1.md", {
      id: "g1",
      status: "active",
      objective: 'Implement the OpenSpec change "change-a".',
    });
    writeGoalFile(root, "active_goal_20260102_g2.md", {
      id: "g2",
      status: "paused",
      objective: "A plain goal.",
    });
    writeGoalFile(root, "active_goal_bad.md", "{ not json");
    writeGoalFile(root, "notes.md", "not a goal");
    fs.mkdirSync(path.join(root, "archived"));

    const goals = await readGoalBaseSummaries({ cwd: root }, async () =>
      facetFor(root),
    );
    expect(goals.map((goal) => goal.id).sort()).toEqual(["g1", "g2"]);
    expect(goals.find((goal) => goal.id === "g1")?.objective).toContain(
      "change-a",
    );
  });

  it("degrades to an empty base when goal-x is missing or the root is unreadable", async () => {
    expect(
      await readGoalBaseSummaries({ cwd: "/tmp" }, async () => {
        throw new Error("goal-x missing");
      }),
    ).toEqual([]);

    expect(
      await readGoalBaseSummaries({ cwd: "/tmp" }, async () =>
        facetFor(path.join(os.tmpdir(), "pi-openspec-x-does-not-exist")),
      ),
    ).toEqual([]);
  });
});

function createMessagePi(): {
  pi: { sendMessage: (message: unknown, options?: unknown) => void };
  sent: Array<{ message: { content: string }; options?: unknown }>;
} {
  const sent: Array<{ message: { content: string }; options?: unknown }> = [];
  return {
    sent,
    pi: {
      sendMessage(message: unknown, options?: unknown) {
        sent.push({ message: message as { content: string }, options });
      },
    },
  };
}

function sessionContext(root: string, sessionId: string) {
  return {
    cwd: root,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as Parameters<
    ReturnType<typeof createOpsxRecoverySessionStartHandler>
  >[1];
}

describe("createOpsxRecoverySessionStartHandler", () => {
  it("offers the recovery entry once per session for an unfinished opsx goal", async () => {
    const root = makeRoot();
    writeGoalFile(root, "active_goal_20260101_g1.md", {
      id: "g1",
      status: "paused",
      objective: 'Implement the OpenSpec change "change-a".',
    });
    const { pi, sent } = createMessagePi();
    const handler = createOpsxRecoverySessionStartHandler(pi, {
      loadGoalXStorage: async () => facetFor(root),
      changeId: "change-a",
    });

    await handler({} as never, sessionContext(root, "s1"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content).toContain("/goal-resume");

    // The notice is one-time per session.
    await handler({} as never, sessionContext(root, "s1"));
    expect(sent).toHaveLength(1);
  });

  it("stays silent when no unfinished opsx goal matches", async () => {
    const root = makeRoot();
    writeGoalFile(root, "active_goal_20260101_g1.md", {
      id: "g1",
      status: "complete",
      objective: 'Implement the OpenSpec change "change-a".',
    });
    const { pi, sent } = createMessagePi();
    const handler = createOpsxRecoverySessionStartHandler(pi, {
      loadGoalXStorage: async () => facetFor(root),
      changeId: "change-a",
    });

    await handler({} as never, sessionContext(root, "s2"));
    expect(sent).toEqual([]);
  });

  it("never throws when the goal base is unreadable", async () => {
    const { pi, sent } = createMessagePi();
    const handler = createOpsxRecoverySessionStartHandler(pi, {
      loadGoalXStorage: async () => {
        throw new Error("no goal-x");
      },
    });
    await handler({} as never, sessionContext("/tmp", "s3"));
    expect(sent).toEqual([]);
  });
});

describe("readArchivedGoals", () => {
  it("reads archived goal files with the status each was archived under", async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "archived"));
    writeGoalFile(path.join(root, "archived"), "goal_20260101_g1.md", {
      id: "g1",
      status: "complete",
      objective: 'Implement the OpenSpec change "change-a".',
    });
    // goal-x archives a manually cleared goal under its live status, so the
    // status distinguishes "finished" from "/goal-clear mid-flow".
    writeGoalFile(path.join(root, "archived"), "goal_20260102_g3.md", {
      id: "g3",
      status: "paused",
      objective: 'Implement the OpenSpec change "change-b".',
    });
    writeGoalFile(path.join(root, "archived"), "notes.md", "not a goal");
    writeGoalFile(root, "active_goal_20260101_g2.md", {
      id: "g2",
      status: "active",
      objective: "still active",
    });

    const archived = await readArchivedGoals({ cwd: root }, async () =>
      facetFor(root),
    );
    expect(archived).toEqual([
      { id: "g1", status: "complete" },
      { id: "g3", status: "paused" },
    ]);
  });

  it("degrades to an empty list without an archived directory", async () => {
    const root = makeRoot();
    expect(
      await readArchivedGoals({ cwd: root }, async () => facetFor(root)),
    ).toEqual([]);
  });
});

describe("readGoalTaskTree", () => {
  it("returns the active goal's task tree", async () => {
    const root = makeRoot();
    writeGoalFile(root, "active_goal_20260101_g1.md", {
      id: "g1",
      status: "active",
      objective: 'Implement the OpenSpec change "change-a".',
      taskList: {
        blockCompletion: true,
        tasks: [
          { id: "1.1", title: "First task", status: "pending" },
          {
            id: "1.2",
            title: "Second task",
            status: "complete",
            subtasks: [{ id: "1.2.1", title: "Nested", status: "pending" }],
          },
        ],
      },
    });

    const tasks = await readGoalTaskTree({ cwd: root }, "g1", async () =>
      facetFor(root),
    );
    expect(tasks).toEqual([
      { id: "1.1", title: "First task", status: "pending" },
      {
        id: "1.2",
        title: "Second task",
        status: "complete",
        subtasks: [{ id: "1.2.1", title: "Nested", status: "pending" }],
      },
    ]);
  });

  it("returns an empty list for a goal without a task tree and undefined for an unknown goal", async () => {
    const root = makeRoot();
    writeGoalFile(root, "active_goal_20260101_g1.md", {
      id: "g1",
      status: "active",
      objective: "no tasks",
    });

    expect(
      await readGoalTaskTree({ cwd: root }, "g1", async () => facetFor(root)),
    ).toEqual([]);
    // undefined = could not be read; callers must skip the reconciliation.
    expect(
      await readGoalTaskTree({ cwd: root }, "missing", async () =>
        facetFor(root),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when goal-x is missing or the root is unreadable", async () => {
    expect(
      await readGoalTaskTree({ cwd: "/tmp" }, "g1", async () => {
        throw new Error("goal-x missing");
      }),
    ).toBeUndefined();
    expect(
      await readGoalTaskTree({ cwd: "/tmp" }, "g1", async () =>
        facetFor(path.join(os.tmpdir(), "pi-openspec-x-nope")),
      ),
    ).toBeUndefined();
  });
});

describe("recovery re-installs the per-goal auditor override", () => {
  it("installs the override for every unfinished opsx goal", async () => {
    const root = makeRoot();
    writeGoalFile(root, "active_goal_20260101_g1.md", {
      id: "g1",
      status: "paused",
      objective: 'Implement the OpenSpec change "change-a".',
    });
    writeGoalFile(root, "active_goal_20260102_g2.md", {
      id: "g2",
      status: "active",
      objective: 'Implement the OpenSpec change "change-b".',
    });
    const installed: string[] = [];
    const { pi } = createMessagePi();
    const handler = createOpsxRecoverySessionStartHandler(pi, {
      loadGoalXStorage: async () => facetFor(root),
      installAuditor: (goalId) => installed.push(goalId),
    });

    await handler({} as never, sessionContext(root, "s9"));
    expect([...installed].sort()).toEqual(["g1", "g2"]);
  });

  it("does not install for a goal with nothing to resume", async () => {
    const root = makeRoot();
    writeGoalFile(root, "active_goal_20260101_g1.md", {
      id: "g1",
      status: "complete",
      objective: 'Implement the OpenSpec change "change-a".',
    });
    const installed: string[] = [];
    const { pi } = createMessagePi();
    const handler = createOpsxRecoverySessionStartHandler(pi, {
      loadGoalXStorage: async () => facetFor(root),
      installAuditor: (goalId) => installed.push(goalId),
    });

    await handler({} as never, sessionContext(root, "s10"));
    expect(installed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Design D6: the authoritative focus reader
// ---------------------------------------------------------------------------

describe("readFocusedGoalSnapshot (design D6)", () => {
  /**
   * The real goal-x helpers, with an optional override. Using the published
   * modules (rather than a reimplementation) is the point: the focus semantics
   * under test are goal-x's own.
   */
  async function realFocusLoader(
    overrides: Partial<GoalXFocusFacet> = {},
  ): Promise<GoalXFocusFacet> {
    const rootModule = await import(
      "@xzzpig/pi-goal-x/extensions/storage/goal-root.ts"
    );
    const filesModule = await import(
      "@xzzpig/pi-goal-x/extensions/storage/goal-files.ts"
    );
    const recordModule = await import(
      "@xzzpig/pi-goal-x/extensions/goal-record.ts"
    );
    const poolModule = await import(
      "@xzzpig/pi-goal-x/extensions/goal-pool.ts"
    );
    const settingsModule = await import(
      "@xzzpig/pi-goal-x/extensions/goal-settings.ts"
    );
    const real = {
      goalStorageRoot: rootModule.goalStorageRoot,
      parseGoalFile: filesModule.parseGoalFile,
      readActiveGoalPoolAsync: filesModule.readActiveGoalPoolAsync,
      normalizeGoalFocusEntry: recordModule.normalizeGoalFocusEntry,
      normalizeGoalRecord: recordModule.normalizeGoalRecord,
      resolveSessionFocus: poolModule.resolveSessionFocus,
      loadGoalSettings: settingsModule.loadGoalSettings,
    };
    return { ...real, ...overrides } as unknown as GoalXFocusFacet;
  }

  /** Write a canonical active goal file and return its absolute path. */
  function writeGoal(
    root: string,
    id: string,
    overrides: Record<string, unknown> = {},
  ): string {
    const goalRoot = path.join(root, ".pi", "goals");
    fs.mkdirSync(goalRoot, { recursive: true });
    const file = path.join(goalRoot, `active_goal_2026010112000000_${id}.md`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        id,
        objective: 'Implement the OpenSpec change "change-a".',
        status: "active",
        autoContinue: true,
        sisyphus: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        activePath: file,
        ...overrides,
      }),
    );
    return file;
  }

  function focusBranch(
    focusedGoalId: string | null,
    storageRoot?: string,
  ): unknown[] {
    return [
      {
        type: "custom",
        id: "focus-1",
        parentId: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        customType: "pi-goal-focus",
        data: {
          version: 1,
          ...(storageRoot ? { storageRoot } : {}),
          focusedGoalId,
          reason: "selected",
        },
      },
    ];
  }

  function focusContext(root: string, branch: unknown[]) {
    return {
      cwd: root,
      goalStorageRoot: path.join(root, ".pi", "goals"),
      sessionManager: {
        getSessionId: () => "s-focus",
        getLeafId: () => "focus-1",
        getBranch: () => branch,
      },
    };
  }

  it("a real focus entry selects the goal and reads its canonical record", async () => {
    const root = makeRoot();
    writeGoal(root, "g1");
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch("g1")),
      { loader: () => realFocusLoader() },
    );
    expect(snapshot.state).toBe("known-focused");
    expect(snapshot.goalId).toBe("g1");
    expect(snapshot.record?.objective).toContain("change-a");
    expect(snapshot.token.goalId).toBe("g1");
    expect(snapshot.token.focusEntryId).toBe("focus-1");
    expect(snapshot.token.branchGeneration).toBe("focus-1");
    expect(snapshot.token.storageRoot).toBe(path.join(root, ".pi", "goals"));
  });

  it("an explicit null focus never falls back to another goal", async () => {
    const root = makeRoot();
    writeGoal(root, "g1");
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch(null)),
      { loader: () => realFocusLoader() },
    );
    expect(snapshot.state).toBe("known-unfocused");
    expect(snapshot.token.goalId).toBeNull();
  });

  it("several goals without auto-select stay unfocused", async () => {
    const root = makeRoot();
    writeGoal(root, "g1");
    writeGoal(root, "g2");
    const snapshot = await readFocusedGoalSnapshot(focusContext(root, []), {
      loader: () => realFocusLoader(),
    });
    expect(snapshot.state).toBe("known-unfocused");
  });

  it("a single goal is auto-selected only when the setting is explicitly true", async () => {
    const root = makeRoot();
    writeGoal(root, "g1");

    const off = await readFocusedGoalSnapshot(focusContext(root, []), {
      loader: () => realFocusLoader(),
    });
    expect(off.state).toBe("known-unfocused");

    const on = await readFocusedGoalSnapshot(focusContext(root, []), {
      loader: () =>
        realFocusLoader({
          loadGoalSettings: () => ({ autoSelectSingleGoal: true }),
        }),
    });
    expect(on.state).toBe("known-focused");
    expect(on.goalId).toBe("g1");
  });

  it("a focus entry recorded against another storage root does not apply", async () => {
    const root = makeRoot();
    writeGoal(root, "g1");
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch("g1", "/somewhere/else/.pi/goals")),
      { loader: () => realFocusLoader() },
    );
    expect(snapshot.state).toBe("known-unfocused");
    expect(snapshot.token.goalId).toBeNull();
  });

  it("a newer real tool result covers a task change the file has not flushed", async () => {
    const root = makeRoot();
    writeGoal(root, "g1", { updatedAt: "2026-01-01T00:00:00.000Z" });
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch("g1")),
      {
        loader: () => realFocusLoader(),
        recentToolRecord: {
          goalId: "g1",
          toolCallId: "call-1",
          observedAt: "2026-01-01T02:00:00.000Z",
          record: {
            id: "g1",
            status: "active",
            objective: 'Implement the OpenSpec change "change-a".',
            updatedAt: "2026-01-01T01:30:00.000Z",
            taskList: {
              tasks: [{ id: "1.1", title: "t", status: "complete" }],
            },
          },
        },
      },
    );
    expect(snapshot.state).toBe("known-focused");
    expect(snapshot.record?.taskList?.tasks?.[0]?.status).toBe("complete");
  });

  it("an older tool result never overrides the newer canonical file", async () => {
    const root = makeRoot();
    writeGoal(root, "g1", { updatedAt: "2026-01-01T05:00:00.000Z" });
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch("g1")),
      {
        loader: () => realFocusLoader(),
        recentToolRecord: {
          goalId: "g1",
          toolCallId: "call-old",
          observedAt: "2026-01-01T01:00:00.000Z",
          record: {
            id: "g1",
            status: "active",
            objective: "stale",
            updatedAt: "2026-01-01T01:00:00.000Z",
          },
        },
      },
    );
    expect(snapshot.record?.objective).toContain("change-a");
  });

  it("the record is located by its known path, never by scanning the root", async () => {
    const root = makeRoot();
    const file = writeGoal(root, "g1");
    const probed: string[] = [];
    let poolReads = 0;
    const base = await realFocusLoader();
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch("g1")),
      {
        loader: async () => ({
          ...base,
          parseGoalFile: (filePath: string) => {
            probed.push(filePath);
            return base.parseGoalFile(filePath);
          },
          readActiveGoalPoolAsync: async (ctx) => {
            poolReads += 1;
            return base.readActiveGoalPoolAsync(ctx);
          },
        }),
      },
    );
    expect(snapshot.state).toBe("known-focused");
    expect(poolReads).toBe(1);
    expect(probed).toEqual([file]);
  });

  it("reports unknown instead of guessing when goal-x is unavailable", async () => {
    const root = makeRoot();
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch("g1")),
      {
        loader: async () => {
          throw new Error("goal-x missing");
        },
      },
    );
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.reason).toContain("unavailable");
  });

  it("reports unknown when the focused goal has no readable record", async () => {
    const root = makeRoot();
    const base = await realFocusLoader();
    const snapshot = await readFocusedGoalSnapshot(
      focusContext(root, focusBranch("g1")),
      {
        loader: async () => ({
          ...base,
          readActiveGoalPoolAsync: async () => new Map(),
          resolveSessionFocus: () => "g1",
        }),
      },
    );
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.reason).toContain("no readable record");
  });

  it("reading leaves every canonical goal file byte-identical", async () => {
    const root = makeRoot();
    const file = writeGoal(root, "g1");
    const before = fs.readFileSync(file);
    await readFocusedGoalSnapshot(focusContext(root, focusBranch("g1")), {
      loader: () => realFocusLoader(),
    });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("refreshGoalRecordByPath re-reads the known path without scanning", async () => {
    const root = makeRoot();
    const file = writeGoal(root, "g1");
    const refreshed = await refreshGoalRecordByPath(file, () =>
      realFocusLoader(),
    );
    expect(refreshed?.id).toBe("g1");

    const missing = await refreshGoalRecordByPath(
      path.join(root, "gone.md"),
      () => realFocusLoader(),
    );
    expect(missing).toBeUndefined();
  });
});
