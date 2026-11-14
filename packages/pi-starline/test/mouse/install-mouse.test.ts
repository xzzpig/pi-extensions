import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MouseEventsApi } from "@xzzpig/pi-mouse-events/api";
import { describe, expect, it } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import {
	activeSelectionHintText,
	installMouseFeaturesOn,
} from "../../extensions/starline/mouse/index";

type SelectionBounds = {
	start: { row: number; col: number; scrollView?: unknown };
	end: { row: number; col: number };
};
type SelectionColumns = { start: number; end: number };

type RegisteredHandler = (context: { event?: unknown; tui: unknown }) => unknown;

type FakeApi = {
	api: MouseEventsApi;
	mouseHandlers: Array<{ priority: number; handler: RegisteredHandler }>;
	copyHandlers: Array<{ priority: number; handler: RegisteredHandler }>;
};

/**
 * The `pi-mouse-events` API is faked at exactly its published shape: handlers
 * are captured, never invoked by the fake itself — the tests invoke them the
 * way the extension would, with the receiver as `tui`. `liveReceiver` hands
 * back the fixture receiver, the way the real API reports the renderer the
 * input wrapper last saw.
 */
function makeFakeApi(receiver: unknown, copySlot = true): FakeApi {
	const mouseHandlers: FakeApi["mouseHandlers"] = [];
	const copyHandlers: FakeApi["copyHandlers"] = [];
	const api = {
		version: 2,
		eventChannel: "pi-mouse-events:mouse",
		copySlotAvailable: copySlot,
		liveReceiver: () => receiver,
		addMouseHandler(handler: RegisteredHandler, options?: { priority?: number }) {
			mouseHandlers.push({ priority: options?.priority ?? 0, handler });
			return () => {};
		},
		addCopyHandler(handler: RegisteredHandler, options?: { priority?: number }) {
			copyHandlers.push({ priority: options?.priority ?? 0, handler });
			return () => {};
		},
	} as unknown as MouseEventsApi;
	return { api, mouseHandlers, copyHandlers };
}

function makeCtx(receiver: unknown): ExtensionContext {
	return { ui: receiver } as unknown as ExtensionContext;
}

function install(receiver: object, deps: { getConfig: () => PolishedTuiConfig }, copySlot = true) {
	const fake = makeFakeApi(receiver, copySlot);
	const dispose = installMouseFeaturesOn(fake.api, makeCtx(receiver), deps);
	return { ...fake, dispose };
}

type FakeAltScreen = {
	selectionBounds: SelectionBounds | undefined;
	previousScreen: string[];
	copyOnSelect: boolean;
	getCopyOnSelect(): boolean;
	hasActiveSelection(): boolean;
	getSelectionBounds(): SelectionBounds | undefined;
	getSelectionColumns(line: string, row: number, selection: SelectionBounds): SelectionColumns;
	flash(message: string, durationMs?: number): void;
	hasOverlay(): boolean;
	requestRender(): void;
};

/**
 * A minimal stand-in for `getSelectionColumns` — real enough to exercise
 * `selectionText`'s row-by-row loop without pulling in grapheme-boundary
 * handling, which is Pi's own concern and covered by the contract tests
 * against the actual prototype.
 */
function fakeSelectionColumns(
	line: string,
	row: number,
	selection: SelectionBounds,
): SelectionColumns {
	return {
		start: row === selection.start.row ? selection.start.col : 0,
		end: row === selection.end.row ? selection.end.col : line.length,
	};
}

function makePrototype(): { prototype: FakeAltScreen; calls: string[]; flashes: string[] } {
	const calls: string[] = [];
	const flashes: string[] = [];
	const prototype: FakeAltScreen = {
		selectionBounds: { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
		previousScreen: ["hello world"],
		copyOnSelect: false,
		getCopyOnSelect() {
			return this.copyOnSelect;
		},
		hasActiveSelection() {
			return this.selectionBounds !== undefined;
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
		flash(message: string) {
			flashes.push(message);
			calls.push(`flash:${message}`);
		},
		hasOverlay() {
			return false;
		},
		requestRender() {},
	};
	return { prototype, calls, flashes };
}

function makeConfig(copyNotice: boolean): () => PolishedTuiConfig {
	return () =>
		({
			icons: { rail: "│" },
			mouse: {
				copyNotice,
				enabled: true,
				wheelRouting: true,
			},
		}) as PolishedTuiConfig;
}

describe("installMouseFeaturesOn selectionHint", () => {
	it("shows the hint while the renderer is not auto-copying and a selection exists", () => {
		const { prototype } = makePrototype();
		const { dispose } = install(prototype, { getConfig: makeConfig(true) });

		// The hint binds through the API's `liveReceiver()` — the fixture
		// receiver — so no input event is needed to see it.
		expect(activeSelectionHintText()).toContain("5 characters selected");

		dispose();
		expect(activeSelectionHintText()).toBeNull();
	});

	it("no hint while the renderer auto-copies", () => {
		const { prototype } = makePrototype();
		const { dispose } = install(prototype, { getConfig: makeConfig(true) });

		prototype.copyOnSelect = true;
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});

	it("no hint without a selection", () => {
		const { prototype } = makePrototype();
		const { dispose } = install(prototype, { getConfig: makeConfig(true) });

		prototype.selectionBounds = undefined;
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});

	it("derives no hint when Pi's selection APIs are missing, and still registers the copy", () => {
		// Dropping `getCopyOnSelect`/`hasActiveSelection` takes `selectionHint`
		// with it — no hint — while the copy features need neither and still
		// answer the copy key.
		const { prototype } = makePrototype();
		const { getCopyOnSelect: _droppedA, hasActiveSelection: _droppedB, ...withoutApi } = prototype;

		const { dispose, copyHandlers } = install(withoutApi, { getConfig: makeConfig(true) });

		expect(activeSelectionHintText()).toBeNull();
		expect(copyHandlers).toHaveLength(1);
		dispose();
	});
});

describe("installMouseFeaturesOn wiring", () => {
	it("registers no copy handler when the extension's copy slot is unavailable", () => {
		// pi-tui < 0.84.3 has no `copyActiveSelectionToClipboard`, so the
		// extension reports `copySlotAvailable: false`; registering into a slot
		// nothing invokes would be the half-working install the capability
		// table's rule forbids.
		const { prototype } = makePrototype();
		const { dispose, copyHandlers, mouseHandlers } = install(
			prototype,
			{ getConfig: makeConfig(true) },
			false,
		);

		expect(copyHandlers).toHaveLength(0);
		// Everything that does not answer a copy still registers.
		expect(mouseHandlers.map((entry) => entry.priority).sort()).toEqual([0, 10, 20]);
		dispose();
	});

	it("registers the range delete on ctx.ui.onTerminalInput and consumes a selected backspace", () => {
		const { prototype } = makePrototype();
		const listeners: Array<(data: string) => unknown> = [];
		const receiverWithInput = Object.assign(prototype, {
			onTerminalInput(handler: (data: string) => unknown) {
				listeners.push(handler);
				return () => {};
			},
		});
		const { dispose } = install(receiverWithInput, { getConfig: makeConfig(true) });

		expect(listeners).toHaveLength(1);
		// A selection the fixture cannot map into an editor falls through —
		// `deleteSelectedRange` declines and the key stays Pi's.
		const result = listeners[0]("\x7f");
		expect(result).toBeUndefined();
		dispose();
		expect(listeners).toHaveLength(1); // unsubscribe is the fixture's no-op; wiring covered above
	});

	it("leaves ctrl+c and ctrl+d alone in the range-delete listener", () => {
		const { prototype } = makePrototype();
		const listeners: Array<(data: string) => unknown> = [];
		const receiverWithInput = Object.assign(prototype, {
			onTerminalInput(handler: (data: string) => unknown) {
				listeners.push(handler);
				return () => {};
			},
		});
		const { dispose } = install(receiverWithInput, { getConfig: makeConfig(true) });

		expect(listeners[0]("\x03")).toBeUndefined();
		expect(listeners[0]("\x04")).toBeUndefined();
		dispose();
	});
});
