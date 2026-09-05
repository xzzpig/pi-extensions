import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import {
	editorBoxFor,
	setActiveEditor,
	wheelTarget,
} from "../../extensions/starline/mouse/editor-mouse";
import { type BoxLike, boxFor } from "../../extensions/starline/mouse/hit-test";
import { installMouseFeaturesOn } from "../../extensions/starline/mouse/index";

const WIDTH = 40;
const HEIGHT = 12;
/** `editorVisibleLines(TERMINAL_ROWS)` — Pi's own `max(5, rows * 0.3)`. */
const TERMINAL_ROWS = 12;
const VISIBLE = 5;

/**
 * Enough of Pi's `Editor` to be both laid out and scrolled: it renders a window
 * of its own lines, and exposes the `state`/`buildVisualLineMap` surface
 * `editor-scroll.ts` reads. One logical line per visual line keeps the map
 * trivial — wrapping is Pi's concern and is covered in `editor-scroll.test.ts`.
 */
class FakeEditor {
	readonly state: { lines: string[]; cursorLine: number; cursorCol: number };
	scrollOffset = 0;
	lastWidth = WIDTH;
	preferredVisualCol: number | null = 3;
	snappedFromCursorCol: number | null = 7;

	constructor(lines: string[]) {
		this.state = { lines, cursorLine: 0, cursorCol: 0 };
	}

	buildVisualLineMap(_width: number) {
		return this.state.lines.map((line, index) => ({
			logicalLine: index,
			startCol: 0,
			length: line.length,
		}));
	}

	render(_width: number): string[] {
		const window = this.state.lines.slice(this.scrollOffset, this.scrollOffset + VISIBLE);
		while (window.length < VISIBLE) window.push("");
		return window;
	}

	invalidate(): void {}
}

function draft(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `draft ${index}`);
}

/** The dock shape `interactive-mode.js` builds, reduced to the editor slot. */
function renderFrame(container: Container) {
	const transcript = new Text(draft(40).join("\n"), 0, 0);
	const scroll = new ScrollView(transcript, { primary: true });
	const dock = new VStack([{ component: container, shrink: 1, minSize: 3 }]);
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	return renderLayoutFrame(root, WIDTH, HEIGHT, () => {}) as { root: BoxLike };
}

function mount(editor: FakeEditor) {
	const container = new Container();
	container.addChild(editor as unknown as Parameters<Container["addChild"]>[0]);
	return { container, frame: renderFrame(container) };
}

describe("the editor's place in Pi's real layout", () => {
	it("gives the editor no box of its own", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		// The premise this task was handed, falsified against the real engine.
		expect(boxFor(frame.root, editor)).toBeUndefined();
	});

	it("gives the container the editor is mounted in a box with the editor's rect", () => {
		const editor = new FakeEditor(draft(20));
		const { container, frame } = mount(editor);
		const box = editorBoxFor(frame.root, editor);

		expect(box?.component).toBe(container);
		expect(box?.children).toEqual([]);
		expect(box?.rect).toEqual({ x: 0, y: HEIGHT - VISIBLE, width: WIDTH, height: VISIBLE });
	});

	it("finds nothing once the editor is unmounted from its container", () => {
		const editor = new FakeEditor(draft(20));
		const { container, frame } = mount(editor);
		container.clear();

		expect(editorBoxFor(frame.root, editor)).toBeUndefined();
	});
});

describe("wheelTarget", () => {
	it("routes to the editor when the pointer is over it", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		expect(wheelTarget(frame.root, editor, 10, HEIGHT - 1)).toBe("editor");
	});

	it("routes to the transcript otherwise", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		expect(wheelTarget(frame.root, editor, 10, 0)).toBe("transcript");
	});

	it("routes to the transcript when the editor is not mounted", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		expect(wheelTarget(frame.root, new FakeEditor(draft(3)), 10, HEIGHT - 1)).toBe("transcript");
	});

	it("routes to the transcript when there is no layout yet", () => {
		const editor = new FakeEditor(draft(20));

		expect(wheelTarget(undefined, editor, 10, HEIGHT - 1)).toBe("transcript");
	});
});

type FakeAltScreen = {
	currentLayout?: { root: BoxLike };
	terminal: { rows: number };
	wheelScrollLines: number;
	overlay: boolean;
	hasOverlay(): boolean;
	requestRender(): void;
	getSelectionBounds(): undefined;
	getSelectionColumns(): { start: number; end: number };
	flash(): void;
};

function makePrototype(): { prototype: FakeAltScreen; renders: number[] } {
	const renders: number[] = [];
	const prototype: FakeAltScreen = {
		terminal: { rows: TERMINAL_ROWS },
		wheelScrollLines: 3,
		overlay: false,
		hasOverlay() {
			return this.overlay;
		},
		requestRender() {
			renders.push(1);
		},
		getSelectionBounds: () => undefined,
		getSelectionColumns: () => ({ start: 0, end: 0 }),
		flash() {},
	};
	return { prototype, renders };
}

function makeConfig(wheelRouting: boolean): () => PolishedTuiConfig {
	return () =>
		({
			mouse: {
				enabled: true,
				wheelRouting,
				copyNotice: true,
				clickToExpandTools: false,
			},
		}) as PolishedTuiConfig;
}

const disposers: Array<() => void> = [];

afterEach(() => {
	while (disposers.length > 0) disposers.pop()?.();
	setActiveEditor(undefined);
});

type MouseContext = { event: Record<string, unknown>; tui: unknown };
type RegisteredHandler = (context: MouseContext) => unknown;

/**
 * Registers the features the way `pi-mouse-events` would, capturing the
 * handlers. The wheel handler is `mouseHandlers[1]`: registration order is
 * fixed by `installMouseFeaturesOn` — expand (20), wheel (10), caret (0) —
 * and the sub-option config is read at event time, not registration time, so
 * the index does not depend on the config here.
 */
function install(receiver: object, wheelRouting = true) {
	const mouseHandlers: RegisteredHandler[] = [];
	const copyHandlers: Array<(context: { tui: unknown }) => unknown> = [];
	const api = {
		version: 1,
		eventChannel: "pi-mouse-events:mouse",
		copySlotAvailable: true,
		addMouseHandler(handler: RegisteredHandler) {
			mouseHandlers.push(handler);
			return () => {
				const index = mouseHandlers.indexOf(handler);
				if (index !== -1) mouseHandlers.splice(index, 1);
			};
		},
		addCopyHandler(handler: (context: { tui: unknown }) => unknown) {
			copyHandlers.push(handler);
			return () => {};
		},
	} as never;
	const dispose = installMouseFeaturesOn(api, { ui: receiver } as never, {
		getConfig: makeConfig(wheelRouting),
	});
	const wheelHandler = (): RegisteredHandler | undefined => mouseHandlers[1];
	disposers.push(dispose);
	return { wheelHandler, mouseHandlers, dispose };
}

function wheelEvent(direction: 1 | -1, x: number, y: number): Record<string, unknown> {
	return {
		kind: "wheel",
		wheel: direction,
		x,
		y,
		button: direction === 1 ? 65 : 64,
		release: false,
	};
}

/**
 * What the wheel handler answers, per notch. The extension's own suite covers
 * the fall-through to Pi's routing for an unhandled notch; what Starline
 * owes is the consumption decision, which is what these assert.
 */
describe("the mouse-wheel handler", () => {
	function arrange(lines: number) {
		const editor = new FakeEditor(draft(lines));
		const { frame } = mount(editor);
		const { prototype, renders } = makePrototype();
		prototype.currentLayout = frame;
		setActiveEditor({ component: editor, scrollable: editor });
		return { editor, prototype, renders };
	}

	it("scrolls the input box instead of the transcript, and consumes the notch", () => {
		const { editor, prototype, renders } = arrange(20);
		const { wheelHandler } = install(prototype);

		const result = wheelHandler()!({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		expect(result).toEqual({ handled: true });
		expect(editor.scrollOffset).toBe(3);
		expect(renders).toHaveLength(1);
	});

	it("drags the caret into the new window so the next frame keeps the offset", () => {
		const { editor, prototype } = arrange(20);
		const { wheelHandler } = install(prototype);

		wheelHandler()!({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		// Pi re-derives `scrollOffset` from the caret on every render, so an
		// offset the caret is not inside of is undone by the very next frame.
		expect(editor.state.cursorLine).toBe(3);
		expect(editor.preferredVisualCol).toBeNull();
		expect(editor.snappedFromCursorCol).toBeNull();
	});

	it("does not consume a notch that landed outside the input box", () => {
		const { editor, prototype, renders } = arrange(20);
		const { wheelHandler } = install(prototype);

		const result = wheelHandler()!({ event: wheelEvent(-1, 10, 0), tui: prototype });

		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
		expect(renders).toHaveLength(0);
	});

	it("does not consume a notch over a draft that fits", () => {
		const { editor, prototype } = arrange(VISIBLE);
		const { wheelHandler } = install(prototype);

		const result = wheelHandler()!({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
	});

	it("keeps the notch once the box is scrolled to its end", () => {
		// Chaining on to the transcript at the boundary would make the box feel
		// like it slipped out from under the pointer.
		const { editor, prototype } = arrange(20);
		const { wheelHandler } = install(prototype);
		editor.scrollOffset = 15;
		editor.state.cursorLine = 19;

		const result = wheelHandler()!({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		expect(result).toEqual({ handled: true });
		expect(editor.scrollOffset).toBe(15);
	});

	it("lets the transcript have every notch when wheelRouting is off", () => {
		const { editor, prototype } = arrange(20);
		const { wheelHandler } = install(prototype, false);

		const result = wheelHandler()!({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
	});

	it("lets the transcript have a notch aimed at an overlay", () => {
		const { editor, prototype } = arrange(20);
		prototype.overlay = true;
		const { wheelHandler } = install(prototype);

		const result = wheelHandler()!({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
	});

	it("lets the transcript have every notch when no editor is registered", () => {
		const { editor, prototype } = arrange(20);
		setActiveEditor(undefined);
		const { wheelHandler } = install(prototype);

		const result = wheelHandler()!({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
	});

	it("stops acting once the handler is unsubscribed", () => {
		const { editor, prototype } = arrange(20);
		const { wheelHandler, mouseHandlers, dispose } = install(prototype);
		const handler = wheelHandler()!;
		dispose();

		expect(mouseHandlers).toHaveLength(0);
		const result = handler({ event: wheelEvent(1, 10, HEIGHT - 1), tui: prototype });

		// The extension no longer holds the handler, and the dispose also tore
		// down the install the handler would bind its receiver through — a
		// stale reference declines, and Pi's own routing answers the notch.
		expect(result).toBeUndefined();
		expect(editor.scrollOffset).toBe(0);
	});
});
