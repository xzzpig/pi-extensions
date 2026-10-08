import { statusLabel } from "./goal-core.ts";
import { modelBudgetLine } from "./goal-accounting.ts";
import { detailedSummary } from "./goal-format.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalRecord } from "./goal-record.ts";
import { schedulerSummaryParts } from "./goal-scheduler-state.ts";
import { buildTaskSummary } from "./goal-policy.ts";
import { goalPromptParts } from "./prompts/goal-prompts.ts";

// Only new generation is formatted here. Existing session messages are not projected.
const CONTEXT_USAGE_GUARD =
  "Usage spans goal turns, not context. Latest snapshot supersedes earlier snapshots.";
type GoalPromptSettings = Parameters<typeof goalPromptParts>[1];

function effectiveBudget(budget: number | undefined): number | undefined {
  return typeof budget === "number" && Number.isFinite(budget) && budget > 0
    ? Math.floor(budget)
    : undefined;
}

/**
 * Main-model version of the live goal prompt. The existing formatter remains
 * available for compatibility, but the request path receives only execution
 * policy, real budget/run constraints, and actionable scheduling information.
 */
export function goalModelPromptParts(
  goal: GoalRecord,
  settings?: GoalPromptSettings,
): { state: string; counters?: string } {
  // Do not pass host context usage into the prompt formatter. Its returned
  // telemetry tail is intentionally discarded before it reaches retention.
  const parts = goalPromptParts(goal, settings);
  const guardAt = parts.state.lastIndexOf(CONTEXT_USAGE_GUARD);
  if (
    guardAt < 0 ||
    guardAt + CONTEXT_USAGE_GUARD.length !== parts.state.length
  ) {
    throw new Error(
      "Unable to isolate the generated goal telemetry suffix safely.",
    );
  }
  const generatedPrefix = parts.state.slice(0, guardAt);
  const limitsAt = generatedPrefix.lastIndexOf("\nLimits: ");
  if (limitsAt < 0)
    throw new Error("Unable to isolate the generated goal limits line safely.");
  const policy = generatedPrefix.slice(0, limitsAt);

  const constraints: string[] = [];
  const budgetCap = effectiveBudget(goal.tokenBudget);
  if (budgetCap !== undefined) {
    constraints.push(
      `Lifetime token budget cap: ${budgetCap} tokens (spending cap, not context capacity).`,
    );
  }
  const runLimit = settings?.maxAutonomousRuns;
  if (
    typeof runLimit === "number" &&
    Number.isSafeInteger(runLimit) &&
    runLimit >= 0
  ) {
    if (runLimit === 0) {
      constraints.push(
        "Automatic continuation is disabled by the configured zero run limit.",
      );
    } else {
      constraints.push(`Maximum autonomous runs: ${runLimit}.`);
    }
  }

  const { runs } = schedulerSummaryParts(
    goal.scheduler,
    runLimit,
    settings?.showAutonomousRuns,
  );
  const budgetSnapshot = modelBudgetLine(goal);
  const counters = [budgetSnapshot, runs].filter((line): line is string =>
    Boolean(line),
  );
  const snapshotKinds = [
    ...(budgetSnapshot ? ["Lifetime-budget"] : []),
    ...(runs ? ["Autonomous-run"] : []),
  ];
  const snapshotGuidance =
    snapshotKinds.length > 0
      ? `${snapshotKinds.join(" and ")} readings are cumulative across goal turns; the newest reading is current.`
      : undefined;
  const state = [policy, ...constraints, snapshotGuidance]
    .filter(Boolean)
    .join("\n");
  if (counters.length === 0) return { state };
  return { state, counters: counters.join("\n") };
}

/**
 * Project ledger events for a model-facing history. The detail-page formatter
 * only serializes/filter-by-goalId, so its caller accepts this projected data
 * as unknown; accounting and UI continue to use the authoritative event type.
 */
export function projectGoalModelLedgerEvents(
  events: readonly GoalLedgerEvent[],
  tokenBudget?: number,
): unknown[] {
  const keepBudgetUsage = effectiveBudget(tokenBudget) !== undefined;
  const projected: unknown[] = [];
  for (const event of events) {
    if (event.type === "audit_usage") continue;
    if (!keepBudgetUsage && event.type === "goal_budget_changed") {
      projected.push({
        type: event.type,
        goalId: event.goalId,
        oldBudget: event.oldBudget,
        newBudget: event.newBudget,
        at: event.at,
      });
      continue;
    }
    if (!keepBudgetUsage && event.type === "goal_budget_limited") {
      projected.push({
        type: event.type,
        goalId: event.goalId,
        budget: event.budget,
        at: event.at,
      });
      continue;
    }
    if (!keepBudgetUsage && event.type === "goal_budget_warning") {
      projected.push({
        type: event.type,
        goalId: event.goalId,
        budget: event.budget,
        at: event.at,
      });
      continue;
    }
    projected.push(event);
  }
  return projected;
}

/** Recent-event summaries show event kinds only; audit spend is never an execution event. */
export function excludeGoalModelAuditUsage(
  events: readonly GoalLedgerEvent[],
): GoalLedgerEvent[] {
  return events.filter((event) => event.type !== "audit_usage");
}

/** A model-facing detailed goal summary; authoritative UI/auditor formatters stay unchanged. */
export function goalModelDetailedSummary(goal: GoalRecord | null): string {
  if (!goal) return detailedSummary(null);
  const lines = [
    `Goal: ${goal.objective}`,
    `Status: ${statusLabel(goal)}`,
    `Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
  ];
  const budget = modelBudgetLine(goal);
  if (budget) lines.push(budget);
  if (goal.sisyphus)
    lines.push(
      "Mode: Sisyphus (prompt/criteria variant; shared goal lifecycle)",
    );
  if (goal.taskList) {
    lines.push(`Tasks: ${buildTaskSummary(goal.taskList)}`);
    const queue = [...(goal.taskList.tasks ?? [])];
    let firstPending: { id: string; title: string } | undefined;
    while (queue.length > 0 && !firstPending) {
      const task = queue.shift();
      if (!task) break;
      if (task.status === "pending") firstPending = task;
      else if (task.subtasks) queue.push(...task.subtasks);
    }
    if (firstPending)
      lines.push(
        `Next pending task: ${firstPending.id} — ${firstPending.title}`,
      );
  }
  if (goal.activePath) lines.push(`File: ${goal.activePath}`);
  if (goal.archivedPath) lines.push(`Archive: ${goal.archivedPath}`);
  if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`);
  if (goal.pauseReason) lines.push(`Agent pause reason: ${goal.pauseReason}`);
  if (goal.pauseSuggestedAction)
    lines.push(`Agent suggests: ${goal.pauseSuggestedAction}`);
  return lines.join("\n");
}

/** Remove only the plugin-generated audit-cost header, never report/findings text. */
export function goalModelAuditRejectionText(text: string): string {
  const prefix =
    "Goal audit rejected.\n\nGoal completion rejected by independent auditor.\n";
  if (!text.startsWith(prefix)) return text;
  const separator = text.indexOf("\n\n", prefix.length);
  if (separator < 0) return text;
  const header = text.slice(prefix.length, separator).split("\n");
  const projected = header.filter((line) => !line.startsWith("Audit cost: $"));
  return projected.length === header.length
    ? text
    : `${prefix}${projected.join("\n")}${text.slice(separator)}`;
}
