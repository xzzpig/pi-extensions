/**
 * Tests for `/opsx:rollback` delegating to goal-x's rollback module
 * (spec: REJECT 回滚带备份; task 11.1).
 */
import { describe, expect, it } from "vitest";

import type { GoalBaseSummary } from "../src/flow-recovery.ts";
import { registerRollbackFlow } from "../src/rollback-command.ts";
import type { ReviewWindowDelta } from "../src/review-scope.ts";

const GOALS: GoalBaseSummary[] = [
  {
    id: "goal-1",
    status: "active",
    objective: 'Implement the OpenSpec change "change-a".',
  },
];

const DELTA: ReviewWindowDelta = {
  goalId: "goal-1",
  empty: false,
  truncated: false,
  diagnostics: [],
  repos: [
    {
      root: "/repo",
      base: "abc123",
      baseKind: "stash",
      entries: [{ path: "src/a.ts", status: "modified", code: "M" }],
    },
  ],
};

const CTX = {
  cwd: "/tmp",
  sessionManager: { getSessionId: () => "s1" },
};

function createPi() {
  const sent: Array<{ content: string }> = [];
  let stored: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerCommand(
      _name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      stored = options.handler;
    },
    sendMessage(message: { content: string }) {
      sent.push(message);
    },
    appendEntry() {},
  };
  return { pi, sent, handler: () => stored };
}

describe("registerRollbackFlow", () => {
  it("degrades when the change has no opsx goal", async () => {
    const { pi, sent, handler } = createPi();
    registerRollbackFlow(pi as never, {
      readGoals: async () => [],
      readDelta: async () => DELTA,
    });
    await handler()!("change-a", CTX as never);
    expect(sent.at(-1)?.content).toContain("No opsx goal in the active base");
  });

  it("degrades when the window delta is unavailable", async () => {
    const { pi, sent, handler } = createPi();
    registerRollbackFlow(pi as never, {
      readGoals: async () => GOALS,
      readDelta: async () => undefined,
    });
    await handler()!("change-a", CTX as never);
    expect(sent.at(-1)?.content).toContain(
      "no baseline commit to roll back to",
    );
    expect(sent.at(-1)?.content).toContain("Nothing was changed");
  });

  it("degrades when the goal-x rollback module cannot be loaded", async () => {
    const { pi, sent, handler } = createPi();
    registerRollbackFlow(pi as never, {
      readGoals: async () => GOALS,
      readDelta: async () => DELTA,
      rollbackModule: async () => {
        throw new Error("boom");
      },
    });
    await handler()!("change-a", CTX as never);
    expect(sent.at(-1)?.content).toContain("could not be loaded");
    expect(sent.at(-1)?.content).toContain("Nothing was changed");
  });

  it("delegates plan -> backup -> execute and reports via the facet", async () => {
    const { pi, sent, handler } = createPi();
    const calls: string[] = [];
    registerRollbackFlow(pi as never, {
      readGoals: async () => GOALS,
      readDelta: async () => DELTA,
      rollbackModule: async () => ({
        planRollback: () => {
          calls.push("plan");
          return {
            goalId: "goal-1",
            repos: [{ base: "abc123", baseKind: "stash" }],
            restoreCount: 1,
            deleteCount: 0,
            unrecoverableCount: 0,
          };
        },
        writeRollbackBackup: async () => {
          calls.push("backup");
          return { ok: true, dir: "/archive/rollback_dir", bytes: 42 };
        },
        executeRollback: async () => {
          calls.push("execute");
          return [{ restored: 1, deleted: 0, failures: [] }];
        },
        formatRollbackReport: (_plan, _results, dir) =>
          `Rolled back 1 file(s). Backup: ${dir}`,
      }),
    });
    await handler()!("change-a", CTX as never);
    expect(calls).toEqual(["plan", "backup", "execute"]);
    expect(sent.at(-1)?.content).toContain(
      "Rolled back 1 file(s). Backup: /archive/rollback_dir",
    );
  });

  it("aborts before touching the worktree when the backup fails", async () => {
    const { pi, sent, handler } = createPi();
    let executed = false;
    registerRollbackFlow(pi as never, {
      readGoals: async () => GOALS,
      readDelta: async () => DELTA,
      rollbackModule: async () => ({
        planRollback: () => ({
          goalId: "goal-1",
          repos: [{ base: "abc123", baseKind: "stash" }],
          restoreCount: 1,
          deleteCount: 0,
          unrecoverableCount: 0,
        }),
        writeRollbackBackup: async () => ({
          ok: false,
          dir: null,
          reason: "disk full",
          bytes: 0,
        }),
        executeRollback: async () => {
          executed = true;
          return [];
        },
        formatRollbackReport: () => "",
      }),
    });
    await handler()!("change-a", CTX as never);
    expect(executed).toBe(false);
    expect(sent.at(-1)?.content).toContain("backup could not be written");
    expect(sent.at(-1)?.content).toContain("Nothing was changed");
  });

  it("sends a usage notice for a blank change id", async () => {
    const { pi, sent, handler } = createPi();
    registerRollbackFlow(pi as never, {});
    await handler()!("", { cwd: "/tmp" } as never);
    expect(sent.at(-1)?.content).toContain("Usage: /opsx:rollback");
  });
});
