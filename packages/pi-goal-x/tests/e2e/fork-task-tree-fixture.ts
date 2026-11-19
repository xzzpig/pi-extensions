/* Test-only bridge: install the real extension and drive its core in a throwaway session. */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import installGoal from "../../extensions/goal.ts";
import { createGoal, cloneGoal } from "../../extensions/goal-record.ts";
import type { GoalCore } from "../../extensions/goal-state.ts";

export default function (pi: ExtensionAPI): void {
  installGoal(pi);
  const core = (pi as ExtensionAPI & { _goalCore: GoalCore })._goalCore;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.cwd.startsWith("/tmp/pi-e2e-goal-tree-"))
      throw new Error("fixture requires isolated /tmp/pi-e2e-goal-tree-* cwd");
    mkdirSync(join(ctx.cwd, ".pi", "goals"), { recursive: true });
    const goal = createGoal({
      objective: "任务树隔离验收",
      autoContinue: false,
      sisyphus: false,
    });
    goal.taskList = {
      tasks: Array.from({ length: 24 }, (_, i) => ({
        id: `t${i}`,
        title: `任务 ${i}`,
        status: "pending" as const,
        ...(i === 17
          ? {
              subtasks: [
                { id: "child", title: "子任务", status: "pending" as const },
              ],
            }
          : {}),
      })),
      blockCompletion: false,
      proposedAt: new Date().toISOString(),
    };
    goal.currentTaskId = "child";
    core.setGoal(goal, ctx, false, "created");
  });
  const change = (ctx: ExtensionContext, id: string): void => {
    if (!core.state.goal) throw new Error("fixture goal missing");
    const goal = cloneGoal(core.state.goal);
    goal.currentTaskId = id;
    core.setGoal(goal, ctx, false);
  };
  pi.registerCommand("fixture-next", {
    description: "测试：切换到任务 t23",
    handler: async (_args, ctx) => change(ctx, "t23"),
  });
  pi.registerCommand("fixture-back", {
    description: "测试：切换回子任务",
    handler: async (_args, ctx) => change(ctx, "child"),
  });
  pi.registerCommand("fixture-audit", {
    description: "测试：展示审计视图",
    handler: async (_args, ctx) => {
      core.auditProgress = { phase: "running", elapsedMs: 0, recentOutput: [] };
      core.updateUI(ctx);
    },
  });
  pi.registerCommand("fixture-audit-end", {
    description: "测试：结束审计视图",
    handler: async (_args, ctx) => {
      core.auditProgress = null;
      core.updateUI(ctx);
    },
  });
  pi.registerCommand("fixture-card", {
    description: "测试：模拟结果卡",
    handler: async (_args, ctx) => {
      core.setAuditResult("approved", "fixture result");
      core.updateUI(ctx);
    },
  });
  pi.registerCommand("fixture-overlay", {
    description: "测试：打开覆盖层",
    handler: async (_args, ctx) => {
      await ctx.ui.custom(
        (_tui, _theme, _keys, done) => ({
          render: (width: number) =>
            Array.from({ length: 7 }, () =>
              "OVERLAY BLOCKS TASK INPUT".padEnd(width),
            ),
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
