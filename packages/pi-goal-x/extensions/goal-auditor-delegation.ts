// Fork-only module. The upstream completion auditor runs in an in-process
// agent session; this fork instead delegates the audit to a pi-subagents child
// agent. Everything here is that delegation machinery, moved verbatim out of
// `./goal-auditor.ts` so the upstream-derived prompt/resource helpers there
// stay diffable against upstream:
//   - the structured verdict contract (GOAL_AUDITOR_RESULT_SCHEMA and parsing),
//   - launch preflight (the default goal-auditor agent is registered at
//     runtime by `./goal-auditor-registration.ts`, so no standalone
//     definition materialization is needed here),
//   - the delegation event lifecycle (request/started/update/response/cancel),
//   - progress parsing for the child-only report_auditor_progress provider,
//   - terminal child-session usage capture.
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSubagentLaunchContract } from "@xzzpig/pi-subagents/preflight";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationResponse,
	type SubagentDelegationThinking,
	type SubagentDelegationUpdate,
	type SubagentDelegationUsage,
} from "@xzzpig/pi-subagents/delegation";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";
import {
	DEFAULT_AUDITOR_AGENT,
	DEFAULT_AUDITOR_TIMEOUT_MS,
	loadGoalSettings,
	type GoalSettings,
	type ThinkingLevel,
} from "./goal-settings.ts";
import { getDefaultGoalAuditorRegistration } from "./goal-auditor-registration.ts";
import { resolveExternalAuditorAgentDefinition } from "./goal-auditor-agent-resolver.ts";
import {
	REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX,
	REPORT_AUDITOR_PROGRESS_TOOL_NAME,
} from "./goal-auditor-progress.ts";
import {
	buildGoalAuditorPrompt,
	type AuditorProgress,
	type AuditorProgressCallback,
} from "./goal-auditor.ts";

export interface GoalAuditorEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface GoalAuditorStructuredResult {
	verdict: "approved" | "disapproved";
	report: string;
	findings: string[];
}

export interface GoalAuditorResult {
	approved: boolean;
	disapproved: boolean;
	output: string;
	findings?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	error?: string;
	cancelled?: boolean;
	runId?: string;
	requestId?: string;
	/**
	 * True when Escape parked the audit: the delegated child is still running,
	 * its event listeners are still attached, and `session` can resume or cancel
	 * the SAME attempt. Terminal fields (output/findings/usage) are absent here;
	 * they arrive with the result `resume()`/`cancel()` settle with.
	 */
	interrupted?: boolean;
	/** Present exactly when `interrupted` is true; the caller decides the outcome. */
	session?: GoalAuditorSessionHandle;
	/**
	 * Child session usage from the terminal delegation response, when pi-subagents
	 * reported one. Presentation/accounting only: it never changes the verdict, and
	 * the caller decides whether it lands on a tool result or the goal ledger.
	 */
	usage?: SubagentDelegationUsage;
}

/**
 * Handle to a parked (Escape-interrupted) audit delegation. The child is NOT
 * cancelled by Escape: it keeps running and its terminal response is captured.
 * `resume()` keeps waiting on that SAME attempt; `cancel()` sends the delegation
 * cancel now. Both settle with the attempt's terminal result (verdict or
 * cancellation), which carries the child usage for accounting.
 */
export interface GoalAuditorSessionHandle {
	/** Continue watching the parked attempt; resolves with its terminal audit result. */
	resume(): Promise<GoalAuditorResult>;
	/** Kill the parked attempt (sends the delegation cancel); resolves when settled. */
	cancel(): Promise<GoalAuditorResult>;
}

export const GOAL_AUDITOR_RESULT_SCHEMA = {
	type: "object",
	properties: {
		verdict: { enum: ["approved", "disapproved"] },
		report: { type: "string" },
		findings: { type: "array", items: { type: "string" } },
	},
	required: ["verdict", "report", "findings"],
	additionalProperties: false,
} as const;

const START_HANDSHAKE_TIMEOUT_MS = 5_000;
// Built-in 30-minute audit wall-clock cap; the auditor.timeoutMs setting
// (resolved via resolveAuditorTerminalTimeoutMs) overrides this default.
const TERMINAL_TIMEOUT_MS = DEFAULT_AUDITOR_TIMEOUT_MS;
const CANCELLATION_TIMEOUT_MS = 5_000;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function auditorLaunchContractInput(args: GoalCompletionAuditorArgs, settings: GoalSettings, overrides: ReturnType<typeof resolveAuditorDelegationOverrides>) {
	return {
		agent: resolveAuditorAgent(settings),
		cwd: args.ctx.cwd,
		context: "fresh" as const,
		...(overrides.model ? { model: overrides.model } : {}),
		...(overrides.thinking ? { thinking: overrides.thinking } : {}),
		...(args.ctx.model ? { parentModel: { provider: args.ctx.model.provider, id: args.ctx.model.id } } : {}),
		...(typeof args.ctx.modelRegistry?.getAvailable === "function" ? { availableModels: args.ctx.modelRegistry.getAvailable() } : {}),
		projectTrusted: args.ctx.isProjectTrusted?.() === true,
		...(args.ctx.isProjectTrusted?.() === true ? { trustedProjectCwd: args.ctx.cwd } : {}),
		outputSchema: GOAL_AUDITOR_RESULT_SCHEMA,
		artifacts: true,
	};
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text as ThinkingLevel) ? text as ThinkingLevel : undefined;
}

export function resolveAuditorAgent(settings: GoalSettings | undefined): string {
	return settings?.auditor?.agent?.trim() || DEFAULT_AUDITOR_AGENT;
}

/**
 * Resolve the effective completion-audit wall-clock cap. The layered
 * `auditor.timeoutMs` setting wins (the settings parser guarantees a
 * timer-safe positive integer); anything else falls back to the built-in
 * 30-minute default. Handshake/cancellation guards are intentionally not
 * reachable from settings.
 */
export function resolveAuditorTerminalTimeoutMs(settings: GoalSettings | undefined): number {
	return settings?.auditor?.timeoutMs ?? TERMINAL_TIMEOUT_MS;
}

export function resolveAuditorDelegationOverrides(settings: GoalSettings): {
	model?: string;
	thinking?: SubagentDelegationThinking;
	error?: string;
} {
	const auditor = settings.auditor;
	if (auditor?.provider && !auditor.model) {
		return {
			error: `Provider-only auditor configuration is refused; select an explicit model for provider: ${auditor.provider}`,
		};
	}
	const model = auditor?.provider && auditor.model
		? `${auditor.provider}/${auditor.model}`
		: auditor?.model;
	const thinking = asThinkingLevel(auditor?.thinkingLevel);
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}

export function parseGoalAuditorStructuredResult(value: unknown): { value?: GoalAuditorStructuredResult; error?: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Delegated auditor did not return a JSON object." };
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.some((key) => key !== "verdict" && key !== "report" && key !== "findings")) {
		return { error: "Delegated auditor result contains unsupported fields." };
	}
	if (record.verdict !== "approved" && record.verdict !== "disapproved") {
		return { error: "Delegated auditor result has an invalid verdict." };
	}
	if (typeof record.report !== "string") return { error: "Delegated auditor result is missing a string report." };
	if (!Array.isArray(record.findings) || record.findings.some((finding) => typeof finding !== "string")) {
		return { error: "Delegated auditor result is missing a string findings array." };
	}
	return {
		value: {
			verdict: record.verdict,
			report: record.report,
			findings: record.findings,
		},
	};
}

/**
 * Record the auditor child's spend as its own ledger entry (goal.usage.tokensUsed
 * stays parent-turn-only, so the token budget never changes). Best-effort by
 * construction: a ledger append failure must not block completion. Exactly one
 * call per completion attempt — the three Escape flows (continue, bypass, focus
 * lost) are mutually exclusive, so the entry is never duplicated.
 */
export function appendAuditUsageEntry(core: GoalCore, ctx: ExtensionContext, goalId: string, usage: SubagentDelegationUsage | undefined): void {
	if (!usage) return;
	try {
		core.goalService.appendEvents(ctx, [{
			type: "audit_usage",
			goalId,
			tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			costUsd: usage.cost,
			turns: usage.turns,
			at: nowIso(),
		}]);
	} catch {
		// Ledger append failure should not block completion
	}
}

function formatAuditOutput(report: string, findings: string[]): string {
	const cleanReport = report.trim();
	const cleanFindings = findings.map((finding) => finding.trim()).filter(Boolean);
	if (cleanFindings.length === 0) return cleanReport;
	return [cleanReport, cleanReport ? "" : undefined, "Findings:", ...cleanFindings.map((finding) => `- ${finding}`)]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function matchingIdentity(value: unknown, identity: { requestId: string; ownerRunId: string; nodeId: string }): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<{ requestId: unknown; ownerRunId: unknown; nodeId: unknown }>;
	return candidate.requestId === identity.requestId
		&& candidate.ownerRunId === identity.ownerRunId
		&& candidate.nodeId === identity.nodeId;
}

const DELEGATION_USAGE_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const;

/**
 * Validate the delegation terminal usage the way other event payloads are
 * validated: untrusted event data must not enter accounting with NaN, negative,
 * or missing counters. Returns the received object untouched so callers observe
 * exactly what pi-subagents reported.
 */
function delegationUsage(value: unknown): SubagentDelegationUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of DELEGATION_USAGE_COUNTERS) {
		const counter = record[key];
		if (typeof counter !== "number" || !Number.isFinite(counter) || counter < 0) return undefined;
	}
	for (const key of ["toolCalls", "durationMs"] as const) {
		const counter = record[key];
		if (counter !== undefined && (typeof counter !== "number" || !Number.isFinite(counter) || counter < 0)) return undefined;
	}
	return value as SubagentDelegationUsage;
}

function progressDetails(value: unknown): { label?: string; percentage?: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const label = asNonEmptyString(record.label);
	const percentage = typeof record.percentage === "number" && Number.isFinite(record.percentage)
		? Math.max(0, Math.min(100, record.percentage))
		: undefined;
	return {
		...(label ? { label } : {}),
		...(percentage !== undefined ? { percentage } : {}),
	};
}

function parseProgressDetails(serialized: string | undefined): { label?: string; percentage?: number } {
	if (!serialized) return {};
	try {
		return progressDetails(JSON.parse(serialized));
	} catch {
		return {};
	}
}

function outputLines(update: SubagentDelegationUpdate): string[] {
	if (Array.isArray(update.recentOutputLines)) {
		return update.recentOutputLines.filter((line) => typeof line === "string" && line.trim());
	}
	if (typeof update.recentOutput === "string" && update.recentOutput.trim()) {
		return update.recentOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	}
	return [];
}

function isProgressProtocolLine(line: string): boolean {
	return line.trim().startsWith(REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX);
}

function progressDetailsFromOutput(update: SubagentDelegationUpdate): { label?: string; percentage?: number } {
	const lines = outputLines(update);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (line === undefined) continue;
		const text = line.trim();
		if (text.startsWith(REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX)) {
			const parsed = parseProgressDetails(text.slice(REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX.length));
			if (parsed.label !== undefined || parsed.percentage !== undefined) return parsed;
			continue;
		}
		const legacy = text.match(/^Progress reported:\s*(.*)\s+\((-?\d+(?:\.\d+)?)%\)$/);
		if (legacy) {
			const parsed = progressDetails({ label: legacy[1], percentage: Number(legacy[2]) });
			if (parsed.label !== undefined || parsed.percentage !== undefined) return parsed;
		}
	}
	return {};
}

function progressDetailsFromUpdate(update: SubagentDelegationUpdate): { label?: string; percentage?: number } {
	// Tool arguments are display previews and therefore cannot authorize or
	// carry structured progress. The child-only provider emits the bounded,
	// versioned record in its tool-result text instead.
	return progressDetailsFromOutput(update);
}

function recentLines(update: SubagentDelegationUpdate): string[] | undefined {
	const lines = outputLines(update)
		.filter((line) => !isProgressProtocolLine(line))
		.slice(-8);
	return lines.length > 0 ? lines : undefined;
}

function safeProgress(callback: AuditorProgressCallback | undefined, progress: AuditorProgress): void {
	try {
		callback?.({ ...progress, recentOutput: [...progress.recentOutput] });
	} catch {
		// Progress reporting is presentation-only and cannot affect the verdict.
	}
}

function responseError(response: SubagentDelegationResponse): string {
	if (response.status === "cancelled") return "Auditor aborted.";
	const detail = typeof response.error === "string" && response.error.trim() ? `: ${response.error.trim()}` : "";
	return `Goal auditor delegation ${response.status}${detail}`;
}

export interface GoalCompletionAuditorArgs {
	ctx: ExtensionContext;
	events?: GoalAuditorEvents;
	goal: GoalRecord;
	detailedSummary: string;
	completionSummary?: string | null;
	settings?: GoalSettings;
	warmContext?: string | null;
	/**
	 * Rendered workspace change manifest body (see `renderChangeManifestBody`).
	 * Absent when collection is off, the cwd is not a git repository, or capture
	 * failed, in which case audit input is unchanged from before this feature.
	 */
	changeManifest?: string | null;
	signal?: AbortSignal;
	/**
	 * Park the audit on abort instead of cancelling: Escape keeps the delegated
	 * child alive and hands the caller an `interrupted` result + session handle,
	 * so "continue audit" can resume the SAME subagent. Off by default so
	 * existing callers (and test stubs) keep the current cancel-on-abort path.
	 */
	parkOnAbort?: boolean;
	onProgress?: AuditorProgressCallback;
	/** Test-only identity/time controls. Production callers use generated values. */
	requestId?: string;
	nodeId?: string;
	timeouts?: { startedMs?: number; terminalMs?: number; cancellationMs?: number };
	/** Test-only: bypass launch preflight when exercising event lifecycle in isolation. */
	skipPreflight?: boolean;
}

export async function runGoalCompletionAuditor(args: GoalCompletionAuditorArgs): Promise<GoalAuditorResult> {
	const settings = args.settings ?? loadGoalSettings(args.ctx.cwd);
	const overrides = resolveAuditorDelegationOverrides(settings);
	if (overrides.error) {
		return { approved: false, disapproved: true, output: "", error: overrides.error };
	}
	// One resolved value feeds BOTH the delegation request timeoutMs (runner-side
	// kill deadline) and the local terminal timer, so the two can never drift.
	const terminalTimeoutMs = args.timeouts?.terminalMs ?? resolveAuditorTerminalTimeoutMs(settings);
	if (!args.events) {
		return {
			approved: false,
			disapproved: true,
			output: "",
			error: "pi-subagents extension is not loaded or does not expose the structured delegation event bridge.",
		};
	}

	const events = args.events;
	if (!args.skipPreflight) {
		let preflight: Awaited<ReturnType<typeof resolveSubagentLaunchContract>>;
		try {
			const input = auditorLaunchContractInput(args, settings, overrides);
			preflight = await resolveSubagentLaunchContract(input);
		} catch (error) {
			return {
				approved: false,
				disapproved: true,
				output: "",
				error: `Goal auditor preflight failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (preflight.ok) {
			if (!preflight.contract.tools.effectiveAllowlist.includes(REPORT_AUDITOR_PROGRESS_TOOL_NAME)) {
				return {
					approved: false,
					disapproved: true,
					output: "",
					error: `Goal auditor preflight failed: agent '${preflight.contract.agent.name}' must retain the required ${REPORT_AUDITOR_PROGRESS_TOOL_NAME} tool.`,
				};
			}
			if (!preflight.contract.tools.effectiveAllowlist.includes("structured_output")) {
				return {
					approved: false,
					disapproved: true,
					output: "",
					error: "Goal auditor preflight failed: structured_output is unavailable.",
				};
			}
		} else if (preflight.code === "missing_agent") {
			// The default auditor is registered with the installed pi-subagents
			// owner at session_start. That owner stores registrations under ITS OWN
			// ExtensionAPI identity (the runtime registry is a per-owner WeakMap),
			// so a registry query issued from this extension can never observe our
			// own registration. Trust the local record of what this process
			// registered instead, and enforce the protocol tool on the definition
			// that was actually handed to the owner. structured_output is
			// guaranteed by the structured delegation request shape below.
			const auditorAgent = resolveAuditorAgent(settings);
			// [fork] S2: before the local default-registration fallback, let a
			// cross-extension resolver (./goal-auditor-agent-resolver.ts, fed by
			// e.g. pi-openspec-x at init) supply an equivalent definition for the
			// configured agent: file-based preflight discovery cannot see runtime
			// registrations owned by pi-subagents. A hit takes exactly the
			// local-registration path below (protocol-tool enforcement on the
			// supplied definition; structured_output is guaranteed by the request
			// shape); a miss leaves the original fallback byte-identical.
			const externallyResolved = resolveExternalAuditorAgentDefinition(auditorAgent);
			const registered = externallyResolved
				? { name: auditorAgent, definition: externallyResolved }
				: getDefaultGoalAuditorRegistration();
			if (!registered) {
				return {
					approved: false,
					disapproved: true,
					output: "",
					error: `Goal auditor preflight failed: '${auditorAgent}' is neither a configured agent nor an active runtime registration. Load the pi-subagents extension (which owns runtime agent registration) or define the auditor explicitly, then retry.\n\n${preflight.message}`,
				};
			}
			if (registered.name !== auditorAgent) {
				return {
					approved: false,
					disapproved: true,
					output: "",
					error: `Goal auditor preflight failed: auditor.agent resolves to '${auditorAgent}', but the active runtime registration is '${registered.name}'. A runtime registration never substitutes for a different configured agent.\n\n${preflight.message}`,
				};
			}
			const excludedTools = new Set(registered.definition.excludeTools ?? []);
			const effectiveAllowlist = (registered.definition.tools ?? []).filter((tool) => !excludedTools.has(tool));
			if (!effectiveAllowlist.includes(REPORT_AUDITOR_PROGRESS_TOOL_NAME)) {
				return {
					approved: false,
					disapproved: true,
					output: "",
					error: `Goal auditor preflight failed: agent '${auditorAgent}' must retain the required ${REPORT_AUDITOR_PROGRESS_TOOL_NAME} tool.`,
				};
			}
		} else {
			return {
				approved: false,
				disapproved: true,
				output: "",
				error: `Goal auditor preflight failed: ${preflight.message}`,
			};
		}
	}
	const requestId = args.requestId ?? randomUUID();
	const ownerRunId = args.goal.id;
	const nodeId = args.nodeId ?? `goal-completion:${args.goal.id}:${args.goal.revision ?? 0}`;
	const identity = { requestId, ownerRunId, nodeId };
	const startedAt = Date.now();
	const progress: AuditorProgress = {
		recentOutput: [],
		phase: "running",
		elapsedMs: 0,
	};
	const request = {
		...identity,
		agent: resolveAuditorAgent(settings),
		task: buildGoalAuditorPrompt({
			goal: args.goal,
			detailedSummary: args.detailedSummary,
			completionSummary: args.completionSummary,
			settings,
			warmContext: args.warmContext,
			changeManifest: args.changeManifest,
		}),
		context: "fresh" as const,
		cwd: args.ctx.cwd,
		...(overrides.model ? { model: overrides.model } : {}),
		...(overrides.thinking ? { thinking: overrides.thinking } : {}),
		timeoutMs: terminalTimeoutMs,
		artifacts: true,
		result: { kind: "structured" as const, schema: GOAL_AUDITOR_RESULT_SCHEMA },
	};
	return new Promise<GoalAuditorResult>((resolve) => {
		let settled = false;
		let started = false;
		let startedTimer: ReturnType<typeof setTimeout> | undefined;
		let terminalTimer: ReturnType<typeof setTimeout> | undefined;
		let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
		let cancellationReason: "user_abort" | "terminal_timeout" | undefined;
		let terminalUsage: SubagentDelegationUsage | undefined;
		// Escape park: the child keeps running and the listeners stay attached; the
		// caller settles the interrupted result and decides via the session handle.
		let parked = false;
		let parkPromise: Promise<GoalAuditorResult> | undefined;
		let parkResolve: ((result: GoalAuditorResult) => void) | undefined;
		const unsubscribes: Array<() => void> = [];
		const subscribe = (event: string, handler: (data: unknown) => void): void => {
			const unsubscribe = events.on(event, handler);
			if (typeof unsubscribe === "function") unsubscribes.push(unsubscribe);
		};
		function cancellationResult(
			reason: "user_abort" | "terminal_timeout",
			acknowledged = false,
		): GoalAuditorResult {
			if (reason === "user_abort") {
				return {
					approved: false,
					disapproved: true,
					output: "",
					error: "Auditor aborted.",
					cancelled: true,
				};
			}
			return {
				approved: false,
				disapproved: true,
				output: "",
				error: acknowledged
					? "Goal auditor delegation did not return a terminal response before its timeout and was cancelled."
					: "Goal auditor delegation did not return a terminal response before its timeout and did not acknowledge cancellation.",
			};
		}
		function cancelAttempt(reason: "user_abort" | "terminal_timeout"): void {
			if (settled || cancellationReason) return;
			cancellationReason = reason;
			try {
				events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, identity);
			} catch (error) {
				finish({
					approved: false,
					disapproved: true,
					output: "",
					error: `Could not cancel goal auditor delegation: ${error instanceof Error ? error.message : String(error)}`,
				});
				return;
			}
			if (settled) return;
			cancellationTimer = setTimeout(() => finish(cancellationResult(reason)), args.timeouts?.cancellationMs ?? CANCELLATION_TIMEOUT_MS);
			cancellationTimer.unref?.();
		}
		const onAbort = () => {
			if (args.parkOnAbort) park();
			else cancelAttempt("user_abort");
		};
		/**
		 * Park the audit on Escape: keep the delegated child running and the event
		 * listeners/timers attached, and settle the caller's promise with an
		 * `interrupted` result + session handle. The flow asks the user and then
		 * resumes the SAME attempt or cancels it after all.
		 */
		function park(): void {
			if (settled || parked) return;
			parked = true;
			parkPromise = new Promise<GoalAuditorResult>((resolveParked) => {
				parkResolve = resolveParked;
			});
			const session: GoalAuditorSessionHandle = {
				resume: () => {
					// The flow re-arms the audit display before resuming; from here on
					// progress updates flow again until the attempt settles.
					parked = false;
					return parkPromise!;
				},
				cancel: () => {
					cancelAttempt("user_abort");
					return parkPromise!;
				},
			};
			resolve({
				approved: false,
				disapproved: true,
				output: "",
				error: "Auditor aborted.",
				cancelled: true,
				interrupted: true,
				session,
				requestId,
			});
		}
		// Progress reporting pauses while parked: the flow clears auditProgress for
		// the Escape dialog, and resume() re-arms the display. Suppressing updates
		// keeps the hidden dashboard from churning underneath the dialog.
		const reportProgress = (p: AuditorProgress) => {
			if (parked) return;
			safeProgress(args.onProgress, p);
		};
		const cleanup = () => {
			if (startedTimer) clearTimeout(startedTimer);
			if (terminalTimer) clearTimeout(terminalTimer);
			if (cancellationTimer) clearTimeout(cancellationTimer);
			args.signal?.removeEventListener("abort", onAbort);
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
		const finish = (result: GoalAuditorResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			progress.phase = "done";
			progress.label = "Audit complete.";
			progress.percentage = 100;
			progress.elapsedMs = Date.now() - startedAt;
			if (result.output.trim()) progress.recentOutput = result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-8);
			reportProgress(progress);
			const usage = result.usage ?? terminalUsage;
			const final = { ...result, ...(usage ? { usage } : {}), requestId };
			if (parkResolve) {
				// Parked by Escape: the child's terminal result (verdict, failure, or
				// cancellation confirmation) is handed to the parked session handle.
				const resolveParked = parkResolve;
				parkResolve = undefined;
				resolveParked(final);
				return;
			}
			resolve(final);
		};
		const armTerminalTimeout = () => {
			if (terminalTimer) return;
			terminalTimer = setTimeout(() => {
				cancelAttempt("terminal_timeout");
			}, terminalTimeoutMs);
			terminalTimer.unref?.();
		};

		subscribe(SUBAGENT_DELEGATION_STARTED_EVENT, (value) => {
			if (!matchingIdentity(value, identity)) return;
			if (started) return;
			started = true;
			if (startedTimer) clearTimeout(startedTimer);
			progress.elapsedMs = Date.now() - startedAt;
			reportProgress(progress);
			armTerminalTimeout();
		});
		subscribe(SUBAGENT_DELEGATION_UPDATE_EVENT, (value) => {
			if (!matchingIdentity(value, identity)) return;
			const update = value as SubagentDelegationUpdate;
			if (!started) {
				started = true;
				if (startedTimer) clearTimeout(startedTimer);
				armTerminalTimeout();
			}
			const reported = progressDetailsFromUpdate(update);
			const output = recentLines(update);
			if (typeof update.currentTool === "string") {
				progress.currentTool = update.currentTool;
				progress.currentToolArgs = update.currentToolArgs;
				progress.currentToolStartedAt = Date.now();
				progress.phase = "tool_executing";
			}
			if (output) {
				progress.recentOutput = output;
				if (update.currentTool === undefined) {
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					progress.currentToolStartedAt = undefined;
					progress.phase = "producing_report";
				}
			}
			if (reported.label) progress.label = reported.label;
			if (reported.percentage !== undefined) progress.percentage = reported.percentage;
			if (typeof update.durationMs === "number" && update.durationMs >= 0) progress.elapsedMs = update.durationMs;
			else progress.elapsedMs = Date.now() - startedAt;
			reportProgress(progress);
		});
		subscribe(SUBAGENT_DELEGATION_RESPONSE_EVENT, (value) => {
			if (!matchingIdentity(value, identity)) return;
			const response = value as SubagentDelegationResponse;
			if (response.status !== "invalid_request") terminalUsage = delegationUsage(response.usage);
			if (cancellationReason) {
				finish(cancellationResult(cancellationReason, true));
				return;
			}
			if (response.status === "invalid_request") {
				finish({
					approved: false,
					disapproved: true,
					output: "",
					error: response.error?.trim() || "Goal auditor delegation request was rejected as invalid.",
				});
				return;
			}
			if (response.status !== "completed") {
				finish({
					approved: false,
					disapproved: true,
					output: "",
					model: response.model,
					thinkingLevel: asThinkingLevel(response.thinking),
					error: responseError(response),
					cancelled: response.status === "cancelled",
					runId: response.runId,
				});
				return;
			}
			if (response.result?.kind !== "structured") {
				finish({
					approved: false,
					disapproved: true,
					output: "",
					model: response.model,
					thinkingLevel: asThinkingLevel(response.thinking),
					error: "Delegated auditor did not return the required structured verdict.",
					runId: response.runId,
				});
				return;
			}
			const parsed = parseGoalAuditorStructuredResult(response.result.value);
			if (!parsed.value) {
				finish({
					approved: false,
					disapproved: true,
					output: "",
					model: response.model,
					thinkingLevel: asThinkingLevel(response.thinking),
					error: parsed.error,
					runId: response.runId,
				});
				return;
			}
			const structured = parsed.value;
			finish({
				approved: structured.verdict === "approved",
				disapproved: structured.verdict === "disapproved",
				output: formatAuditOutput(structured.report, structured.findings),
				findings: structured.findings,
				model: response.model,
				thinkingLevel: asThinkingLevel(response.thinking),
				runId: response.runId,
			});
		});

		startedTimer = setTimeout(() => {
			finish({
				approved: false,
				disapproved: true,
				output: "",
				error: "pi-subagents extension is not loaded or did not acknowledge the structured goal-auditor request.",
			});
		}, args.timeouts?.startedMs ?? START_HANDSHAKE_TIMEOUT_MS);
		startedTimer.unref?.();
		args.signal?.addEventListener("abort", onAbort, { once: true });
		reportProgress(progress);
		try {
			if (args.signal?.aborted) {
				if (args.parkOnAbort) park();
				else cancelAttempt("user_abort");
			}
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
		} catch (error) {
			finish({
				approved: false,
				disapproved: true,
				output: "",
				error: `Could not start goal auditor delegation: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	});
}
