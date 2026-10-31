import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import registerSubagentNotify, { createCompletionSendRegistry } from "../../src/runs/background/notify.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function createEventBus() {
	const emitter = new EventEmitter();
	return {
		on(event: string, listener: (...args: unknown[]) => void) {
			emitter.on(event, listener);
			return () => emitter.off(event, listener);
		},
		emit(event: string, ...args: unknown[]) {
			return emitter.emit(event, ...args);
		},
	};
}

function createNotifier(held = false) {
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const events = createEventBus();
	const notifier = registerSubagentNotify({
		events,
		isHeld: () => held,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
			return false;
		},
	} as unknown as Pick<ExtensionAPI, "events"> & { sendMessage: (message: unknown, options: unknown) => boolean; isHeld: () => boolean }, {
		currentSessionId: "session-a",
		completionOwnerId: "owner-a",
	}, {
		batchConfig: { enabled: false },
		sendRegistry: createCompletionSendRegistry(),
	});
	return { notifier, sent };
}

it("exposes only parent-waking completion handoffs, not explicit non-wakes", async () => {
	const { notifier, sent } = createNotifier();
	try {
		const result = await notifier.deliver({ id: "wake", sessionId: "session-a", completionOwnerId: "owner-a", success: true });
		assert.equal(result, true);
		assert.equal(notifier.hasPendingWake(), true, "accepted wake remains pending until native message_start");
		assert.deepEqual(sent[0]?.options, { triggerTurn: true });

		notifier.messageStarted({ role: "custom", customType: "subagent-notify", content: (sent[0]?.message as { content: string }).content } as never);
		assert.equal(notifier.hasPendingWake(), false);

		await notifier.deliver({ id: "silent", sessionId: "session-a", completionOwnerId: "owner-a", success: true, triggerTurn: false });
		assert.deepEqual(sent[1]?.options, { triggerTurn: false });
		assert.equal(notifier.hasPendingWake(), false, "an explicit non-wake does not block goal continuation");
	} finally {
		notifier.dispose();
	}
});

it("does not claim a native parent wake while completion delivery is held", async () => {
	const { notifier, sent } = createNotifier(true);
	try {
		await notifier.deliver({ id: "held", sessionId: "session-a", completionOwnerId: "owner-a", success: true });
		assert.deepEqual(sent[0]?.options, { triggerTurn: true }, "the notifier delegates hold handling to the parent-wake adapter");
		assert.equal(notifier.hasPendingWake(), false, "a held parent has no native wake currently promised");
	} finally {
		notifier.dispose();
	}
});
