import type { AuditorProgress } from "../goal-auditor.ts";
import type {
  AuditorDashboardModel,
  DeriveAuditorDashboardOptions,
} from "./auditor-dashboard-model.ts";

/** Model reports are display data: never derive item states from percentage or verdict. */
export function deriveDynamicAuditorDashboardModel(
  progress: AuditorProgress,
  options: DeriveAuditorDashboardOptions = {},
): AuditorDashboardModel {
  const estimate = progress.percentage;
  return {
    auditorLabel:
      options.auditorLabel ?? progress.label ?? "Independent completion audit",
    elapsedMs: progress.elapsedMs,
    ...(estimate !== undefined && Number.isFinite(estimate)
      ? { percentage: Math.min(100, Math.max(0, Math.round(estimate))) }
      : {}),
    checks: (progress.checks ?? []).map((item) => ({ ...item })),
    progressDiagnostic: progress.progressDiagnostic,
    currentTool: progress.currentTool,
    currentToolArgs: progress.currentToolArgs,
    recentOutput: [...progress.recentOutput],
    ...(options.verdict ? { verdict: options.verdict } : {}),
    active: progress.phase !== "done",
  };
}
