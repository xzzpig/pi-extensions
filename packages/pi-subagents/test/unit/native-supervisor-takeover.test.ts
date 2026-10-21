import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import {
	SUPERVISOR_RESPONDER_REGISTER_EVENT,
	type SupervisorResponderOutcome,
	type SupervisorResponderScope,
} from "../../src/api/supervisor-routing.ts";
import {
	createSupervisorDispatcher,
	createSupervisorLaunchHooks,
	disposeSupervisorRouting,
	registerSupervisorResponderEventListener,
} from "../../src/intercom/fork-supervisor-routing.ts";
import {
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";

const SESSION_ID = "session-1";

interface Harness {
	channelDir: string;
	pi: ExtensionAPI;
	wakes: Array<{ message: unknown; options: unknown }>;
	detaches: unknown[];
	tools: Map<string, ToolDefinition>;
	poll: () => Promise<void>;
	sendTool: (params: Record<string, unknown>) => Promise<unknown>;
	cleanup: () => void;
}

function makeHarness(options: { dispatcher: boolean } = { dispatcher: true }): Harness {
	const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-takeover-"));
	ensureSupervisorChannelDir(channelDir);
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus = {
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const listeners = handlers.get(channel) ?? new Set();
			listeners.add(handler);
			handlers.set(channel, listeners);
			return () => listeners.delete(handler);
		},
	};
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		events: bus,
		on() {
			return () => {};
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		getAllTools() {
			return [...tools.values()];
		},
	} as unknown as ExtensionAPI;
	const state = {
		supervisorOwnerSessionId: SESSION_ID,
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		asyncJobs: new Map(),
	} as unknown as SubagentState;
	const wakes: Array<{ message: unknown; options: unknown }> = [];
	const detaches: unknown[] = [];
	const detachListener = bus.on(INTERCOM_DETACH_REQUEST_EVENT, (data) => detaches.push(data));
	const dispatcher = options.dispatcher
		? createSupervisorDispatcher(pi, () => SESSION_ID)
		: undefined;
	const channel = createNativeSupervisorChannel(pi, state, {
		getChannelDirs: () => ({ dirs: [channelDir] }),
		parentWake: {
			sendMessage: (message: unknown, opts: unknown) => {
				wakes.push({ message, options: opts });
			},
		} as never,
		...(dispatcher ? { supervisorDispatcher: dispatcher } : {}),
	});
	channel.registerTools();
	const tool = tools.get("subagent_supervisor");
	assert.ok(tool);
	return {
		channelDir,
		pi,
		wakes,
		detaches,
		tools,
		poll: async () => {
			await tool!.execute("poll-1", { action: "pending" }, undefined, undefined, undefined as never);
		},
		sendTool: async (params) => tool!.execute("call-1", params, undefined, undefined, undefined as never),
		cleanup: () => {
			channel.dispose();
			disposeSupervisorRouting(pi);
			detachListener?.();
			fs.rmSync(channelDir, { recursive: true, force: true });
		},
	};
}

function writeRequest(
	channelDir: string,
	overrides: Partial<{
		id: string;
		reason: string;
		message: string;
		runId: string;
		agent: string;
		childIndex: number;
		expiresAt: number;
		orchestratorSessionId: string;
		expectsReply: boolean;
	}> = {},
): { id: string; file: string } {
	const id = overrides.id ?? "ask-1";
	const request = {
		type: "subagent.supervisor.request",
		id,
		createdAt: Date.now(),
		reason: overrides.reason ?? "need_decision",
		message: overrides.message ?? "what is the release marker?",
		expectsReply: overrides.expectsReply ?? true,
		orchestratorSessionId: overrides.orchestratorSessionId ?? SESSION_ID,
		runId: overrides.runId ?? "run-1",
		agent: overrides.agent ?? "goal-auditor",
		childIndex: overrides.childIndex ?? 0,
		...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
	};
	const file = path.join(channelDir, "requests", `${id}.json`);
	fs.writeFileSync(file, JSON.stringify(request), "utf-8");
	return { id, file };
}

function replyFile(channelDir: string, id: string): string {
	return path.join(channelDir, "replies", `${id}.json`);
}

function scope(overrides: Partial<SupervisorResponderScope> = {}): SupervisorResponderScope {
	return {
		sessionId: SESSION_ID,
		requestId: "delegation-1",
		ownerRunId: "goal-1",
		nodeId: "goal-completion:goal-1:1",
		agent: "goal-auditor",
		...overrides,
	};
}

function bindRoute(pi: ExtensionAPI, overrides: Partial<{ agent: string; nodeId: string }> = {}) {
	const hooks = createSupervisorLaunchHooks(
		pi,
		{
			requestId: "delegation-1",
			ownerRunId: "goal-1",
			nodeId: overrides.nodeId ?? "goal-completion:goal-1:1",
			agent: overrides.agent ?? "goal-auditor",
		},
		() => SESSION_ID,
	);
	assert.ok(hooks, "expected launch hooks for the registered attempt");
	hooks!.beforeNativeChildLaunch({
		runId: "run-1",
		agent: overrides.agent ?? "goal-auditor",
		childIndex: 0,
		bridgeActive: true,
	});
	return hooks!;
}

function registerResponder(
	pi: ExtensionAPI,
	respond: () => SupervisorResponderOutcome | Promise<SupervisorResponderOutcome>,
	onFailure?: (error: Error) => void,
): void {
	// The owner listener lives for the test's own event bus; the bus is discarded
	// with the harness, so the disposer is intentionally not retained here.
	void registerSupervisorResponderEventListener(pi, () => SESSION_ID);
	const request = {
		version: 1,
		scope: scope(),
		respond,
		...(onFailure ? { onFailure } : {}),
	};
	pi.events.emit(SUPERVISOR_RESPONDER_REGISTER_EVENT, request);
	const result = (request as { result?: { ok: boolean; error?: Error } }).result;
	assert.equal(result?.ok, true, `registration failed: ${result?.error?.message ?? "no result"}`);
}

const tick = async (times = 6): Promise<void> => {
	for (let index = 0; index < times; index += 1) await Promise.resolve();
};
describe("native supervisor takeover", () => {
	it("claims a bound route without waking the parent or emitting detach", async () => {
		const harness = makeHarness();
		try {
			let resolveReply: ((outcome: SupervisorResponderOutcome) => void) | undefined;
			let calls = 0;
			const ownerPi = harness.pi;
			registerResponder(ownerPi, () => {
				calls += 1;
				return new Promise<SupervisorResponderOutcome>((resolve) => {
					resolveReply = resolve;
				});
			});
			bindRoute(ownerPi);
			writeRequest(harness.channelDir);
			await harness.poll();
			assert.equal(calls, 1);
			assert.equal(harness.wakes.length, 0, "a claimed ask must not wake the parent");
			assert.equal(harness.detaches.length, 0, "a claimed ask must not request detach");
			resolveReply!({ kind: "reply", message: "ALPHA" });
			await tick();
			const reply = JSON.parse(fs.readFileSync(replyFile(harness.channelDir, "ask-1"), "utf-8"));
			assert.equal(reply.message, "ALPHA");
			assert.equal(fs.existsSync(path.join(harness.channelDir, "requests", "ask-1.json")), false);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps default wake and detach for an unregistered route", async () => {
		const harness = makeHarness();
		try {
			writeRequest(harness.channelDir);
			await harness.poll();
			assert.equal(harness.wakes.length, 1, "an unregistered ask keeps the native wake");
			assert.deepEqual(harness.wakes[0]?.options, { triggerTurn: true });
			assert.equal(harness.detaches.length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("answers a duplicate observation exactly once", async () => {
		const harness = makeHarness();
		try {
			const ownerPi = harnessOwner(harness);
			let calls = 0;
			registerResponder(ownerPi, () => {
				calls += 1;
				return { kind: "reply", message: "ALPHA" };
			});
			bindRoute(ownerPi);
			writeRequest(harness.channelDir);
			await harness.poll();
			await tick();
			// Re-observing the same ask id (fresh poll cycle) must not re-prompt.
			await harness.poll();
			await tick();
			assert.equal(calls, 1);
			assert.equal(fs.readFileSync(replyFile(harness.channelDir, "ask-1"), "utf-8").includes("ALPHA"), true);
		} finally {
			harness.cleanup();
		}
	});

	it("refuses a generic parent reply for a responder-managed ask", async () => {
		const harness = makeHarness();
		try {
			const ownerPi = harnessOwner(harness);
			let resolveReply: ((outcome: SupervisorResponderOutcome) => void) | undefined;
			registerResponder(ownerPi, () => new Promise<SupervisorResponderOutcome>((resolve) => {
				resolveReply = resolve;
			}));
			bindRoute(ownerPi);
			writeRequest(harness.channelDir);
			await harness.poll();
			await assert.rejects(
				() => harness.sendTool({ action: "reply", replyTo: "ask-1", message: "hijack" }),
				/responder-managed/,
			);
			// The responder's own answer still lands.
			resolveReply!({ kind: "reply", message: "ALPHA" });
			await tick();
			const reply = JSON.parse(fs.readFileSync(replyFile(harness.channelDir, "ask-1"), "utf-8"));
			assert.equal(reply.message, "ALPHA");
		} finally {
			harness.cleanup();
		}
	});

	it("fails a claimed ask closed instead of falling back to wake or detach", async () => {
		const harness = makeHarness();
		try {
			const ownerPi = harnessOwner(harness);
			const failures: Error[] = [];
			registerResponder(
				ownerPi,
				() => ({ kind: "error", code: "unresolved", message: "needs a new user decision" }),
				(error) => failures.push(error),
			);
			bindRoute(ownerPi);
			writeRequest(harness.channelDir);
			await harness.poll();
			await tick();
			assert.equal(failures.length, 1);
			assert.match(String(failures[0]?.message), /unresolved/);
			assert.equal(harness.wakes.length, 0, "a failed claimed ask must not wake the parent");
			assert.equal(harness.detaches.length, 0, "a failed claimed ask must not request detach");
			assert.equal(fs.existsSync(replyFile(harness.channelDir, "ask-1")), false);
		} finally {
			harness.cleanup();
		}
	});

	it("never claims an already-expired ask", async () => {
		const harness = makeHarness();
		try {
			const ownerPi = harnessOwner(harness);
			let calls = 0;
			registerResponder(ownerPi, () => {
				calls += 1;
				return { kind: "reply", message: "ALPHA" };
			});
			bindRoute(ownerPi);
			writeRequest(harness.channelDir, { expiresAt: Date.now() - 1000 });
			await harness.poll();
			await tick();
			assert.equal(calls, 0);
			assert.equal(harness.wakes.length, 0);
			assert.equal(harness.detaches.length, 0);
		} finally {
			harness.cleanup();
		}
	});

	it("does not claim a request that belongs to another owner session", async () => {
		const harness = makeHarness();
		try {
			const ownerPi = harnessOwner(harness);
			let calls = 0;
			registerResponder(ownerPi, () => {
				calls += 1;
				return { kind: "reply", message: "ALPHA" };
			});
			bindRoute(ownerPi);
			writeRequest(harness.channelDir, { orchestratorSessionId: "session-other" });
			await harness.poll();
			await tick();
			assert.equal(calls, 0);
			assert.equal(harness.wakes.length, 0);
			assert.equal(harness.detaches.length, 0);
		} finally {
			harness.cleanup();
		}
	});
});

/**
 * The harness builds its own pi; tests need the same instance to register a
 * responder on the dispatcher's owner registry.
 */
function harnessOwner(harness: Harness): ExtensionAPI {
	const owner = (harness as Harness & { pi?: ExtensionAPI }).pi;
	if (!owner) throw new Error("harness is missing its owning ExtensionAPI");
	return owner;
}
