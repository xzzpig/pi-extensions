/**
 * Legal completed-prefix snapshot of the parent conversation (fork-only).
 *
 * The audit side channel seeds a read-only session from the parent's finished
 * history. Only a *completed* prefix is legal to replay: an assistant tool call
 * without its result, a partially returned multi-call group, or a deferred
 * assistant that has not converged would make the provider reject the seed or,
 * worse, let a half-finished tool exchange read as evidence.
 *
 * Rules (design D4):
 * - messages come from the SDK's own branch/compaction builder;
 * - system messages are dropped first — they carry toolsAdded/toolsRemoved
 *   capability declarations that must never override the side channel's real
 *   tool set;
 * - the prefix stops before the first incomplete assistant tool group, and no
 *   already-returned partial result of that same group is copied;
 * - an orphan, duplicate or out-of-order toolResult inside the prefix is a
 *   hard context error — never a synthesized result;
 * - fully paired failed toolResults are a legitimate completed group;
 * - pending/deferred assistants that have not converged are excluded;
 * - the result is deep-cloned so later parent branch changes cannot mutate it;
 * - system prompt + legal messages + goal payload must fit 256 KiB of UTF-8
 *   JSON (the exact limit is allowed, one byte over is rejected).
 */
import {
	buildSessionContext,
	type SessionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** The SDK's own message type for a built session context. */
type ContextMessage = SessionContext["messages"][number];

/** Hard UTF-8 JSON budget for the captured seed (system prompt + messages + goal payload). */
export const MAX_AUDIT_CONTEXT_BYTES = 256 * 1024;

export interface CapturedAuditContext {
	/** Completed prefix, deep-cloned, system messages removed. */
	messages: ContextMessage[];
	thinkingLevel: string;
	model: SessionContext["model"];
	/** Messages dropped from the tail (incomplete group, deferred assistant, ...). */
	droppedMessages: number;
	/** UTF-8 JSON size of systemPrompt + messages + goalPayload. */
	bytes: number;
}

export type AuditContextCapture =
	| { ok: true; context: CapturedAuditContext }
	| { ok: false; code: "context_error" | "capacity_exceeded"; message: string };

export interface CaptureCompletedAuditContextInput {
	entries: readonly SessionEntry[];
	leafId: string | null;
	/** The parent's current system prompt (captured separately by the caller). */
	systemPrompt: string;
	/** Goal/contract payload the responder must also see; counted in the budget. */
	goalPayload: unknown;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function contextError(message: string): AuditContextCapture {
	return { ok: false, code: "context_error", message };
}

interface ToolCallPart {
	type: "toolCall";
	id: string;
	name?: string;
}

function toolCallParts(message: ContextMessage): ToolCallPart[] {
	if (message.role !== "assistant") return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is ToolCallPart =>
			Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "toolCall"
				&& typeof (part as { id?: unknown }).id === "string",
	);
}

/**
 * Capture the completed parent prefix for the side channel.
 *
 * `entries`/`leafId` must come from the live session manager; the branch and
 * compaction resolution is delegated to the SDK so this module never
 * reimplements provider replay rules.
 */
export function captureCompletedAuditContext(
	input: CaptureCompletedAuditContextInput,
): AuditContextCapture {
	let built: ReturnType<typeof buildSessionContext>;
	try {
		built = buildSessionContext([...input.entries], input.leafId);
	} catch (error) {
		return contextError(
			"Could not build the parent session context: error details omitted",
		);
	}
	const raw = Array.isArray(built?.messages) ? built.messages : [];
	// Capability declarations live on system messages; the side channel keeps its
	// own real tool set, so they are stripped before any group analysis.
	const messages = raw.filter((message) => message.role !== "system");
	const droppedBySystem = raw.length - messages.length;
	// Only roles whose semantics are known may be replayed. Anything else (a future
	// privileged role, an unknown capability carrier) must fail closed instead of
	// silently becoming seed content for the read-only responder.
	const REPLAYABLE_ROLES = new Set([
		"user",
		"assistant",
		"toolResult",
		"compactionSummary",
		"branchSummary",
		// Session-local informational carriers pi can put in the model context
		// (goal-context events and bash execution records). They carry no capability
		// declaration (system messages are stripped above) and are safe to replay.
		"custom",
		"bashExecution",
	]);
	for (const message of messages) {
		const role = String((message as { role?: unknown }).role ?? "");
		if (!REPLAYABLE_ROLES.has(role)) {
			return contextError(`Parent message role '${role}' cannot be safely replayed.`);
		}
	}

	let prefixEnd = messages.length;
	let groupStart = -1;
	let pending: string[] = [];
	const seen = new Set<string>();

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (message.role === "assistant") {
			if (pending.length > 0) {
				// The previous group never finished; its partial results are not legal.
				prefixEnd = groupStart;
				break;
			}
			const deferred = (message as { deferred?: unknown }).deferred !== undefined
				|| (message as { stopReason?: unknown }).stopReason === "deferred";
			if (deferred) {
				prefixEnd = index;
				break;
			}
			const calls = toolCallParts(message);
			if (calls.length > 0) {
				pending = calls.map((call) => call.id);
				groupStart = index;
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
		if (typeof toolCallId !== "string") return contextError("A toolResult message has no toolCallId.");
		if (pending.length === 0) {
			return contextError(`Orphan toolResult for call '${toolCallId}' appears without an assistant tool call.`);
		}
		if (seen.has(toolCallId)) {
			return contextError(`Duplicate toolResult for call '${toolCallId}'.`);
		}
		const position = pending.indexOf(toolCallId);
		if (position < 0) {
			return contextError(`toolResult for call '${toolCallId}' does not belong to the open assistant tool group.`);
		}
		// A real provider may return the results of parallel tool calls in ANY order.
		// Completeness (every call of the group answered exactly once), duplicates,
		// orphans and cross-group mixing are the errors that matter; intra-group
		// permutation is legal and therefore accepted here.
		seen.add(toolCallId);
		pending.splice(position, 1);
		if (pending.length === 0) groupStart = -1;
	}
	if (pending.length > 0 && prefixEnd === messages.length) {
		// The conversation ends inside an unfinished group (the current
		// update_goal call); drop that whole group, partial results included.
		prefixEnd = groupStart;
	}

	const completed = messages.slice(0, prefixEnd);
	let cloned: ContextMessage[];
	try {
		cloned = structuredClone(completed);
	} catch (error) {
		return contextError(
			"Could not clone the completed context: error details omitted",
		);
	}

	const bytes = byteLength(JSON.stringify({
		systemPrompt: input.systemPrompt,
		messages: cloned,
		goalPayload: input.goalPayload,
	}));
	if (bytes > MAX_AUDIT_CONTEXT_BYTES) {
		return {
			ok: false,
			code: "capacity_exceeded",
			message: `Audit context is ${bytes} bytes, over the ${MAX_AUDIT_CONTEXT_BYTES}-byte limit.`,
		};
	}

	return {
		ok: true,
		context: {
			messages: cloned,
			thinkingLevel: typeof built?.thinkingLevel === "string" ? built.thinkingLevel : "off",
			model: built?.model ?? null,
			droppedMessages: droppedBySystem + (messages.length - prefixEnd),
			bytes,
		},
	};
}
