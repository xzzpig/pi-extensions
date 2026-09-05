/**
 * The extension entry point actually wiring the mouse features to the
 * `pi-mouse-events` extension.
 *
 * Starline no longer touches `TuiAltScreen.prototype` — that is the new
 * extension's job — so what this file pins is the other half of the contract:
 * the real `session_start`/`session_shutdown` handlers register and unregister
 * the features through the API published on `globalThis`, register nothing
 * when the API is absent, and leave the prototype exactly as they found it.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSelectionHintText } from "../../extensions/starline/mouse/index";

let mouseEnabled = true;

vi.mock("../../extensions/starline/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/starline/config")>();
	return {
		...actual,
		ensureConfigExists: () => {},
		loadConfig: () => ({
			...actual.defaultConfig,
			projectRefreshIntervalMs: 0,
			// `editor: false` keeps the editor factory out of the wiring under
			// test; `statusLine: false` keeps the footer out of it too.
			features: { ...actual.defaultConfig.features, editor: false, statusLine: false },
			mouse: { ...actual.defaultConfig.mouse, enabled: mouseEnabled },
		}),
	};
});

import starline from "../../extensions/starline/index";

type MouseHandler = (context: { event?: unknown; tui: unknown }) => unknown;
type CopyHandler = (context: { tui: unknown }) => unknown;

const MOUSE_EVENTS_API_KEY = Symbol.for("pi-mouse-events.api.v1");

type PublishedApi = {
	mouseHandlers: MouseHandler[];
	copyHandlers: CopyHandler[];
	live: unknown;
};

/**
 * A stand-in for the `pi-mouse-events` API at its published shape, parked on
 * the same `Symbol.for` key the real extension uses, so Starline's own
 * consumer accessor finds it. `live` is what `liveReceiver()` reports — the
 * tests point it at a fixture receiver the way the real input wrapper binds
 * the live renderer on first input.
 */
function publishFakeApi(copySlot = true): PublishedApi {
	const published: PublishedApi = { mouseHandlers: [], copyHandlers: [], live: undefined };
	(globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY] = {
		version: 1,
		eventChannel: "pi-mouse-events:mouse",
		copySlotAvailable: copySlot,
		liveReceiver: () => published.live,
		addMouseHandler(handler: MouseHandler) {
			published.mouseHandlers.push(handler);
			return () => {
				published.mouseHandlers = published.mouseHandlers.filter((entry) => entry !== handler);
			};
		},
		addCopyHandler(handler: CopyHandler) {
			published.copyHandlers.push(handler);
			return () => {
				published.copyHandlers = published.copyHandlers.filter((entry) => entry !== handler);
			};
		},
	};
	return published;
}

function unpublishFakeApi(): void {
	delete (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY];
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function loadExtension() {
	const handlers = new Map<string, Handler[]>();
	starline({
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
		getThinkingLevel() {
			return "off";
		},
	} as never);
	return handlers;
}

async function emit(handlers: Map<string, Handler[]>, name: string, ctx: unknown) {
	for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
}

/**
 * A minimal extension context. `ui` is Pi's extension-UI surface only — the
 * methods Starline installs through — while `receiver` is the renderer-like
 * fixture the fake API's `liveReceiver()` reports, the way the real input
 * wrapper binds the live `TuiAltScreen` on first input. Keeping them separate
 * is the whole point: in a real session `ctx.ui` is not the renderer, and
 * probing it instead of the live receiver would disable every feature.
 */
function makeCtx(overrides: { hasUI?: boolean; mode?: string } = {}) {
	let editorFactory: unknown;
	const receiver = {
		selectionBounds: { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
		previousScreen: ["hello world"],
		copyOnSelect: false,
		getCopyOnSelect(this: { copyOnSelect: boolean }) {
			return this.copyOnSelect;
		},
		hasActiveSelection(this: { selectionBounds: unknown }) {
			return this.selectionBounds !== undefined;
		},
		getSelectionBounds(this: { selectionBounds: unknown }) {
			return this.selectionBounds;
		},
		getSelectionColumns(
			line: string,
			row: number,
			selection: { start: { row: number; col: number }; end: { row: number; col: number } },
		) {
			return {
				start: row === selection.start.row ? selection.start.col : 0,
				end: row === selection.end.row ? selection.end.col : line.length,
			};
		},
		flash() {},
		hasOverlay() {
			return false;
		},
		requestRender() {},
	};
	const ui = {
		theme: {} as never,
		onTerminalInput(_handler: (data: string) => unknown) {
			return () => {};
		},
		setFooter() {},
		setEditorComponent(factory: unknown) {
			editorFactory = factory;
		},
		getEditorComponent() {
			return editorFactory;
		},
	};
	return {
		hasUI: overrides.hasUI ?? true,
		mode: overrides.mode ?? "tui",
		cwd: process.cwd(),
		model: { id: "test", provider: "anthropic", contextWindow: 10_000 },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => null,
		ui,
		receiver,
	};
}

describe("extension wiring of the mouse features", () => {
	let open: { handlers: Map<string, Handler[]>; ctx: ReturnType<typeof makeCtx> } | undefined;
	let published: PublishedApi | undefined;

	async function startSession(ctx = makeCtx()) {
		const handlers = loadExtension();
		open = { handlers, ctx };
		await emit(handlers, "session_start", ctx);
		return { handlers, ctx };
	}

	async function endSession() {
		if (!open) return;
		const { handlers, ctx } = open;
		open = undefined;
		await emit(handlers, "session_shutdown", ctx);
	}

	afterEach(async () => {
		try {
			await endSession();
		} finally {
			mouseEnabled = true;
			unpublishFakeApi();
			published = undefined;
		}
	});

	it("registers the mouse handlers on session_start and unregisters them on shutdown", async () => {
		published = publishFakeApi();
		await startSession();

		// Three mouse handlers (expand, wheel, caret) plus the copy handler.
		expect(published.mouseHandlers).toHaveLength(3);
		expect(published.copyHandlers).toHaveLength(1);

		await endSession();
		expect(published.mouseHandlers).toHaveLength(0);
		expect(published.copyHandlers).toHaveLength(0);
	});

	it("never touches the TuiAltScreen prototype", async () => {
		published = publishFakeApi();
		const proto = TuiAltScreen.prototype as unknown as Record<string, unknown>;
		const before = {
			viewport: proto.handleViewportInput,
			copy: (TuiAltScreen.prototype as unknown as Record<string, unknown>)
				.copyActiveSelectionToClipboard,
			selection: (TuiAltScreen.prototype as unknown as Record<string, unknown>)
				.handleSelectionMouseEvent,
			wheel: (TuiAltScreen.prototype as unknown as Record<string, unknown>).routeWheel,
		};

		await startSession();
		await endSession();

		expect(proto.handleViewportInput).toBe(before.viewport);
		expect(
			(TuiAltScreen.prototype as unknown as Record<string, unknown>).copyActiveSelectionToClipboard,
		).toBe(before.copy);
		expect(
			(TuiAltScreen.prototype as unknown as Record<string, unknown>).handleSelectionMouseEvent,
		).toBe(before.selection);
		expect((TuiAltScreen.prototype as unknown as Record<string, unknown>).routeWheel).toBe(
			before.wheel,
		);
	});

	it("registers nothing when mouse.enabled is false", async () => {
		published = publishFakeApi();
		mouseEnabled = false;
		await startSession();

		expect(published.mouseHandlers).toHaveLength(0);
		expect(published.copyHandlers).toHaveLength(0);
	});

	it("registers nothing — with one console note — when the extension is not installed", async () => {
		// No publishFakeApi(): the package is missing. No fallback, no patches —
		// the features are simply off.
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await startSession();
			// The capability warning never fires either: without the API the
			// install stops before probing.
			expect(warn).not.toHaveBeenCalled();
			expect(info).toHaveBeenCalled();
		} finally {
			info.mockRestore();
			warn.mockRestore();
		}
	});

	it("registers no copy handler when the extension's copy slot is unavailable", async () => {
		published = publishFakeApi(false);
		await startSession();

		expect(published.copyHandlers).toHaveLength(0);
		// The pointer features do not need the copy slot.
		expect(published.mouseHandlers).toHaveLength(3);
	});

	it("registers without duplication across two session_starts", async () => {
		published = publishFakeApi();
		const { handlers, ctx } = await startSession();
		await emit(handlers, "session_start", ctx);

		expect(published.mouseHandlers).toHaveLength(3);
		expect(published.copyHandlers).toHaveLength(1);
	});

	it("derives the selection hint from the live receiver once one exists", async () => {
		published = publishFakeApi();
		const { ctx } = await startSession();

		// No renderer has been seen yet — install binds lazily, so there is
		// nothing to read a selection from and the hint stays quiet.
		expect(activeSelectionHintText()).toBeNull();

		// The first input binds the live receiver (the fake reports the
		// fixture here), and the hint reads it from then on.
		published.live = ctx.receiver;
		expect(activeSelectionHintText()).toContain("5 characters selected");

		await endSession();
		expect(activeSelectionHintText()).toBeNull();
	});

	it("stays out of a non-TUI context", async () => {
		published = publishFakeApi();
		await startSession(makeCtx({ hasUI: false }));

		expect(published.mouseHandlers).toHaveLength(0);
		expect(published.copyHandlers).toHaveLength(0);
	});
});
