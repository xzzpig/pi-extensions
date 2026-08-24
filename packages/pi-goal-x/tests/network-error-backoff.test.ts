import assert from "node:assert/strict";
import test from "node:test";

import {
	NETWORK_ERROR_BACKOFF_DELAYS_MS,
	networkErrorBackoffPlan,
} from "../extensions/network-error-backoff.ts";
import {
	hasNetworkErrorAssistantMessage,
	isNetworkErrorAssistantMessage,
} from "../extensions/goal-format.ts";

test("network-error backoff uses a bounded exponential recovery ladder", () => {
	assert.deepEqual(NETWORK_ERROR_BACKOFF_DELAYS_MS, [5_000, 10_000, 20_000, 40_000, 80_000]);
	assert.deepEqual(networkErrorBackoffPlan(1), { attempt: 1, maxAttempts: 5, delayMs: 5_000 });
	assert.deepEqual(networkErrorBackoffPlan(5), { attempt: 5, maxAttempts: 5, delayMs: 80_000 });
	assert.equal(networkErrorBackoffPlan(0), undefined);
	assert.equal(networkErrorBackoffPlan(6), undefined);
});

test("network-error detection accepts provider error text and raw finish reason only", () => {
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: network_error" }),
		true,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", rawStopReason: "network-error" }),
		true,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" }),
		false,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "stop", errorMessage: "network_error" }),
		false,
	);
	assert.equal(
		hasNetworkErrorAssistantMessage([
			{ role: "assistant", stopReason: "error", errorMessage: "other provider error" },
			{ role: "assistant", stopReason: "error", rawStopReason: "network_error" },
		]),
		true,
	);
});
