import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PI_NOTIFY_UI_SPAN_SILENT_EVENT,
	emitUiSpanSilent,
	type UiSpanSilentEvents,
} from "../../src/ui-silent-marker.ts";

describe("emitUiSpanSilent", () => {
	it("emits the pi-notify silent-span marker with the given reason", () => {
		const emitted: Array<{ channel: string; data: unknown }> = [];
		const events: UiSpanSilentEvents = {
			emit(channel, data) {
				emitted.push({ channel, data });
			},
		};

		emitUiSpanSilent(events, "fleet");
		assert.deepEqual(emitted, [
			{ channel: PI_NOTIFY_UI_SPAN_SILENT_EVENT, data: { reason: "fleet" } },
		]);
	});

	it("is a no-op without a bus (pi-notify not installed)", () => {
		assert.doesNotThrow(() => emitUiSpanSilent(undefined, "admin"));
	});

	it("swallows a failing bus observationally", () => {
		const events: UiSpanSilentEvents = {
			emit() {
				throw new Error("bus down");
			},
		};
		assert.doesNotThrow(() => emitUiSpanSilent(events, "admin"));
	});
});
