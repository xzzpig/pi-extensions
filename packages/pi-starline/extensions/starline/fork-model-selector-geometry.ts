import type { Component } from "@earendil-works/pi-tui";

export type SelectorModel = { provider: string; id: string };
type ModelItem = { model: SelectorModel };
type Stack = Component & { children: Component[] };

/** Narrow, guarded view of Pi's selector internals; not a replacement selector. */
export type ModelSelectorState = Stack & {
	filteredModels: ModelItem[];
	selectedIndex: number;
	listContainer: Stack;
	searchInput: { getValue(): string };
	scope: string;
	closed: boolean;
	tui: { terminal: { rows: number } };
	updateList(): void;
	handleSelect(model: SelectorModel): void;
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
function component(value: unknown): value is Component {
	return record(value) && typeof value.render === "function";
}
function stack(value: unknown): value is Stack {
	return (
		component(value) &&
		Array.isArray((value as Stack).children) &&
		(value as Stack).children.every(component)
	);
}
export function selectorState(value: unknown): ModelSelectorState | undefined {
	if (!record(value) || !stack(value)) return undefined;
	const v = value;
	if (
		!Array.isArray(v.filteredModels) ||
		!v.filteredModels.every(
			(item: unknown) =>
				record(item) &&
				record(item.model) &&
				typeof item.model.provider === "string" &&
				typeof item.model.id === "string",
		)
	)
		return undefined;
	if (
		!Number.isInteger(v.selectedIndex) ||
		(v.selectedIndex as number) < 0 ||
		(v.filteredModels.length > 0 && (v.selectedIndex as number) >= v.filteredModels.length) ||
		!stack(v.listContainer) ||
		!value.children.includes(v.listContainer) ||
		!record(v.tui) ||
		!record(v.tui.terminal) ||
		!Number.isInteger(v.tui.terminal.rows) ||
		(v.tui.terminal.rows as number) < 1 ||
		!record(v.searchInput) ||
		typeof v.searchInput.getValue !== "function" ||
		typeof v.scope !== "string" ||
		typeof v.closed !== "boolean" ||
		typeof v.updateList !== "function" ||
		typeof v.handleSelect !== "function"
	)
		return undefined;
	// SAFETY: every field in the narrow structural contract was validated above.
	return value as unknown as ModelSelectorState;
}

export type ModelRow = { start: number; end: number; model: SelectorModel; index: number };
export type SelectorGeometry = {
	width: number;
	height: number;
	rows: ModelRow[];
	signature: string;
};

/** Mirrors Pi 1.1/1.5's updateList window only. Pin with real-class contract tests. */
export function visibleModelStart(selected: number, count: number): number {
	return Math.max(0, Math.min(selected - 5, count - 10));
}

/** Read actual child heights (including wrapped Text), never parse displayed model names. */
export function selectorGeometry(value: unknown, width: number): SelectorGeometry | undefined {
	const state = selectorState(value);
	if (!state || state.closed || !Number.isInteger(width) || width < 1) return undefined;
	let height = 0;
	let listStart: number | undefined;
	for (const child of state.children) {
		if (child === state.listContainer) listStart = height;
		height += child.render(width).length;
	}
	if (listStart === undefined) return undefined;
	const start = visibleModelStart(state.selectedIndex, state.filteredModels.length);
	const count = Math.min(10, state.filteredModels.length - start);
	if (state.listContainer.children.length < count) return undefined;
	let row = listStart;
	const rows: ModelRow[] = [];
	for (let offset = 0; offset < count; offset++) {
		const child = state.listContainer.children[offset];
		const item = state.filteredModels[start + offset];
		if (!child || !item) return undefined;
		const end = row + child.render(width).length;
		if (end <= row) return undefined;
		rows.push({ start: row, end, index: start + offset, model: item.model });
		row = end;
	}
	const signature = JSON.stringify([
		width,
		height,
		state.tui.terminal.rows,
		state.scope,
		state.searchInput.getValue(),
		state.filteredModels.map(({ model }) => [model.provider, model.id]),
		rows.map((entry) => [entry.start, entry.end, entry.index]),
	]);
	return { width, height, rows, signature };
}

export function modelRowAt(geometry: SelectorGeometry, x: number, y: number): ModelRow | undefined {
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= geometry.width) return undefined;
	return geometry.rows.find((row) => y >= row.start && y < row.end);
}
