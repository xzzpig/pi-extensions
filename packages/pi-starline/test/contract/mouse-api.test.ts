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
import {
	type CopyHandlerEntryLike,
	type MouseHandlerEntryLike,
	runCopyHandlersInPriorityOrder,
	runMouseHandlersInPriorityOrder,
} from "@xzzpig/pi-mouse-events/test-support";
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

	it("rejects an API object from a different contract major", () => {
		(globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY] = {
			version: 2,
			eventChannel: MOUSE_EVENT_CHANNEL,
		};
		try {
			expect(getMouseEventsApi()).toBeUndefined();
		} finally {
			delete (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY];
		}
	});
});

/**
 * `test/mouse/shim.ts` replays the extension's slot dispatch for the
 * behavioural suites. These assertions pin the real implementation's
 * semantics — priority order, consume-on-first-handled, skip-throwing,
 * fall-through — so a change in `pi-mouse-events` goes red here before it
 * silently diverges from the shim.
 */
describe("the pi-mouse-events slot-dispatch semantics", () => {
	const baseEvent = {
		kind: "down" as const,
		button: 0,
		x: 3,
		y: 4,
		release: false,
		handled: false,
	};

	it("runs handlers in priority order and consumes on the first handled:true", () => {
		const calls: string[] = [];
		const entries: MouseHandlerEntryLike[] = [
			{
				id: 2,
				priority: 5,
				handler: () => {
					calls.push("later");
				},
			},
			{
				id: 1,
				priority: 9,
				handler: () => {
					calls.push("first");
					return { handled: true };
				},
			},
			{
				id: 0,
				priority: 1,
				handler: () => {
					calls.push("never");
				},
			},
		];
		expect(runMouseHandlersInPriorityOrder(entries, baseEvent, {})).toBe(true);
		expect(calls).toEqual(["first"]);
	});

	it("breaks priority ties by registration order (lowest id first)", () => {
		const calls: string[] = [];
		const entries: MouseHandlerEntryLike[] = [
			{
				id: 7,
				priority: 3,
				handler: () => {
					calls.push("second");
				},
			},
			{
				id: 2,
				priority: 3,
				handler: () => {
					calls.push("first");
				},
			},
		];
		expect(runMouseHandlersInPriorityOrder(entries, baseEvent, {})).toBe(false);
		expect(calls).toEqual(["first", "second"]);
	});

	it("skips a throwing handler and keeps dispatching", () => {
		const calls: string[] = [];
		const entries: MouseHandlerEntryLike[] = [
			{
				id: 1,
				priority: 9,
				handler: () => {
					throw new Error("boom");
				},
			},
			{
				id: 2,
				priority: 1,
				handler: () => {
					calls.push("reached");
					return { handled: true };
				},
			},
		];
		expect(runMouseHandlersInPriorityOrder(entries, baseEvent, {})).toBe(true);
		expect(calls).toEqual(["reached"]);
	});

	it("hands the event the handler sees an unhandled copy without a dispatch target", () => {
		let seen: { handled: boolean; dispatched?: unknown } | undefined;
		const entries: MouseHandlerEntryLike[] = [
			{
				id: 1,
				priority: 0,
				handler: ({ event }) => {
					seen = event;
				},
			},
		];
		runMouseHandlersInPriorityOrder(entries, baseEvent, {});
		expect(seen?.handled).toBe(false);
		expect(seen?.dispatched).toBeUndefined();
	});

	it("runs copy handlers in priority order and consumes on the first handled:true", () => {
		const calls: string[] = [];
		const entries: CopyHandlerEntryLike[] = [
			{
				id: 2,
				priority: 1,
				handler: () => {
					calls.push("later");
				},
			},
			{
				id: 1,
				priority: 9,
				handler: () => {
					calls.push("first");
					return { handled: true };
				},
			},
		];
		expect(runCopyHandlersInPriorityOrder(entries, {})).toBe(true);
		expect(calls).toEqual(["first"]);
	});
});
