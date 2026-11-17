import type {
  AuditItemProgress,
  AuditItemState,
} from "./fork-audit-checklist.ts";

export const AUDIT_PROGRESS_V2_PREFIX = "pi-goal-x:audit-progress:v2:";
export const AUDIT_PROGRESS_MAX_BYTES = 4096;
export const AUDIT_PROGRESS_MAX_DETAIL = 512;
export const AUDIT_PROGRESS_STATES = [
  "pending",
  "running",
  "passed",
  "failed",
] as const;

export interface AuditItemUpdate {
  sequence: number;
  checkId: string;
  state: AuditItemState;
  detail?: string;
  label?: string;
  percentage?: number;
}

/** Decode only the bounded tool-result record, never display-preview arguments. */
function decode(text: string): AuditItemUpdate | undefined {
  if (Buffer.byteLength(text, "utf8") > AUDIT_PROGRESS_MAX_BYTES)
    return undefined;
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || Array.isArray(record))
    return undefined;
  const row = record as Record<string, unknown>;
  if (!Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1)
    return undefined;
  if (
    typeof row.checkId !== "string" ||
    !row.checkId.length ||
    row.checkId.length > 80
  )
    return undefined;
  if (!AUDIT_PROGRESS_STATES.some((state) => state === row.state))
    return undefined;
  if (
    row.detail !== undefined &&
    (typeof row.detail !== "string" ||
      [...row.detail].length > AUDIT_PROGRESS_MAX_DETAIL)
  )
    return undefined;
  if (row.label !== undefined && typeof row.label !== "string")
    return undefined;
  if (
    row.percentage !== undefined &&
    (typeof row.percentage !== "number" ||
      !Number.isFinite(row.percentage) ||
      row.percentage < 0 ||
      row.percentage > 100)
  )
    return undefined;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "sequence",
          "checkId",
          "state",
          "detail",
          "label",
          "percentage",
        ].includes(key),
    )
  )
    return undefined;
  // All accepted fields have been narrowed above; discard unknown input at the boundary.
  return {
    sequence: Number(row.sequence),
    checkId: row.checkId,
    state: row.state as AuditItemState,
    ...(row.detail !== undefined ? { detail: row.detail as string } : {}),
    ...(row.label !== undefined ? { label: row.label as string } : {}),
    ...(row.percentage !== undefined
      ? { percentage: row.percentage as number }
      : {}),
  };
}

export interface AuditProgressTarget {
  checks?: AuditItemProgress[];
  phase: string;
  label?: string;
  percentage?: number;
  progressDiagnostic?: string;
}

/** One reducer per attempt; callers retain their existing request/owner/node filtering. */
export function createAuditProgressReducer() {
  let sequence = 0;
  return (target: AuditProgressTarget, lines: readonly string[]): void => {
    if (target.phase === "done") return;
    const updates: AuditItemUpdate[] = [];
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith(AUDIT_PROGRESS_V2_PREFIX)) continue;
      const update = decode(text.slice(AUDIT_PROGRESS_V2_PREFIX.length));
      if (!update) {
        target.progressDiagnostic = "Ignored invalid audit progress record.";
        continue;
      }
      updates.push(update);
    }
    updates.sort((a, b) => a.sequence - b.sequence);
    for (const update of updates) {
      if (update.sequence <= sequence) continue;
      sequence = update.sequence;
      if (!target.checks?.some((item) => item.id === update.checkId)) {
        target.progressDiagnostic =
          "Ignored audit progress for an unknown checklist item.";
        continue;
      }
      target.checks = target.checks.map((item) =>
        item.id === update.checkId
          ? {
              ...item,
              state: update.state,
              detail: update.detail,
              sequence: update.sequence,
            }
          : item,
      );
      if (update.label !== undefined) target.label = update.label;
      if (update.percentage !== undefined)
        target.percentage = update.percentage;
    }
  };
}
