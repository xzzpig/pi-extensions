/**
 * The `pi-mouse-events` API contract, from the consumer side.
 *
 * `mouse/api-consumer.ts` duplicates the package's `Symbol.for` key because a
 * value import would both give Starline its own module copy and fail to load
 * when the package is not installed. That duplication is the one thing that
 * can silently drift, so this file pins it against the real package (a
 * workspace devDependency at development time, the same published package at
 * runtime): if the key ever changes, this goes red here and not as a mysteriously
 * dead feature set on a user's machine.
 */
import { MOUSE_EVENT_CHANNEL, MOUSE_EVENTS_API_KEY } from "@xzzpig/pi-mouse-events/api";
import { describe, expect, it } from "vitest";
import { getMouseEventsApi } from "../../extensions/starline/mouse/api-consumer";

describe("the pi-mouse-events API contract", () => {
	it("reads the same Symbol.for key the package publishes under", () => {
		// Publish through the package's own key, read through Starline's.
		const api = { version: 1, eventChannel: MOUSE_EVENT_CHANNEL };
		(globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY] = api;
		try {
			expect(getMouseEventsApi()).toBe(api);
		} finally {
			delete (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY];
		}
	});

	it("finds nothing when the extension is not installed", () => {
		delete (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY];
		expect(getMouseEventsApi()).toBeUndefined();
	});
});
