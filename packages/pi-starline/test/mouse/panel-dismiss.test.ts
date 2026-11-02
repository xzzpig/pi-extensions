import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activeStatusPanelRect,
	closeStatusPanel,
	isStatusPanelOpen,
	openStatusPanel,
} from "../../extensions/starline/fork-status-panel";
import { clearStatusPanelModel } from "../../extensions/starline/fork-status-view";
import {
	installStatusPanelDismiss,
	isOutsideStatusPanel,
} from "../../extensions/starline/mouse/panel-dismiss";
import { publishPointerEvent } from "../../extensions/starline/mouse/pointer-events";

const ROWS = 42;

const rect = { left: 25, top: 9, width: 72, height: 24 };

const disposers: (() => void)[] = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	closeStatusPanel();
	clearStatusPanelModel();
});

function press(x: number, y: number) {
	return { button: 0, x, y };
}

describe("isOutsideStatusPanel", () => {
	it("counts the four sides and the corners", () => {
		expect(isOutsideStatusPanel(press(24, 20), rect)).toBe(true);
		expect(isOutsideStatusPanel(press(97, 20), rect)).toBe(true);
		expect(isOutsideStatusPanel(press(40, 8), rect)).toBe(true);
		expect(isOutsideStatusPanel(press(40, 33), rect)).toBe(true);
	});

	it("keeps everything inside, edges included", () => {
		expect(isOutsideStatusPanel(press(25, 9), rect)).toBe(false);
		expect(isOutsideStatusPanel(press(96, 32), rect)).toBe(false);
		expect(isOutsideStatusPanel(press(60, 20), rect)).toBe(false);
	});

	it("counts the footer row as outside too", () => {
		// The bar is not special: a press there dismisses the panel, and the guard in
		// `dismissStatusPanel` stops that same press from reopening it.
		expect(isOutsideStatusPanel(press(10, ROWS - 1), rect)).toBe(true);
	});

	it("ignores everything that is not a press", () => {
		expect(isOutsideStatusPanel({ button: 0, x: 1, y: 1, release: true }, rect)).toBe(false);
		// motion (bit 32) and wheel (bit 64) are not presses
		expect(isOutsideStatusPanel({ button: 32, x: 1, y: 1 }, rect)).toBe(false);
		expect(isOutsideStatusPanel({ button: 64, x: 1, y: 1 }, rect)).toBe(false);
	});

	it("does nothing without a rectangle", () => {
		expect(isOutsideStatusPanel(press(1, 1), undefined)).toBe(false);
	});
});

describe("installStatusPanelDismiss", () => {
	function mountPanel() {
		const custom: { factory: unknown }[] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				notify: vi.fn(),
				custom: (factory: unknown) => {
					custom.push({ factory });
					(factory as (...args: unknown[]) => unknown)(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text },
						{},
						() => {},
					);
					return Promise.resolve(undefined);
				},
			},
		};
		openStatusPanel(ctx as never);
		// Render once so the panel records where it is.
		const mounted = custom[0];
		if (!mounted) throw new Error("panel was not mounted");
		const component = (
			mounted.factory as (...args: unknown[]) => {
				render(width: number): string[];
				handleInput(data: string): void;
			}
		)({ requestRender() {} }, { fg: (_c: string, t: string) => t }, {}, () => {});
		component.render(80);
		return { ctx, component, custom };
	}

	it("closes the panel on a press outside it", () => {
		disposers.push(installStatusPanelDismiss());
		mountPanel();
		const box = activeStatusPanelRect();
		expect(box).toBeDefined();
		expect(isStatusPanelOpen()).toBe(true);

		publishPointerEvent(press((box?.left ?? 0) - 2, 20), { terminal: { rows: ROWS } });
		expect(isStatusPanelOpen()).toBe(false);
	});

	it("keeps the panel on a press inside it", () => {
		disposers.push(installStatusPanelDismiss());
		mountPanel();
		const box = activeStatusPanelRect();
		publishPointerEvent(press((box?.left ?? 0) + 2, (box?.top ?? 0) + 2), {
			terminal: { rows: ROWS },
		});
		expect(isStatusPanelOpen()).toBe(true);
	});

	it("closes on a press on the footer row, and does not let it reopen", () => {
		disposers.push(installStatusPanelDismiss());
		const { ctx, custom } = mountPanel();
		publishPointerEvent(press(2, ROWS - 1), { terminal: { rows: ROWS } });
		expect(isStatusPanelOpen()).toBe(false);
		// The same press then reaches the pill underneath: it must not reopen.
		openStatusPanel(ctx as never);
		expect(isStatusPanelOpen()).toBe(false);
		expect(custom).toHaveLength(1);
		// A deliberate second click opens it: the guard was a single echo.
		openStatusPanel(ctx as never);
		expect(isStatusPanelOpen()).toBe(true);
		expect(custom).toHaveLength(2);
	});

	it("opens again after Esc: the stale rectangle must not swallow the press", () => {
		disposers.push(installStatusPanelDismiss());
		const { ctx, component, custom } = mountPanel();
		expect(isStatusPanelOpen()).toBe(true);

		// Esc closes through the component, which is the path that used to leave the
		// rectangle behind.
		component.handleInput("\x1b");
		expect(isStatusPanelOpen()).toBe(false);
		expect(activeStatusPanelRect()).toBeUndefined();

		// The next press is a new gesture: the observer must not dismiss (and arm the
		// guard) for a panel that is already gone.
		publishPointerEvent(press(2, ROWS - 1), { terminal: { rows: ROWS } });
		openStatusPanel(ctx as never);
		expect(isStatusPanelOpen()).toBe(true);
		expect(custom).toHaveLength(2);
	});

	it("does nothing when no panel is open", () => {
		disposers.push(installStatusPanelDismiss());
		expect(() => publishPointerEvent(press(1, 1), { terminal: { rows: ROWS } })).not.toThrow();
	});
});
