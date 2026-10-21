import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorResponderRequest } from "@xzzpig/pi-subagents/supervisor-routing";
import {
	MAX_AUDIT_ASKS,
	MAX_AUDIT_ASK_BYTES,
	MAX_AUDIT_RECORD_BYTES,
	MAX_AUDIT_REPLY_BYTES,
	OMITTED_ERROR_DETAILS,
	SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL,
	createAuditSupervisorSidechannel,
	invalidateAuditSidechannelsForOwner,
	invalidateAllAuditSidechannels,
	invalidateAuditSidechannels,
	registerAuditSidechannelLifecycle,
	type AuditSideSession,
	type AuditSideSessionInput,
	type AuditSidechannelDeps,
} from "../extensions/goal-audit-sidechannel.ts";

const SESSION_ID = "session-1";

function makeCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
	const base = {
		cwd: "/tmp/audit-sidechannel",
		getSystemPrompt: () => "PARENT SYSTEM PROMPT",
		model: { provider: "mock", id: "mock-model" },
		modelRegistry: { runtime: { id: "parent-runtime" } },
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => null,
		},
	};
	return { ...base, ...overrides } as unknown as ExtensionContext;
}

interface FakeSessionOptions {
	onPrompt?: (input: AuditSideSessionInput, text: string) => Promise<void> | void;
	promptError?: unknown;
	idleError?: unknown;
	usage?: Array<Record<string, unknown>>;
	/** Deliver each generated message twice (duplicate listener delivery). */
	emitTwice?: boolean;
	/** Emitted by the SDK when an abort closes a generation mid-flight. */
	abortUsage?: Record<string, unknown>;
}

function makeSessionFactory(options: FakeSessionOptions = {}) {
	const state = {
		created: 0,
		prompts: [] as string[],
		disposed: 0,
		aborted: 0,
		inputs: [] as AuditSideSessionInput[],
	};
	const factory = async (input: AuditSideSessionInput): Promise<AuditSideSession> => {
		state.created += 1;
		state.inputs.push(input);
		let listener: ((message: unknown) => void) | undefined;
		return {
			prompt: async (text) => {
				state.prompts.push(text);
				if (options.promptError) throw options.promptError;
				await options.onPrompt?.(input, text);
				// A real provider emits a NEW assistant message per generation, each with
				// its own id; mirror that so per-generation billing can be asserted.
				const generation = state.prompts.length;
				for (const usage of options.usage ?? []) {
					const message = { id: `gen-${generation}`, ...usage };
					listener?.(message);
					if (options.emitTwice) listener?.(message);
				}
			},
			waitForIdle: async () => {
				if (options.idleError) throw options.idleError;
			},
			abort: async () => {
				state.aborted += 1;
				// A real abort closes the in-flight generation with a message_end that
				// still carries what was spent; billing must survive that path.
				if (options.abortUsage) listener?.({ id: `abort-${state.aborted}`, usage: options.abortUsage });
			},
			dispose: () => {
				state.disposed += 1;
			},
			subscribeMessageEnd: (handler) => {
				listener = handler;
				return () => {
					listener = undefined;
				};
			},
		};
	};
	return { factory, state };
}

function ask(overrides: Partial<SupervisorResponderRequest> = {}): SupervisorResponderRequest {
	return {
		requestId: "ask-1",
		reason: "need_decision",
		message: "What is the release marker?",
		runId: "run-1",
		agent: "goal-auditor",
		childIndex: 0,
		deadlineAt: Date.now() + 60_000,
		signal: new AbortController().signal,
		...overrides,
	};
}

function deps(overrides: Partial<AuditSidechannelDeps> = {}): AuditSidechannelDeps {
	return {
		ctx: makeCtx(),
		getThinkingLevel: () => "off",
		goalPayload: { goal: "g1" },
		getAuditDeadlineAt: () => Date.now() + 120_000,
		requestId: "delegation-1",
		ownerRunId: "goal-1",
		nodeId: "goal-completion:goal-1:1",
		...overrides,
	};
}

/** Submit through the real custom tool the side channel hands to the session. */
async function submit(input: AuditSideSessionInput, value: Record<string, unknown>): Promise<void> {
	const tool = input.customTools.find((candidate) => candidate.name === SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL);
	assert.ok(tool, "submit tool must be registered");
	await (tool.execute as unknown as (id: string, params: unknown) => Promise<unknown>)("submit-1", value);
}

describe("audit supervisor side channel", () => {
	it("freezes the parent context before the first question (later mutations cannot leak in)", async () => {
		let systemPrompt = "SYSTEM-BEFORE";
		let model: unknown = { provider: "p-before", id: "m-before" };
		let thinking = "high";
		let entries: unknown[] = [];
		const mutableCtx = {
			cwd: "/tmp/audit-sidechannel",
			getSystemPrompt: () => systemPrompt,
			sessionManager: { getEntries: () => entries, getLeafId: () => "e1", getSessionId: () => "s-1" },
			modelRegistry: { runtime: { borrowed: true } },
		};
		Object.defineProperty(mutableCtx, "model", { get: () => model });
		const { factory, state } = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "ALPHA" }) });
		const channel = createAuditSupervisorSidechannel(deps({
			ctx: mutableCtx as never,
			getThinkingLevel: () => thinking,
			goalPayload: { goalId: "g1", "CONTRACT-MARKER": true },
			sessionFactory: factory,
		}));
		// Mutate the parent AFTER the attempt was created but BEFORE the question.
		systemPrompt = "SYSTEM-AFTER";
		model = { provider: "p-after", id: "m-after" };
		thinking = "off";
		entries = [];
		const outcome = await channel.respond(ask());
		assert.deepEqual(outcome, { kind: "reply", message: "ALPHA" });
		const input = state.inputs[0]!;
		// The parent's effective thinking level comes from the captured branch context
		// (an empty branch reports "off"); the later getter change must not leak in.
		assert.equal(input.thinkingLevel, "high", "the parent getter is authoritative and frozen");
		assert.notEqual(input.thinkingLevel, "low", "a later getter change cannot leak in");
		assert.deepEqual(input.model, { provider: "p-before", id: "m-before" }, "the captured model is frozen");
		const capturedPrompt = input.resourceLoader.getSystemPrompt() ?? "";
		assert.ok(capturedPrompt.startsWith("SYSTEM-BEFORE"), "the captured system prompt is frozen");
		assert.doesNotMatch(capturedPrompt, /SYSTEM-AFTER/, "a later parent system prompt cannot leak in");
		// Paths are frozen too: the live session manager is not re-read per ask.
		assert.equal(state.created, 1, "one session for the frozen attempt");
		// The goal payload is part of what the responder actually receives.
		assert.match(state.prompts[0]!, /CONTRACT-MARKER/);
	});

	it("fails closed when the parent model runtime cannot be borrowed", async () => {
		let created = 0;
		const ctx = makeCtx({ modelRegistry: {} });
		const delegate = makeSessionFactory({ onPrompt: (i) => submit(i, { kind: "reply", message: "OK" }) });
		const channel = createAuditSupervisorSidechannel(deps({
			ctx,
			sessionFactory: async (input) => {
				created += 1;
				return delegate.factory(input);
			},
		}));
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error");
		assert.equal(outcome.kind === "error" ? outcome.code : "", "config_error");
		assert.equal(created, 0, "the SDK must never build a fresh runtime in its own");
	});

	it("never bills Infinity when finite counters overflow", async () => {
		const big = { input: Number.MAX_VALUE, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
		const factory = makeSessionFactory({
			usage: [{ id: "gen-a", usage: big }, { id: "gen-b", usage: big }],
			onPrompt: async (input) => {
				// Two prompts ⇒ two distinct generations ⇒ the sum overflows.
				await Promise.resolve();
				submit(input, { kind: "reply", message: "OK" });
			},
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory.factory }));
		const outcome = await channel.respond(ask());
		const usage = channel.usage();
		assert.ok(Number.isFinite(usage.tokens), "the reported total stays finite");
		assert.ok(Number.isFinite(usage.inputTokens), "the reported input stays finite");
		assert.equal(outcome.kind, "error", "an unrepresentable total fails the ask closed");
		assert.equal(channel.records().at(-1)?.deliveryStatus, "failed");
	});

	it("still bills a generation that the abort produced during invalidation", async () => {
		const factory = makeSessionFactory({
			onPrompt: async (input) => {
				// The user bypasses while the model is running; the abort emits its own
				// assistant message carrying the real spend of that aborted generation.
				channel.invalidate("user_bypass");
				await new Promise((resolve) => setTimeout(resolve, 10));
				submit(input, { kind: "reply", message: "LATE" });
			},
			abortUsage: { input: 19, output: 7, cacheRead: 3, cacheWrite: 1, cost: { total: 0.2 } },
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory.factory }));
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error", "an invalidated ask never answers");
		const usage = channel.usage();
		assert.equal(usage.inputTokens, 19, "the aborted generation's spend is still billed");
		assert.equal(usage.outputTokens, 7);
	});

	it("keeps a cancelled running ask's record even though disposal seals replies", async () => {
		const release: Array<() => void> = [];
		const factory = makeSessionFactory({
			onPrompt: () =>
				new Promise<void>((resolve) => {
					release.push(resolve);
				}),
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory.factory }));
		const pending = channel.respond(ask());
		await new Promise((resolve) => setTimeout(resolve, 10));
		channel.invalidate("focus_changed");
		await channel.dispose();
		// The PRODUCTION freeze boundary: capture what the handoff would copy right here,
		// before the barrier is ever released.
		const frozen = [...channel.records()];
		assert.equal(frozen.length, 1, "the cancelled question must already be frozen");
		assert.equal(frozen[0]?.supervisorRequestId, "ask-1");
		assert.equal(frozen[0]?.deliveryStatus, "cancelled");
		for (const resolve of release) resolve();
		const outcome = await pending;
		assert.equal(outcome.kind, "error");
		const records = channel.records();
		assert.equal(records.length, 1, "the cancelled question is still reported");
		assert.equal(records[0]?.supervisorRequestId, "ask-1");
		assert.equal(records[0]?.deliveryStatus, "cancelled");
	});

	it("freezes the goal payload by value: later mutation cannot change the prompt or bypass capacity", async () => {
		const payload: Record<string, unknown> = { contract: "BEFORE" };
		const { factory, state } = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "OK" }) });
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory, goalPayload: payload }));
		// Mutate the caller's object AFTER the attempt was created, including a size bomb.
		payload.contract = "AFTER";
		payload.blob = "x".repeat(300_000);
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "reply", "a frozen snapshot keeps the attempt usable");
		assert.match(state.prompts[0]!, /BEFORE/);
		assert.doesNotMatch(state.prompts[0]!, /AFTER/);
		assert.ok(state.prompts[0]!.length < 300_000, "the 300 KB mutation never reaches the prompt");
	});

	it("converges on the deadline even when session creation outlives it", async () => {
		let prompted = 0;
		const lateFactory = async (input: AuditSideSessionInput): Promise<AuditSideSession> => {
			await new Promise((resolve) => setTimeout(resolve, 120));
			return {
				prompt: async () => {
					prompted += 1;
				},
				waitForIdle: async () => {},
				abort: async () => {},
				dispose: () => {},
				subscribeMessageEnd: () => () => {},
			};
		};
		const channel = createAuditSupervisorSidechannel(deps({
			sessionFactory: lateFactory,
			clock: () => Date.now(),
		}));
		const outcome = await channel.respond({ ...ask(), deadlineAt: Date.now() + 40 });
		assert.equal(outcome.kind, "error");
		assert.equal(outcome.kind === "error" ? outcome.code : "", "deadline_missing");
		assert.equal(prompted, 0, "an expired ask never reaches the model");
		assert.equal(channel.records().at(-1)?.deliveryStatus, "cancelled");
	});

	it("locks the ask after an invalid submit even when a well-formed submit follows", async () => {
		const { factory } = makeSessionFactory({
			onPrompt: async (input) => {
				await assert.rejects(() => submit(input, { kind: "reply", message: "ALPHA", EXTRA_FIELD: "x" }));
				// The SDK/first rejection must not be rescuable by a later valid submit.
				await submit(input, { kind: "reply", message: "ALPHA" });
			},
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error", "an invalid submit locks the ask shut");
		assert.equal(channel.records().at(-1)?.deliveryStatus, "failed");
	});

	it("never delivers a reply when the generation was invalidated during the model call", async () => {
		let channelRef: { invalidate(reason: string): void } | undefined;
		const { factory } = makeSessionFactory({
			onPrompt: async (input) => {
				channelRef?.invalidate("focus_changed");
				await submit(input, { kind: "reply", message: "LATE_REPLY" });
			},
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		channelRef = channel;
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error");
		assert.equal(outcome.kind === "error" ? outcome.code : "", "cancelled");
		assert.equal(channel.records().at(-1)?.deliveryStatus, "cancelled");
	});

	it("bills one generation once even if the same message is observed twice", async () => {
		const { factory } = makeSessionFactory({
			emitTwice: true,
			usage: [{ usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } } }],
			onPrompt: (input) => submit(input, { kind: "reply", message: "ALPHA" }),
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		assert.equal((await channel.respond(ask())).kind, "reply");
		const usage = channel.usage();
		assert.equal(usage.turns, 1, "one generation is billed once");
		assert.equal(usage.tokens, 18, "cache counters are part of the token delta");
		assert.equal(Math.round(usage.costUsd * 100), 1);
	});

	it("revokes only the owning goal's side channel", async () => {
		const { factory: factoryA } = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "A" }) });
		const { factory: factoryB } = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "B" }) });
		const channelA = createAuditSupervisorSidechannel(deps({ sessionFactory: factoryA, ownerRunId: "goal-A" }));
		const channelB = createAuditSupervisorSidechannel(deps({ sessionFactory: factoryB, ownerRunId: "goal-B" }));
		const releaseA = registerAuditSidechannelLifecycle("session-1", "goal-A", { invalidate: (reason) => channelA.invalidate(reason) });
		const releaseB = registerAuditSidechannelLifecycle("session-1", "goal-B", { invalidate: (reason) => channelB.invalidate(reason) });
		invalidateAuditSidechannelsForOwner("session-1", "goal-A", "focus_changed");
		assert.equal((await channelA.respond(ask({ requestId: "ask-A" }))).kind, "error");
		assert.deepEqual(await channelB.respond(ask({ requestId: "ask-B" })), { kind: "reply", message: "B" });
		releaseA();
		releaseB();
	});

	it("creates no session and makes no provider call without a question", async () => {
		const { factory, state } = makeSessionFactory();
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		assert.deepEqual(channel.records(), []);
		assert.equal(state.created, 0);
		channel.seal();
		await channel.dispose();
		await channel.dispose();
		assert.equal(state.disposed, 0);
	});

	it("answers one question, records it once, and reuses one session serially", async () => {
		const { factory, state } = makeSessionFactory({
			onPrompt: (input) => submit(input, { kind: "reply", message: "ALPHA" }),
			usage: [{ usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } } }],
		});
		const ctx = makeCtx();
		const channel = createAuditSupervisorSidechannel(deps({ ctx, sessionFactory: factory }));
		const first = await channel.respond(ask());
		assert.deepEqual(first, { kind: "reply", message: "ALPHA" });
		const second = await channel.respond(ask({ requestId: "ask-2", message: "Again?" }));
		assert.deepEqual(second, { kind: "reply", message: "ALPHA" });
		assert.equal(state.created, 1, "one session is reused");
		assert.equal(state.prompts.length, 2, "questions are serialized");
		assert.deepEqual(channel.records().map((record) => record.deliveryStatus), ["delivered", "delivered"]);
		assert.deepEqual(channel.usage(), {
			inputTokens: 20,
			outputTokens: 10,
			cacheReadTokens: 2,
			cacheWriteTokens: 4,
			tokens: 36,
			costUsd: 0.02,
			turns: 2,
		});
		const input = state.inputs[0]!;
		assert.deepEqual(input.tools, ["read", "grep", "find", "ls", SUBMIT_AUDIT_SUPERVISOR_REPLY_TOOL]);
		// The parent ModelRuntime is borrowed, never rebuilt or disposed here.
		assert.equal(input.modelRuntime, (ctx.modelRegistry as unknown as { runtime: unknown }).runtime);
		assert.deepEqual(input.settingsManager, {
			settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
		});
		const parentRuntime = (ctx.modelRegistry as unknown as { runtime: { disposed?: () => void } }).runtime;
		let parentDisposed = 0;
		parentRuntime.disposed = () => { parentDisposed += 1; };
		channel.seal();
		await channel.dispose();
		assert.equal(state.disposed, 1);
		assert.equal(parentDisposed, 0, "the borrowed parent runtime is never disposed");
	});

	it("returns unresolved without approving and records the missing decision", async () => {
		const { factory } = makeSessionFactory({
			onPrompt: (input) => submit(input, { kind: "unresolved", reason: "needs a new user authorisation" }),
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error");
		if (outcome.kind !== "error") return;
		assert.equal(outcome.code, "unresolved");
		assert.equal(channel.records()[0]?.deliveryStatus, "failed");
		assert.equal(channel.records()[0]?.unresolvedReason, "needs a new user authorisation");
		assert.equal(channel.records()[0]?.answer, undefined);
		channel.seal();
		await channel.dispose();
	});

	it("fails closed when no valid submit was made or two were made", async () => {
		const silent = createAuditSupervisorSidechannel(deps({ sessionFactory: makeSessionFactory().factory }));
		const silentOutcome = await silent.respond(ask());
		assert.equal(silentOutcome.kind, "error");
		if (silentOutcome.kind === "error") assert.equal(silentOutcome.code, "session_error");
		await silent.dispose();

		const doubleFactory = makeSessionFactory({
			onPrompt: async (input) => {
				await submit(input, { kind: "reply", message: "first" });
				await assert.rejects(() => submit(input, { kind: "reply", message: "second" }), /already submitted/);
			},
		});
		const doubled = createAuditSupervisorSidechannel(deps({ sessionFactory: doubleFactory.factory }));
		const doubledOutcome = await doubled.respond(ask());
		assert.equal(doubledOutcome.kind, "error");
		if (doubledOutcome.kind === "error") assert.equal(doubledOutcome.code, "session_error");
		await doubled.dispose();
	});

	it("enforces the ask count and byte limits without consuming quota on duplicates", async () => {
		const { factory, state } = makeSessionFactory({
			onPrompt: (input) => submit(input, { kind: "reply", message: "ok" }),
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		for (let index = 0; index < MAX_AUDIT_ASKS; index += 1) {
			await channel.respond(ask({ requestId: `ask-${index}` }));
		}
		// A duplicate id does not consume additional quota.
		await channel.respond(ask({ requestId: "ask-0" }));
		const overflow = await channel.respond(ask({ requestId: "ask-overflow" }));
		assert.equal(overflow.kind, "error");
		if (overflow.kind === "error") assert.equal(overflow.code, "invalid_ask");
		assert.equal(state.created, 1);

		const tooBig = createAuditSupervisorSidechannel(deps({ sessionFactory: makeSessionFactory().factory }));
		const askOutcome = await tooBig.respond(ask({ message: "x".repeat(MAX_AUDIT_ASK_BYTES) }));
		assert.equal(askOutcome.kind, "error");
		if (askOutcome.kind === "error") assert.equal(askOutcome.code, "invalid_ask");
		await tooBig.dispose();

		const bigReply = createAuditSupervisorSidechannel(deps({
			sessionFactory: makeSessionFactory({
				onPrompt: (input) => submit(input, { kind: "reply", message: "y".repeat(MAX_AUDIT_REPLY_BYTES + 1) }),
			}).factory,
		}));
		const replyOutcome = await bigReply.respond(ask());
		assert.equal(replyOutcome.kind, "error");
		if (replyOutcome.kind === "error") assert.equal(replyOutcome.code, "invalid_ask");
		await bigReply.dispose();
	});

	it("uses the earliest deadline and rejects an ask without a finite deadline", async () => {
		const past = createAuditSupervisorSidechannel(deps({
			sessionFactory: makeSessionFactory().factory,
			getAuditDeadlineAt: () => Date.now() + 120_000,
		}));
		const pastOutcome = await past.respond(ask({ deadlineAt: Date.now() - 1 }));
		assert.equal(pastOutcome.kind, "error");
		if (pastOutcome.kind === "error") assert.equal(pastOutcome.code, "deadline_missing");
		assert.equal(past.records()[0]?.deliveryStatus, "cancelled");
		await past.dispose();

		const none = createAuditSupervisorSidechannel(deps({
			sessionFactory: makeSessionFactory().factory,
			getAuditDeadlineAt: () => undefined,
		}));
		const noneOutcome = await none.respond(ask({ deadlineAt: undefined }));
		assert.equal(noneOutcome.kind, "error");
		if (noneOutcome.kind === "error") assert.equal(noneOutcome.code, "deadline_missing");
		await none.dispose();
	});

	it("accepts only a plain JSON object for an interview reply", async () => {
		const plain = makeSessionFactory({
			onPrompt: (input) => submit(input, { kind: "reply", message: JSON.stringify({ answer: "ALPHA", confidence: 0.9 }) }),
		});
		const ok = createAuditSupervisorSidechannel(deps({ sessionFactory: plain.factory }));
		const okOutcome = await ok.respond(ask({ reason: "interview_request" }));
		assert.equal(okOutcome.kind, "reply");
		await ok.dispose();

		for (const message of ["```json\n{\"a\":1}\n```", "[1,2,3]", "not json"]) {
			const bad = createAuditSupervisorSidechannel(deps({
				sessionFactory: makeSessionFactory({
					onPrompt: (input) => submit(input, { kind: "reply", message }),
				}).factory,
			}));
			const outcome = await bad.respond(ask({ reason: "interview_request" }));
			assert.equal(outcome.kind, "error", message);
			if (outcome.kind === "error") assert.equal(outcome.code, "invalid_ask", message);
			assert.equal(bad.records()[0]?.deliveryStatus, "failed");
			await bad.dispose();
		}
	});

	it("disposes a session that races cancellation before any prompt", async () => {
		let releaseFactory: (() => void) | undefined;
		const state = { created: 0, disposed: 0, prompts: 0 };
		const channel = createAuditSupervisorSidechannel(deps({
			sessionFactory: async (input) => {
				state.created += 1;
				await new Promise<void>((resolve) => {
					releaseFactory = resolve;
				});
				return {
					prompt: async () => {
						state.prompts += 1;
						await submit(input, { kind: "reply", message: "late" });
					},
					waitForIdle: async () => {},
					abort: async () => {},
					dispose: () => {
						state.disposed += 1;
					},
					subscribeMessageEnd: () => () => {},
				};
			},
		}));
		const pending = channel.respond(ask());
		while (!releaseFactory) await new Promise((resolve) => setTimeout(resolve, 1));
		const disposed = channel.dispose();
		releaseFactory();
		await disposed;
		const outcome = await pending;
		assert.equal(outcome.kind, "error");
		if (outcome.kind === "error") assert.equal(outcome.code, "cancelled");
		assert.equal(state.prompts, 0, "no prompt is issued after cancellation");
		assert.equal(state.disposed, 1, "the racing session is disposed exactly once");
	});

	it("revokes reply permission on a session lifecycle event and leaves other sessions alone", async () => {
		const { factory } = makeSessionFactory({
			onPrompt: (input) => submit(input, { kind: "reply", message: "ALPHA" }),
		});
		const first = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		const second = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		const releaseFirst = registerAuditSidechannelLifecycle(
		"session-1",
			"g1",
			{ invalidate: (reason) => first.invalidate(reason) });
		const releaseSecond = registerAuditSidechannelLifecycle(
		"session-2",
			"g1",
			{ invalidate: (reason) => second.invalidate(reason) });
		assert.equal((await first.respond(ask())).kind, "reply");
		invalidateAuditSidechannels("session-1", "focus_changed");
		const revoked = await first.respond(ask({ requestId: "ask-2" }));
		assert.equal(revoked.kind, "error");
		if (revoked.kind === "error") assert.equal(revoked.code, "cancelled");
		// Another session's audit keeps its permission.
		assert.equal((await second.respond(ask())).kind, "reply");
		invalidateAuditSidechannels("session-1", "focus_changed");
		releaseFirst();
		releaseSecond();
		await first.dispose();
		await second.dispose();
	});

	it("invalidate is idempotent and never throws", async () => {
		const { factory } = makeSessionFactory({
			onPrompt: (input) => submit(input, { kind: "reply", message: "ALPHA" }),
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		const release = registerAuditSidechannelLifecycle(
		"session-1",
			"g1",
			{ invalidate: (reason) => channel.invalidate(reason) });
		await channel.respond(ask());
		assert.doesNotThrow(() => invalidateAllAuditSidechannels("focus_changed"));
		assert.doesNotThrow(() => invalidateAllAuditSidechannels("focus_changed"));
		release();
		await channel.dispose();
		assert.equal(channel.records().length, 1);
	});

	it("keeps the record budget large enough for the ask and reply limits", () => {
		assert.ok(
			MAX_AUDIT_ASKS * MAX_AUDIT_REPLY_BYTES <= MAX_AUDIT_RECORD_BYTES,
			"the 8-ask x 8 KiB reply budget must fit the 96 KiB record budget",
		);
	});

	it("refuses to answer after seal or dispose", async () => {
		const { factory, state } = makeSessionFactory({
			onPrompt: (input) => submit(input, { kind: "reply", message: "ok" }),
		});
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		await channel.respond(ask());
		channel.seal();
		const sealed = await channel.respond(ask({ requestId: "ask-2" }));
		assert.equal(sealed.kind, "error");
		if (sealed.kind === "error") assert.equal(sealed.code, "cancelled");
		await channel.dispose();
		const closed = await channel.respond(ask({ requestId: "ask-3" }));
		assert.equal(closed.kind, "error");
		if (closed.kind === "error") assert.equal(closed.code, "cancelled");
		assert.equal(state.created, 1);
	});
});

// ── Content-level diagnostic oracle (approved 3.2 repair plan, 11 entries) ──
const SECRET = "sk-LEAK-CANARY-9f2b";
const CONFIG = "raw-config-apiKey-LEAK";
const PAYLOAD = "z".repeat(200_000);

function leakingError(): Error {
	const error = new Error(`Authorization: Bearer ${SECRET}; config=${CONFIG}; payload=${PAYLOAD.slice(0, 32)}`);
	(error as Error & { cause?: unknown }).cause = { nested: `Bearer ${SECRET}` };
	return error;
}

const OBSERVED: string[] = [];
function observeConsole(): () => void {
	const original = { log: console.log, error: console.error, warn: console.warn };
	const record = (...args: unknown[]) => {
		OBSERVED.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
	};
	console.log = record as never;
	console.error = record as never;
	console.warn = record as never;
	return () => {
		console.log = original.log;
		console.error = original.error;
		console.warn = original.warn;
	};
}

function assertNoLeak(haystack: string, label: string): void {
	assert.equal(haystack.includes(SECRET), false, `${label} leaked the synthetic bearer token`);
	assert.equal(haystack.includes("Bearer"), false, `${label} leaked a Bearer header`);
	assert.equal(haystack.includes(CONFIG), false, `${label} leaked raw config`);
	assert.equal(haystack.includes(PAYLOAD.slice(0, 16)), false, `${label} leaked the oversized payload`);
}

interface OracleRow {
	name: string;
	build: (factory: ReturnType<typeof makeSessionFactory>["factory"]) => AuditSidechannelDeps;
	expectedCode: string;
	/** True when the failure happens before any session is created. */
	beforeSession?: boolean;
	expectGetterUnread?: boolean;
}

const ORACLE: OracleRow[] = [
	{
		name: "parent model getter throws",
		expectedCode: "config_error",
		beforeSession: true,
		expectGetterUnread: true,
		build: (sessionFactory) => {
			const ctx = makeCtx();
			Object.defineProperty(ctx, "model", {
				get() {
					throw leakingError();
				},
			});
			return deps({ ctx, sessionFactory });
		},
	},
	{
		name: "captured registry runtime getter throws",
		expectedCode: "config_error",
		beforeSession: true,
		build: (sessionFactory) =>
			deps({
				ctx: makeCtx({
					modelRegistry: {
						get runtime() {
							throw leakingError();
						},
					},
				}),
				sessionFactory,
			}),
	},
	{
		name: "session getEntries throws",
		expectedCode: "context_error",
		beforeSession: true,
		build: (sessionFactory) =>
			deps({
				ctx: makeCtx({
					sessionManager: {
						getEntries: () => {
							throw leakingError();
						},
						getLeafId: () => null,
					},
				}),
				sessionFactory,
			}),
	},
	{
		name: "getSystemPrompt throws",
		expectedCode: "context_error",
		beforeSession: true,
		build: (sessionFactory) =>
			deps({
				ctx: makeCtx({
					getSystemPrompt: () => {
						throw leakingError();
					},
				}),
				sessionFactory,
			}),
	},
	{
		name: "session factory rejects",
		expectedCode: "session_error",
		build: (sessionFactory) => deps({
			sessionFactory: async () => {
				void sessionFactory;
				throw leakingError();
			},
		}),
	},
	{
		name: "session prompt rejects",
		expectedCode: "session_error",
		build: (sessionFactory) => deps({ sessionFactory }),
	},
	{
		name: "waitForIdle rejects",
		expectedCode: "session_error",
		build: (sessionFactory) => deps({ sessionFactory }),
	},
	{
		name: "audit deadline getter throws",
		expectedCode: "deadline_missing",
		beforeSession: true,
		build: (sessionFactory) => deps({
			sessionFactory,
			getAuditDeadlineAt: () => {
				throw leakingError();
			},
		}),
	},
	{
		name: "ask payload serialization throws",
		expectedCode: "invalid_ask",
		beforeSession: true,
		build: (sessionFactory) => deps({ sessionFactory }),
	},
	{
		name: "reference payload serialization throws",
		expectedCode: "invalid_ask",
		build: (sessionFactory) => deps({ sessionFactory }),
	},
	{
		name: "post-submit liveness check throws",
		expectedCode: "session_error",
		build: (sessionFactory) => deps({
			sessionFactory,
			verifyLive: () => {
				throw leakingError();
			},
		}),
	},
];

function oracleRequest(row: OracleRow): SupervisorResponderRequest {
	if (row.name === "ask payload serialization throws") {
		return ask({
			interview: {
				toJSON() {
					throw leakingError();
				},
			},
		});
	}
	if (row.name === "reference payload serialization throws") {
		// The opaque interview object survives the first (ask-size) serialization
		// and fails on the second (reference) one.
		let calls = 0;
		return ask({
			interview: {
				toJSON() {
					calls += 1;
					if (calls > 1) throw leakingError();
					return { question: "ok" };
				},
			},
		});
	}
	return ask();
}

function oracleFactory(row: OracleRow) {
	if (row.name === "session prompt rejects") {
		return makeSessionFactory({ promptError: leakingError() });
	}
	if (row.name === "waitForIdle rejects") {
		return makeSessionFactory({ idleError: leakingError() });
	}
	if (row.name === "post-submit liveness check throws") {
		return makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "ok" }) });
	}
	return makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "ok" }) });
}

describe("diagnostic safety oracle", () => {
	for (const row of ORACLE) {
		it(`${row.name} => ${row.expectedCode} with no external detail`, async () => {
			const { factory, state } = oracleFactory(row);
			const channel = createAuditSupervisorSidechannel(row.build(factory));
			const restore = observeConsole();
			let outcome: Awaited<ReturnType<typeof channel.respond>>;
			try {
				outcome = await channel.respond(oracleRequest(row));
			} finally {
				restore();
			}
			assert.equal(outcome.kind, "error", row.name);
			if (outcome.kind !== "error") return;
			assert.equal(outcome.code, row.expectedCode, row.name);
			assert.ok(outcome.message.length > 0, "error text must be non-empty");
			assert.ok(outcome.message.length <= 1024, "error text must be bounded");
			assertNoLeak(outcome.message, `${row.name} message`);
			assertNoLeak(JSON.stringify(channel.records()), `${row.name} records`);
			assertNoLeak(JSON.stringify(channel.usage()), `${row.name} usage`);
			assertNoLeak(JSON.stringify(state.prompts), `${row.name} prompts`);
			if (row.beforeSession) {
				assert.equal(state.created, 0, `${row.name} must not create a session`);
				assert.equal(state.prompts.length, 0, `${row.name} must not prompt`);
			}
			if (channel.records().length > 0) {
				const last = channel.records().at(-1)!;
				assert.equal(last.deliveryStatus === "delivered", false, `${row.name} must not record a delivered answer`);
				assert.equal(last.answer, undefined, `${row.name} must not record an answer`);
			}
			channel.seal();
			await channel.dispose();
			await channel.dispose();
			assert.equal(state.disposed <= 1, true, "cleanup is idempotent");
			assertNoLeak(OBSERVED.join("\n"), `${row.name} console`);
			assertNoLeak(JSON.stringify(channel.records()), `${row.name} frozen records`);
		});
	}

	it("never reads properties off a thrown value", async () => {
		const reads: string[] = [];
		const trapped = new Proxy(new Error("x"), {
			get(target, property, receiver) {
				reads.push(String(property));
				return Reflect.get(target, property, receiver);
			},
		});
		const { factory } = makeSessionFactory({ promptError: trapped });
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory }));
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error");
		if (outcome.kind === "error") {
			assert.equal(outcome.code, "session_error");
			assert.match(outcome.message, new RegExp(OMITTED_ERROR_DETAILS));
		}
		// Only the instanceof check is allowed to touch the object.
		assert.equal(reads.some((property) => ["message", "stack", "cause", "name"].includes(property)), false, `read: ${reads.join(",")}`);
		await channel.dispose();
	});

	it("does not leak when the parent model is missing", async () => {
		const { factory, state } = makeSessionFactory();
		const channel = createAuditSupervisorSidechannel(deps({ ctx: makeCtx({ model: undefined }), sessionFactory: factory }));
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error");
		if (outcome.kind === "error") assert.equal(outcome.code, "config_error");
		assert.equal(state.created, 0);
		await channel.dispose();
	});
	it("accepts exactly the ask byte limit and rejects it by one byte", async () => {
		const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
		const base = byteLength(JSON.stringify({ message: "", interview: undefined }));
		const exact = "a".repeat(MAX_AUDIT_ASK_BYTES - base);
		const atLimit = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "OK" }) });
		const okChannel = createAuditSupervisorSidechannel(deps({ sessionFactory: atLimit.factory }));
		assert.equal(byteLength(JSON.stringify({ message: exact, interview: undefined })), MAX_AUDIT_ASK_BYTES);
		const ok = await okChannel.respond({ ...ask(), requestId: "ask-limit", message: exact });
		assert.equal(ok.kind, "reply", "exactly the limit is accepted");
		const over = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "OK" }) });
		const overChannel = createAuditSupervisorSidechannel(deps({ sessionFactory: over.factory }));
		const tooBig = await overChannel.respond({ ...ask(), requestId: "ask-over", message: exact + "a" });
		assert.equal(tooBig.kind, "error");
		assert.equal(tooBig.kind === "error" ? tooBig.code : "", "invalid_ask");
	});

	it("accepts exactly the reply byte limit and rejects it by one byte", async () => {
		const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
		const atLimit = "r".repeat(MAX_AUDIT_REPLY_BYTES);
		const factory = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: atLimit }) });
		const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory.factory }));
		const ok = await channel.respond(ask());
		assert.equal(ok.kind, "reply", "exactly the reply limit is accepted");
		assert.equal(byteLength(atLimit), MAX_AUDIT_REPLY_BYTES);
		const overFactory = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: atLimit + "r" }) });
		const overChannel = createAuditSupervisorSidechannel(deps({ sessionFactory: overFactory.factory }));
		const tooBig = await overChannel.respond(ask());
		assert.equal(tooBig.kind, "error");
		assert.equal(tooBig.kind === "error" ? tooBig.code : "", "invalid_ask");
	});

	it("reserves the record capacity BEFORE delivering: the largest fitting record is delivered, one more byte is not", async () => {
		const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
		const run = async (questionChars: number) => {
			const factory = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "OK" }) });
			const channel = createAuditSupervisorSidechannel(deps({ sessionFactory: factory.factory }));
			const outcome = await channel.respond({ ...ask(), requestId: "rec", message: "q".repeat(questionChars) });
			return { outcome, records: channel.records() };
		};
		// Binary-search the exact boundary against the implementation's own measurement.
		let low = 0;
		let high = MAX_AUDIT_RECORD_BYTES;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			const { outcome } = await run(mid);
			if (outcome.kind === "reply") low = mid;
			else high = mid - 1;
		}
		const atLimit = await run(low);
		assert.equal(atLimit.outcome.kind, "reply", "the largest record that fits is still delivered");
		assert.ok(byteLength(JSON.stringify(atLimit.records)) <= MAX_AUDIT_RECORD_BYTES);
		const over = await run(low + 1);
		assert.equal(over.outcome.kind, "error", "one byte more fails closed");
		assert.equal(over.records.some((record) => record.deliveryStatus === "delivered"), false, "nothing was delivered");
		assert.ok(byteLength(JSON.stringify(over.records)) <= MAX_AUDIT_RECORD_BYTES);
	});

	it("refuses to deliver a reply when the audit target is no longer live", async () => {
		const factory = makeSessionFactory({ onPrompt: (input) => submit(input, { kind: "reply", message: "ALPHA" }) });
		const channel = createAuditSupervisorSidechannel(deps({
			sessionFactory: factory.factory,
			verifyLive: () => {
				throw new Error("The audit target is no longer live; the answer was refused.");
			},
		}));
		const outcome = await channel.respond(ask());
		assert.equal(outcome.kind, "error", "a stale target never receives an answer");
		assert.equal(channel.records().some((record) => record.deliveryStatus === "delivered"), false);
	});

});
