/**
 * The status panel (fork-only).
 *
 * A bounded, scrollable list of every status the bar can draw, with the text as
 * published rather than the shortened pill. The bar is one row and cannot grow;
 * this is where the rest of the content lives, so nothing that left the row is
 * unreachable.
 *
 * The component is deliberately dumb: it reads a model the footer published,
 * wraps text to its own width, and keeps a viewport. It never runs an action on
 * hover, scroll or plain selection — only Enter (or a click on the entry's own
 * action row) does, and only for entries the action registry actually resolves.
 *
 * Three properties are worth stating because they are easy to lose:
 *
 * - The reading position is anchored to an entry and a line offset inside it,
 *   not to an absolute row. A status that grows above the viewport, or a
 *   re-wrap after a resize, keeps the same text under the eye.
 * - The viewport and the click map come from the same last render. Resizing the
 *   terminal re-wraps both, so an action row is never hit by stale geometry.
 * - Every drawn line fits the width it was given, however narrow that is: the
 *   box sheds its padding, then its borders, rather than overflowing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { StatusPanelItem, StatusPanelModel } from "./fork-status-view";
import { readStatusPanelModel } from "./fork-status-view";
import { getMouseEventsApi } from "./mouse/api-consumer";
import { requestPointerShape } from "./mouse/pointer-shape";
import { contrastTextSgr } from "./pill";
import { pillActionFor, runPillAction } from "./pill-actions";
import { closePillBubble } from "./pill-bubble";
import { EXTENSION_STATUS_PREFIX } from "./pill-config";
import { resolveBackgroundSgr, safeThemeFg, type ThemeLike } from "./style";

const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
};

const SELECTED_MARKER = "▌";
const UNSELECTED_MARKER = " ";
/** Filled row styling, and the fallback when no themed background is available. */
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const STYLE_OFF = "\x1b[0m";

/** Rows the panel asks for at most, before it starts scrolling. */
const MAX_PANEL_HEIGHT = 24;

/** Below this width the box drops its side padding; below the next, its borders. */
const PADDED_WIDTH = 10;
const BORDERED_WIDTH = 5;

const stateLabels: Record<StatusPanelItem["state"], string> = {
	full: "已显示",
	truncated: "已缩略",
	hidden: "未展示",
	off: "已关闭",
};

export type PanelLine = {
	text: string;
	/** Entry this row belongs to, for click selection. */
	itemKey?: string;
	/** This row is the entry's explicit action affordance. */
	action?: boolean;
	/** This row toggles the other-statuses group. */
	toggleOthers?: boolean;
};

export type PanelLines = {
	lines: PanelLine[];
	/** First row of the selected entry's block, when it has one. */
	selectedStart?: number;
	/** Last row of the selected entry's block. */
	selectedEnd?: number;
	/** First row of every entry's block, in draw order. */
	blockStarts: Map<string, number>;
};

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function pad(line: string, width: number): string {
	return truncateToWidth(line, width, "", true);
}

function rule(width: number, left: string, right: string, label: string): string {
	const inner = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
	const text = ` ${label} `;
	const body = truncateToWidth(text, inner, "", true);
	const rest = Math.max(0, inner - visibleWidth(body));
	return `${left}${body}${BOX.horizontal.repeat(rest)}${right}`;
}

function borderLine(content: string, innerWidth: number, sidePad: boolean): string {
	const body = pad(content, innerWidth);
	return sidePad
		? `${BOX.vertical} ${body} ${BOX.vertical}`
		: `${BOX.vertical}${body}${BOX.vertical}`;
}

/** Entries in the order ↑/↓ walks them. */
export function panelItemOrder(model: StatusPanelModel, showOthers: boolean): StatusPanelItem[] {
	return showOthers ? [...model.items, ...model.others] : [...model.items];
}

/**
 * The styling of the selected entry's block: its whole width is filled, the way
 * the pill bubble fills the row it has selected, and the text is recoloured for
 * that fill.
 *
 * The theme supplies the fill (`accent`, the colour the marker already used) and
 * `contrastTextSgr` picks dark or light text for it. When the theme cannot
 * resolve a background — a fixture, an older Pi, an unusual theme — reverse
 * video does the same job with no colour knowledge at all.
 */
function selectionFill(theme: ThemeLike | undefined): { open: string; close: string } {
	if (theme) {
		try {
			const background = resolveBackgroundSgr(theme, "theme", "accent");
			if (background) {
				return { open: `${background}${contrastTextSgr(background)}`, close: STYLE_OFF };
			}
		} catch {
			// Fall through to reverse video.
		}
	}
	return { open: REVERSE_ON, close: REVERSE_OFF };
}

function itemRows(
	item: StatusPanelItem,
	innerWidth: number,
	selected: boolean,
	theme: ThemeLike | undefined,
): PanelLine[] {
	// A selected row is drawn inside one solid fill: inner colour escapes would
	// reset that background mid-row, so the fill owns the colours instead.
	const border = (text: string) => (!theme || selected ? text : safeThemeFg(theme, "muted", text));
	// Decoration goes before text: at a couple of columns a prefix would eat the
	// only thing worth showing, so it is dropped and the body keeps the width.
	const markerPrefix =
		innerWidth >= 4 ? `${selected ? border(SELECTED_MARKER) : UNSELECTED_MARKER} ` : "";
	const bodyPrefix = innerWidth >= 6 ? "  " : "";
	const title = `${markerPrefix}${item.title}`;
	const rows: PanelLine[] = [{ text: title, itemKey: item.key }];
	const wrapWidth = Math.max(1, innerWidth - visibleWidth(bodyPrefix));
	for (const line of wrapTextWithAnsi(item.text, wrapWidth)) {
		rows.push({ text: `${bodyPrefix}${line}`, itemKey: item.key });
	}
	const meta = [stateLabels[item.state]];
	if (item.actionable) meta.push("Enter 执行");
	const metaText = `${bodyPrefix}${meta.join(" · ")}`;
	rows.push({
		text: item.actionable && theme && !selected ? safeThemeFg(theme, "muted", metaText) : metaText,
		itemKey: item.key,
		action: item.actionable,
	});
	return rows;
}

/**
 * Build every row the panel can show, and remember where each entry starts so
 * the caller can reveal the selection and keep the reading position anchored.
 */
export function buildStatusPanelLines(
	model: StatusPanelModel,
	options: {
		innerWidth: number;
		selectedKey?: string;
		showOthers: boolean;
		theme?: ThemeLike;
	},
): PanelLines {
	const { innerWidth, selectedKey, showOthers, theme } = options;
	const lines: PanelLine[] = [];
	const blockStarts = new Map<string, number>();
	let selectedStart: number | undefined;
	let selectedEnd: number | undefined;

	const push = (item: StatusPanelItem) => {
		const selected = item.key === selectedKey;
		const start = lines.length;
		blockStarts.set(item.key, start);
		lines.push(...itemRows(item, innerWidth, selected, theme));
		// The block ends at the entry's own last row: the blank separator belongs
		// to the gap between entries, so a filled block keeps that gap.
		if (selected) {
			selectedStart = start;
			selectedEnd = lines.length - 1;
		}
		lines.push({ text: "" });
	};

	if (model.items.length === 0 && model.others.length === 0) {
		lines.push({ text: "" });
		lines.push({ text: "  暂无状态" });
		lines.push({ text: "  其他扩展通过 ctx.ui.setStatus() 发布状态后会出现在这里。" });
		lines.push({ text: "" });
		return { lines, blockStarts };
	}

	for (const item of model.items) push(item);

	if (model.others.length > 0) {
		const label = showOthers
			? `其他状态(已关闭/未纳入布局 ${model.others.length} 项) · Tab 收起`
			: `其他状态(已关闭/未纳入布局 ${model.others.length} 项) · Tab 展开`;
		lines.push({
			text: theme ? safeThemeFg(theme, "muted", `  ${label}`) : `  ${label}`,
			toggleOthers: true,
		});
		lines.push({ text: "" });
		if (showOthers) for (const item of model.others) push(item);
	}

	return { lines, selectedStart, selectedEnd, blockStarts };
}

export type StatusPanelMouseEvent = {
	type?: string;
	x: number;
	y: number;
	wheelDelta?: number;
};

export type StatusPanelComponent = {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	handleMouse(event: StatusPanelMouseEvent): { handled?: boolean } | undefined;
	selectedKey(): string | undefined;
	scrollOffset(): number;
	/** Rows of content the last render drew; paging uses this, not a constant. */
	viewportHeight(): number;
	/** Where the box is on screen, for outside-click dismissal. */
	rect(): { left: number; top: number; width: number; height: number } | undefined;
	othersExpanded(): boolean;
};

export type StatusPanelComponentOptions = {
	readModel: () => StatusPanelModel;
	theme?: ThemeLike;
	/** Preferred outer width and height; narrower or shorter terminals win. */
	width: number;
	height: number;
	focusKey?: string;
	onAction: (item: StatusPanelItem) => void;
	onClose: () => void;
};

type Geometry = {
	outer: number;
	inner: number;
	contentHeight: number;
	bordered: boolean;
	sidePad: boolean;
	contentTop: number;
};

type Rendered = Geometry & {
	lines: PanelLine[];
	scrollTop: number;
};

/** Where the eye is: an entry key plus rows from that entry's first line. */
type ScrollAnchor = { key: string; offset: number };

/** How the box sheds decoration as the terminal narrows or shortens. */
function geometryFor(
	renderWidth: number,
	preferredWidth: number,
	preferredHeight: number,
): Geometry {
	const outer = Math.max(1, Math.min(Math.floor(renderWidth), preferredWidth));
	// A terminal that reports its height caps the panel and leaves a spare row;
	// one that does not (tests, redirected output) gets the preferred height.
	const terminalRows = process.stdout.rows;
	const rows =
		typeof terminalRows === "number" && terminalRows > 0
			? Math.max(1, Math.min(preferredHeight, terminalRows - 1))
			: preferredHeight;
	const bordered = outer >= BORDERED_WIDTH && rows >= 3;
	const sidePad = bordered && outer >= PADDED_WIDTH;
	const inner = bordered ? Math.max(1, outer - (sidePad ? 4 : 2)) : outer;
	const contentHeight = bordered ? Math.max(1, rows - 2) : Math.max(1, rows);
	return { outer, inner, contentHeight, bordered, sidePad, contentTop: bordered ? 1 : 0 };
}

/**
 * The panel's behaviour, independent of how Pi mounts it. Tests drive this
 * object directly; `showStatusPanel` wraps it in `ctx.ui.custom`.
 */
export function createStatusPanelComponent(
	options: StatusPanelComponentOptions,
): StatusPanelComponent {
	const preferredWidth = Math.max(1, Math.floor(options.width));
	const preferredHeight = Math.max(1, Math.floor(options.height));
	let scrollTop = 0;
	let showOthers = false;
	let selectedKey: string | undefined;
	let initialised = false;
	/**
	 * How to place the viewport on the next render, if at all. Set when the
	 * selection moves rather than on every render: PageUp and the wheel must be
	 * able to leave the selection off screen instead of being snapped back.
	 *
	 * `start` pins the entry's first row (opening, Home, a block taller than the
	 * viewport), `end` pins its last row (End), `visible` scrolls the least the
	 * entry needs to become visible.
	 */
	let revealSelection: "start" | "end" | "visible" | undefined = "start";
	/** Reading position, re-applied when the content or the wrapping changes. */
	let anchor: ScrollAnchor | undefined;
	let lastSignature: string | undefined;
	let lastOrder: string[] = [];
	let lastRender: Rendered | undefined;

	const model = () => {
		try {
			return options.readModel();
		} catch {
			return { items: [], others: [], hiddenCount: 0, signature: "error" } as StatusPanelModel;
		}
	};

	const order = () => panelItemOrder(model(), showOthers);

	const ensureSelection = () => {
		const items = order();
		if (items.length === 0) {
			selectedKey = undefined;
			return;
		}
		if (!initialised) {
			initialised = true;
			const focus = options.focusKey;
			selectedKey = (focus && items.find((item) => item.key === focus)?.key) ?? items[0]?.key;
			scrollTop = 0;
			revealSelection = "start";
			return;
		}
		if (selectedKey && items.some((item) => item.key === selectedKey)) return;
		// The selection vanished: move to whatever took its place, so the list
		// does not jump back to the top under the user.
		const previousIndex = selectedKey === undefined ? -1 : lastOrder.indexOf(selectedKey);
		const nextIndex = previousIndex < 0 ? 0 : Math.min(previousIndex, items.length - 1);
		selectedKey = items[nextIndex]?.key;
		revealSelection = "visible";
	};

	const select = (key: string | undefined) => {
		if (key === selectedKey) return;
		selectedKey = key;
		revealSelection = "visible";
	};

	/**
	 * Move to an entry and place it deliberately. Differs from `select` by acting
	 * even when the key is already selected, which is what makes Home return to
	 * the top of a list whose first entry never changed.
	 */
	const revealAt = (key: string | undefined, mode: "start" | "end") => {
		if (key === undefined) return;
		selectedKey = key;
		revealSelection = mode;
	};

	const run = (item: StatusPanelItem | undefined) => {
		if (!item?.actionable) return;
		options.onClose();
		options.onAction(item);
	};

	const move = (step: number) => {
		const items = order();
		if (items.length === 0) return;
		const index = items.findIndex((item) => item.key === selectedKey);
		const from = index < 0 ? (step > 0 ? -1 : 0) : index;
		const next = (from + step + items.length) % items.length;
		select(items[next]?.key);
	};

	/** Move the viewport without moving the selection: scrolling never silently
	 * changes which entry the next Enter acts on. */
	const scrollByLines = (delta: number) => {
		const height = lastRender?.contentHeight ?? 1;
		const limit = Math.max(0, (lastRender?.lines.length ?? 0) - height);
		scrollTop = clamp(scrollTop + delta, 0, limit);
		if (lastRender) lastRender = { ...lastRender, scrollTop };
	};

	const page = (delta: number) => {
		scrollByLines(delta * (lastRender?.contentHeight ?? 1));
	};

	const toggleOthers = () => {
		showOthers = !showOthers;
		const items = order();
		if (items.length === 0) return;
		if (!items.some((item) => item.key === selectedKey)) {
			selectedKey = showOthers ? (items.at(-1)?.key ?? items[0]?.key) : items[0]?.key;
			revealSelection = "visible";
		}
	};

	/** The entry whose block contains, or precedes, a row. */
	const anchorFor = (
		lines: PanelLine[],
		blocks: Map<string, number>,
		top: number,
	): ScrollAnchor | undefined => {
		let key: string | undefined;
		let start = 0;
		for (const [candidate, blockStart] of blocks) {
			if (blockStart <= top && (key === undefined || blockStart > start)) {
				key = candidate;
				start = blockStart;
			}
		}
		if (key === undefined) {
			const first = lines[top];
			return first?.itemKey ? { key: first.itemKey, offset: 0 } : undefined;
		}
		return { key, offset: Math.max(0, top - start) };
	};

	return {
		render(renderWidth: number): string[] {
			const geometry = geometryFor(renderWidth, preferredWidth, preferredHeight);
			ensureSelection();
			const current = model();
			const signature = `${current.signature}|${geometry.inner}|${showOthers ? 1 : 0}`;
			const built = buildStatusPanelLines(current, {
				innerWidth: geometry.inner,
				selectedKey,
				showOthers,
				...(options.theme ? { theme: options.theme } : {}),
			});

			// Content or wrapping changed under the viewport: put the same text back
			// under the eye before touching the selection.
			if (anchor && signature !== lastSignature && !revealSelection) {
				const start = built.blockStarts.get(anchor.key);
				// `offset` counts rows from the entry's first row down to the top of
				// the viewport, so the restore adds it back to the entry's start.
				if (start !== undefined) scrollTop = start + anchor.offset;
				else if (built.selectedStart !== undefined) scrollTop = built.selectedStart;
			}

			if (
				revealSelection !== undefined &&
				built.selectedStart !== undefined &&
				built.selectedEnd !== undefined
			) {
				const blockHeight = built.selectedEnd - built.selectedStart + 1;
				if (revealSelection === "start") {
					scrollTop = built.selectedStart;
				} else if (revealSelection === "end") {
					scrollTop = Math.max(built.selectedStart, built.selectedEnd - geometry.contentHeight + 1);
				} else if (built.selectedStart < scrollTop || blockHeight > geometry.contentHeight) {
					// A block taller than the viewport opens at its first row, not its
					// last: the top of the entry is where reading starts.
					scrollTop = built.selectedStart;
				} else if (built.selectedEnd >= scrollTop + geometry.contentHeight) {
					scrollTop = built.selectedEnd - geometry.contentHeight + 1;
				}
				revealSelection = undefined;
			}

			scrollTop = clamp(scrollTop, 0, Math.max(0, built.lines.length - geometry.contentHeight));
			anchor = anchorFor(built.lines, built.blockStarts, scrollTop);
			lastSignature = signature;
			lastOrder = panelItemOrder(current, showOthers).map((item) => item.key);
			lastRender = { ...geometry, lines: built.lines, scrollTop };

			const fill = selectionFill(options.theme);
			const rows: string[] = [];
			for (let index = 0; index < geometry.contentHeight; index += 1) {
				const absolute = scrollTop + index;
				const row = built.lines[absolute];
				const width = geometry.bordered ? geometry.inner : geometry.outer;
				const body = pad(row?.text ?? "", width);
				// The fill spans the full row, padding included, so the selection
				// reads as a block rather than as highlighted words.
				const filled =
					built.selectedStart !== undefined &&
					built.selectedEnd !== undefined &&
					absolute >= built.selectedStart &&
					absolute <= built.selectedEnd
						? `${fill.open}${body}${fill.close}`
						: body;
				rows.push(
					geometry.bordered ? borderLine(filled, geometry.inner, geometry.sidePad) : filled,
				);
			}
			if (!geometry.bordered) return rows;
			return [
				rule(geometry.outer, BOX.topLeft, BOX.topRight, headerLabel(current)),
				...rows,
				rule(
					geometry.outer,
					BOX.bottomLeft,
					BOX.bottomRight,
					hintLabel(showOthers, geometry.inner),
				),
			];
		},
		invalidate() {},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) {
				options.onClose();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				const item = order().find((candidate) => candidate.key === selectedKey);
				run(item);
				return;
			}
			// Arrows scroll the viewport by a visual line and keep the entry identity
			// (design §4); Shift+arrows step the selection.
			if (matchesKey(data, Key.shift("up"))) {
				move(-1);
				return;
			}
			if (matchesKey(data, Key.shift("down"))) {
				move(1);
				return;
			}
			if (matchesKey(data, Key.up)) {
				scrollByLines(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				scrollByLines(1);
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				page(-1);
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				page(1);
				return;
			}
			if (matchesKey(data, Key.home)) {
				revealAt(order()[0]?.key, "start");
				return;
			}
			if (matchesKey(data, Key.end)) {
				revealAt(order().at(-1)?.key, "end");
				return;
			}
			if (matchesKey(data, Key.tab)) {
				toggleOthers();
			}
		},
		handleMouse(event: StatusPanelMouseEvent): { handled?: boolean } | undefined {
			if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return undefined;
			if (event.type === "wheel") {
				const delta = typeof event.wheelDelta === "number" ? event.wheelDelta : 0;
				page(delta);
				return { handled: true };
			}
			if (event.type !== "click" && event.type !== "move") return undefined;
			const view = lastRender;
			if (!view) return undefined;
			const row = event.y - view.contentTop;
			const inside = row >= 0 && row < view.contentHeight;
			if (event.type === "move" && !inside) return undefined;
			// The click map is the last drawn frame, so a resize cannot leave it
			// pointing at rows the user is not looking at.
			const line = inside ? view.lines[view.scrollTop + row] : undefined;
			if (!line) {
				// A click that lands on the frame, the padding, or anywhere outside the
				// box is "outside": dismiss, the way the bubble dismisses. Claiming it
				// also keeps it from falling through to the bar underneath, which would
				// reopen the panel it is closing.
				if (event.type === "click") {
					options.onClose();
					return { handled: true };
				}
				return undefined;
			}
			if (event.type === "move") {
				// A row that belongs to nothing (the gap between entries) is not a
				// target: claim nothing, so the pointer goes back to an arrow.
				if (line.itemKey === undefined && !line.toggleOthers) return undefined;
				// The pointer is a second way to move the highlight, like the pill
				// bubble: whatever entry is under it becomes the selected one. No
				// reveal is requested — the pointer is already on the row, and
				// scrolling the list under a resting pointer would fight the user.
				if (line.itemKey !== undefined) selectedKey = line.itemKey;
				requestPointerShape("pointer");
				return { handled: true };
			}
			if (line.toggleOthers) {
				toggleOthers();
				return { handled: true };
			}
			if (line.itemKey) select(line.itemKey);
			// A click on an entry runs it when it has an action, exactly like Enter:
			// the pointer selected it, and asking the user to hit the small meta row
			// as well would make the first click look broken. Read-only entries have
			// nothing to run, so the click only selects them.
			if (line.itemKey) {
				const item = panelItemOrder(model(), showOthers).find(
					(candidate) => candidate.key === line.itemKey,
				);
				if (item?.actionable) {
					// The action runs with the panel's own `command` semantics (that is what
					// Enter does too), so a click and the keyboard behave identically.
					run(item);
					return { handled: true };
				}
			}
			return { handled: true };
		},
		selectedKey: () => selectedKey,
		scrollOffset: () => scrollTop,
		viewportHeight: () => lastRender?.contentHeight ?? preferredHeight,
		rect: () => {
			const view = lastRender;
			if (!view) return undefined;
			// Pi centres an overlay inside the terminal margins (one cell each side):
			// `left = margin + floor((available - layoutWidth) / 2)`, the same formula
			// `TuiAltScreen.resolveOverlayLayout` uses. The drawn width comes from the
			// frame, because the renderer may hand the component fewer columns than
			// the layout reserved.
			const columns = process.stdout.columns ?? 80;
			const rows = process.stdout.rows ?? 24;
			const available = { width: Math.max(1, columns - 2), height: Math.max(1, rows - 2) };
			const layoutWidth = Math.min(preferredWidth, available.width);
			const layoutHeight = Math.min(preferredHeight, available.height);
			return {
				left: 1 + Math.floor(Math.max(0, available.width - layoutWidth) / 2),
				top: 1 + Math.floor(Math.max(0, available.height - layoutHeight) / 2),
				width: view.outer,
				height: view.contentHeight + (view.bordered ? 2 : 0),
			};
		},
		othersExpanded: () => showOthers,
	};
}

function headerLabel(model: StatusPanelModel): string {
	if (model.items.length === 0 && model.others.length === 0) return "状态 · 暂无";
	const total = model.items.length + model.others.length;
	const parts = [`状态 · ${total} 项`];
	if (model.hiddenCount > 0) parts.push(`${model.hiddenCount} 项未展示`);
	return parts.join("，");
}

function hintLabel(showOthers: boolean, innerWidth: number): string {
	const variants = [
		[
			"↑↓ 滚动",
			"Shift+↑↓ 选择",
			"PgUp/PgDn 翻页",
			"Home/End 首尾",
			"Enter 执行",
			"Esc 关闭",
			...(showOthers ? [] : ["Tab 其他状态"]),
		],
		["↑↓ 滚动", "Shift+↑↓ 选择", "PgUp/PgDn 翻页", "Enter 执行", "Esc 关闭"],
		["↑↓ · Shift+↑↓ · PgUp/PgDn · Esc"],
		["Esc 关闭"],
	];
	for (const parts of variants) {
		const label = parts.join(" · ");
		// Two spaces of padding plus one space each side of the label.
		if (visibleWidth(label) + 4 <= innerWidth) return label;
	}
	return "";
}

let active: { close: () => void; focusKey?: string } | undefined;
/**
 * Where the open panel is on screen, for outside-click dismissal: Pi centres the
 * overlay (its layout formula is mirrored below), and the drawn width is the one
 * the component actually rendered.
 */
let activeRect: { left: number; top: number; width: number; height: number } | undefined;

/**
 * Set when a press dismissed the panel. That same press also reaches the bar's
 * pill, whose handler would otherwise reopen the panel it just put away; the
 * next open request is that echo, so it is swallowed once. Any other close
 * clears the flag, which keeps it a one-gesture guard rather than a time window.
 */
let reopenBlocked = false;

/** The open panel's screen rectangle, or undefined when none is up. */
export function activeStatusPanelRect():
	| { left: number; top: number; width: number; height: number }
	| undefined {
	return activeRect;
}

export function isStatusPanelOpen(): boolean {
	return active !== undefined;
}

/** Put the panel away, if one is open. Idempotent. */
export function closeStatusPanel(): void {
	const current = active;
	active = undefined;
	activeRect = undefined;
	reopenBlocked = false;
	current?.close();
}

/**
 * Put the panel away because the user pressed outside it.
 *
 * Arms a short guard so the same press, once the footer sees it, cannot reopen
 * the panel: the click that dismisses is not a request to open.
 */
export function dismissStatusPanel(): void {
	closeStatusPanel();
	reopenBlocked = true;
}

/**
 * Note that a press arrived while no panel was open: whatever dismissed the last
 * one has been dealt with, so the guard must not swallow this new gesture.
 */
export function resetStatusPanelDismissGuard(): void {
	reopenBlocked = false;
}

export type ShowStatusPanelOptions = {
	/** Entry to select when the panel opens. */
	focusKey?: string;
	/** Override the model; defaults to the footer's latest. */
	readModel?: () => StatusPanelModel;
	/** Called with the entry the user asked to act on. */
	onAction: (item: StatusPanelItem) => void;
};

/**
 * Open the panel. No-op outside the interactive TUI: the RPC and print modes
 * have no terminal component to mount, and rendering must stay independent of
 * them.
 */
export function showStatusPanel(ctx: ExtensionContext, options: ShowStatusPanelOptions): void {
	const mode = (ctx as typeof ctx & { mode?: string }).mode;
	if (!ctx.hasUI || (mode !== undefined && mode !== "tui")) return;
	closeStatusPanel();

	const columns = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const width = Math.max(1, Math.min(columns - 2, 80));
	const height = Math.max(1, Math.min(Math.floor(rows * 0.7), MAX_PANEL_HEIGHT));
	const readModel = options.readModel ?? readStatusPanelModel;

	const mount = ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let mounted = true;
			const close = () => {
				if (!mounted) return;
				mounted = false;
				// Every way out goes through here — Esc, an action, the bar, Pi tearing
				// the overlay down — so the screen rectangle must go with it. A stale
				// rectangle would make the outside-press observer dismiss a panel that is
				// no longer open, and that dismissal's guard would swallow the next real
				// open (the +N press that follows an Esc).
				if (active?.close === close) {
					active = undefined;
					activeRect = undefined;
				}
				done(undefined);
			};
			active = { close, ...(options.focusKey ? { focusKey: options.focusKey } : {}) };
			const component = createStatusPanelComponent({
				readModel,
				theme,
				width,
				height,
				...(options.focusKey ? { focusKey: options.focusKey } : {}),
				onAction: (item) => options.onAction(item),
				onClose: close,
			});
			return {
				render: (renderWidth: number) => {
					const lines = component.render(renderWidth);
					if (active?.close === close) activeRect = component.rect();
					return lines;
				},
				invalidate: () => component.invalidate(),
				handleInput: (data: string) => {
					component.handleInput(data);
					tui.requestRender();
				},
				handleMouse: (event: StatusPanelMouseEvent) => {
					const result = component.handleMouse(event);
					if (result?.handled) tui.requestRender();
					return result;
				},
				dispose: () => {
					mounted = false;
					if (active?.close === close) {
						active = undefined;
						activeRect = undefined;
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width, maxHeight: height, margin: 1 },
		},
	);

	void mount.catch(() => {
		if (active?.close) {
			active = undefined;
			activeRect = undefined;
		}
	});
}

/**
 * The action key behind a panel entry: third-party entries are configured as
 * `extensionStatus:<key>` but their action is registered under `<key>`.
 */
function canonicalActionKey(configKey: string): string {
	return configKey.startsWith(EXTENSION_STATUS_PREFIX)
		? configKey.slice(EXTENSION_STATUS_PREFIX.length)
		: configKey;
}

/**
 * Ask the shared mouse layer whether an overlay is already up.
 *
 * Optional by design: without `@xzzpig/pi-mouse-events`, or on a Pi whose
 * receiver has no overlay probe, the check is skipped rather than assumed.
 */
function externalOverlayVisible(): boolean | undefined {
	try {
		const receiver = getMouseEventsApi()?.liveReceiver?.() as { hasOverlay?: unknown } | undefined;
		const probe = receiver?.hasOverlay;
		if (typeof probe !== "function") return undefined;
		return probe.call(receiver) === true;
	} catch {
		return undefined;
	}
}

/**
 * Open the panel and route an explicitly chosen entry to its own action.
 *
 * Every entrance — the `+N` pill, a shortened pill, the `/starline statuses`
 * command and the settings row — goes through here, so the hand-over happens
 * in one place: our own bubble is closed first (it is an overlay too, and
 * leaving it up would both hide the panel and make the check below always
 * answer "someone else is up"), then an external overlay makes this a refusal
 * instead of a stack.
 *
 * The lookup happens at activation time, not when the panel opened: a status
 * whose action disappeared (or appeared) meanwhile must behave as the session
 * currently says. No anchor is passed — the entry may be in the overflow set,
 * where there is no pill on screen to point a bubble at.
 */
export function openStatusPanel(ctx: ExtensionContext, focusKey?: string): void {
	// The press that just dismissed the panel also reaches the pill underneath it.
	// That is the same gesture, not a request to open: swallow it once.
	if (reopenBlocked) {
		reopenBlocked = false;
		return;
	}
	closePillBubble();
	// The same entrance closes it, like a menu-bar item: pressing `+N` again, or
	// running the command while the panel is up, puts it away instead of
	// stacking another one or complaining about "an open dialog" — that dialog
	// is this panel. A *different* entry is a new request, so it replaces the
	// open panel with one focused there; only the same target toggles.
	if (isStatusPanelOpen()) {
		if (focusKey === undefined || focusKey === active?.focusKey) {
			closeStatusPanel();
			return;
		}
	}
	// Some other dialog owns the screen. Mouse and command entrances both stay
	// quiet: the panel cannot be shown over it, and a warning would only explain
	// something the user did not ask for.
	if (externalOverlayVisible() === true) return;
	showStatusPanel(ctx, {
		...(focusKey ? { focusKey } : {}),
		onAction: (item) => {
			let action: ReturnType<typeof pillActionFor>;
			try {
				action = pillActionFor(canonicalActionKey(item.key));
			} catch {
				return;
			}
			// A panel entry is a click target, so the action runs the way a pill click
			// does: the model and thinking entries open their pickers instead of
			// stepping to the next value the way the bare `/starline model` command
			// does. No anchor is passed — an overflowed entry has no pill on screen.
			if (action) runPillAction(action, ctx, undefined, "click");
		},
	});
}
