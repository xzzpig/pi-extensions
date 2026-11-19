/* Isolated real Goal-X installation with deterministic, explicitly simulated audit progress. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import installGoal from "../../extensions/goal.ts";
import { createGoal } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { goalStorageContext } from "../../extensions/storage/goal-root.ts";
import { appendGoalEvent } from "../../extensions/goal-ledger.ts";
import type { GoalCore } from "../../extensions/goal-state.ts";

export default function (pi: ExtensionAPI): void {
  installGoal(pi);
  const core = (pi as ExtensionAPI & { _goalCore: GoalCore })._goalCore;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.cwd.startsWith("/tmp/pi-e2e-audit-mouse-"))
      throw new Error("audit fixture requires isolated cwd");
    mkdirSync(join(ctx.cwd, ".pi", "goals"), { recursive: true });
    const goal = createGoal({
      objective: "审计面板隔离验收",
      autoContinue: false,
      sisyphus: false,
    });
    goal.taskList = {
      tasks: [
        {
          id: "parent",
          title: "父任务",
          status: "pending",
          subtasks: [{ id: "child", title: "子任务", status: "pending" }],
        },
      ],
      blockCompletion: false,
      proposedAt: new Date().toISOString(),
    };
    goal.currentTaskId = "parent";
    const storage = goalStorageContext(ctx);
    const persisted = writeActiveGoalFile(storage, goal);
    const seeded = appendGoalEvent(storage, {
      type: "goal_created",
      goalId: goal.id,
      objective: goal.objective,
      sisyphus: false,
      autoContinue: false,
      at: new Date().toISOString(),
    });
    if (!seeded.ok) throw new Error("failed to seed fixture ledger");
    core.setGoal(persisted, ctx, false, "created");
    core.auditProgress = {
      attemptId: "fixture-attempt",
      phase: "running",
      elapsedMs: 12000,
      recentOutput: ["诊断行"],
      checks: Array.from({ length: 24 }, (_, i) => ({
        id: `check-${i}`,
        label: `审计检查 ${i}`,
        source: "extra" as const,
        state: i === 0 ? ("running" as const) : ("pending" as const),
        detail: i === 1 ? "中文依据详细内容".repeat(8) : undefined,
      })),
    };
    core.updateUI(ctx);
  });
  pi.registerCommand("audit-refresh", {
    description: "模拟同一审计进度刷新",
    handler: async (_args, ctx) => {
      if (core.auditProgress)
        core.auditProgress = { ...core.auditProgress, elapsedMs: 34000 };
      core.updateUI(ctx);
    },
  });
  pi.registerCommand("audit-next", {
    description: "模拟新 attempt",
    handler: async (_args, ctx) => {
      if (core.auditProgress)
        core.auditProgress = {
          ...core.auditProgress,
          attemptId: "fixture-next",
        };
      core.updateUI(ctx);
    },
  });
  pi.registerCommand("audit-card", {
    description: "模拟审计结束",
    handler: async (_args, ctx) => {
      core.auditProgress = null;
      core.setAuditResult("approved", "fixture result");
      core.updateUI(ctx);
    },
  });
  pi.registerCommand("audit-overlay", {
    description: "模拟前置浮层",
    handler: async (_args, ctx) => {
      await ctx.ui.custom(
        (_tui, _theme, _keys, done) => ({
          render: (width: number) =>
            Array.from({ length: 7 }, () => "OVERLAY AUDIT".padEnd(width)),
          handleInput: (data: string) => {
            if (data === "\u001b") done(undefined);
          },
          invalidate: () => {},
        }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            offsetY: 9,
            width: "80%",
            maxHeight: "50%",
          },
        },
      );
    },
  });
}
