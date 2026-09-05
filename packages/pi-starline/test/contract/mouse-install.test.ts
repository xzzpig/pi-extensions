/**
 * Starline's mouse features against the REAL installed `TuiAltScreen.prototype`
 * — not a fake. `pi-tui-contract.test.ts` checks that the methods Starline
 * reads still exist with the right shape; this checks that the features
 * composed through the `pi-mouse-events` API behave correctly when the receiver
 * is a real renderer instance: the real `getSelectionColumns` column math, the
 * real `getSelectionBounds` anchor reading, the real OSC 52 write path.
 *
 * The prototype itself is never touched — Starline installs nothing on it, so
 * there is nothing to restore; what this file asserts instead is that the
 * features answer through a receiver exactly the way a live session hands them
 * one (the handler context's `tui`, the API's `liveReceiver()` hook).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { MouseEventsApi } from "@xzzpig/pi-mouse-events/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import { setActiveEditor } from "../../extensions/starline/mouse/editor-mouse";
import {
	activeSelectionHintText,
	installMouseFeaturesOn,
} from "../../extensions/starline/mouse/index";

const WIDTH = 40;
const HEIGHT = 12;
const EDITOR_ROWS = 5;

type Receiver = Record<string, unknown> & {
	terminal: { rows?: number; columns?: number; write: (data: string) => void };
	written: string[];
};

function makeConfig(): () => PolishedTuiConfig {
	return () =>
		({
			icons: { rail: "│" },
			editorClickCursor: true,
			features: { copyFriendly: false },
			mouse: {
				wheelRouting: true,
				copyNotice: true,
				enabled: true,
				clickToExpandTools: true,
				transcriptCleanCopy: true,
			},
		}) as PolishedTuiConfig;
}

interface CapturedHandlers {
	mouseHandlers: Array<(context: { event: unknown; tui: unknown }) => unknown>;
	copyHandlers: Array<(context: { tui: unknown }) => unknown>;
	dispose: () => void;
}

/**
 * A fake `pi-mouse-events` API at its published shape, whose captured handlers
 * a test then invokes the way the extension would — with the receiver as
 * `tui`, and the raw mouse report the extension parsed as `event`.
 */
function install(
	receiver: object,
	getConfig: () => PolishedTuiConfig = makeConfig(),
): CapturedHandlers {
	const mouseHandlers: CapturedHandlers["mouseHandlers"] = [];
	const copyHandlers: CapturedHandlers["copyHandlers"] = [];
	const api = {
		version: 1,
		eventChannel: "pi-mouse-events:mouse",
		copySlotAvailable: true,
		liveReceiver: () => receiver,
		addMouseHandler(handler: (context: { event: unknown; tui: unknown }) => unknown) {
			mouseHandlers.push(handler);
			return () => {};
		},
		addCopyHandler(handler: (context: { tui: unknown }) => unknown) {
			copyHandlers.push(handler);
			return () => {};
		},
	} as unknown as MouseEventsApi;
	const dispose = installMouseFeaturesOn(api, { ui: receiver } as unknown as ExtensionContext, {
		getConfig,
	});
	return { mouseHandlers, copyHandlers, dispose };
}

function makeReceiver(previousScreen: string[]): Receiver {
	const written: string[] = [];
	const receiver = Object.create(TuiAltScreen.prototype) as Receiver;
	// The constructor normally sets these; a fake that never ran one must. Pi
	// 0.84.4's select-without-copy is on exactly when it is false.
	receiver.copyOnSelect = false;
	receiver.selectionAnchor = undefined;
	receiver.selectionFocus = undefined;
	receiver.previousScreen = previousScreen;
	// An empty stack keeps the real `hasOverlay` short-circuited for a receiver
	// that never ran the constructor.
	receiver.overlayStack = [];
	receiver.terminal = {
		rows: HEIGHT,
		columns: WIDTH,
		write: (data: string) => {
			written.push(data);
		},
	};
	// The constructor normally builds this; a detached receiver without one
	// makes the real `flash` throw, which would swallow the copy's success.
	receiver.flashes = { flash: () => {} };
	receiver.written = written;
	return receiver;
}

function decodeOsc52(data: string): string {
	const match = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(data);
	return Buffer.from(match?.[1] ?? "", "base64").toString();
}

describe("the copy features against the real receiver methods", () => {
	let captured: CapturedHandlers | undefined;

	afterEach(() => {
		captured?.dispose();
		captured = undefined;
		setActiveEditor(undefined);
	});

	it("hints the verbatim selection count when nothing needs cleaning", () => {
		const receiver = makeReceiver([
			"hello world   ", // trailing spaces must be trimmed, matching Pi's own .trimEnd()
			"second row here",
			"end",
		]);
		receiver.selectionAnchor = { row: 0, col: 2 };
		receiver.selectionFocus = { row: 2, col: 3 };
		captured = install(receiver);

		// The hint binds through the API's `liveReceiver()` — the fixture
		// receiver here. The clean copy declines (no chrome to strip), so the
		// hint promises what Pi's own copy would deliver: the verbatim rows,
		// through the receiver's real `getSelectionColumns` math.
		const expectedText = ["llo world", "second row here", "end"].join("\n");
		expect(activeSelectionHintText()).toContain(`${expectedText.length} characters selected`);

		const handled = captured.copyHandlers[0]({ tui: receiver });
		expect(handled).toBeUndefined();
		expect(receiver.written).toEqual([]);
	});

	it("copies Starline's rail chrome off a transcript selection, as real OSC 52", () => {
		const rule = "─".repeat(WIDTH);
		const lines = [rule, ...["hello", "world"].map((line) => `│ ${line}`.padEnd(WIDTH)), rule];
		const receiver = makeReceiver([]);
		// A transcript selection: the anchors carry a scroll view, and the
		// layout holds the box behind it with the rendered rows — what the
		// clean copy reads instead of the screen.
		const scrollView = { name: "transcript" };
		receiver.selectionAnchor = { row: 0, col: 0, scrollView };
		receiver.selectionFocus = { row: 3, col: WIDTH, scrollView };
		receiver.currentLayout = {
			root: {
				rect: { x: 0, y: 0, width: WIDTH, height: lines.length },
				children: [
					{
						scrollView,
						scrollContentLines: lines,
						rect: { x: 0, y: 0, width: WIDTH, height: lines.length },
						children: [],
					},
				],
			},
		};
		captured = install(receiver);

		const handled = captured.copyHandlers[0]({ tui: receiver });

		expect(handled).toEqual({ handled: true });
		expect(receiver.written).toHaveLength(1);
		expect(decodeOsc52(receiver.written[0])).toBe("hello\nworld");
	});
});

/** The parsed wheel report `pi-mouse-events` hands a handler: down, bit 65. */
function wheelDown(
	x: number,
	y: number,
): { kind: string; wheel: 1; x: number; y: number; button: number; release: boolean } {
	return { kind: "wheel", wheel: 1, x, y, button: 65, release: false };
}

/** A scrollable draft, and enough of Pi's `Editor` to be laid out and scrolled. */
class FakeEditor {
	readonly state = {
		lines: Array.from({ length: 20 }, (_value, index) => `draft ${index}`),
		cursorLine: 0,
		cursorCol: 0,
	};
	scrollOffset = 0;
	lastWidth = WIDTH;
	preferredVisualCol: number | null = null;
	snappedFromCursorCol: number | null = null;

	buildVisualLineMap(_width: number) {
		return this.state.lines.map((line, index) => ({
			logicalLine: index,
			startCol: 0,
			length: line.length,
		}));
	}

	render(_width: number): string[] {
		const window = this.state.lines.slice(this.scrollOffset, this.scrollOffset + EDITOR_ROWS);
		while (window.length < EDITOR_ROWS) window.push("");
		return window;
	}

	invalidate(): void {}
}

function makeWheelReceiver() {
	const editor = new FakeEditor();
	const container = new Container();
	container.addChild(editor as unknown as Parameters<Container["addChild"]>[0]);
	const transcript = new Text(Array.from({ length: 40 }, (_v, i) => `line ${i}`).join("\n"), 0, 0);
	const scroll = new ScrollView(transcript, { primary: true, follow: "end" });
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{
			component: new VStack([{ component: container, shrink: 1, minSize: 3 }]),
			basis: "auto",
			grow: 0,
			shrink: 1,
			minSize: 1,
		},
	]);
	const receiver = Object.create(TuiAltScreen.prototype) as Receiver;
	receiver.currentLayout = renderLayoutFrame(root, WIDTH, HEIGHT, () => {});
	receiver.terminal = { rows: HEIGHT, columns: WIDTH, write: () => {} };
	receiver.wheelScrollLines = 3;
	receiver.overlayStack = [];
	receiver.scrollbarHover = undefined;
	receiver.scrollbarDrag = undefined;
	receiver.stopped = true;
	setActiveEditor({ component: editor, scrollable: editor });
	return { receiver, editor, scroll };
}

describe("the wheel handler against the real layout engine", () => {
	let captured: CapturedHandlers | undefined;

	afterEach(() => {
		captured?.dispose();
		captured = undefined;
		setActiveEditor(undefined);
	});

	function wheelHandlerFor(receiver: object) {
		captured = install(receiver);
		// Priority 10 is the wheel handler — see `installMouseFeaturesOn`
		// (expand registers at 20, the caret at 0). Located by index here; the
		// install-mouse.test.ts suite pins which priority each feature gets.
		const handler = captured.mouseHandlers[1];
		expect(handler).toBeDefined();
		return handler;
	}

	it("scrolls the input box for a notch Pi parsed out of a real SGR sequence", () => {
		const { receiver, editor, scroll } = makeWheelReceiver();
		// Parked at the top, so a notch that leaked through to Pi's routing would
		// move it and be caught below rather than being absorbed by the end stop.
		scroll.scrollTo(0);

		const result = wheelHandlerFor(receiver)({ event: wheelDown(10, HEIGHT - 1), tui: receiver });

		expect(result).toEqual({ handled: true });
		expect(editor.scrollOffset).toBe(3);
		expect(scroll.scrollTop).toBe(0);
	});

	it("leaves a notch over the transcript to Pi's own routing", () => {
		const { receiver, editor, scroll } = makeWheelReceiver();
		scroll.scrollTo(0);

		const result = wheelHandlerFor(receiver)({ event: wheelDown(10, 0), tui: receiver });

		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
		// The handler never scrolls the transcript itself — Pi's own routing
		// (which the extension leaves untouched for unhandled notches) does.
		expect(scroll.scrollTop).toBe(0);
	});

	it("consumes the notch for the draft, and asks for the repaint itself", () => {
		const { receiver, editor, scroll } = makeWheelReceiver();
		scroll.scrollTo(0);
		const renders: number[] = [];
		receiver.requestRender = () => renders.push(1);
		captured = install(receiver);
		const handler = captured.mouseHandlers[1];

		handler({ event: wheelDown(10, HEIGHT - 1), tui: receiver });

		// Consuming the notch means Pi never reaches its own repaint for that
		// event; the handler asks for one itself.
		expect(editor.scrollOffset).toBe(3);
		expect(renders).toHaveLength(1);
	});

	it("leaves the wheel alone while an overlay is up", () => {
		const { receiver, editor, scroll } = makeWheelReceiver();
		scroll.scrollTo(0);
		receiver.hasOverlay = () => true;
		captured = install(receiver);
		const handler = captured.mouseHandlers[1];

		const result = handler({ event: wheelDown(10, HEIGHT - 1), tui: receiver });

		// The dialog is what the pointer is aimed at; neither the draft nor the
		// transcript moves, and the notch defers to the focused overlay.
		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
		expect(scroll.scrollTop).toBe(0);
	});
});
