import type {
	TranscriptEntry,
	TranscriptState,
} from "@xzzpig/pi-components/transcript";
import { readTranscriptRecords, type FleetTranscriptReadOptions } from "./fleet-transcript.ts";

/** Runtime shape of `@xzzpig/pi-components/transcript` as consumed here.
 *  Expressed as a static typeof-import so the dependency stays lazy at
 *  runtime: the module is only loaded through the guarded dynamic import. */
type NativeTranscriptModule = typeof import("@xzzpig/pi-components/transcript");

export type { NativeTranscriptModule };

const REQUIRED_NATIVE_EXPORTS = [
	"createTranscriptState",
	"appendEntry",
	"ensureTurn",
	"finishTurn",
	"findLatestEntry",
	"ensureToolCall",
	"upsertText",
	"upsertToolResult",
	"appendNotice",
	"renderTranscriptLines",
	"TranscriptToolComponents",
	"ensureTranscriptTheme",
] as const;

let nativeSupportPromise: Promise<NativeTranscriptModule | null> | undefined;

/**
 * Structural probe for a candidate transcript module: every export the native
 * renderer calls must be present. Exported pure so hosts and tests can check
 * arbitrary objects (e.g. simulating an older shared-library build).
 */
export function hasRequiredNativeExports(candidate: unknown): candidate is NativeTranscriptModule {
	if (!candidate || typeof candidate !== "object") return false;
	return REQUIRED_NATIVE_EXPORTS.every((name) => name in (candidate as Record<string, unknown>));
}

/**
 * Loads the shared transcript module once and validates it exposes every
 * export the native renderer needs. Resolves `null` when the package is
 * absent (or an older host ships an incompatible build) so callers can fall
 * back to the legacy rail renderer without try/catch at call sites.
 */
export function loadNativeTranscriptSupport(): Promise<NativeTranscriptModule | null> {
	nativeSupportPromise ??= (async () => {
		try {
			const mod: NativeTranscriptModule = await import("@xzzpig/pi-components/transcript");
			return hasRequiredNativeExports(mod) ? mod : null;
		} catch {
			return null;
		}
	})();
	return nativeSupportPromise;
}

export interface NativeFleetBuildInput {
	filePath: string;
	trustedRoots: string[];
	trustedFiles?: string[];
	trustedFileRoot?: string;
	width: number;
	expandedTools: boolean;
	cwd?: string;
	maxRecords?: number;
	theme: {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
		bold(text: string): string;
	};
}

export interface NativeFleetBuildResult {
	lines: string[];
	conversationState: string;
	truncated: boolean;
	warning?: string;
	entryCount: number;
}

function contentParts(content: unknown): Array<{ type: string; text?: string; thinking?: string }> {
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is { type: string; text?: string; thinking?: string } =>
		Boolean(part) && typeof part === "object" && typeof (part as { type?: unknown }).type === "string");
}

function partsToText(parts: Array<{ type: string; text?: string }>): string {
	return parts
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function partsToThinking(parts: Array<{ type: string; thinking?: string }>): string {
	return parts
		.filter((part) => part.type === "thinking" && typeof part.thinking === "string")
		.map((part) => part.thinking)
		.join("\n")
		.trim();
}

function parseArgsPayload(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		// Truncated payloads (>32 KiB at write time) are not valid JSON; D4
		// degrades them to empty arguments instead of failing the entry.
		return undefined;
	}
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function nestedField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = record[key];
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** Builds entries from child-transcript v1 JSONL records. Mirrors the legacy
 *  parser's semantics: user messages open exchanges (a finished assistant turn
 *  is closed before the next supervisor message), tool calls pair with results
 *  by toolCallId regardless of record order, stderr becomes an error notice,
 *  and stdout stays ignored. */
function ingestRecords(
	mod: NativeTranscriptModule,
	state: TranscriptState,
	records: Array<Record<string, unknown>>,
): { truncatedMarkerSeen: boolean } {
	let truncatedMarkerSeen = false;
	let currentTurnHasFinishedAssistant = false;
	const pendingErrors = new Map<string, boolean>();
	const degradedArgs = new Map<string, string>();

	for (const record of records) {
		const recordType = stringValue(record, "recordType");
		if (recordType === "truncated") {
			truncatedMarkerSeen = true;
			continue;
		}
		if (recordType === "stdout") continue;

		if (recordType === "stderr") {
			const text = stringValue(record, "text");
			if (text) mod.appendNotice(state, text, "error");
			continue;
		}

		if (recordType === "tool_start") {
			const turnId = mod.ensureTurn(state);
			const toolName = stringValue(record, "toolName") ?? "tool";
			const toolCallId = stringValue(record, "toolCallId") ?? `tool-${state.nextEntryId}`;
			const parsedArgs = parseArgsPayload(record.argsPayload);
			if (parsedArgs === undefined && record.argsPayload !== undefined) {
				// Truncated/corrupt payload: builtin renderers need real args and
				// may swallow text-only results, so remember to re-surface the
				// preview and outcome as a warning notice after pairing completes.
				degradedArgs.set(toolCallId, stringValue(record, "argsPreview") ?? "");
			}
			mod.ensureToolCall(state, turnId, toolCallId, toolName, parsedArgs ?? {});
			continue;
		}

		if (recordType === "tool_end") {
			const toolCallId = stringValue(record, "toolCallId");
			if (toolCallId) pendingErrors.set(toolCallId, record.isError === true);
			continue;
		}

		if (recordType !== "message") continue;

		const message = nestedField(record, "message");
		const role = stringValue(record, "role") ?? stringValue(message ?? {}, "role");

		if (role === "user") {
			if (state.currentTurnId !== null && currentTurnHasFinishedAssistant) {
				mod.finishTurn(state);
			}
			const turnId = mod.ensureTurn(state);
			const textParts = contentParts(message?.content);
			const text = stringValue(record, "text") ?? partsToText(textParts);
			if (!text) continue;
			const existing = mod.findLatestEntry(state, turnId, "user-message");
			if (existing) existing.text = text;
			else mod.appendEntry(state, { type: "user-message", turnId, text });
			currentTurnHasFinishedAssistant = false;
			continue;
		}

		if (role === "assistant") {
			const turnId = mod.ensureTurn(state);
			const parts = contentParts(message?.content);
			const thinking = partsToThinking(parts);
			const text = partsToText(parts);
			if (thinking) mod.upsertText(state, turnId, "thinking", thinking, false);
			if (text) {
				mod.upsertText(state, turnId, "assistant-text", text, false);
				currentTurnHasFinishedAssistant = true;
			}
			continue;
		}

		if (role === "toolResult" || role === "tool_result") {
			const toolCallId = stringValue(record, "toolCallId") ?? stringValue(message ?? {}, "toolCallId") ?? `tool-${state.nextEntryId}`;
			const toolName = stringValue(record, "toolName") ?? stringValue(message ?? {}, "toolName") ?? "tool";
			const failed = record.isError === true || message?.isError === true;
			const isError = failed || pendingErrors.get(toolCallId) === true;
			pendingErrors.delete(toolCallId);
			const resultContent = Array.isArray(message?.content)
				? message.content
				: typeof record.text === "string"
					? [{ type: "text", text: record.text }]
					: [];
			const turnId = state.toolCalls.get(toolCallId)?.turnId ?? mod.ensureTurn(state);
			mod.upsertToolResult(
				state,
				turnId,
				toolCallId,
				toolName,
				{ content: resultContent },
				isError,
				false,
			);
			currentTurnHasFinishedAssistant = false;
		}
	}

	// Terminal-state guarantee: every recorded call gets a result entry so the
	// native component never renders a stale running spinner for history.
	for (const [toolCallId, toolCall] of state.toolCalls.entries()) {
		if (toolCall.resultEntryId !== undefined) continue;
		const callEntry = state.entries.find((entry) => entry.id === toolCall.callEntryId);
		if (callEntry?.type !== "tool-call") continue;
		const isError = pendingErrors.get(toolCallId) === true;
		mod.upsertToolResult(
			state,
			toolCall.turnId,
			toolCallId,
			callEntry.toolName,
			{ content: [{ type: "text", text: isError ? "(tool ended with error)" : "(no result recorded)" }] },
			isError,
			false,
			);
	}

	// Degraded-argument visibility net: builtin renderers can hide text-only
	// results when args are empty, so re-surface preview + outcome as a notice.
	for (const [toolCallId, preview] of degradedArgs) {
		const toolRecord = state.toolCalls.get(toolCallId);
		const callEntry = state.entries.find((entry) => entry.id === toolRecord?.callEntryId);
		if (callEntry?.type !== "tool-call") continue;
		const resultEntry = toolRecord?.resultEntryId === undefined
			? undefined
			: state.entries.find((candidate) => candidate.id === toolRecord.resultEntryId);
		const resultText = resultEntry?.type === "tool-result"
			? (resultEntry.result?.content ?? []).map((part) => part.text ?? "").join(" ").trim()
			: "";
		const summary = [
			`${callEntry.toolName}: arguments truncated`,
			preview ? `preview ${preview}` : undefined,
			resultText ? `result: ${resultText.split(/\r?\n/)[0]}` : undefined,
		].filter(Boolean).join(" · ");
		mod.appendNotice(state, summary, "warning");
	}
	return { truncatedMarkerSeen };
}

function conversationStateOf(entries: readonly TranscriptEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || entry.type === "turn-boundary") continue;
		if (entry.type === "assistant-text") return "assistant response";
		if (entry.type === "user-message") return "supervisor message";
		if (entry.type === "tool-result") return `${entry.toolName} · ${entry.isError ? "error" : "complete"}`;
		if (entry.type === "tool-call") {
			const toolRecord = state_toolCallStatus(entries, entry.toolCallId);
			return `${entry.toolName} · ${toolRecord}`;
		}
		return "activity";
	}
	return "activity";
}

function state_toolCallStatus(entries: readonly TranscriptEntry[], toolCallId: string): "running" | "complete" | "error" {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "tool-result" && entry.toolCallId === toolCallId) {
			return entry.isError ? "error" : "complete";
		}
	}
	return "complete";
}

/**
 * Renders a persisted child transcript through Pi-native components. Reads
 * via the shared trusted-root guard, replays records into shared-library
 * entries, then renders with the same message/tool components the main
 * transcript uses. Returns `null` only when the caller passed a module that
 * turned out to be unusable; read/validation problems surface as warnings.
 */
export function buildNativeFleetTranscript(
	mod: NativeTranscriptModule,
	input: NativeFleetBuildInput,
): NativeFleetBuildResult {
	mod.ensureTranscriptTheme();
	const readOptions: FleetTranscriptReadOptions = {
		trustedRoots: input.trustedRoots,
		...(input.trustedFiles ? { trustedFiles: input.trustedFiles } : {}),
		...(input.trustedFileRoot ? { trustedFileRoot: input.trustedFileRoot } : {}),
		...(input.maxRecords !== undefined ? { maxRecords: input.maxRecords } : {}),
	};
	const read = readTranscriptRecords(input.filePath, readOptions);
	if (read.records.length === 0) {
		return {
			lines: [],
			conversationState: "activity",
			truncated: read.truncated,
			...(read.warning ? { warning: read.warning } : {}),
			entryCount: 0,
		};
	}

	const state = mod.createTranscriptState({});
	const { truncatedMarkerSeen } = ingestRecords(mod, state, read.records);

	const registry = new mod.TranscriptToolComponents({
		expanded: input.expandedTools,
		...(input.cwd ? { cwd: input.cwd } : {}),
	});
	for (const entry of state.entries) {
		if (entry.type !== "tool-call") continue;
		registry.handleStart(entry.toolCallId, entry.toolName, entry.args);
		const toolRecord = state.toolCalls.get(entry.toolCallId);
		const resultEntry = toolRecord?.resultEntryId === undefined
			? undefined
			: state.entries.find((candidate) => candidate.id === toolRecord.resultEntryId);
		if (resultEntry?.type === "tool-result") {
			registry.handleEnd(entry.toolCallId, entry.toolName, resultEntry.result, resultEntry.isError);
		} else {
			registry.handleEnd(entry.toolCallId, entry.toolName, null, false);
		}
	}

	const lines = mod.renderTranscriptLines(state.entries, {
		width: input.width,
		theme: input.theme,
		toolComponents: registry,
	});

	const indicatorLines: string[] = [];
	if (read.truncated || truncatedMarkerSeen) {
		indicatorLines.push(input.theme.fg("dim", "↑ Earlier activity omitted"));
	}
	if (read.warning) {
		for (const line of read.warning.split(/\r?\n/)) {
			indicatorLines.push(input.theme.fg("warning", `! ${line}`));
		}
	}

	return {
		lines: [...indicatorLines, ...lines],
		conversationState: conversationStateOf(state.entries),
		truncated: read.truncated || truncatedMarkerSeen,
		...(read.warning ? { warning: read.warning } : {}),
		entryCount: state.entries.length,
	};
}
