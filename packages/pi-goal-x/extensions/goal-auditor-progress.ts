import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import {
  AUDIT_PROGRESS_V2_PREFIX,
  AUDIT_PROGRESS_MAX_BYTES,
  AUDIT_PROGRESS_MAX_DETAIL,
  type AuditItemUpdate,
} from "./fork-audit-progress.ts";

export const REPORT_AUDITOR_PROGRESS_TOOL_NAME = "report_auditor_progress";
/** Legacy records remain readable for custom auditors. */
export const REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX =
  "pi-goal-x:audit-progress:v1:";

const percentage = Type.Number({ minimum: 0, maximum: 100 });
export const reportAuditorProgressParams = Type.Union([
  Type.Object(
    {
      label: Type.String({
        description: "Short description of the current audit phase.",
      }),
      percentage,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      checkId: Type.String({
        minLength: 1,
        maxLength: 80,
        description: "Exact checkId from this audit's supplied checklist.",
      }),
      state: Type.Union([
        Type.Literal("pending"),
        Type.Literal("running"),
        Type.Literal("passed"),
        Type.Literal("failed"),
      ]),
      detail: Type.Optional(
        Type.String({
          maxLength: AUDIT_PROGRESS_MAX_DETAIL,
          description:
            "Brief evidence or missing requirement; not a final verdict.",
        }),
      ),
      label: Type.Optional(Type.String({ maxLength: 160 })),
      percentage: Type.Optional(percentage),
    },
    { additionalProperties: false },
  ),
]);

/** Child-only provider. Sequence is owned by this audit child, never model supplied. */
export default function goalAuditorProgressExtension(
  pi: Pick<ExtensionAPI, "registerTool">,
): void {
  let sequence = 0;
  pi.registerTool(
    defineTool({
      name: REPORT_AUDITOR_PROGRESS_TOOL_NAME,
      label: "Report Auditor Progress",
      description:
        "Report a supplied completion-audit checklist item's state and brief evidence to the parent dashboard; legacy phase estimates remain supported.",
      promptSnippet:
        "Report checklist progress using checkId, state and optional detail.",
      promptGuidelines: [
        "Use the supplied checklist IDs; report running before checking and passed or failed with brief evidence after checking. Recheck when needed.",
        "Do not add or rename checklist items. Legacy label/percentage only reports an estimate, not item completion.",
        "This tool does not determine the verdict; submit the final verdict through structured_output.",
      ],
      parameters: reportAuditorProgressParams,
      executionMode: "sequential",
      async execute(
        _toolCallId,
        params,
      ): Promise<
        AgentToolResult<AuditItemUpdate | { label: string; percentage: number }>
      > {
        if ("checkId" in params) {
          if (
            params.detail !== undefined &&
            [...params.detail].length > AUDIT_PROGRESS_MAX_DETAIL
          )
            throw new Error("Audit progress detail exceeds its limit.");
          const progress = { sequence: sequence + 1, ...params };
          const record = JSON.stringify(progress);
          if (Buffer.byteLength(record, "utf8") > AUDIT_PROGRESS_MAX_BYTES)
            throw new Error("Audit progress record exceeds its limit.");
          sequence += 1;
          return {
            content: [
              { type: "text", text: `${AUDIT_PROGRESS_V2_PREFIX}${record}` },
            ],
            details: progress,
          };
        }
        // Preserve the exact old tool result for existing custom-agent integrations.
        const progress = { label: params.label, percentage: params.percentage };
        return {
          content: [
            {
              type: "text",
              text: `Progress reported: ${progress.label} (${progress.percentage}%)\n${REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX}${JSON.stringify(progress)}`,
            },
          ],
          details: progress,
        };
      },
    }),
  );
}
