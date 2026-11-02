import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeConfig } from "../extensions/starline/config";
import { installFooter } from "../extensions/starline/footer";
import { OVERFLOW_SUMMARY_KEY } from "../extensions/starline/fork-pill-overflow";
import { closeStatusPanel, isStatusPanelOpen } from "../extensions/starline/fork-status-panel";
import {
	clearStatusPanelModel,
	readStatusPanelModel,
} from "../extensions/starline/fork-status-view";
import { emptyGitStatus } from "../extensions/starline/git";
import { installStatusPanelDismiss } from "../extensions/starline/mouse/panel-dismiss";
import { publishPointerEvent } from "../extensions/starline/mouse/pointer-events";
import { registerExternalPillAction } from "../extensions/starline/pill-api";
import { closePillBubble } from "../extensions/starline/pill-bubble";
import { createInitialState } from "../extensions/starline/state";
import type { ThemeLike } from "../extensions/starline/style";

const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const plain = (text: string) => stripVTControlCharacters(text);

afterEach(() => {
	closePillBubble();
	closeStatusPanel();
	clearStatusPanelModel();
});

type FooterFactory = (...args: unknown[]) => {
	render(width: number): string[];
	handleMouse?: (event: Record<string, unknown>) => { handled?: boolean } | undefined;
	dispose?: () => void;
};

type CustomCapture = {
	factory: (...args: unknown[]) => Record<string, unknown>;
	options?: Record<string, unknown>;
};

function makeFooter(options: {
	statuses: ReadonlyMap<string, string>;
	segments?: string[];
	pill?: Record<string, unknown>;
	extensionStatuses?: Record<string, unknown>;
	width?: number;
}) {
	let factory: FooterFactory | undefined;
	const custom: CustomCapture[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp/project",
		model: { id: "kimi", provider: "deepseek", contextWindow: 200_000 },
		sessionManager: { getSessionName: () => undefined },
		getContextUsage: () => undefined,
		hasPendingMessages: () => false,
		ui: {
			theme,
			setFooter(next: FooterFactory | undefined) {
				factory = next;
			},
			custom: vi.fn((componentFactory: CustomCapture["factory"], overlayOptions: unknown) => {
				custom.push({
					factory: componentFactory,
					options: overlayOptions as Record<string, unknown>,
				});
				// Mount it the way Pi does, so the panel's open-panel handle exists and
				// a second press can be a toggle rather than another mount. Render once
				// so it also records the rectangle the dismissal check reads.
				const mounted = componentFactory(
					{ requestRender: vi.fn() },
					theme,
					{ matches: () => false },
					vi.fn(),
				) as { render?(width: number): string[] } | undefined;
				mounted?.render?.(80);
				return Promise.resolve(undefined);
			}),
			notify: vi.fn(),
		},
	};

	const state = createInitialState(emptyGitStatus());
	state.modelLabel = "kimi";
	const config = mergeConfig({
		footerStyle: "pill",
		pill: {
			segments: options.segments ?? ["cwd", "extensionStatus"],
			...(options.pill ?? {}),
		},
		colorSources: { starship: "theme" },
		extensionStatuses: options.extensionStatuses as never,
	});

	installFooter(ctx as never, state, () => config, {
		setRequestRender() {},
		scheduleProjectRefresh() {},
	});

	const footer = factory?.({ requestRender() {} }, theme, {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => options.statuses,
	});
	if (!footer) throw new Error("footer factory was not registered");

	const renderRow = (width: number) => {
		const line = footer.render(width)[0] ?? "";
		return { line, text: plain(line) };
	};
	return { footer, ctx, custom, renderRow };
}

function statuses(count: number): Map<string, string> {
	const map = new Map<string, string>();
	for (let index = 0; index < count; index += 1) {
		map.set(`status-${String(index).padStart(2, "0")}`, `value ${index}`);
	}
	return map;
}

function openPanel(capture: CustomCapture) {
	const done = vi.fn();
	const component = capture.factory(
		{ requestRender: vi.fn() },
		theme,
		{ matches: () => false },
		done,
	) as {
		render(width: number): string[];
		handleInput?(data: string): void;
		handleMouse?(event: Record<string, unknown>): { handled?: boolean } | undefined;
	};
	return { component, done };
}

describe("the governed bar", () => {
	it("summarises the entries that do not fit and keeps the row inside the width", () => {
		const { renderRow } = makeFooter({ statuses: statuses(12) });
		const { line, text } = renderRow(60);
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(text).toMatch(/\+\d+/);
		// Whatever is drawn is a whole pill: no content cut by the edge.
		expect(text).not.toContain("…");
	});

	it("draws every pill when the row has room", () => {
		const { renderRow } = makeFooter({
			statuses: new Map([
				["a", "alpha"],
				["b", "beta"],
			]),
		});
		const { text } = renderRow(200);
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
		expect(text).not.toMatch(/\+\d+/);
	});

	it("publishes a model whose states match the row", () => {
		const { renderRow } = makeFooter({ statuses: statuses(12) });
		renderRow(60);
		const model = readStatusPanelModel();
		const hidden = model.items.filter((item) => item.state === "hidden");
		expect(hidden.length).toBe(model.hiddenCount);
		expect(hidden.length).toBeGreaterThan(0);
		expect(model.items.every((item) => item.state !== "off")).toBe(true);
	});

	it("marks a shortened pill as truncated without hiding it", () => {
		const long = "这是一条非常非常长的第三方状态文本用于测试缩略";
		const { renderRow } = makeFooter({
			statuses: new Map([["goal", long]]),
			segments: ["extensionStatus"],
		});
		const { text } = renderRow(120);
		expect(text).toContain("…");
		const model = readStatusPanelModel();
		const item = model.items.find((candidate) => candidate.key === "extensionStatus:goal");
		expect(item?.state).toBe("truncated");
		expect(item?.text).toBe(long);
	});
});

describe("degradation on a very narrow bar", () => {
	it("draws a bare +N, then a bare +, before giving up", () => {
		const { renderRow } = makeFooter({
			statuses: new Map([["mcp", "MCP: 8 servers connected"]]),
			segments: ["extensionStatus"],
		});
		const one = renderRow(1);
		expect(one.text).toBe("+");
		expect(visibleWidth(one.line)).toBeLessThanOrEqual(1);
		const two = renderRow(2);
		expect(two.text).toBe("+1");
		expect(visibleWidth(two.line)).toBeLessThanOrEqual(2);
		// Decoration is what gets dropped first: no caps where they cannot fit.
		expect(one.text).not.toContain("\ue0b6");
		expect(two.text).not.toContain("\ue0b6");
		for (const width of [1, 2, 3, 4, 5, 6]) {
			const row = renderRow(width);
			expect(visibleWidth(row.line)).toBeLessThanOrEqual(width);
			expect(row.text).toContain("+");
		}
	});
});

describe("governance off keeps the old click behaviour", () => {
	const long = "a".repeat(40);

	it("does not turn a fully drawn read-only pill into a panel entry", () => {
		const { footer, custom, renderRow } = makeFooter({
			statuses: new Map([["long", long]]),
			segments: ["extensionStatus"],
			pill: { overflow: { enabled: false } },
		});
		const width = 120;
		const { text } = renderRow(width);
		expect(text).toContain(long);
		footer.handleMouse?.({
			type: "press",
			x: text.indexOf(long),
			y: 0,
			width,
			height: 1,
		});
		expect(custom).toHaveLength(0);
	});

	it("still opens the panel for the same pill when governance is on", () => {
		const { footer, custom, renderRow } = makeFooter({
			statuses: new Map([["long", long]]),
			segments: ["extensionStatus"],
		});
		const width = 120;
		const { text } = renderRow(width);
		footer.handleMouse?.({
			type: "press",
			x: text.indexOf(long.slice(0, 10)),
			y: 0,
			width,
			height: 1,
		});
		expect(custom).toHaveLength(1);
	});
});

describe("opening the detail view", () => {
	it("opens the panel from the summary pill", () => {
		const { footer, custom, renderRow } = makeFooter({ statuses: statuses(12) });
		const width = 60;
		const { line } = renderRow(width);
		const text = plain(line);
		const summary = /\+\d+/.exec(text);
		expect(summary).toBeTruthy();
		const column = text.indexOf(summary?.[0] ?? "");
		expect(footer.handleMouse?.({ type: "press", x: column, y: 0, width, height: 1 })).toEqual({
			handled: true,
		});
		expect(custom).toHaveLength(1);
		const { component } = openPanel(custom[0]!);
		const rows = component.render(60).map(plain).join("\n");
		expect(rows).toContain("状态");
		expect(rows).toContain("未展示");
	});

	it("closes the panel when the summary pill is pressed again", () => {
		const { footer, custom, renderRow } = makeFooter({ statuses: statuses(12) });
		const width = 60;
		const text = plain(renderRow(width).line);
		const column = text.indexOf(/\+\d+/.exec(text)?.[0] ?? "");
		const press = () => footer.handleMouse?.({ type: "press", x: column, y: 0, width, height: 1 });
		press();
		expect(custom).toHaveLength(1);
		expect(isStatusPanelOpen()).toBe(true);
		// The same pill again is a toggle, not a second panel and not a warning.
		press();
		expect(custom).toHaveLength(1);
		expect(isStatusPanelOpen()).toBe(false);
	});

	it("dismisses on any bar press and does not let that press reopen it", () => {
		const dispose = installStatusPanelDismiss();
		try {
			const { footer, custom, renderRow } = makeFooter({ statuses: statuses(12) });
			const width = 60;
			const text = plain(renderRow(width).line);
			const summaryColumn = text.indexOf(/\+\d+/.exec(text)?.[0] ?? "");
			// The renderer publishes every pointer report before Pi dispatches it.
			const press = (x: number) => {
				publishPointerEvent({ button: 0, x, y: 41 }, { terminal: { rows: 42 } });
				footer.handleMouse?.({ type: "press", x, y: 0, width, height: 1 });
			};

			press(summaryColumn);
			expect(isStatusPanelOpen()).toBe(true);

			// Padding on the bar is outside the panel: it goes away and the footer's
			// own press does not bring it back.
			press(0);
			expect(isStatusPanelOpen()).toBe(false);

			// The pill itself is outside too: one press closes, and the guard keeps the
			// footer's toggle from reopening it in the same gesture.
			press(summaryColumn);
			expect(isStatusPanelOpen()).toBe(true);
			press(summaryColumn);
			expect(isStatusPanelOpen()).toBe(false);
			expect(custom).toHaveLength(2);
		} finally {
			dispose();
		}
	});

	it("opens again after Esc closed the panel", () => {
		const dispose = installStatusPanelDismiss();
		try {
			const { footer, custom, renderRow } = makeFooter({ statuses: statuses(12) });
			const width = 60;
			const text = plain(renderRow(width).line);
			const summaryColumn = text.indexOf(/\+\d+/.exec(text)?.[0] ?? "");
			const press = () => {
				publishPointerEvent({ button: 0, x: summaryColumn, y: 41 }, { terminal: { rows: 42 } });
				footer.handleMouse?.({ type: "press", x: summaryColumn, y: 0, width, height: 1 });
			};

			press();
			expect(isStatusPanelOpen()).toBe(true);

			// Esc closes through the component, which must also clear the rectangle and
			// the guard state the observer reads.
			const panel = custom[0];
			if (!panel) throw new Error("panel was not mounted");
			const component = (
				panel.factory as (...args: unknown[]) => { handleInput(data: string): void }
			)({ requestRender: vi.fn() }, theme, { matches: () => false }, vi.fn());
			component.handleInput("\x1b");
			expect(isStatusPanelOpen()).toBe(false);

			// The next +N press is a new gesture: it must open, not be swallowed.
			press();
			expect(isStatusPanelOpen()).toBe(true);
			expect(custom).toHaveLength(2);
		} finally {
			dispose();
		}
	});

	it("does not stack on an external overlay when the +N pill is pressed", () => {
		const mouseKey = Symbol.for("pi-mouse-events.api.v2");
		(globalThis as Record<symbol, unknown>)[mouseKey] = {
			version: 2,
			liveReceiver: () => ({ hasOverlay: () => true }),
		};
		try {
			const { footer, custom, renderRow } = makeFooter({ statuses: statuses(12) });
			const width = 60;
			const text = plain(renderRow(width).line);
			const column = text.indexOf(/\+\d+/.exec(text)?.[0] ?? "");
			expect(footer.handleMouse?.({ type: "press", x: column, y: 0, width, height: 1 })).toEqual({
				handled: true,
			});
			expect(custom).toHaveLength(0);
		} finally {
			delete (globalThis as Record<symbol, unknown>)[mouseKey];
		}
	});

	it("opens the panel from a shortened pill with no action", () => {
		const long = "这是一条非常非常长的第三方状态文本用于测试缩略";
		const { footer, custom, renderRow } = makeFooter({
			statuses: new Map([["goal", long]]),
			segments: ["extensionStatus"],
		});
		const { text } = renderRow(120);
		const column = text.indexOf("这");
		expect(footer.handleMouse?.({ type: "press", x: column, y: 0, width: 120, height: 1 })).toEqual(
			{ handled: true },
		);
		expect(custom).toHaveLength(1);
		const { component } = openPanel(custom[0]!);
		const rows = component.render(80).map(plain).join("\n");
		expect(rows).toContain(long);
	});

	it("keeps an existing action instead of opening the panel", () => {
		const action = vi.fn();
		registerExternalPillAction("mcp", action);
		const { footer, custom, renderRow } = makeFooter({
			statuses: new Map([["mcp", "MCP: 8 servers connected, with a long tail"]]),
			segments: ["extensionStatus"],
		});
		const { text } = renderRow(80);
		const column = text.indexOf("MCP");
		footer.handleMouse?.({ type: "press", x: column, y: 0, width: 80, height: 1 });
		expect(action).toHaveBeenCalledTimes(1);
		expect(custom).toHaveLength(0);
	});

	it("keeps a status that reuses the summary pill's own key", () => {
		const action = vi.fn();
		registerExternalPillAction(OVERFLOW_SUMMARY_KEY, action);
		const { footer, custom, renderRow } = makeFooter({
			statuses: new Map([
				[OVERFLOW_SUMMARY_KEY, "DUP-STATUS"],
				["zzz-long", "Z".repeat(60)],
			]),
			segments: ["extensionStatus"],
		});
		const width = 40;
		const { text } = renderRow(width);
		expect(text).toContain("DUP-STATUS");
		const summary = /\+\d+/.exec(text);
		expect(summary).toBeTruthy();

		// The third-party pill keeps its own action: identity is its columns, not
		// the key it happens to share with the summary.
		footer.handleMouse?.({
			type: "press",
			x: text.indexOf("DUP-STATUS"),
			y: 0,
			width,
			height: 1,
		});
		expect(action).toHaveBeenCalledTimes(1);
		expect(custom).toHaveLength(0);

		// The real summary still opens the panel.
		footer.handleMouse?.({
			type: "press",
			x: text.indexOf(summary?.[0] ?? ""),
			y: 0,
			width,
			height: 1,
		});
		expect(custom).toHaveLength(1);
	});

	it("resolves the row for the width it was measured at", () => {
		const { footer, custom, renderRow } = makeFooter({ statuses: statuses(12) });
		renderRow(80);
		const narrow = renderRow(50);
		renderRow(80);
		const summary = /\+\d+/.exec(narrow.text);
		expect(summary).toBeTruthy();
		const column = narrow.text.indexOf(summary?.[0] ?? "");
		footer.handleMouse?.({ type: "press", x: column, y: 0, width: 50, height: 1 });
		expect(custom).toHaveLength(1);
	});
});

describe("governance off", () => {
	it("restores the single truncation and never draws a summary", () => {
		const { renderRow } = makeFooter({
			statuses: statuses(12),
			pill: { overflow: { enabled: false } },
		});
		const { line, text } = renderRow(60);
		expect(text).not.toMatch(/\+\d+/);
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		// Two different rows: the legacy one is the old single cut, which may end
		// mid-pill and therefore differ from the governed row.
		const governed = makeFooter({ statuses: statuses(12) }).renderRow(60);
		expect(governed.text).not.toBe(text);
	});

	it("still offers the panel, described from the legacy row", () => {
		const { renderRow } = makeFooter({
			statuses: new Map([
				["a", "alpha"],
				["b", "beta"],
			]),
			pill: { overflow: { enabled: false } },
		});
		renderRow(200);
		const model = readStatusPanelModel();
		const statusItems = model.items.filter((item) => item.key.startsWith("extensionStatus:"));
		expect(statusItems.map((item) => item.state)).toEqual(["full", "full"]);
		expect(model.hiddenCount).toBe(0);
	});
});
