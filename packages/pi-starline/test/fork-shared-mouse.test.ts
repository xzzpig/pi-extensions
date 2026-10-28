import { afterEach, describe, expect, it, vi } from "vitest";
import { createMouseEventsApi } from "../../pi-mouse-events/extensions/api-registry.ts";
import {
	type InstalledPatches,
	installMousePatches,
} from "../../pi-mouse-events/extensions/patch.ts";
import { nativeCopyHandler } from "../extensions/starline/mouse/fork-native-clipboard";
import { installSharedPillMouse } from "../extensions/starline/mouse/fork-pill-mouse";
import { requestPointerShape } from "../extensions/starline/mouse/pointer-shape";
import {
	closePillBubble,
	isPillBubbleOpenFor,
	showPillBubble,
} from "../extensions/starline/pill-bubble";

const KEY = Symbol.for("pi-mouse-events.api.v2");
let patches: InstalledPatches | undefined;
let stopPillMouse: (() => void) | undefined;

afterEach(() => {
	stopPillMouse?.();
	stopPillMouse = undefined;
	patches?.dispose();
	patches = undefined;
	closePillBubble();
	delete (globalThis as Record<symbol, unknown>)[KEY];
});

class Renderer {
	terminal = { rows: 24, write: vi.fn() };
	nativeInput = vi.fn();
	copySelection?: (text: string) => boolean | string | Promise<boolean | string>;
	applySelection(rows: string[]) {
		return rows;
	}
	handleViewportInput(data: string) {
		this.nativeInput(data);
	}
	async copyActiveSelectionToClipboard() {
		return false;
	}
}

function setup() {
	const pi = { events: { emit() {} } };
	patches = installMousePatches(pi as never, Renderer.prototype);
	if (!patches) throw new Error("missing shared mouse patch");
	const api = createMouseEventsApi(patches);
	(globalThis as Record<symbol, unknown>)[KEY] = api;
	return { api, receiver: new Renderer() };
}

describe("Starline and the real shared mouse layer", () => {
	it("routes Starline's pointer request through the shared hover dispatch", () => {
		const { receiver } = setup();
		receiver.nativeInput.mockImplementationOnce(() => requestPointerShape("pointer"));
		receiver.handleViewportInput("\x1b[<35;3;4M");
		receiver.handleViewportInput("\x1b[<35;4;4M");
		expect(receiver.terminal.write.mock.calls.map(([value]) => value)).toEqual([
			"\x1b]22;pointer\x1b\\",
			"\x1b]22;default\x1b\\",
		]);
	});

	it("safely ignores pointer requests with an older v2 publisher", () => {
		(globalThis as Record<symbol, unknown>)[KEY] = { version: 2 };
		expect(() => requestPointerShape("pointer")).not.toThrow();
	});

	it("dismisses a bubble on an outside press without consuming it", () => {
		const { api, receiver } = setup();
		stopPillMouse = installSharedPillMouse(api);
		const custom = vi.fn().mockResolvedValue(undefined);
		showPillBubble(
			{ hasUI: true, ui: { custom } } as never,
			{ title: "Queue", body: ["one"] },
			{
				key: "queue",
				startColumn: 10,
				endColumn: 18,
				centerColumn: 14,
				terminalWidth: 80,
				background: "",
				foreground: "",
			},
		);
		const [factory, options] = custom.mock.calls[0];
		const done = vi.fn();
		const bubble = factory({ requestRender() {} }, {}, {}, done);
		bubble.render(options.overlayOptions.width);
		expect(isPillBubbleOpenFor("queue")).toBe(true);
		receiver.handleViewportInput("\x1b[<0;1;1M");
		expect(done).toHaveBeenCalledOnce();
		expect(isPillBubbleOpenFor("queue")).toBe(false);
		expect(receiver.nativeInput).toHaveBeenCalledOnce();
	});

	it("awaits native clipboard completion through the real shared copy slot", async () => {
		const { api, receiver } = setup();
		const copy = vi.fn(async (_text: string) => true);
		receiver.copySelection = copy;
		if (!api.addAsyncCopyHandler) throw new Error("missing async copy slot");
		api.addAsyncCopyHandler(
			nativeCopyHandler(() => ({
				receiver,
				showNotice: false,
				texts: [() => "clean text"],
			})),
		);
		expect(await receiver.copyActiveSelectionToClipboard()).toBe(true);
		expect(copy).toHaveBeenCalledWith("clean text");
		expect(receiver.terminal.write).not.toHaveBeenCalled();
	});
});
