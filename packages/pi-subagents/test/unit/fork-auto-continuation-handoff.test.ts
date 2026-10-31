import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { registerGoalAutoContinueGate, GOAL_AUTO_CONTINUE_GATE_EVENT } from "../../src/goal-auto-continue-gate.ts";
import registerSubagentNotify, { createCompletionSendRegistry } from "../../src/runs/background/notify.ts";
import { createResultDeliveryOwnership } from "../../src/runs/background/result-delivery-ownership.ts";
import { createParentWake } from "../../src/shared/parent-wake.ts";
import type { SubagentState } from "../../src/shared/types.ts";

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
	};
}

it("keeps success, failure, and stop result handoffs ahead of continuation until the reserved parent wake starts", async () => {
	const sessionId = "parent-session-uuid";
	const sessionManager = { getSessionId: () => sessionId };
	let idle = true;
	const sent: Array<{ message: any; options: any }> = [];
	const events = eventBus();
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	const parentWake = createParentWake(pi as never);
	parentWake.bindSession({ isIdle: () => idle, sessionManager } as never);
	const state = {
		baseCwd: "/tmp",
		currentSessionId: sessionId,
		supervisorOwnerSessionId: sessionId,
		completionOwnerId: "owner-a",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
	} as unknown as SubagentState;
	const notifier = registerSubagentNotify({
		events,
		sendMessage: parentWake.sendMessage,
		isHeld: parentWake.isHeld,
	} as never, state, {
		batchConfig: { enabled: false },
		sendRegistry: createCompletionSendRegistry(),
	});
	notifier.bindSession(sessionManager);
	const disposeGate = registerGoalAutoContinueGate(pi as never, {
		state,
		ownership: createResultDeliveryOwnership(state),
		notifier,
		parentWake,
		isHeld: parentWake.isHeld,
		owedResultRunIds: new Set(),
	});
	const gateReasons: string[] = [];
	const requestGate = () => events.emit(GOAL_AUTO_CONTINUE_GATE_EVENT, {
		version: 1,
		sessionId,
		goalId: "goal-1",
		defer: ({ reason }: { reason: string }) => gateReasons.push(reason),
	});
	try {
		const success = { id: "result-success", sessionId, completionOwnerId: "owner-a", success: true, summary: "completed" };
		assert.equal(await notifier.deliver(success), true);
		assert.equal(notifier.hasPendingWake(), true, "native wake remains pending until the parent starts the notification");
		await notifier.deliver(success);
		assert.equal(sent.length, 1, "the existing completion registry still deduplicates repeated delivery");

		await notifier.deliver({ id: "result-failure", sessionId, completionOwnerId: "owner-a", success: false, state: "failed", summary: "failed" });
		await notifier.deliver({ id: "result-stopped", sessionId, completionOwnerId: "owner-a", success: false, state: "stopped", stopped: true, summary: "stopped" });
		assert.deepEqual(sent.map(({ options }) => options), [
			{ triggerTurn: true },
			{ triggerTurn: false },
			{ triggerTurn: false },
		]);
		assert.equal(parentWake.isPending(), true, "the later results are accepted behind the already-reserved native wake");
		requestGate();
		assert.deepEqual(gateReasons, ["parent-wake-pending"]);

		const firstNotice = sent[0]!.message;
		notifier.messageStarted({ role: "custom", customType: "subagent-notify", content: firstNotice.content } as never);
		assert.equal(notifier.hasPendingWake(), false, "message_start releases the notifier's unstarted wake");
		assert.equal(parentWake.isPending(), true, "the host reservation covers the accepted-but-turn-starting handoff");
		requestGate();
		assert.deepEqual(gateReasons, ["parent-wake-pending", "parent-wake-pending"]);

		parentWake.agentStarted();
		idle = false;
		assert.equal(parentWake.isPending(), false, "agent_start consumes the startup reservation; GoalRuntime's readiness guard covers the active turn");
		idle = true;
		assert.equal(parentWake.isPending(), false, "after the parent turn consumes the notices no handoff reservation remains");
		requestGate();
		assert.deepEqual(gateReasons, ["parent-wake-pending", "parent-wake-pending"]);
	} finally {
		disposeGate();
		notifier.dispose();
		parentWake.sessionShutdown("quit");
	}
});
