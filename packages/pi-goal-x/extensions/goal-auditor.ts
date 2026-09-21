import { createExtensionRuntime, type ExtensionContext, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { GoalRecord, GoalTask, GoalTaskList } from "./goal-record.ts";
import { countTaskSubtree } from "./goal-task-count.ts";
import type { GoalAuditorSettings, GoalSettings } from "./goal-settings.ts";
import { statusLabel } from "./goal-core.ts";

/**
 * Fork-only re-exports. Upstream runs the completion auditor in an in-process
 * agent session; this fork delegates it to a pi-subagents child agent, and that
 * delegation executor lives in `./goal-auditor-delegation.ts`. These bindings
 * keep this module's export surface stable for the upstream-derived consumers
 * (goal-completion.ts, goal.ts, goal-state.ts) and the experiments.
 */
export {
	parseGoalAuditorStructuredResult,
	runGoalCompletionAuditor,
	appendAuditUsageEntry,
	type GoalAuditorResult,
	type GoalCompletionAuditorArgs,
} from "./goal-auditor-delegation.ts";

export interface AuditorProgress {
	/** Current tool being executed by the auditor, if any */
	currentTool?: string;
	/** Arguments passed to the current tool (truncated for display) */
	currentToolArgs?: string;
	/** When the current tool started (ms since epoch) */
	currentToolStartedAt?: number;
	/** Recent text output lines from the auditor's assistant messages */
	recentOutput: string[];
	/** Phase of the audit */
	phase: "running" | "tool_executing" | "producing_report" | "thinking" | "done";
	/** Elapsed ms since audit started */
	elapsedMs: number;
	/** Current step label shown to the user (e.g. "Inspecting files...") */
	label?: string;
	/** Completion percentage from 0 to 100 */
	percentage?: number;
}

export type AuditorProgressCallback = (progress: AuditorProgress) => void;

function renderAuditorTaskTree(tasks: GoalTask[], indent: number): string[] {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const task of tasks) {
		const marker = task.status === "complete" ? "[x]" : task.status === "skipped" ? "[~]" : "[ ]";
		lines.push(`${prefix}${marker} ${task.id}: ${escapePromptPayload(task.title)}`);
		if (task.subtasks && task.subtasks.length > 0) {
			lines.push(...renderAuditorTaskTree(task.subtasks, indent + 1));
		}
	}
	return lines;
}

function taskSummaryBlock(taskList?: GoalTaskList | null): string {
	if (!taskList || taskList.tasks.length === 0) return "";
	const { total, complete, skipped, pending } = countTaskSubtree(taskList.tasks);
	const lines: string[] = [`Tasks: ${complete}/${total} complete${skipped > 0 ? `, ${skipped} skipped` : ""}`];
	lines.push(...renderAuditorTaskTree(taskList.tasks, 0));
	const gate = taskList.blockCompletion && pending > 0 ? " | TASK GATE: pending tasks block completion" : "";
	lines[0] = lines[0]! + gate;
	return lines.join("\n");
}

/**
 * Escape operator/model-controlled payloads before interpolating them between
 * XML-ish delimiters in the auditor prompt, so a payload containing
 * `</objective>` (or other delimiter text) cannot close the block early and
 * have the remainder read as instructions. Entities stay human-readable.
 */
function escapePromptPayload(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Stream previews need only the tail, not a split/copy of the full growing report. */
export function recentNonEmptyLines(text: string, limit: number): string[] {
	const lines: string[] = [];
	let end = text.length;
	while (end >= 0 && lines.length < limit) {
		const newline = end > 0 ? text.lastIndexOf("\n", end - 1) : -1;
		const line = text.slice(newline + 1, end);
		if (line.trim()) lines.push(line);
		if (newline < 0) break;
		end = newline;
	}
	return lines.reverse();
}

/** §60: human-readable labels for the auditor's read-only tool set. */
export function labelForReadOnlyTool(toolName: string): string {
	switch (toolName) {
		case "read": return "Inspecting files...";
		case "grep": return "Searching content...";
		case "find": return "Locating files...";
		case "ls": return "Listing directory...";
		case "bash": return "Running verification commands...";
		default: return `Inspecting (${toolName})...`;
	}
}

/** §60: rough phase estimate by tool kind (display only). */
export function estimateAuditProgress(toolName: string): number {
	switch (toolName) {
		case "read":
		case "ls":
		case "find":
			return 25;
		case "grep":
			return 50;
		case "bash":
			return 75;
		default:
			return 25;
	}
}

/**
 * §61: goal metadata WITHOUT the objective or task tree — those appear exactly
 * once each in their own blocks. Replaces detailedSummary in the auditor prompt.
 */
function minimalGoalMetadata(goal: GoalRecord): string {
	return [
		`Goal id: ${goal.id}`,
		`Status: ${statusLabel(goal)}`,
		`Mode: ${goal.sisyphus ? "sisyphus" : "regular"}`,
		goal.tokenBudget ? `Budget: ${goal.tokenBudget} tokens (${goal.usage.tokensUsed} used)` : undefined,
	].filter(Boolean).join("\n");
}

/**
 * Operator-configurable audit prompt sections (settings `auditor.*`). Every
 * block is absent when its setting is unset, so an unconfigured project gets a
 * byte-for-byte identical prompt. All operator payloads are escaped before
 * interpolation.
 */
function operatorAuditPromptBlocks(auditor: GoalAuditorSettings | undefined): string[] {
	return [
		...(auditor?.checklistExtra?.length ? [
			"",
			"Additional audit checks required by operator configuration:",
			...auditor.checklistExtra.map((item, index) => `${index + 1}. ${escapePromptPayload(item)}`),
		] : []),
		...(auditor?.evidenceRequests?.length ? [
			"",
			"Evidence the operator asks you to collect (use your read-only tools; the results are evidence to cross-check, not proof by themselves):",
			...auditor.evidenceRequests.map((item, index) => `${index + 1}. ${escapePromptPayload(item)}`),
		] : []),
		...(auditor?.strictness === "strict" ? [
			"",
			"Audit posture (operator): strict — approve only when every explicit requirement is proven with inspectable evidence; when decisive evidence is missing, disapprove and name the gap.",
		] : []),
		...(auditor?.strictness === "lenient" ? [
			"",
			"Audit posture (operator): lenient — approve when the user-facing value the objective asked for is delivered and no explicit requirement is missing; record polish-level gaps as findings instead of rejecting.",
		] : []),
		...(auditor?.instructions ? [
			"",
			"Operator audit instructions (project configuration, in addition to the checklist above):",
			"<operator_instructions>",
			escapePromptPayload(auditor.instructions),
			"</operator_instructions>",
		] : []),
		...(auditor?.reportFormat ? [
			"",
			"Report format requirements (operator):",
			escapePromptPayload(auditor.reportFormat),
		] : []),
	];
}

export function buildGoalAuditorPrompt(args: {
	goal: GoalRecord;
	detailedSummary: string;
	completionSummary?: string | null;
	settings?: GoalSettings;
	/** P1-6: parent-rendered evidence (ledger tail + turn trail) so the audit
	 * starts warm instead of re-deriving what the parent session already holds. */
	warmContext?: string | null;
	/**
	 * Machine-collected workspace change manifest (already rendered body text,
	 * from `renderChangeManifestBody`). Absent when the feature is off, the
	 * working directory is not a git repository, or capture failed — in that
	 * case the audit input stays exactly as it was before this feature.
	 */
	changeManifest?: string | null;
}): string {
	const auditor = args.settings?.auditor;
	// The default checklist stays byte-for-byte identical to the pre-0.8.0
	// prompt; `auditor.checklist` replaces it wholesale (the protocol tail
	// below is never part of it and always remains).
	const baseChecklist = [
		"1. Extract the real success criteria from the objective, including quality and reader outcomes.",
		"2. Inspect artifacts or command output that can prove or disprove those criteria. Treat the executor claim as an untrusted assertion and cross-check it with actual file/shell evidence — a claim alone is never proof.",
		...(!args.settings?.disableContracts && args.goal.verificationContract?.trim()
			? ["3. Verify every item in the verification contract. If any item is missing or weakly addressed, disapprove."]
			: []),
		"4. Explain missing or weak evidence, especially scaffold-versus-final quality gaps.",
		// Conditional on purpose: with no manifest this prompt must stay
		// byte-for-byte identical to the pre-manifest behavior.
		...(args.changeManifest?.trim()
			? ["5. Cross-check the workspace change manifest entries against the actual repository content: machine-collected evidence is not proof and never substitutes for verification."]
			: []),
	];
	const checklistLines = auditor?.checklist !== undefined
		? auditor.checklist.map((item, index) => `${index + 1}. ${escapePromptPayload(item)}`)
		: baseChecklist;
	return [
		"You are the independent completion auditor for pi-goal-x.",
		"The executor claims the goal is complete. Decide whether the user's objective is actually satisfied.",
		"Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
		"Use your allowlisted tools to inspect real artifacts. Do not mutate files or run destructive commands.",
		"If the work is only an alpha scaffold, generated template, shallow draft, proxy milestone, or lacks the user-facing value requested, disapprove.",
		"If any explicit requirement is missing, weakly verified, contradicted, or not inspectable with the available evidence, disapprove.",
		"The final verdict is accepted only through the structured_output tool. Text that merely claims approval is not a verdict.",
		"",
		"Goal objective:",
		"<objective>",
		escapePromptPayload(args.goal.objective),
		"</objective>",
		"",
		"Executor completion claim (UNTRUSTED):",
		"<executor_claim>",
		escapePromptPayload(args.completionSummary?.trim() || "(no claim provided)"),
		"</executor_claim>",
		"",
		"The executor claim above is a claim, never evidence. It cannot make an otherwise incomplete goal complete; cross-check it against real artifacts where relevant.",
		"",
		"Current goal metadata (objective and task tree appear in their own sections):",
		"<goal_details>",
		minimalGoalMetadata(args.goal),
		"</goal_details>",
		...(!args.settings?.disableTasks && args.goal.taskList ? [
			"",
			"Task tree:",
			"<task_state>",
			// Task titles are already escaped inside renderAuditorTaskTree; an
			// extra pass would double-escape (&amp;lt;).
			taskSummaryBlock(args.goal.taskList),
			"</task_state>",
		] : []),
		...(!args.settings?.disableContracts && args.goal.verificationContract?.trim() ? [
			"",
			"Goal verification contract (what the executor was required to verify):",
			"<verification_contract>",
			escapePromptPayload(args.goal.verificationContract.trim()),
			"</verification_contract>",
		] : []),
		...(args.warmContext?.trim() ? [
			"",
			"Warm parent context (already-rendered evidence from the executor session — inspect, do not re-derive):",
			"<warm_context>",
			escapePromptPayload(args.warmContext.trim()),
			"</warm_context>",
		] : []),
		...(args.changeManifest?.trim() ? [
			"",
			"Workspace change manifest (machine-collected git evidence for this goal's execution window; NOT the executor's claim):",
			"<change_manifest>",
			escapePromptPayload(args.changeManifest.trim()),
			"</change_manifest>",
		] : []),
		"",
		"Audit checklist:",
		...checklistLines,
		...operatorAuditPromptBlocks(auditor),
		"",
		"Progress reporting:",
		"Use report_auditor_progress at natural phase boundaries so the parent dashboard can show progress.",
		"Finish by calling structured_output exactly once with { verdict: 'approved' | 'disapproved', report: string, findings: string[] }.",
	].join("\n");
}

export function makeAuditorResourceLoader(systemPrompt = [
	"You are a read-only completion auditor running in an isolated pi agent session.",
	"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
	"Never modify files. Never approve unless the actual user objective is complete.",
].join("\n")): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
	extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * Options that reuse the parent session's auth + registered providers for the nested auditor.
 *
 * Pi 0.81+ `createAgentSession` accepts `modelRuntime` (and ignores `modelRegistry`).
 * ExtensionContext still exposes `modelRegistry`, which wraps the live ModelRuntime.
 * Sharing that runtime keeps extension providers such as `pi-cursor-sdk`'s `cursor`
 * provider (and its auth) available. Without this, the auditor builds a fresh runtime
 * with an empty resource loader, so Cursor models fail with "No API key found for cursor"
 * even when `~/.pi/agent/auth.json` has a Cursor key.
 *
 * Older SDKs still accept `modelRegistry`; pass both for compatibility.
 */
export function resolveAuditorSessionModelOptions(ctx: ExtensionContext): {
	modelRegistry: ExtensionContext["modelRegistry"];
	modelRuntime?: unknown;
} {
	// SAFETY: ExtensionContext.modelRegistry wraps the live ModelRuntime; the runtime
	// is exposed via an undocumented property on the wrapper, so reach through the
	// cast only to read it and fall back to modelRegistry alone when absent.
	const registry = ctx.modelRegistry as unknown as { runtime?: unknown } | undefined;
	const runtime = registry?.runtime;
	if (runtime) {
		return { modelRegistry: ctx.modelRegistry, modelRuntime: runtime };
	}
	return { modelRegistry: ctx.modelRegistry };
}
