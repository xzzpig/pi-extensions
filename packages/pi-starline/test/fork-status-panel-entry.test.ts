import { afterEach, describe, expect, it, vi } from "vitest";
import { handleStatusPanelCommand } from "../extensions/starline/fork-overflow-settings";
import {
	closeStatusPanel,
	isStatusPanelOpen,
	openStatusPanel,
} from "../extensions/starline/fork-status-panel";
import {
	clearStatusPanelModel,
	publishStatusPanelModel,
} from "../extensions/starline/fork-status-view";
import { registerExternalPillAction } from "../extensions/starline/pill-api";
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
				// Mount it the way Pi does, so the module's open-panel handle exists.
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

describe("a panel entry runs its action like a pill click", () => {
	it("passes via=click so pickers open instead of cycling", () => {
		const seen: (string | undefined)[] = [];
		const dispose = registerExternalPillAction("alpha", (actionContext) => {
			seen.push(actionContext.via);
		});
		try {
			publishStatusPanelModel({
				items: [{ key: "alpha", title: "alpha", text: "one", state: "full", actionable: true }],
				others: [],
				hiddenCount: 0,
				signature: "entry-via",
			});
			const { ctx, custom } = fakeContext();
			openStatusPanel(ctx);
			const mounted = custom[0];
			if (!mounted) throw new Error("panel was not mounted");
			const component = (
				mounted.factory as (...args: unknown[]) => {
					render(width: number): string[];
					handleInput(data: string): void;
				}
			)({ requestRender() {} }, { fg: (_c: string, t: string) => t }, {}, () => {});
			// Rendering is what settles the initial selection.
			component.render(80);
			component.handleInput("\r");
			expect(seen).toEqual(["click"]);
		} finally {
			dispose();
		}
	});
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

	it("stays silent on top of an external overlay", () => {
		publishMouseApi({ hasOverlay: () => true });
		const { ctx, custom, notify } = fakeContext();

		openStatusPanel(ctx);

		expect(custom).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("stays silent from the command entrance too", () => {
		publishMouseApi({ hasOverlay: () => true });
		const { ctx, custom, notify } = fakeContext();

		expect(handleStatusPanelCommand("statuses", ctx)).toBe(true);

		expect(custom).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("opens when no overlay is up, and while no mouse layer is installed", () => {
		const withApi = fakeContext();
		publishMouseApi({ hasOverlay: () => false });
		openStatusPanel(withApi.ctx);
		expect(withApi.custom).toHaveLength(1);
		closeStatusPanel();

		clearMouseApi();
		const withoutApi = fakeContext();
		openStatusPanel(withoutApi.ctx);
		expect(withoutApi.custom).toHaveLength(1);
		closeStatusPanel();
	});

	it("opens when the overlay probe is missing or broken", () => {
		const withoutProbe = fakeContext();
		publishMouseApi({});
		openStatusPanel(withoutProbe.ctx);
		expect(withoutProbe.custom).toHaveLength(1);
		closeStatusPanel();

		const throwing = fakeContext();
		publishMouseApi({
			hasOverlay: () => {
				throw new Error("receiver gone");
			},
		});
		openStatusPanel(throwing.ctx);
		expect(throwing.custom).toHaveLength(1);
		closeStatusPanel();
	});

	it("still closes its own bubble when the external overlay wins", () => {
		const { ctx } = fakeContext();
		showPillBubble(ctx, { title: "Model", body: ["kimi"] }, bubbleAnchor);
		publishMouseApi({ hasOverlay: () => true });

		openStatusPanel(ctx);

		expect(isPillBubbleOpenFor("model")).toBe(false);
	});

	it("closes instead of stacking when the same entrance is used again", () => {
		const { ctx, custom } = fakeContext();
		openStatusPanel(ctx);
		expect(isStatusPanelOpen()).toBe(true);
		openStatusPanel(ctx);
		expect(isStatusPanelOpen()).toBe(false);
		// The second call toggled the open panel away; it did not mount another.
		expect(custom).toHaveLength(1);
	});

	it("replaces the panel when a different entry is asked for", () => {
		const { ctx, custom } = fakeContext();
		openStatusPanel(ctx, "extensionStatus:a");
		openStatusPanel(ctx, "extensionStatus:b");
		expect(isStatusPanelOpen()).toBe(true);
		expect(custom).toHaveLength(2);
	});

	it("toggles the panel opened from a summary pill", () => {
		const { ctx, custom } = fakeContext();
		openStatusPanel(ctx, "extensionStatus:goal");
		openStatusPanel(ctx, "extensionStatus:goal");
		expect(isStatusPanelOpen()).toBe(false);
		expect(custom).toHaveLength(1);
	});
});
