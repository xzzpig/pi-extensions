/**
 * Fork-only tool-result handler for a foreground subagent run.
 *
 * Why this file exists: upstream `execution.ts` has no `handleToolResult`; the
 * fork added ~60 lines of tool-result bookkeeping (budget blocking, mutating
 * failure escalation, supervisor progress publication) inside the run closure.
 * It only reads/writes state the run already owns, so the handler lives here and
 * the upstream run keeps one factory call.
 *
 * `handledToolResultIds` is bounded so a long run cannot grow it without limit;
 * the oldest id is evicted first, which only risks re-processing results the
 * child itself re-sends, never dropping a live one.
 */

import type { Message } from "@earendil-works/pi-ai";

import type { AgentProgress, RunSyncOptions, SingleResult } from "../../shared/types.ts";
import { extractTextFromContent } from "../../shared/utils.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	recordMutatingFailure,
	resetMutatingFailureState,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import { isToolBudgetBlockedMessage, toolBudgetState } from "../shared/tool-budget.ts";
import type { ControlEvent } from "../../shared/types.ts";

export type PendingToolResult = {
	tool: string;
	path?: string;
	mutates: boolean;
	startedAt?: number;
	progressText?: string;
};

type MutatingFailureState = ReturnType<typeof createMutatingFailureState>;

const MAX_HANDLED_TOOL_RESULT_IDS = 1024;

export interface ToolResultHandlerDeps {
	result: SingleResult;
	progress: AgentProgress;
	options: RunSyncOptions;
	/** Name used in the needs-attention message. */
	agentName: string;
	handledToolResultIds: Set<string>;
	pendingToolResultsByCallId: Map<string, PendingToolResult>;
	/** Unkeyed snapshot taken at `tool_call`; the handler consumes it. */
	pendingToolState: { current: PendingToolResult | undefined };
	mutatingFailures: MutatingFailureState;
	mutatingFailureWindowMs: number;
	controlConfig: { failedToolAttemptsBeforeAttention: number };
	appendRecentOutput(progress: AgentProgress, lines: string[]): void;
	fireUpdate(): void;
	emitNeedsAttention(
		now: number,
		input: {
			message?: string;
			reason?: ControlEvent["reason"];
			recentFailureSummary?: string;
			currentTool?: string;
			toolCallId?: string;
			hasCommandController?: boolean;
			currentPath?: string;
			currentToolDurationMs?: number;
		},
	): boolean;
}

export function createToolResultHandler(
	deps: ToolResultHandlerDeps,
): (message: Message, completion: { toolCallId?: unknown; toolName?: unknown }, now: number) => void {
	const {
		result,
		progress,
		options,
		agentName,
		handledToolResultIds,
		pendingToolResultsByCallId,
		pendingToolState,
		mutatingFailures,
		mutatingFailureWindowMs,
		controlConfig,
		appendRecentOutput,
		fireUpdate,
		emitNeedsAttention,
	} = deps;
	return (message, completion, now): void => {
		const rawCallId = completion.toolCallId ?? (message as { toolCallId?: unknown }).toolCallId;
		const callId = typeof rawCallId === "string" && rawCallId.length > 0 ? rawCallId : undefined;
		if (callId) {
			if (handledToolResultIds.has(callId)) return;
			if (handledToolResultIds.size >= MAX_HANDLED_TOOL_RESULT_IDS) {
				const oldest = handledToolResultIds.values().next().value;
				if (typeof oldest === "string") handledToolResultIds.delete(oldest);
			}
			handledToolResultIds.add(callId);
		}
		result.messages!.push(message);
		const resultText = extractTextFromContent(message.content);
		const keyedSnapshot = callId ? pendingToolResultsByCallId.get(callId) : undefined;
		if (callId && keyedSnapshot) pendingToolResultsByCallId.delete(callId);
		const toolSnapshot = keyedSnapshot ?? pendingToolState.current;
		if (!keyedSnapshot || pendingToolState.current === keyedSnapshot) pendingToolState.current = undefined;
		// The result event's own tool name is authoritative; the snapshot is a fallback.
		const resultToolName = completion.toolName ?? (message as { toolName?: unknown }).toolName;
		const blockedTool = (typeof resultToolName === "string" && resultToolName.length > 0
			? resultToolName
			: undefined) ?? toolSnapshot?.tool;
		const budgetBlocked = Boolean(options.toolBudget && isToolBudgetBlockedMessage(options.toolBudget, resultText, blockedTool));
		if (options.toolBudget && budgetBlocked) {
			result.toolBudgetBlocked = true;
			result.toolBudget = toolBudgetState(
				options.toolBudget,
				Math.max(progress.toolCount, options.toolBudget.hard + 1),
				blockedTool,
			);
		}
		appendRecentOutput(progress, resultText.split("\n").slice(-10));
		// Pi 1.2+: a successful contact_supervisor progress_update call carries
		// its text back through the result message. Publish the matching
		// snapshot's text so the widget shows the latest successful update.
		const messageToolName = (message as { toolName?: unknown }).toolName;
		if ((message as { isError?: unknown }).isError !== true && messageToolName === toolSnapshot?.tool && toolSnapshot?.progressText) {
			progress.progressText = toolSnapshot.progressText;
			progress.progressUpdatedAt = now;
		}
		if (toolSnapshot?.mutates && !budgetBlocked && message.role === "toolResult" && didMutatingToolFail(message)) {
			recordMutatingFailure(mutatingFailures, {
				tool: toolSnapshot.tool,
				path: toolSnapshot.path,
				error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
				ts: now,
			}, mutatingFailureWindowMs);
			if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
				emitNeedsAttention(now, {
					message: `${agentName} needs attention after repeated mutating tool failures`,
					reason: "tool_failures",
					currentTool: toolSnapshot.tool,
					currentPath: toolSnapshot.path,
					currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
					recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
				});
			}
		} else if (toolSnapshot?.mutates) {
			resetMutatingFailureState(mutatingFailures);
		}
		fireUpdate();
	
	};
}
