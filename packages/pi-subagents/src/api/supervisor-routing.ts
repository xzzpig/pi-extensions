/**
 * Versioned cross-extension supervisor-responder routing API (fork-only).
 *
 * A consumer extension (pi-goal-x's completion audit) registers one responder
 * for ONE exact delegation attempt before the request is emitted. The
 * pi-subagents owner binds that registration to the real child route (runId +
 * canonical agent + childIndex) before the child's first prompt, and then
 * hands that attempt's `need_decision` / `interview_request` asks to the
 * responder instead of waking the parent model or detaching the child.
 *
 * The registration travels through the same synchronous, in-process event
 * contract as `runtime-agent-events.ts`: the client emits a request object and
 * reads the owner's result back out of that same object, so an owner that is
 * missing, not ready, or older than this API fails closed with an actionable
 * error instead of silently degrading to native wake/detach.
 *
 * This module is deliberately types + constants + the client call only. The
 * owner-side registry, launch binding and ask dispatcher live in
 * `../intercom/fork-supervisor-routing.ts` so the model-facing surface stays
 * unchanged.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUPERVISOR_RESPONDER_REGISTER_EVENT = "pi-subagents:supervisor-responder-register:v1";
export const SUPERVISOR_RESPONDER_REGISTER_VERSION = 1;

/**
 * Identity of the one delegation attempt a responder owns.
 *
 * `requestId` is the DELEGATION attempt id (the id the structured delegation
 * request was emitted with), never the supervisor ask id. `agent` is the agent
 * name the request asked for; the owner binds the canonical resolved agent
 * separately, so an alias can never be used to take over another agent's asks.
 */
export interface SupervisorResponderScope {
	sessionId: string;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
}

export type SupervisorResponderReason = "need_decision" | "interview_request" | "progress_update";

/**
 * One supervisor ask routed to a responder.
 *
 * `requestId` here is the ASK id (the native supervisor request id); consumers
 * that keep a coordination record rename it to `supervisorRequestId` to keep it
 * distinct from `SupervisorResponderScope.requestId`.
 */
export interface SupervisorResponderRequest {
	requestId: string;
	reason: SupervisorResponderReason;
	message: string;
	interview?: unknown;
	runId: string;
	agent: string;
	childIndex: number;
	/** Absolute deadline for this ask; absent means only the audit deadline applies. */
	deadlineAt?: number;
	signal: AbortSignal;
}

export type SupervisorResponderOutcome =
	| { kind: "reply"; message: string }
	| { kind: "error"; code: string; message: string };

export type SupervisorResponder = (
	request: SupervisorResponderRequest,
) => SupervisorResponderOutcome | Promise<SupervisorResponderOutcome>;

/** Owner-side handle returned through the registration event. */
export interface SupervisorResponderRegistration {
	/** Idempotent; removes only this registration. */
	dispose(): void;
}

export type SupervisorResponderRegistrationResult =
	| { ok: true; registration: SupervisorResponderRegistration }
	| { ok: false; error: Error };

export interface SupervisorResponderRegistrationRequest {
	version: 1;
	scope: SupervisorResponderScope;
	respond: SupervisorResponder;
	/** Called at most once per scope when a claimed ask cannot be answered or delivered. */
	onFailure?: (error: Error) => void;
	result?: SupervisorResponderRegistrationResult;
}

export interface RegisterSupervisorResponderViaEventsInput {
	pi: Pick<ExtensionAPI, "events">;
	scope: SupervisorResponderScope;
	respond: SupervisorResponder;
	onFailure?: (error: Error) => void;
}

const MAX_IDENTITY_LENGTH = 256;
const IDENTITY_FIELDS = ["sessionId", "requestId", "ownerRunId", "nodeId", "agent"] as const;

function identityError(field: string, reason: string): string {
	return `Supervisor responder scope.${field} ${reason}.`;
}

/**
 * Validate a scope strictly: every identity field must be present, non-empty,
 * CR/LF-free and within the delegation identity byte budget. A scope that only
 * names an agent (the "take over every ask of this agent" shape) is refused.
 */
export function validateSupervisorResponderScope(
	scope: unknown,
): { scope: SupervisorResponderScope } | { error: string } {
	if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
		return { error: "Supervisor responder scope must be an object." };
	}
	const candidate = scope as Record<string, unknown>;
	for (const field of IDENTITY_FIELDS) {
		const value = candidate[field];
		if (typeof value !== "string") return { error: identityError(field, "must be a string") };
		if (!value.trim()) return { error: identityError(field, "must not be empty") };
		if (value.length > MAX_IDENTITY_LENGTH) {
			return { error: identityError(field, `must be at most ${MAX_IDENTITY_LENGTH} characters`) };
		}
		if (/[\r\n]/.test(value)) return { error: identityError(field, "must not contain CR or LF") };
	}
	if (candidate.agent === "*") {
		return { error: "Supervisor responder scope.agent must name one agent; wildcard takeover is not supported." };
	}
	return {
		scope: {
			sessionId: candidate.sessionId as string,
			requestId: candidate.requestId as string,
			ownerRunId: candidate.ownerRunId as string,
			nodeId: candidate.nodeId as string,
			agent: candidate.agent as string,
		},
	};
}

function errorFrom(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * Register a responder for one exact delegation attempt through the installed
 * pi-subagents owner in this Pi process. Throws an actionable error when the
 * owner is missing, older than this API, or refuses the registration.
 */
export function registerSupervisorResponderViaEvents(
	input: RegisterSupervisorResponderViaEventsInput,
): SupervisorResponderRegistration {
	const validated = validateSupervisorResponderScope(input.scope);
	if ("error" in validated) throw new Error(validated.error);
	if (typeof input.respond !== "function") {
		throw new Error("Supervisor responder must be a function: (request) => outcome.");
	}
	if (input.onFailure !== undefined && typeof input.onFailure !== "function") {
		throw new Error("Supervisor responder onFailure must be a function when provided.");
	}
	const request: SupervisorResponderRegistrationRequest = {
		version: SUPERVISOR_RESPONDER_REGISTER_VERSION,
		scope: validated.scope,
		respond: input.respond,
		...(input.onFailure ? { onFailure: input.onFailure } : {}),
	};
	input.pi.events.emit(SUPERVISOR_RESPONDER_REGISTER_EVENT, request);
	const result = request.result as unknown;
	if (result === undefined) {
		throw new Error(
			"pi-subagents is not installed, not ready, or does not support supervisor responder event registration.",
		);
	}
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const candidate = result as Record<string, unknown>;
		if (
			candidate.ok === true &&
			candidate.registration &&
			typeof candidate.registration === "object" &&
			typeof (candidate.registration as { dispose?: unknown }).dispose === "function"
		) {
			const registration = candidate.registration as SupervisorResponderRegistration;
			let disposed = false;
			return {
				dispose: () => {
					if (disposed) return;
					disposed = true;
					registration.dispose();
				},
			};
		}
		if (candidate.ok === false && candidate.error instanceof Error) throw candidate.error;
		if (candidate.ok === false) throw errorFrom(candidate.error);
	}
	throw new Error("pi-subagents returned a malformed supervisor responder registration result.");
}
