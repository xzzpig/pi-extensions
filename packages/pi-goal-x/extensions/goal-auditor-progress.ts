import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REPORT_AUDITOR_PROGRESS_TOOL_NAME = "report_auditor_progress";
/**
 * Stable child-to-parent progress record carried in the tool-result text.
 * Delegation exposes currentToolArgs as a display preview rather than raw JSON.
 */
export const REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX = "pi-goal-x:audit-progress:v1:";

const reportAuditorProgressParams = Type.Object({
	label: Type.String({
		description: "Short description of the current completion-audit phase.",
	}),
	percentage: Type.Number({
		description: "Completion percentage for the current audit phase.",
		minimum: 0,
		maximum: 100,
	}),
}, { additionalProperties: false });

/**
 * Loaded only by the goal-auditor child. Structured delegation observes the
 * tool call and projects its arguments into Goal-X's five-stage dashboard.
 */
export default function goalAuditorProgressExtension(pi: ExtensionAPI): void {
	pi.registerTool(defineTool({
		name: REPORT_AUDITOR_PROGRESS_TOOL_NAME,
		label: "Report Auditor Progress",
		description: "Report a completion-audit phase and percentage to the parent goal dashboard.",
		promptSnippet: "Report the current completion-audit phase and percentage.",
		promptGuidelines: [
			"Use this at meaningful audit phase boundaries so the parent can show progress.",
			"This tool does not determine the verdict; submit the final verdict through structured_output.",
		],
		parameters: reportAuditorProgressParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const progress = { label: params.label, percentage: params.percentage };
			return {
				content: [{
					type: "text",
					text: `Progress reported: ${progress.label} (${progress.percentage}%)\n${REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX}${JSON.stringify(progress)}`,
				}],
				details: progress,
			};
		},
	}));
}
