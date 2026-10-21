import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SUPERVISOR_RESPONDER_REGISTER_EVENT,
	SUPERVISOR_RESPONDER_REGISTER_VERSION,
	registerSupervisorResponderViaEvents,
	validateSupervisorResponderScope,
	type SupervisorResponderScope,
} from "../../src/api/supervisor-routing.ts";
import { appendSupervisorReplyEntry } from "../../src/intercom/native-supervisor-channel.ts";
import {
	createSupervisorDispatcher,
	createSupervisorLaunchHooks,
	disposeSupervisorRouting,
	disposeSupervisorRoutingForOwner,
	registerSupervisorResponderEventListener,
} from "../../src/intercom/fork-supervisor-routing.ts";

function makeEventBus(): ExtensionAPI["events"] {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const listeners = handlers.get(channel) ?? new Set();
			listeners.add(handler);
			handlers.set(channel, listeners);
			return () => listeners.delete(handler);
		},
	};
}

function makePi(events: ExtensionAPI["events"] = makeEventBus()): ExtensionAPI {
	return { on() {}, registerTool() {}, events } as unknown as ExtensionAPI;
}

function scope(overrides: Partial<SupervisorResponderScope> = {}): SupervisorResponderScope {
	return {
		sessionId: "session-1",
		requestId: "delegation-1",
		ownerRunId: "goal-1",
		nodeId: "goal-completion:goal-1:1",
		agent: "goal-auditor",
		...overrides,
	};
}

function setup(liveSessionId: string | null = "session-1") {
	const pi = makePi();
	let ownerSessionId = liveSessionId;
	const disposeListener = registerSupervisorResponderEventListener(pi, () => ownerSessionId);
	const respond = () => ({ kind: "reply" as const, message: "ok" });
	return {
		pi,
		respond,
		getOwnerSessionId: () => ownerSessionId,
		setOwnerSessionId: (next: string | null) => {
			ownerSessionId = next;
		},
		cleanup: () => {
			disposeSupervisorRouting(pi);
			disposeListener();
		},
	};
}

describe("supervisor responder scope validation", () => {
	it("accepts a complete delegation identity", () => {
		const validated = validateSupervisorResponderScope(scope());
		assert.ok("scope" in validated);
		if (!("scope" in validated)) return;
		assert.deepEqual(validated.scope, scope());
	});

	it("rejects a missing, empty, over-long or CRLF identity field", () => {
		for (const field of ["sessionId", "requestId", "ownerRunId", "nodeId", "agent"] as const) {
			const missing = { ...scope() } as Record<string, unknown>;
			delete missing[field];
			assert.ok("error" in validateSupervisorResponderScope(missing), `missing ${field}`);
			assert.ok("error" in validateSupervisorResponderScope(scope({ [field]: "   " })), `blank ${field}`);
			assert.ok("error" in validateSupervisorResponderScope(scope({ [field]: "a\r\nb" })), `crlf ${field}`);
			assert.ok("error" in validateSupervisorResponderScope(scope({ [field]: "x".repeat(257) })), `long ${field}`);
			assert.ok("error" in validateSupervisorResponderScope(scope({ [field]: 7 as unknown as string })), `type ${field}`);
		}
	});

	it("rejects a wildcard agent and non-object scopes", () => {
		assert.ok("error" in validateSupervisorResponderScope(scope({ agent: "*" })));
		assert.ok("error" in validateSupervisorResponderScope(null));
		assert.ok("error" in validateSupervisorResponderScope([]));
		assert.ok("error" in validateSupervisorResponderScope("goal-auditor"));
	});
});

describe("supervisor responder registration", () => {
	it("fails closed with an actionable error when no owner is listening", () => {
		const pi = makePi();
		assert.throws(
			() => registerSupervisorResponderViaEvents({ pi, scope: scope(), respond: () => ({ kind: "reply", message: "x" }) }),
			/pi-subagents is not installed, not ready, or does not support supervisor responder event registration/,
		);
	});

	it("refuses an unsupported event version", () => {
		const pi = makePi();
		registerSupervisorResponderEventListener(pi, () => "session-1");
		const request: Record<string, unknown> = {
			version: SUPERVISOR_RESPONDER_REGISTER_VERSION + 1,
			scope: scope(),
			respond: () => ({ kind: "reply", message: "x" }),
		};
		pi.events.emit(SUPERVISOR_RESPONDER_REGISTER_EVENT, request);
		const result = request.result as { ok: boolean; error?: Error };
		assert.equal(result.ok, false);
		assert.match(String(result.error?.message), /Unsupported supervisor responder registration event version/);
	});

	it("acknowledges a registration and returns an idempotent dispose", () => {
		const harness = setup();
		try {
			const registration = registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope(),
				respond: harness.respond,
			});
			assert.equal(typeof registration.dispose, "function");
			registration.dispose();
			registration.dispose();
			// The entry is gone, so the same scope can be registered again.
			const again = registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope(),
				respond: harness.respond,
			});
			again.dispose();
		} finally {
			harness.cleanup();
		}
	});

	it("refuses a scope that is not the live supervisor owner session", () => {
		const harness = setup("session-1");
		try {
			assert.throws(
				() =>
					registerSupervisorResponderViaEvents({
						pi: harness.pi,
						scope: scope({ sessionId: "session-2" }),
						respond: harness.respond,
					}),
				/not the live supervisor owner session/,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("refuses a duplicate registration for the same delegation attempt", () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope(), respond: harness.respond });
			assert.throws(
				() =>
					registerSupervisorResponderViaEvents({
						pi: harness.pi,
						scope: scope(),
						respond: harness.respond,
					}),
				/already registered for delegation attempt 'delegation-1'/,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a replacement registration alive when an old handle is disposed twice", () => {
		const harness = setup();
		try {
			const first = registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope(), respond: harness.respond });
			first.dispose();
			const second = registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope(), respond: harness.respond });
			// A stale handle must never remove the replacement.
			first.dispose();
			assert.throws(
				() =>
					registerSupervisorResponderViaEvents({
						pi: harness.pi,
						scope: scope(),
						respond: harness.respond,
					}),
				/already registered/,
			);
			second.dispose();
		} finally {
			harness.cleanup();
		}
	});

	it("isolates registrations between owners", () => {
		const first = setup();
		const second = setup();
		try {
			registerSupervisorResponderViaEvents({ pi: first.pi, scope: scope(), respond: first.respond });
			// A different owner with the same scope is a different registry.
			const other = registerSupervisorResponderViaEvents({ pi: second.pi, scope: scope(), respond: second.respond });
			other.dispose();
		} finally {
			first.cleanup();
			second.cleanup();
		}
	});

	it("releases stale session bindings on owner reset but keeps the live session", () => {
		const harness = setup("session-1");
		try {
			const registration = registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope(),
				respond: harness.respond,
			});
			// Same session: nothing is released.
			disposeSupervisorRoutingForOwner(harness.pi, "session-1");
			assert.throws(
				() =>
					registerSupervisorResponderViaEvents({
						pi: harness.pi,
						scope: scope(),
						respond: harness.respond,
					}),
				/already registered/,
			);
			// New session: the stale registration is gone.
			harness.setOwnerSessionId("session-2");
			disposeSupervisorRoutingForOwner(harness.pi, "session-2");
			const replacement = registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope({ sessionId: "session-2" }),
				respond: harness.respond,
			});
			replacement.dispose();
			registration.dispose();
		} finally {
			harness.cleanup();
		}
	});
});

describe("supervisor route binding before the first prompt", () => {
	const identity = (overrides: Partial<{ requestId: string; ownerRunId: string; nodeId: string; agent: string }> = {}) => ({
		requestId: "delegation-1",
		ownerRunId: "goal-1",
		nodeId: "goal-completion:goal-1:1",
		agent: "goal-auditor",
		...overrides,
	});

	const ask = (overrides: Partial<{ askId: string; runId: string; agent: string; childIndex: number }> = {}) => ({
		askId: "ask-1",
		runId: "run-1",
		agent: "goal-auditor",
		childIndex: 0,
		reason: "need_decision" as const,
		message: "what is the release marker?",
		...overrides,
	});

	it("returns no hooks for an attempt with no responder", () => {
		const harness = setup();
		try {
			assert.equal(
				createSupervisorLaunchHooks(harness.pi, identity(), harness.getOwnerSessionId),
				undefined,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("binds the canonical agent and claims only that exact route", async () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope({ agent: "audit-alias" }),
				respond: harness.respond,
			});
			const hooks = createSupervisorLaunchHooks(
				harness.pi,
				identity({ agent: "audit-alias" }),
				harness.getOwnerSessionId,
			);
			assert.ok(hooks);
			// The executor resolves the alias to its canonical agent before the prompt.
			hooks!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: true });
			const dispatcher = createSupervisorDispatcher(harness.pi, harness.getOwnerSessionId);
			const delivered: string[] = [];
			assert.equal(dispatcher.claim(ask(), (message) => delivered.push(message)), true);
			// The requested alias is not a route of its own.
			assert.equal(dispatcher.claim(ask({ askId: "ask-2", agent: "audit-alias" }), () => {}), false);
			await Promise.resolve();
			await Promise.resolve();
			assert.deepEqual(delivered, ["ok"]);
		} finally {
			harness.cleanup();
		}
	});

	it("claims the earliest ask immediately after binding", async () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope(), respond: harness.respond });
			const hooks = createSupervisorLaunchHooks(harness.pi, identity(), harness.getOwnerSessionId);
			assert.ok(hooks);
			hooks!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: true });
			const dispatcher = createSupervisorDispatcher(harness.pi, harness.getOwnerSessionId);
			let delivered: string | undefined;
			assert.equal(dispatcher.claim(ask(), (message) => { delivered = message; }), true);
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(delivered, "ok");
		} finally {
			harness.cleanup();
		}
	});

	it("isolates attempts that share a requestId but differ by node", () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope({ nodeId: "node-a", agent: "agent-a" }),
				respond: harness.respond,
			});
			registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope({ nodeId: "node-b", agent: "agent-b" }),
				respond: harness.respond,
			});
			const hooksA = createSupervisorLaunchHooks(harness.pi, identity({ nodeId: "node-a", agent: "agent-a" }), harness.getOwnerSessionId);
			assert.ok(hooksA);
			hooksA!.beforeNativeChildLaunch({ runId: "run-a", agent: "agent-a", childIndex: 0, bridgeActive: true });
			const dispatcher = createSupervisorDispatcher(harness.pi, harness.getOwnerSessionId);
			assert.equal(dispatcher.claim(ask({ runId: "run-a", agent: "agent-a" }), () => {}), true);
			// The sibling attempt is still unbound, so its route is not claimed.
			assert.equal(dispatcher.claim(ask({ askId: "ask-b", runId: "run-b", agent: "agent-b" }), () => {}), false);
		} finally {
			harness.cleanup();
		}
	});

	it("refuses a route already bound to another attempt", () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope({ nodeId: "node-a" }), respond: harness.respond });
			registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope({ nodeId: "node-b" }), respond: harness.respond });
			const hooksA = createSupervisorLaunchHooks(harness.pi, identity({ nodeId: "node-a" }), harness.getOwnerSessionId);
			const hooksB = createSupervisorLaunchHooks(harness.pi, identity({ nodeId: "node-b" }), harness.getOwnerSessionId);
			assert.ok(hooksA && hooksB);
			hooksA!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: true });
			assert.throws(
				() => hooksB!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: true }),
				/already bound to another delegation attempt/,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("refuses a second child launch for the same hooks", () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope(), respond: harness.respond });
			const hooks = createSupervisorLaunchHooks(harness.pi, identity(), harness.getOwnerSessionId);
			assert.ok(hooks);
			hooks!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: true });
			assert.throws(
				() => hooks!.beforeNativeChildLaunch({ runId: "run-2", agent: "goal-auditor", childIndex: 0, bridgeActive: true }),
				/was already bound/,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("refuses to bind after the registration was released", () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope(), respond: harness.respond });
			const hooks = createSupervisorLaunchHooks(harness.pi, identity(), harness.getOwnerSessionId);
			assert.ok(hooks);
			hooks!.release();
			assert.throws(
				() => hooks!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: true }),
				/disposed before the child launched/,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("leaves the attempt unbound when the child has no supervisor capability", () => {
		const harness = setup();
		try {
			registerSupervisorResponderViaEvents({ pi: harness.pi, scope: scope(), respond: harness.respond });
			const hooks = createSupervisorLaunchHooks(harness.pi, identity(), harness.getOwnerSessionId);
			assert.ok(hooks);
			hooks!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: false });
			const dispatcher = createSupervisorDispatcher(harness.pi, harness.getOwnerSessionId);
			assert.equal(dispatcher.claim(ask(), () => {}), false);
		} finally {
			harness.cleanup();
		}
	});

	it("fails closed instead of falling back when the owner session changed before the ask", () => {
		const harness = setup();
		try {
			const failures: Error[] = [];
			registerSupervisorResponderViaEvents({
				pi: harness.pi,
				scope: scope(),
				respond: harness.respond,
				onFailure: (error) => failures.push(error),
			});
			const hooks = createSupervisorLaunchHooks(harness.pi, identity(), harness.getOwnerSessionId);
			assert.ok(hooks);
			hooks!.beforeNativeChildLaunch({ runId: "run-1", agent: "goal-auditor", childIndex: 0, bridgeActive: true });
			harness.setOwnerSessionId("session-other");
			const dispatcher = createSupervisorDispatcher(harness.pi, harness.getOwnerSessionId);
			let delivered = false;
			// Still claimed: an orphaned bound route must never wake the parent or detach.
			assert.equal(dispatcher.claim(ask(), () => { delivered = true; }), true);
			assert.equal(failures.length, 1);
			assert.match(String(failures[0]?.message), /owner_session_changed/);
			assert.equal(delivered, false);
		} finally {
			harness.cleanup();
		}
	});
	it("a journaling failure never echoes the external exception body or stack", async () => {
		const seen: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			seen.push(args);
		};
		try {
			const pi = { events: makeEventBus(), registerTool: () => {}, appendEntry: () => { throw new Error("SYNTHETIC_EXTERNAL_MARKER_CTX"); } };
			appendSupervisorReplyEntry(
				pi as never,
				{ id: "ask-1", reason: "need_decision", message: "q", expectsReply: true, orchestratorSessionId: "s", runId: "r", agent: "a", childIndex: 0, createdAt: 1, expiresAt: 2, channelDir: "/tmp/x", requestFile: "/tmp/x/requests/ask-1.json" } as never,
				{ id: "ask-1", message: "ALPHA", createdAt: 1 } as never,
			);
		} finally {
			console.error = original;
		}
		const text = JSON.stringify(seen);
		assert.equal(text.includes("SYNTHETIC_EXTERNAL_MARKER_CTX"), false);
		assert.equal(/\bat .+\(.+:\d+:\d+\)/.test(text), false);
	});
});
