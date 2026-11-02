import { afterEach, describe, expect, it, vi } from "vitest";
import { handleStatusPanelCommand } from "../extensions/starline/fork-overflow-settings";
import { closeStatusPanel, openStatusPanel } from "../extensions/starline/fork-status-panel";
import { clearStatusPanelModel } from "../extensions/starline/fork-status-view";
import type { PillAnchor } from "../extensions/starline/pill-bubble";
import {
	closePillBubble,
	isPillBubbleOpenFor,
	showPillBubble,
} from "../extensions/starline/pill-bubble";

type CustomCall = { factory: unknown; options?: Record<string, unknown> };

function fakeContext() {
	const custom: CustomCall[] = [];
	const notify = vi.fn();
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify,
			custom: (factory: unknown, options?: Record<string, unknown>) => {
				custom.push({ factory, options });
				return Promise.resolve(undefined);
			},
		},
	};
	return { ctx: ctx as never, custom, notify };
}

function publishMouseApi(receiver: unknown): void {
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-mouse-events.api.v2")] = {
		version: 2,
		liveReceiver: () => receiver,
	};
}

function clearMouseApi(): void {
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-mouse-events.api.v2")];
}

const bubbleAnchor: PillAnchor = {
	centerColumn: 8,
	terminalWidth: 80,
	background: "\x1b[48;2;40;40;40m",
	foreground: "",
	key: "model",
};

afterEach(() => {
	closePillBubble();
	closeStatusPanel();
	clearStatusPanelModel();
	clearMouseApi();
});

describe("the panel entrance hands over cleanly", () => {
	it("closes Starline's own bubble before it mounts", () => {
		const { ctx, custom } = fakeContext();
		showPillBubble(ctx, { title: "Model", body: ["kimi"] }, bubbleAnchor);
		expect(isPillBubbleOpenFor("model")).toBe(true);

		openStatusPanel(ctx);

		// The bubble is gone, and the panel is the only overlay left.
		expect(isPillBubbleOpenFor("model")).toBe(false);
		expect(custom).toHaveLength(2);
		expect(custom[1]?.options).toMatchObject({ overlay: true });
	});

	it("refuses to stack on top of an external overlay", () => {
		publishMouseApi({ hasOverlay: () => true });
		const { ctx, custom, notify } = fakeContext();

		openStatusPanel(ctx);

		expect(custom).toHaveLength(0);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
	});

	it("refuses from the command entrance too, and says why", () => {
		publishMouseApi({ hasOverlay: () => true });
		const { ctx, custom, notify } = fakeContext();

		expect(handleStatusPanelCommand("statuses", ctx)).toBe(true);

		expect(custom).toHaveLength(0);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("opens when no overlay is up, and while no mouse layer is installed", () => {
		const withApi = fakeContext();
		publishMouseApi({ hasOverlay: () => false });
		openStatusPanel(withApi.ctx);
		expect(withApi.custom).toHaveLength(1);

		clearMouseApi();
		const withoutApi = fakeContext();
		openStatusPanel(withoutApi.ctx);
		expect(withoutApi.custom).toHaveLength(1);
	});

	it("opens when the overlay probe is missing or broken", () => {
		const withoutProbe = fakeContext();
		publishMouseApi({});
		openStatusPanel(withoutProbe.ctx);
		expect(withoutProbe.custom).toHaveLength(1);

		const throwing = fakeContext();
		publishMouseApi({
			hasOverlay: () => {
				throw new Error("receiver gone");
			},
		});
		openStatusPanel(throwing.ctx);
		expect(throwing.custom).toHaveLength(1);
	});

	it("still closes its own bubble when the external overlay wins", () => {
		const { ctx } = fakeContext();
		showPillBubble(ctx, { title: "Model", body: ["kimi"] }, bubbleAnchor);
		publishMouseApi({ hasOverlay: () => true });

		openStatusPanel(ctx);

		expect(isPillBubbleOpenFor("model")).toBe(false);
	});

	it("replaces an already open panel instead of stacking two", () => {
		const { ctx, custom } = fakeContext();
		openStatusPanel(ctx);
		openStatusPanel(ctx);
		expect(custom).toHaveLength(2);
		// Only the newest component stays live.
		const first = custom[0]?.factory as (...args: unknown[]) => { render(width: number): string[] };
		expect(typeof first).toBe("function");
		closeStatusPanel();
	});
});
