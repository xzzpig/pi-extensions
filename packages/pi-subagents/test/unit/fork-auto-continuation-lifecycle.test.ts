import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { GOAL_AUTO_CONTINUE_GATE_EVENT } from "../../src/goal-auto-continue-gate.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";
import { makeMinimalCtx } from "../support/helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function eventBus() {
	const emitter = new EventEmitter();
	return {
		on(event: string, listener: (value: unknown) => void) {
			emitter.on(event, listener);
			return () => emitter.off(event, listener);
		},
		emit(event: string, value: unknown) {
			return emitter.emit(event, value);
		},
		listenerCount(event: string) {
			return emitter.listenerCount(event);
		},
	};
}

function createRuntime(events: ReturnType<typeof eventBus>, sessionManager: { getSessionId(): string; getSessionFile(): string; getEntries(): unknown[]; getBranch(): unknown[] }) {
	const handlers = new Map<string, Handler[]>();
	const pi = new Proxy({
		events,
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool() {},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage() {},
		appendEntry() {},
		getSessionName() { return undefined; },
	}, { get: (target, property) => property in target ? target[property as keyof typeof target] : () => undefined });
	const ctx = {
		...makeMinimalCtx(process.env.PI_CODING_AGENT_DIR ?? process.cwd()),
		isIdle: () => true,
		mode: "interactive",
		sessionManager,
	};
	const previousChildEnv = process.env[SUBAGENT_CHILD_ENV];
	delete process.env[SUBAGENT_CHILD_ENV];
	try {
		registerSubagentExtension(pi as never);
	} finally {
		if (previousChildEnv !== undefined) process.env[SUBAGENT_CHILD_ENV] = previousChildEnv;
	}
	return {
		async start(reason: string, previousSessionFile?: string) {
			await Promise.all((handlers.get("session_start") ?? []).map((handler) => handler({ reason, ...(previousSessionFile ? { previousSessionFile } : {}) }, ctx)));
		},
		async shutdown(reason: string) {
			await Promise.all((handlers.get("session_shutdown") ?? []).map((handler) => handler({ reason }, ctx)));
		},
	};
}

it("installs after session restore and disposes/replaces the listener across load order, session switch, and reload", async () => {
	for (const order of ["goal-first", "subagents-first"] as const) {
		const events = eventBus();
		const sessionIds = { current: `parent-${order}-one` };
		const sessionManager = {
			getSessionId: () => sessionIds.current,
			getSessionFile: () => path.join(process.env.PI_CODING_AGENT_DIR ?? process.cwd(), "sessions", `${sessionIds.current}.jsonl`),
			getEntries: () => [],
			getBranch: () => [],
		};
		const orderObserved: string[] = [];
		let disposeGoalEmitter: (() => void) | undefined;
		const addGoalEmitter = () => {
			disposeGoalEmitter = events.on(GOAL_AUTO_CONTINUE_GATE_EVENT, () => orderObserved.push("goal"));
		};
		if (order === "goal-first") addGoalEmitter();
		let runtime = createRuntime(events, sessionManager);
		try {
			await runtime.start("startup");
			if (order === "subagents-first") addGoalEmitter();
			assert.equal(events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 2, `${order}: one goal-side listener plus one current-session adapter`);

			const deferred: string[] = [];
			const emitGate = (sessionId: string) => events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, {
				version: 1,
				sessionId,
				goalId: "goal-1",
				defer: ({ reason }: { reason: string }) => deferred.push(reason),
			});
			emitGate(sessionIds.current);
			assert.equal(orderObserved.length, 1);
			assert.deepEqual(deferred, [], "restored session with no native wake work remains unblocked");

			const oldId = sessionIds.current;
			const oldFile = sessionManager.getSessionFile();
			sessionIds.current = `parent-${order}-two`;
			await runtime.start("new", oldFile);
			assert.equal(events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 2, "repeated session_start replaces rather than stacks adapters");
			emitGate(oldId);
			assert.deepEqual(deferred, [], "a late request for the replaced session cannot be vetoed by new-session state");

			await runtime.shutdown("reload");
			assert.equal(events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 1, "shutdown releases the session-owned adapter");
			emitGate(oldId);
			assert.deepEqual(deferred, [], "a stale request after shutdown has no adapter to receive it");

			runtime = createRuntime(events, sessionManager);
			await runtime.start("reload");
			assert.equal(events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 2, "reload installs exactly one restored-session adapter");
			emitGate(sessionIds.current);
			assert.equal(orderObserved.length, 4);
			await runtime.shutdown("quit");
			assert.equal(events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 1);
		} finally {
			await runtime.shutdown("quit");
			disposeGoalEmitter?.();
		}
		assert.equal(events.listenerCount(GOAL_AUTO_CONTINUE_GATE_EVENT), 0);
	}
});
