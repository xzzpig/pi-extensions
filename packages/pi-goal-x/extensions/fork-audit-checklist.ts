import type { GoalRecord } from "./goal-record.ts";
import type { GoalSettings } from "./goal-settings.ts";

export type AuditItemState = "pending" | "running" | "passed" | "failed";
export interface AuditChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly source: "default" | "checklist" | "extra";
}
export type AuditChecklist = readonly Readonly<AuditChecklistItem>[];
export interface AuditItemProgress extends AuditChecklistItem {
  state: AuditItemState;
  detail?: string;
  sequence?: number;
}

/** One immutable snapshot per attempt. Keep these default texts aligned with the audit contract. */
export function buildAuditChecklist(args: {
  goal: Pick<GoalRecord, "verificationContract">;
  settings?: GoalSettings;
  changeManifest?: string | null;
}): AuditChecklist {
  const auditor = args.settings?.auditor;
  const defaults: Array<[number, string]> = [
    [
      1,
      "Extract the real success criteria from the objective, including quality and reader outcomes.",
    ],
    [
      2,
      "Inspect artifacts or command output that can prove or disprove those criteria. Treat the executor claim as an untrusted assertion and cross-check it with actual file/shell evidence — a claim alone is never proof.",
    ],
    ...(!args.settings?.disableContracts &&
    args.goal.verificationContract?.trim()
      ? [
          [
            3,
            "Verify every item in the verification contract. If any item is missing or weakly addressed, disapprove.",
          ] as [number, string],
        ]
      : []),
    [
      4,
      "Explain missing or weak evidence, especially scaffold-versus-final quality gaps.",
    ],
    ...(args.changeManifest?.trim()
      ? [
          [
            5,
            "Cross-check the workspace change manifest entries against the actual repository content: machine-collected evidence is not proof and never substitutes for verification.",
          ] as [number, string],
        ]
      : []),
  ];
  const main: AuditChecklistItem[] =
    auditor?.checklist !== undefined
      ? auditor.checklist.map((label, index) => ({
          id: `checklist-${index + 1}`,
          label,
          source: "checklist",
        }))
      : defaults.map(([id, label]) => ({
          id: `default-${id}`,
          label,
          source: "default",
        }));
  const extra: AuditChecklistItem[] = (auditor?.checklistExtra ?? []).map(
    (label, index) => ({
      id: `extra-${index + 1}`,
      label,
      source: "extra",
    }),
  );
  return Object.freeze([...main, ...extra].map((item) => Object.freeze(item)));
}

function escapePayload(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function auditChecklistPromptLines(
  checklist: AuditChecklist,
  extra = false,
): string[] {
  const items = checklist.filter((item) => (item.source === "extra") === extra);
  return items.map((item, index) => {
    const number =
      item.source === "default" ? item.id.slice("default-".length) : index + 1;
    return `${number}. ${escapePayload(item.label)} [checkId=${item.id}]`;
  });
}

export function auditChecklistExtraPromptLines(
  checklist: AuditChecklist,
): string[] {
  const lines = auditChecklistPromptLines(checklist, true);
  return lines.length
    ? [
        "",
        "Additional audit checks required by operator configuration:",
        ...lines,
      ]
    : [];
}

export function initialAuditChecks(
  checklist: AuditChecklist,
): AuditItemProgress[] {
  return checklist.map((item) => ({ ...item, state: "pending" }));
}
