import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	buildStatusPanelLines,
	createStatusPanelComponent,
	panelItemOrder,
} from "../extensions/starline/fork-status-panel";
import type { StatusPanelItem, StatusPanelModel } from "../extensions/starline/fork-status-view";

const plain = (text: string) => stripVTControlCharacters(text);

function item(
	key: string,
	text: string,
	options: { state?: StatusPanelItem["state"]; actionable?: boolean } = {},
): StatusPanelItem {
	return {
		key,
		title: key.replace("extensionStatus:", ""),
		text,
		state: options.state ?? "full",
		actionable: options.actionable ?? false,
	};
}

function model(items: StatusPanelItem[], others: StatusPanelItem[] = []): StatusPanelModel {
	return {
		items,
		others,
		hiddenCount: items.filter((entry) => entry.state === "hidden").length,
		signature: JSON.stringify({ items, others }),
	};
}

function panel(
	current: StatusPanelModel,
	options: { focusKey?: string; width?: number; height?: number } = {},
) {
	const onAction = vi.fn();
	const onClose = vi.fn();
	const component = createStatusPanelComponent({
		readModel: () => current,
		width: options.width ?? 60,
		height: options.height ?? 12,
		...(options.focusKey ? { focusKey: options.focusKey } : {}),
		onAction,
		onClose,
	});
	return { component, onAction, onClose };
}

const FILL_ON = "\x1b[7m";

describe("selection highlighting", () => {
	it("fills the whole selected block and nothing else", () => {
		const current = model([item("extensionStatus:a", "alpha"), item("extensionStatus:b", "beta")]);
		const { component } = panel(current, { width: 40, height: 20 });
		const rows = component.render(40);
		const filled = rows
			.map((row, index) => ({ row, index }))
			.filter(({ row }) => row.includes(FILL_ON));
		// Title, one body row and the meta row: the block, not just the title.
		expect(filled).toHaveLength(3);
		expect(filled.map(({ index }) => index)).toEqual([1, 2, 3]);
		// The fill covers the padded row, so the block reads as a block.
		for (const { row } of filled) {
			const inner = plain(row).replace(/^│ ?/, "").replace(/ ?│$/, "");
			expect(visibleWidth(inner)).toBe(36);
		}
		// The blank separator after the block stays unfilled.
		expect(rows[4]?.includes(FILL_ON)).toBe(false);
	});

	it("moves the highlight with the pointer, without scrolling", () => {
		const current = model([
			item("extensionStatus:a", "alpha"),
			item("extensionStatus:b", "beta"),
			item("extensionStatus:c", "gamma"),
		]);
		const { component } = panel(current, { width: 40, height: 20 });
		const rows = component.render(40);
		// Entry c's title sits directly above its body row.
		const bodyRow = rows.findIndex((row) => plain(row).includes("gamma"));
		const titleRow = bodyRow - 1;
		expect(bodyRow).toBeGreaterThan(0);
		expect(plain(rows[titleRow] ?? "")).toContain("c");
		const before = component.scrollOffset();
		expect(component.handleMouse({ type: "move", x: 3, y: titleRow })).toEqual({ handled: true });
		expect(component.selectedKey()).toBe("extensionStatus:c");
		expect(component.scrollOffset()).toBe(before);
		// The gap row between entries belongs to no entry: it keeps the selection.
		const gapRow = rows.findIndex((row, index) => index > 0 && /^│\s*│$/.test(plain(row)));
		expect(gapRow).toBeGreaterThan(0);
		expect(component.handleMouse({ type: "move", x: 3, y: gapRow })).toBeUndefined();
		expect(component.selectedKey()).toBe("extensionStatus:c");
	});

	it("selects the entry whose action row the pointer is on", () => {
		const current = model([
			item("extensionStatus:a", "alpha"),
			item("extensionStatus:b", "beta", { actionable: true }),
		]);
		const { component } = panel(current, { width: 40, height: 20 });
		const rows = component.render(40);
		// The action row is the meta row of the second block: 1 + 4 (a's block) + 2.
		const actionRow = rows.findIndex((row) => plain(row).includes("Enter 执行"));
		expect(actionRow).toBeGreaterThan(0);
		expect(component.handleMouse({ type: "move", x: 3, y: actionRow })).toEqual({ handled: true });
		expect(component.selectedKey()).toBe("extensionStatus:b");
	});

	it("leaves the highlight alone when the pointer is on the frame", () => {
		const current = model([item("extensionStatus:a", "alpha")]);
		const { component } = panel(current, { width: 40, height: 20 });
		component.render(40);
		expect(component.handleMouse({ type: "move", x: 3, y: 0 })).toBeUndefined();
		expect(component.selectedKey()).toBe("extensionStatus:a");
	});
});

describe("panel lines", () => {
	it("wraps the full text instead of cutting it", () => {
		const text = "这是一条很长的状态文本，用来检查面板是否按宽度换行而不是截断。";
		const { lines } = buildStatusPanelLines(model([item("extensionStatus:goal", text)]), {
			innerWidth: 20,
			showOthers: false,
		});
		const joined = lines.map((line) => plain(line.text)).join("");
		for (const character of text) expect(joined).toContain(character);
		expect(lines.every((line) => visibleWidth(line.text) <= 20 || line.text === "")).toBe(true);
	});

	it("labels full, truncated, hidden and off states", () => {
		const { lines } = buildStatusPanelLines(
			model(
				[
					item("a", "one", { state: "full" }),
					item("b", "two", { state: "truncated" }),
					item("c", "three", { state: "hidden" }),
				],
				[item("d", "four", { state: "off" })],
			),
			{ innerWidth: 40, selectedKey: "a", showOthers: true },
		);
		const text = lines.map((line) => plain(line.text)).join("\n");
		expect(text).toContain("已显示");
		expect(text).toContain("已缩略");
		expect(text).toContain("未展示");
		expect(text).toContain("已关闭");
	});

	it("marks the action row only for actionable entries", () => {
		const { lines } = buildStatusPanelLines(
			model([item("a", "one", { actionable: true }), item("b", "two")]),
			{ innerWidth: 40, showOthers: false },
		);
		const actionRows = lines.filter((line) => line.action);
		expect(actionRows).toHaveLength(1);
		expect(actionRows[0]?.itemKey).toBe("a");
	});

	it("folds the other-statuses group by default", () => {
		const hidden = item("extensionStatus:off-one", "kept readable", { state: "off" });
		const folded = buildStatusPanelLines(model([item("a", "one")], [hidden]), {
			innerWidth: 40,
			showOthers: false,
		});
		expect(folded.lines.map((line) => plain(line.text)).join("\n")).not.toContain("kept readable");
		expect(folded.lines.some((line) => line.toggleOthers)).toBe(true);

		const expanded = buildStatusPanelLines(model([item("a", "one")], [hidden]), {
			innerWidth: 40,
			showOthers: true,
		});
		expect(expanded.lines.map((line) => plain(line.text)).join("\n")).toContain("kept readable");
	});

	it("shows an empty state rather than a blank box", () => {
		const { lines } = buildStatusPanelLines(model([]), { innerWidth: 40, showOthers: false });
		expect(lines.map((line) => plain(line.text)).join("\n")).toContain("暂无状态");
	});
});

describe("panel component", () => {
	it("renders exactly the bounded viewport, never taller than asked", () => {
		const current = model(
			Array.from({ length: 100 }, (_, index) =>
				item(`extensionStatus:s${index}`, `status ${index}`),
			),
		);
		const { component } = panel(current, { height: 10 });
		const rows = component.render(60);
		expect(rows).toHaveLength(10);
		expect(rows.every((row) => visibleWidth(row) <= 60)).toBe(true);
		expect(plain(rows[0] ?? "")).toContain("100 项");
	});

	it("moves the selection and keeps it inside the viewport", () => {
		const current = model(
			Array.from({ length: 40 }, (_, index) =>
				item(`extensionStatus:s${index}`, `status ${index}`),
			),
		);
		const { component } = panel(current, { height: 8 });
		component.render(60);
		expect(component.selectedKey()).toBe("extensionStatus:s0");
		for (let index = 0; index < 20; index += 1) component.handleInput("\u001b[1;2B");
		expect(component.selectedKey()).toBe("extensionStatus:s20");
		const text = component.render(60).map(plain).join("\n");
		expect(text).toContain("s20");
		expect(component.scrollOffset()).toBeGreaterThan(0);
	});

	it("scrolls with PageUp/PageDown, Home/End and the wheel", () => {
		const current = model(
			Array.from({ length: 60 }, (_, index) =>
				item(`extensionStatus:s${index}`, `status ${index}`),
			),
		);
		const { component } = panel(current, { height: 10 });
		component.render(60);
		component.handleInput("\u001b[6~"); // page down
		expect(component.scrollOffset()).toBeGreaterThan(0);
		// Arrows move the viewport by one visual line and keep the entry identity.
		const beforeLine = component.scrollOffset();
		component.handleInput("\u001b[B");
		component.render(60);
		expect(component.scrollOffset()).toBe(beforeLine + 1);
		expect(component.selectedKey()).toBe("extensionStatus:s0");
		component.handleInput("\u001b[H"); // home
		component.render(60);
		expect(component.selectedKey()).toBe("extensionStatus:s0");
		expect(component.scrollOffset()).toBe(0);
		component.handleInput("\u001b[F"); // end
		expect(component.selectedKey()).toBe("extensionStatus:s59");
		const rows = component.render(60).map(plain).join("\n");
		expect(rows).toContain("s59");
		const before = component.scrollOffset();
		// Positive delta scrolls down, negative scrolls up.
		component.handleMouse?.({ type: "wheel", x: 2, y: 2, wheelDelta: 3 });
		expect(component.scrollOffset()).toBeGreaterThanOrEqual(before);
		component.handleMouse?.({ type: "wheel", x: 2, y: 2, wheelDelta: -500 });
		expect(component.scrollOffset()).toBe(0);
	});

	it("does not snap the viewport back to the selection after a deliberate scroll", () => {
		const current = model(
			Array.from({ length: 40 }, (_, index) =>
				item(`extensionStatus:s${index}`, `status ${index}`),
			),
		);
		const { component } = panel(current, { height: 10 });
		component.render(60);
		component.handleInput("\u001b[6~"); // page down
		component.render(60);
		const first = component.scrollOffset();
		expect(first).toBeGreaterThan(0);
		component.handleInput("\u001b[6~");
		component.render(60);
		expect(component.scrollOffset()).toBeGreaterThan(first);

		// Moving the selection brings it back into view, and only then.
		component.handleInput("\u001b[1;2B");
		component.render(60);
		expect(component.selectedKey()).toBe("extensionStatus:s1");
		expect(component.scrollOffset()).toBeLessThanOrEqual(4);
	});

	it("runs an entry's action on Enter, on a click, and only once", () => {
		const current = model([
			item("extensionStatus:mcp", "MCP: 8 servers", { actionable: true }),
			item("extensionStatus:readonly", "plain"),
		]);
		// A click on the entry runs it, exactly like Enter: hovering selected it,
		// so a click that did nothing would look broken.
		const clicked = panel(current);
		const clickedRows = clicked.component.render(60);
		const mcpRow = clickedRows.findIndex((row) => plain(row).includes("▌ mcp"));
		expect(clicked.component.handleMouse?.({ type: "click", x: 3, y: mcpRow })).toEqual({
			handled: true,
		});
		expect(clicked.onAction).toHaveBeenCalledTimes(1);
		expect(clicked.onAction.mock.calls[0]?.[0]).toMatchObject({ key: "extensionStatus:mcp" });
		expect(clicked.onClose).toHaveBeenCalledTimes(1);

		// Enter is still the keyboard path.
		const keyed = panel(current);
		keyed.component.render(60);
		keyed.component.handleInput("\r");
		expect(keyed.onAction).toHaveBeenCalledTimes(1);
		expect(keyed.onClose).toHaveBeenCalledTimes(1);

		// Reading and scrolling never run anything.
		const reading = panel(current);
		reading.component.render(60);
		reading.component.handleMouse?.({ type: "move", x: 2, y: 2 });
		expect(reading.onAction).not.toHaveBeenCalled();

		// A read-only entry has nothing to run: the click only selects it.
		const readOnly = panel(model([item("plain", "plain"), item("other", "other")]));
		const readOnlyRows = readOnly.component.render(60);
		const otherRow = readOnlyRows.findIndex((row) => plain(row).includes("other"));
		expect(readOnly.component.handleMouse?.({ type: "click", x: 3, y: otherRow })).toEqual({
			handled: true,
		});
		expect(readOnly.component.selectedKey()).toBe("other");
		expect(readOnly.onAction).not.toHaveBeenCalled();
		expect(readOnly.onClose).not.toHaveBeenCalled();
	});

	it("dismisses the panel when the click lands outside its rows", () => {
		const current = model([item("extensionStatus:a", "alpha")]);
		const { component, onClose } = panel(current, { width: 40, height: 20 });
		const rows = component.render(40);
		// The top rule, the bottom rule and anything below the box.
		for (const y of [0, rows.length - 1, 41]) {
			onClose.mockClear();
			expect(component.handleMouse?.({ type: "click", x: 3, y })).toEqual({ handled: true });
			expect(onClose).toHaveBeenCalledTimes(1);
		}
		// A click on the gap between entries belongs to no entry, so it neither
		// runs anything nor dismisses the panel.
		const gapRow = rows.findIndex((row, index) => index > 0 && /^│\s*│$/.test(plain(row)));
		onClose.mockClear();
		expect(component.handleMouse?.({ type: "click", x: 3, y: gapRow })).toEqual({ handled: true });
		expect(onClose).not.toHaveBeenCalled();
	});

	it("runs an action from its own row on a click", () => {
		const current = model([item("extensionStatus:mcp", "MCP", { actionable: true })]);
		const { component, onAction } = panel(current);
		component.render(60);
		// Row 0 is the top rule; the entry's rows start under it. Its action row is
		// the third row of the block (title, text, meta).
		component.handleMouse?.({ type: "click", x: 3, y: 3 });
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape and toggles the other group with Tab", () => {
		const current = model([item("a", "one")], [item("off", "hidden text", { state: "off" })]);
		const { component, onClose } = panel(current);
		component.render(60);
		const before = panelItemOrder(current, false).length;
		component.handleInput("\t");
		expect(component.othersExpanded()).toBe(true);
		expect(panelItemOrder(current, true).length).toBeGreaterThan(before);
		expect(component.render(60).map(plain).join("\n")).toContain("hidden text");
		component.handleInput("\u001b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("keeps the selection on the same key when the model updates", () => {
		const first = model([item("a", "one"), item("b", "two"), item("c", "three")]);
		let current = first;
		const component = createStatusPanelComponent({
			readModel: () => current,
			width: 60,
			height: 10,
			onAction: vi.fn(),
			onClose: vi.fn(),
		});
		component.render(60);
		component.handleInput("\u001b[1;2B");
		expect(component.selectedKey()).toBe("b");
		// `a` disappears and a new entry lands above; the selection follows `b`.
		current = model([item("new", "new"), item("b", "two"), item("c", "three")]);
		component.render(60);
		expect(component.selectedKey()).toBe("b");
		// When the selected entry disappears the selection takes its place, not
		// the top of the list.
		current = model([item("new", "new"), item("c", "three")]);
		component.render(60);
		expect(component.selectedKey()).toBe("c");
	});

	it("focuses the requested entry and shows it immediately", () => {
		const current = model(
			Array.from({ length: 30 }, (_, index) =>
				item(`extensionStatus:s${index}`, `status ${index}`, {
					state: index < 10 ? "full" : "hidden",
				}),
			),
		);
		const { component } = panel(current, { focusKey: "extensionStatus:s25", height: 8 });
		const text = component.render(60).map(plain).join("\n");
		expect(component.selectedKey()).toBe("extensionStatus:s25");
		expect(text).toContain("s25");
	});

	it("keeps the hint row inside the box at any width", () => {
		const current = model([item("a", "one")]);
		for (const width of [24, 40, 60, 80]) {
			const { component } = panel(current, { width: 80, height: 8 });
			const rows = component.render(width);
			const bottom = rows.at(-1) ?? "";
			expect(visibleWidth(bottom)).toBeLessThanOrEqual(Math.max(10, width));
			expect(plain(bottom).endsWith("╯")).toBe(true);
		}
	});

	it("sheds decoration instead of overflowing a narrow terminal", () => {
		const current = model([item("a", "one"), item("b", "two")]);
		const { component } = panel(current, { width: 80, height: 10 });
		// The requested width is a preference: every drawn line fits what it was given.
		for (const width of [80, 40, 10, 8, 6, 4, 2, 1]) {
			const rows = component.render(width);
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
		}
		// Below the bordered width the box drops its borders rather than clipping.
		const narrow = component.render(4).map(plain).join("\n");
		expect(narrow).not.toContain("│");
		expect(visibleWidth(component.render(6).at(-1) ?? "")).toBeLessThanOrEqual(6);
	});

	it("shrinks to the terminal height and scrolls instead of overflowing rows", () => {
		const original = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		try {
			Object.defineProperty(process.stdout, "rows", { value: 4, configurable: true });
			const current = model(
				Array.from({ length: 20 }, (_, index) =>
					item(`extensionStatus:s${index}`, `status ${index}`),
				),
			);
			const { component } = panel(current, { width: 60, height: 24 });
			const rows = component.render(60);
			expect(rows.length).toBeLessThanOrEqual(3);
			expect(component.viewportHeight()).toBeLessThanOrEqual(3);
			// The rest is still reachable by scrolling.
			component.handleInput("\u001b[6~");
			component.render(60);
			expect(component.scrollOffset()).toBeGreaterThan(0);
		} finally {
			if (original) Object.defineProperty(process.stdout, "rows", original);
			else delete (process.stdout as { rows?: number }).rows;
		}
	});

	it("keeps the click map in step with the last render after a resize", () => {
		const current = model([
			item("extensionStatus:mcp", "MCP: 8 servers connected, with a long tail", {
				actionable: true,
			}),
		]);
		const { component, onAction } = panel(current, { width: 80, height: 10 });
		// Draw wide, then narrow: the visible rows are re-wrapped.
		component.render(80);
		const rows = component.render(30).map(plain);
		const actionRow = rows.findIndex((row) => row.includes("Enter 执行"));
		expect(actionRow).toBeGreaterThan(-1);
		const contentTop = rows.findIndex((row) => row.includes("mcp")) - 1;
		component.handleMouse?.({ type: "click", x: 3, y: actionRow });
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(contentTop).toBeGreaterThanOrEqual(0);
	});

	it("keeps the exact reading position when content above the viewport grows", () => {
		const items = Array.from({ length: 10 }, (_, index) =>
			item(`extensionStatus:s${index}`, `UNIQUE_BODY_${index}`),
		);
		let current = model(items);
		const component = createStatusPanelComponent({
			readModel: () => current,
			width: 60,
			height: 7,
			onAction: vi.fn(),
			onClose: vi.fn(),
		});
		component.render(60);
		component.handleInput("\u001b[6~"); // page down
		const readingRow = plain(component.render(60)[1] ?? "");
		expect(readingRow).toMatch(/UNIQUE_BODY_\d/);

		// A long status is inserted first: every row below it shifts down, so an
		// absolute row number would land somewhere else.
		current = model([item("extensionStatus:new", "x".repeat(600)), ...items]);
		const after = plain(component.render(60)[1] ?? "");
		expect(after).toBe(readingRow);
	});

	it("keeps the whole body reachable at one or two columns", () => {
		const text = `START${"abcdefghij".repeat(12)}END`;
		const current = model([item("extensionStatus:tiny", text)]);
		for (const width of [1, 2]) {
			const { component } = panel(current, { width: 60, height: 6 });
			const stream: string[] = [];
			for (let step = 0; step < 300; step += 1) {
				stream.push(...component.render(width).map(plain));
				component.handleInput("\u001b[6~");
			}
			const joined = stream.join("");
			// No decoration may win over the text at these widths.
			expect(joined).not.toContain("│");
			// Scrolling reaches every character of the published text, in order.
			let cursor = 0;
			for (const character of joined) {
				if (character === text[cursor]) cursor += 1;
			}
			expect(cursor).toBe(text.length);
			expect(joined).toContain("START");
			expect(joined).toContain("END");
		}
	});

	it("opens a long first entry at its beginning, and Home returns there", () => {
		const text = `START${"abcdefghij".repeat(20)}END`;
		const { component } = panel(model([item("extensionStatus:long", text)]), {
			width: 30,
			height: 8,
		});
		const first = component.render(30).map(plain).join("\n");
		expect(component.scrollOffset()).toBe(0);
		expect(first).toContain("▌ long");
		expect(first).toContain("START");

		// Scrolling to the end and pressing Home must come back to the top even
		// though the first entry was already the selection.
		for (let step = 0; step < 40; step += 1) component.handleInput("\u001b[6~");
		component.render(30);
		expect(component.scrollOffset()).toBeGreaterThan(0);
		component.handleInput("\u001b[H");
		const home = component.render(30).map(plain).join("\n");
		expect(component.scrollOffset()).toBe(0);
		expect(home).toContain("START");
	});

	it("keeps the reading position through the fallback model the panel really reads", async () => {
		const { buildExtensionOnlyModel } = await import("../extensions/starline/fork-status-view");
		const { mergeConfig } = await import("../extensions/starline/config");
		const config = mergeConfig({});
		let statuses = new Map([
			["a", "AAA"],
			["b", "UNIQUE_BODY_B"],
			["c", "CCC"],
		]);
		const component = createStatusPanelComponent({
			readModel: () => buildExtensionOnlyModel(config, statuses),
			width: 60,
			height: 6,
			onAction: vi.fn(),
			onClose: vi.fn(),
		});
		component.render(60);
		component.handleInput("\u001b[6~");
		const before = component.render(60).map(plain);
		expect(before[1]).toContain("b");
		expect(before[2]).toContain("UNIQUE_BODY_B");

		// `a` grows; the fallback signature has to notice, or the anchor is never
		// re-applied and the viewport slides onto `a`.
		statuses = new Map([
			["a", "A".repeat(600)],
			["b", "UNIQUE_BODY_B"],
			["c", "CCC"],
		]);
		const after = component.render(60).map(plain);
		expect(after[1]).toBe(before[1]);
		expect(after[2]).toBe(before[2]);
	});

	it("renders an empty model and survives a throwing reader", () => {
		const empty = panel(model([]));
		expect(empty.component.render(40).map(plain).join("\n")).toContain("暂无状态");
		const broken = createStatusPanelComponent({
			readModel: () => {
				throw new Error("boom");
			},
			width: 40,
			height: 6,
			onAction: vi.fn(),
			onClose: vi.fn(),
		});
		expect(broken.render(40)).toHaveLength(6);
	});
});
