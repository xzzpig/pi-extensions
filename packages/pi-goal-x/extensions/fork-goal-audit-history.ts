import type { GoalLedgerEvent } from "./goal-ledger.ts";

export type GoalAuditEvent = Extract<
  GoalLedgerEvent,
  { type: "audit_started" | "audit_result" | "audit_skipped" }
>;
export function auditApplies(
  latestId: string | undefined,
  event: GoalAuditEvent,
): boolean {
  return (
    event.type === "audit_started" ||
    (event.type === "audit_skipped" && event.reason === "disabled") ||
    latestId === undefined ||
    event.auditId === latestId
  );
}

export type GoalAuditTerminal = Exclude<
  GoalAuditEvent,
  { type: "audit_started" }
>;

export function validAcceptedAuditTerminal(
  value: unknown,
  goalId: string,
  isValidEvent: (value: unknown) => value is GoalLedgerEvent,
): boolean {
  return (
    value === undefined ||
    (isValidEvent(value) &&
      (value.type === "audit_result" || value.type === "audit_skipped") &&
      value.goalId === goalId)
  );
}

export type GoalAuditHistory = {
  audit?: GoalAuditEvent;
  acceptedAuditTerminal?: GoalAuditTerminal;
};

export function applyAuditEvent(
  history: GoalAuditHistory,
  event: GoalAuditEvent,
): void {
  if (!auditApplies(history.audit?.auditId, event)) return;
  history.audit = event;
  if (event.type !== "audit_started") history.acceptedAuditTerminal = event;
}

export function isAuditEvent(event: GoalLedgerEvent): event is GoalAuditEvent {
  return (
    event.type === "audit_started" ||
    event.type === "audit_result" ||
    event.type === "audit_skipped"
  );
}

export function goalAuditHistory(
  events: readonly GoalLedgerEvent[],
  goalId: string,
): GoalAuditHistory {
  const history: GoalAuditHistory = {};
  for (const event of events) {
    if (isAuditEvent(event) && event.goalId === goalId)
      applyAuditEvent(history, event);
  }
  return history;
}

export function goalAuditFailure(history: GoalAuditHistory | undefined) {
  const terminal = history?.acceptedAuditTerminal;
  if (terminal?.type !== "audit_result" || terminal.verdict === "approved")
    return undefined;
  return {
    verdict: terminal.verdict,
    report: terminal.report,
    at: terminal.at,
    historical: history?.audit?.type === "audit_started",
  };
}
