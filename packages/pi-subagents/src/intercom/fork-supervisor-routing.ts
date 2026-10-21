/**
 * Owner-side supervisor responder routing (fork-only).
 *
 * Responsibilities:
 * - hold one owner-local registry keyed by the owning ExtensionAPI object;
 * - accept a registration only for a complete delegation identity, validated
 *   against the live supervisor owner session id;
 * - bind a registration to the real child route (runId + canonical agent +
 *   childIndex) exactly once, before the child's first prompt;
 * - claim that route's asks, answer them through a caller-supplied delivery
 *   closure, and fail closed — never fall back to native wake/detach — once a
 *   claimed ask cannot be answered or delivered;
 * - release bindings on terminal, owner session reset and shutdown.
 *
 * Nothing here changes ordinary subagent/workflow behaviour: a route with no
 * bound registration is not claimed, so the native channel keeps its existing
 * pending/wake/detach handling byte-for-byte.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SUPERVISOR_RESPONDER_REGISTER_EVENT,
	SUPERVISOR_RESPONDER_REGISTER_VERSION,
	validateSupervisorResponderScope,
	type SupervisorResponder,
	type SupervisorResponderOutcome,
	type SupervisorResponderReason,
	type SupervisorResponderRegistration,
	type SupervisorResponderRegistrationRequest,
	type SupervisorResponderRegistrationResult,
	type SupervisorResponderRequest,
	type SupervisorResponderScope,
} from "../api/supervisor-routing.ts";

/** Per-reply hard bound; matches the coordination-record reply budget (8 KiB). */
export const MAX_SUPERVISOR_RESPONDER_REPLY_BYTES = 8 * 1024;

/** Identity of the delegation attempt a consumer registered for. */
export interface SupervisorDelegationIdentity {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
}

/** The real child route, resolved by the executor before the first prompt. */
export interface SupervisorChildRoute {
	runId: string;
	/** Canonical agent resolved by the executor; never the requested alias. */
	agent: string;
	childIndex: number;
	parentSessionId?: string;
	/** False when the child carries no supervisor capability; no binding is made. */
	bridgeActive: boolean;
}

export interface SupervisorLaunchHooks {
	/** Called once, after the real runId exists and before any child prompt. */
	beforeNativeChildLaunch(route: SupervisorChildRoute): void;
	/** Idempotent; drops the pending (or bound) registration for this launch. */
	release(): void;
}

export type SupervisorAskLifecycle = "resolved" | "expired" | "inactive" | "missing" | "wrong-session";

export interface SupervisorAskInput {
	askId: string;
	runId: string;
	agent: string;
	childIndex: number;
	reason: SupervisorResponderReason;
	message: string;
	interview?: unknown;
	deadlineAt?: number;
}

export interface SupervisorDispatcher {
	/**
	 * Synchronously claim an ask for a bound responder. True means "this ask is
	 * responder-managed": the caller must skip the native parent wake and detach.
	 * False means no responder owns this route, so default behaviour applies.
	 */
	claim(input: SupervisorAskInput, deliver: (message: string) => void): boolean;
	/** Native lifecycle observation for an ask this dispatcher may own. */
	observe(askId: string, lifecycle: SupervisorAskLifecycle): void;
}

type AskState = "claimed" | "running" | "delivered" | "failed" | "cancelled";

interface AskRecord {
	askId: string;
	state: AskState;
	registration: Registration;
	controller: AbortController;
	delivered: boolean;
}

interface Registration {
	scope: SupervisorResponderScope;
	respond: SupervisorResponder;
	onFailure?: (error: Error) => void;
	disposed: boolean;
	failureNotified: boolean;
	bound?: SupervisorChildRoute;
}

interface OwnerRegistry {
	registrations: Map<string, Registration>;
	pendingByIdentity: Map<string, Registration>;
	byRoute: Map<string, Registration>;
	asks: Map<string, AskRecord>;
	disposed: boolean;
}

/** Identity key of the owning extension instance (one registry per owner). */
type OwnerKey = Pick<ExtensionAPI, "events">;

const registries = new WeakMap<OwnerKey, OwnerRegistry>();

function registryFor(pi: OwnerKey, create: boolean): OwnerRegistry | undefined {
	const existing = registries.get(pi);
	if (existing || !create) return existing;
	const created: OwnerRegistry = {
		registrations: new Map(),
		pendingByIdentity: new Map(),
		byRoute: new Map(),
		asks: new Map(),
		disposed: false,
	};
	registries.set(pi, created);
	return created;
}

function identityKey(scope: SupervisorResponderScope): string {
	return [scope.sessionId, scope.requestId, scope.ownerRunId, scope.nodeId, scope.agent].join("\u0000");
}

function delegationKey(sessionId: string, identity: SupervisorDelegationIdentity): string {
	return [sessionId, identity.requestId, identity.ownerRunId, identity.nodeId, identity.agent].join("\u0000");
}

function routeKey(runId: string, agent: string, childIndex: number): string {
	return `${runId}\u0000${agent}\u0000${childIndex}`;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function safeMessage(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	return trimmed.length > 1024 ? `${trimmed.slice(0, 1024)}…` : trimmed;
}

/**
 * Install the owner-side registration listener. `getOwnerSessionId` must read
 * the LIVE supervisor owner session id (the SDK runtime session id), never a
 * session file path or a display alias.
 */
export function registerSupervisorResponderEventListener(
	pi: ExtensionAPI,
	getOwnerSessionId: () => string | null,
): () => void {
	return pi.events.on(SUPERVISOR_RESPONDER_REGISTER_EVENT, (rawRequest) => {
		if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) return;
		const request = rawRequest as Record<string, unknown>;
		if (request.result !== undefined) return;
		try {
			if (request.version !== SUPERVISOR_RESPONDER_REGISTER_VERSION) {
				throw new Error(
					`Unsupported supervisor responder registration event version '${String(request.version)}'.`,
				);
			}
			const validated = validateSupervisorResponderScope(request.scope);
			if ("error" in validated) throw new Error(validated.error);
			const respond = request.respond;
			if (typeof respond !== "function") {
				throw new Error("Supervisor responder must be a function: (request) => outcome.");
			}
			if (request.onFailure !== undefined && typeof request.onFailure !== "function") {
				throw new Error("Supervisor responder onFailure must be a function when provided.");
			}
			const registration = registerSupervisorResponder({
				pi,
				scope: validated.scope,
				respond: respond as SupervisorResponder,
				onFailure: request.onFailure as ((error: Error) => void) | undefined,
				getOwnerSessionId,
			});
			request.result = { ok: true, registration } satisfies SupervisorResponderRegistrationResult;
		} catch (error) {
			request.result = {
				ok: false,
				error: error instanceof Error ? error : new Error(String(error)),
			} satisfies SupervisorResponderRegistrationResult;
		}
	});
}

function registerSupervisorResponder(input: {
	pi: ExtensionAPI;
	scope: SupervisorResponderScope;
	respond: SupervisorResponder;
	onFailure?: (error: Error) => void;
	getOwnerSessionId: () => string | null;
}): SupervisorResponderRegistration {
	const registry = registryFor(input.pi, true);
	if (!registry || registry.disposed) {
		throw new Error("The pi-subagents supervisor router has already been disposed.");
	}
	const liveSessionId = input.getOwnerSessionId();
	// Fail closed: without a live owner session id there is no way to prove this scope
	// belongs to the current runtime owner, so the registration must be refused rather
	// than accepted (an unbound registration would silently fall back to the default
	// supervisor path at child launch).
	if (!liveSessionId) {
		throw new Error("The supervisor responder cannot be registered without a live owner session id.");
	}
	if (liveSessionId !== input.scope.sessionId) {
		throw new Error(
			`Supervisor responder scope.sessionId '${input.scope.sessionId}' is not the live supervisor owner session '${liveSessionId}'.`,
		);
	}
	const key = identityKey(input.scope);
	if (registry.registrations.has(key)) {
		throw new Error(
			`A supervisor responder is already registered for delegation attempt '${input.scope.requestId}'.`,
		);
	}
	const registration: Registration = {
		scope: { ...input.scope },
		respond: input.respond,
		...(input.onFailure ? { onFailure: input.onFailure } : {}),
		disposed: false,
		failureNotified: false,
	};
	registry.registrations.set(key, registration);
	registry.pendingByIdentity.set(key, registration);
	return {
		dispose: () => {
			disposeRegistration(registry, key, registration);
		},
	};
}

function disposeRegistration(registry: OwnerRegistry, key: string, registration: Registration): void {
	if (registration.disposed) return;
	registration.disposed = true;
	// Only this registration is removed; a replacement registered on the same
	// scope keeps working because it owns its own map entries.
	if (registry.registrations.get(key) === registration) registry.registrations.delete(key);
	if (registry.pendingByIdentity.get(key) === registration) registry.pendingByIdentity.delete(key);
	if (registration.bound) {
		const boundKey = routeKey(registration.bound.runId, registration.bound.agent, registration.bound.childIndex);
		if (registry.byRoute.get(boundKey) === registration) registry.byRoute.delete(boundKey);
	}
	// Idempotent terminal cleanup: cancel any live ask, then DROP every ask record that
	// referenced this registration so the responder/onFailure closures (and the audit
	// context they hold) do not survive the attempt. Owner shutdown keeps its own sweep.
	for (const [askId, ask] of [...registry.asks.entries()]) {
		if (ask.registration !== registration) continue;
		if (ask.state === "claimed" || ask.state === "running") {
			ask.state = "cancelled";
			ask.controller.abort();
		}
		registry.asks.delete(askId);
	}
}

/**
 * Resolve the pending registration for one delegation attempt and return the
 * pre-launch binding hooks. Undefined when this attempt has no responder, in
 * which case the executor keeps its original launch path.
 */
export function createSupervisorLaunchHooks(
	pi: ExtensionAPI,
	identity: SupervisorDelegationIdentity,
	getOwnerSessionId: () => string | null,
): SupervisorLaunchHooks | undefined {
	const registry = registryFor(pi, false);
	if (!registry || registry.disposed) return undefined;
	const liveSessionId = getOwnerSessionId();
	// A REGISTERED attempt whose owner is gone or changed must fail the launch instead of
	// silently returning undefined (which would start the child on the default path).
	const registered = [...registry.pendingByIdentity.values()].find(
		(candidate) => !candidate.disposed && candidate.scope.requestId === identity.requestId,
	);
	if (registered) {
		if (!liveSessionId) {
			throw new Error(
				`Delegation attempt '${identity.requestId}' has a registered supervisor responder but no live owner session; refusing to start the child without its responder.`,
			);
		}
		if (registered.scope.sessionId !== liveSessionId) {
			throw new Error(
				`Delegation attempt '${identity.requestId}' was registered for owner session '${registered.scope.sessionId}' but the live owner is '${liveSessionId}'; refusing to start the child without its responder.`,
			);
		}
	}
	if (!liveSessionId) return undefined;
	const key = delegationKey(liveSessionId, identity);
	const registration = registry.pendingByIdentity.get(key);
	if (!registration || registration.disposed) return undefined;

	let consumed = false;
	return {
		beforeNativeChildLaunch: (route) => {
			if (consumed) {
				throw new Error(
					`Supervisor route for delegation attempt '${identity.requestId}' was already bound; a second child launch is not supported.`,
				);
			}
			consumed = true;
			if (registration.disposed) {
				throw new Error(
					`Supervisor responder for delegation attempt '${identity.requestId}' was disposed before the child launched.`,
				);
			}
			const currentSessionId = getOwnerSessionId();
			if (currentSessionId !== registration.scope.sessionId) {
				throw new Error(
					`Supervisor responder for delegation attempt '${identity.requestId}' belongs to session '${registration.scope.sessionId}', not the live owner '${String(currentSessionId)}'.`,
				);
			}
			if (!Number.isInteger(route.childIndex) || route.childIndex < 0) {
				throw new Error(
					`Supervisor route for delegation attempt '${identity.requestId}' has an invalid childIndex '${String(route.childIndex)}'.`,
				);
			}
			if (!route.runId.trim() || !route.agent.trim()) {
				throw new Error(
					`Supervisor route for delegation attempt '${identity.requestId}' is missing the real runId or canonical agent.`,
				);
			}
			// A child without supervisor capability can never ask; leave the
			// registration unbound so no ask is claimed and nothing detaches.
			if (!route.bridgeActive) return;
			const keyForRoute = routeKey(route.runId, route.agent, route.childIndex);
			const existing = registry.byRoute.get(keyForRoute);
			if (existing && existing !== registration) {
				throw new Error(
					`Supervisor route '${route.runId}#${route.childIndex} ${route.agent}' is already bound to another delegation attempt.`,
				);
			}
			registration.bound = { ...route };
			registry.byRoute.set(keyForRoute, registration);
			registry.pendingByIdentity.delete(identityKey(registration.scope));
		},
		release: () => {
			disposeRegistration(registry, identityKey(registration.scope), registration);
		},
	};
}

/**
 * Owner-side ask dispatcher used by the native supervisor channel. A claimed
 * ask never falls back to native wake/detach, even when it fails.
 */
export function createSupervisorDispatcher(
	pi: ExtensionAPI,
	getOwnerSessionId: () => string | null,
): SupervisorDispatcher {
	const fail = (ask: AskRecord, code: string, message: string): void => {
		if (ask.state === "delivered" || ask.state === "failed" || ask.state === "cancelled") return;
		ask.state = "failed";
		ask.controller.abort();
		const registration = ask.registration;
		if (registration.failureNotified) return;
		registration.failureNotified = true;
		// `code` and `message` are already bounded/fixed by the callers above.
		const error = new Error(`${code}: ${safeMessage(message, "supervisor responder failed")}`);
		(error as Error & { code?: string }).code = code;
		try {
			registration.onFailure?.(error);
		} catch {
			// The audit's own cancellation path owns its diagnostics; a throwing
			// callback must not crash the native channel's poll loop.
		}
	};

	const run = (ask: AskRecord, input: SupervisorAskInput, deliver: (message: string) => void): void => {
		const registration = ask.registration;
		ask.state = "running";
		const request: SupervisorResponderRequest = {
			requestId: input.askId,
			reason: input.reason,
			message: input.message,
			...(input.interview !== undefined ? { interview: input.interview } : {}),
			runId: input.runId,
			agent: input.agent,
			childIndex: input.childIndex,
			...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
			signal: ask.controller.signal,
		};
		void Promise.resolve()
			.then(() => registration.respond(request))
			.then((outcome: SupervisorResponderOutcome) => {
				if (ask.state === "cancelled" || ask.state === "failed") return;
				if (!outcome || typeof outcome !== "object") {
					fail(ask, "invalid_outcome", "responder returned no outcome");
					return;
				}
				if (outcome.kind === "error") {
					fail(ask, safeMessage(outcome.code, "responder_error"), outcome.message);
					return;
				}
				if (outcome.kind !== "reply" || typeof outcome.message !== "string") {
					fail(ask, "invalid_outcome", "responder returned an unsupported outcome shape");
					return;
				}
				const message = outcome.message.trim();
				if (!message) {
					fail(ask, "empty_reply", "responder returned an empty reply");
					return;
				}
				if (byteLength(message) > MAX_SUPERVISOR_RESPONDER_REPLY_BYTES) {
					fail(ask, "reply_too_large", `reply exceeds ${MAX_SUPERVISOR_RESPONDER_REPLY_BYTES} bytes`);
					return;
				}
				if (ask.controller.signal.aborted) {
					fail(ask, "cancelled", "ask was cancelled before delivery");
					return;
				}
				try {
					deliver(message);
				} catch (error) {
					// The native write failed; the underlying exception text must not cross
					// this boundary (diagnostics never echo external exception bodies).
					void error;
					fail(ask, "delivery_failed", "the native supervisor reply could not be written");
					return;
				}
				ask.state = "delivered";
				ask.delivered = true;
			})
			.catch((error: unknown) => {
				// Same boundary rule for a responder rejection: fixed text only.
				void error;
				fail(ask, "responder_error", "the supervisor responder failed");
			});
	};

	return {
		claim: (input, deliver) => {
			const registry = registryFor(pi, false);
			if (!registry || registry.disposed) return false;
			const registration = registry.byRoute.get(routeKey(input.runId, input.agent, input.childIndex));
			if (!registration || registration.disposed) return false;
			const liveSessionId = getOwnerSessionId();
			if (liveSessionId !== registration.scope.sessionId) {
				// A bound route whose owner session is gone must fail closed: the
				// audit is already orphaned and must never be answered by a stale
				// responder or handed back to the native wake/detach path.
				const orphan: AskRecord = {
					askId: input.askId,
					state: "claimed",
					registration,
					controller: new AbortController(),
					delivered: false,
				};
				registry.asks.set(input.askId, orphan);
				fail(orphan, "owner_session_changed", "supervisor owner session changed during the audit");
				return true;
			}
			const existing = registry.asks.get(input.askId);
			if (existing) {
				// Duplicate observation of the same ask: reuse in-flight handling and
				// never re-prompt the responder or rewrite the reply.
				return true;
			}
			const ask: AskRecord = {
				askId: input.askId,
				state: "claimed",
				registration,
				controller: new AbortController(),
				delivered: false,
			};
			registry.asks.set(input.askId, ask);
			run(ask, input, deliver);
			return true;
		},
		observe: (askId, lifecycle) => {
			const registry = registryFor(pi, false);
			if (!registry) return;
			const ask = registry.asks.get(askId);
			if (!ask) return;
			if (ask.state === "delivered") {
				// A delivered reply removes the request file, so "missing" here is the
				// expected post-delivery observation and must not fail the audit.
				return;
			}
			if (lifecycle === "resolved") {
				ask.state = "delivered";
				ask.delivered = true;
				ask.controller.abort();
				return;
			}
			fail(ask, `ask_${lifecycle.replace("-", "_")}`, `supervisor ask became ${lifecycle}`);
		},
	};
}

/**
 * Release every registration owned by this ExtensionAPI whose session is no
 * longer live (owner session reset, session tree switch, shutdown).
 */
export function disposeSupervisorRoutingForOwner(pi: ExtensionAPI, liveSessionId: string | null): void {
	const registry = registryFor(pi, false);
	if (!registry) return;
	for (const [key, registration] of [...registry.registrations]) {
		if (liveSessionId && registration.scope.sessionId === liveSessionId) continue;
		disposeRegistration(registry, key, registration);
	}
}

/** Full teardown used by the owning extension on shutdown. */
export function disposeSupervisorRouting(pi: ExtensionAPI): void {
	const registry = registryFor(pi, false);
	if (!registry) return;
	registry.disposed = true;
	for (const [key, registration] of [...registry.registrations]) {
		disposeRegistration(registry, key, registration);
	}
	for (const ask of registry.asks.values()) {
		if (ask.state === "claimed" || ask.state === "running") {
			ask.state = "cancelled";
			ask.controller.abort();
		}
	}
	registry.asks.clear();
	registries.delete(pi);
}
