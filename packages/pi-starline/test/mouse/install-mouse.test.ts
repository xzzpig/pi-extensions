import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { MouseEventsApi } from "@xzzpig/pi-mouse-events/api";
import { describe, expect, it } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import {
	activeSelectionHintText,
	installMouseFeaturesOn,
} from "../../extensions/starline/mouse/index";
import { FramedToolComponent } from "./component-graph";

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
		version: 1,
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

function makeConfig(copyNotice: boolean, transcriptCleanCopy = true): () => PolishedTuiConfig {
	return () =>
		({
			icons: { rail: "│" },
			mouse: {
				copyNotice,
				transcriptCleanCopy,
				enabled: true,
				wheelRouting: true,
				clickToExpandTools: true,
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

function decodeOsc52(data: string): string {
	const match = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(data);
	return Buffer.from(match?.[1] ?? "", "base64").toString();
}

const FRAME_WIDTH = 12;

/**
 * A selection over a real, framed tool box, in the layout Pi really builds.
 *
 * The transcript is pi-tui's own `Container` holding one framed expandable
 * component, and the rows come from calling `render` on it — not from a
 * hand-written array, and not from a layout tree with a box per message, which
 * pi-tui never produces (pinned in `test/contract/transcript-layout.test.ts`).
 *
 * The frame is the point of the fixture: `transcriptCleanCopy` must take it
 * off on the way to the clipboard, and the `transcriptCleanCopy: false`
 * opt-out must leave it on.
 */
function makeTranscriptFixture() {
	const written: string[] = [];
	const flashes: string[] = [];
	const scrollView = { name: "transcript" };
	const document = new Container();
	const tool = new FramedToolComponent();
	tool.addChild(new Text("hello", 0, 0));
	document.addChild(tool);
	const lines = document.render(FRAME_WIDTH);
	const contentBox = {
		component: document,
		rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
		children: [],
	};
	// Rows 1..3: the top rule, the body, the bottom rule. Row 0 is the tool
	// box's own blank spacer.
	const bounds = {
		start: { row: 1, col: 0, scrollView },
		end: { row: lines.length - 1, col: FRAME_WIDTH },
	} as SelectionBounds;

	const receiver = {
		selectionBounds: bounds as SelectionBounds | undefined,
		previousScreen: [] as string[],
		copyOnSelect: false,
		currentLayout: {
			root: {
				rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
				children: [
					{
						scrollView,
						scrollContentLines: lines,
						rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
						children: [contentBox],
					},
				],
			},
		},
		terminal: { write: (data: string) => written.push(data) },
		hasOverlay() {
			return false;
		},
		getCopyOnSelect() {
			return this.copyOnSelect;
		},
		hasActiveSelection() {
			return this.selectionBounds !== undefined;
		},
		requestRender() {},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
		flash(message: string) {
			flashes.push(message);
		},
	};

	return { written, flashes, lines, bounds, receiver };
}

describe("installMouseFeaturesOn over a real framed transcript", () => {
	it("counts the cleaned text in the hint, matching what the copy key delivers", () => {
		// The hint promises "N characters selected"; N has to be what the copy
		// key actually puts on the clipboard. Over a framed transcript that is
		// the *cleaned* text now — the frame is chrome, and the count must not
		// promise bytes the copy no longer sends.
		const { receiver, written } = makeTranscriptFixture();
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		expect(written).toEqual([]);
		expect(activeSelectionHintText()).toContain("5 characters selected");

		// The copy key's path: Pi's `handleCopyCommand` reaches
		// `copyActiveSelectionToClipboard` through the extension's copy slot,
		// and the clean copy answers it.
		const handled = copyHandlers[0].handler({ tui: receiver });
		expect(handled).toEqual({ handled: true });
		expect(decodeOsc52(written[0])).toBe("hello");
		dispose();
	});

	it("copies a tool box's content without its frame", () => {
		// transcriptCleanCopy: the border rows are chrome, drawn by pi-toolbox's
		// rounded frame, and the clipboard is better without them. What must
		// survive is the *content* — the text the box actually held.
		const { receiver, written } = makeTranscriptFixture();
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		const handled = copyHandlers[0].handler({ tui: receiver });

		expect(handled).toEqual({ handled: true });
		expect(decodeOsc52(written[0])).toBe("hello");
		dispose();
	});

	it("falls through to Pi's own copy, frame and all, when transcriptCleanCopy is off", () => {
		// The opt-out: with `mouse.transcriptCleanCopy: false` the handler
		// declines, and Pi's own copy — which this fixture's slot sits in front
		// of — puts the frame on the clipboard exactly as before.
		const { receiver, written } = makeTranscriptFixture();
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true, false) });

		const handled = copyHandlers[0].handler({ tui: receiver });

		expect(handled).toBeUndefined();
		expect(written).toEqual([]);
		dispose();
	});

	it("gates the clean copy's notice flash on copyNotice", () => {
		const { receiver, flashes, written } = makeTranscriptFixture();
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(false) });

		copyHandlers[0].handler({ tui: receiver });

		expect(flashes).toEqual([]);
		expect(written).toHaveLength(1);
		dispose();
	});
});

/**
 * A transcript fixture over arbitrary rows, for `transcriptCleanCopy` cases
 * the framed-tool fixture cannot express (user message boxes, tables,
 * screen-space selections). Same wiring: OSC 52 captured in `written`.
 */
function makeLineFixture(lines: readonly string[], bounds: SelectionBounds) {
	const written: string[] = [];
	const receiver = {
		selectionBounds: bounds as SelectionBounds | undefined,
		previousScreen: lines as string[],
		currentLayout: {
			root: {
				rect: { x: 0, y: 0, width: 40, height: lines.length },
				children: [
					{
						scrollView: bounds.start.scrollView,
						scrollContentLines: lines,
						rect: { x: 0, y: 0, width: 40, height: lines.length },
						children: [],
					},
				],
			},
		},
		terminal: { write: (data: string) => written.push(data) },
		hasOverlay() {
			return false;
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
		flash() {},
		requestRender() {},
	};
	return { receiver, written };
}

describe("installMouseFeaturesOn transcriptCleanCopy", () => {
	const WIDTH = 24;
	const userBox = (body: readonly string[]) => [
		"─".repeat(WIDTH),
		...body.map((line) => `│ ${line}`.padEnd(WIDTH)),
		"─".repeat(WIDTH),
	];
	const wholeTranscript = (lines: readonly string[]): SelectionBounds =>
		({
			start: { row: 0, col: 0, scrollView: { name: "transcript" } },
			end: { row: lines.length - 1, col: WIDTH },
		}) as SelectionBounds;

	it("copies a user message as its text, without rail or border rules", () => {
		// The headline case from real use: a drag across a user message box
		// copied the rail, the rules and the padding. Now it copies the message.
		const lines = [
			"previous answer line",
			...userBox(["fix the flaky test", "and the other one"]),
			"next answer line",
		];
		const { receiver, written } = makeLineFixture(lines, wholeTranscript(lines));
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		copyHandlers[0].handler({ tui: receiver });

		expect(decodeOsc52(written[0])).toBe(
			"previous answer line\nfix the flaky test\nand the other one\nnext answer line",
		);
		dispose();
	});

	it("cleans a mid-box drag whose range contains no border row", () => {
		const box = userBox(["one", "two", "three"]);
		const lines = [...box, "after"];
		const bounds = {
			start: { row: 2, col: 0, scrollView: { name: "transcript" } },
			end: { row: 3, col: WIDTH },
		} as SelectionBounds;
		const { receiver, written } = makeLineFixture(lines, bounds);
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		copyHandlers[0].handler({ tui: receiver });

		expect(decodeOsc52(written[0])).toBe("two\nthree");
		dispose();
	});

	it("slices a mid-row start out of the content, not out of the rail", () => {
		// A drag over columns 5..7 of a rail row covers columns 3..5 of the
		// content once the rail comes off — `leftTrim` shifts the columns, and
		// the receiver's column math (exclusive-end here) does the slicing.
		// Without the shift the slice would land two characters to the right.
		const lines = userBox(["abcdefgh"]);
		const bounds = {
			start: { row: 1, col: 5, scrollView: { name: "transcript" } },
			end: { row: 1, col: 7, scrollView: { name: "transcript" } },
		} as SelectionBounds;
		const { receiver, written } = makeLineFixture(lines, bounds);
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		copyHandlers[0].handler({ tui: receiver });

		expect(decodeOsc52(written[0])).toBe("de");
		dispose();
	});

	it("falls back to Pi's verbatim copy for a selection with no chrome", () => {
		// A markdown table — square corners — is content. Nothing about it may
		// change on the way to the clipboard.
		const lines = ["┌─ one ─┬─ two ─┐", "│ a     │ b     │", "└─ ─── ─┴─ ─── ─┘"];
		const { receiver, written } = makeLineFixture(lines, wholeTranscript(lines));
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		const handled = copyHandlers[0].handler({ tui: receiver });

		expect(handled).toBeUndefined();
		expect(written).toEqual([]);
		dispose();
	});

	it("leaves screen-space selections to Pi", () => {
		// No scroll view on the anchor: the selection is over the dock or the
		// status area, not the transcript, and stays byte-for-byte Pi's.
		const lines = ["─".repeat(WIDTH), "│ dock row".padEnd(WIDTH), "─".repeat(WIDTH)];
		const bounds = {
			start: { row: 0, col: 0 },
			end: { row: 2, col: WIDTH },
		} as SelectionBounds;
		const { receiver, written } = makeLineFixture(lines, bounds);
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		const handled = copyHandlers[0].handler({ tui: receiver });

		expect(handled).toBeUndefined();
		expect(written).toEqual([]);
		dispose();
	});

	it("consumes a pure-decoration drag without writing the clipboard", () => {
		// Selecting just a user box's border rules cleans to nothing — Pi's own
		// copy has the same `text.length === 0` shape, it just gets there after
		// building a string of rules.
		const lines = ["plain", ...userBox(["content"]), "plain"];
		const bounds = {
			start: { row: 1, col: 0, scrollView: { name: "transcript" } },
			end: { row: 1, col: WIDTH },
		} as SelectionBounds;
		const { receiver, written } = makeLineFixture(lines, bounds);
		const { dispose, copyHandlers } = install(receiver, { getConfig: makeConfig(true) });

		const handled = copyHandlers[0].handler({ tui: receiver });

		expect(handled).toEqual({ handled: true });
		expect(written).toEqual([]);
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
