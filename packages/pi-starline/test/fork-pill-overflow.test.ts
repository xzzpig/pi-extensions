import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "../extensions/starline/config";
import {
	layoutStatusBar,
	OVERFLOW_SUMMARY_KEY,
	type OverflowLayout,
	type OverflowSummary,
	overflowRetentionOrder,
	overflowSummaryLabel,
} from "../extensions/starline/fork-pill-overflow";
import type { StatusEntry } from "../extensions/starline/fork-status-snapshot";
import { renderPillBar } from "../extensions/starline/pill";
import type { ThemeLike } from "../extensions/starline/style";

/** Plain text: these tests are about columns, not colours. */
const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const pillConfig = mergeConfig({}).pill;

function entry(
	index: number,
	text: string,
	options: { key?: string; priority?: number } = {},
): StatusEntry {
	const key = options.key ?? `seg-${index}`;
	return {
		key,
		actionKey: key,
		title: key,
		kind: "builtin",
		index,
		input: { key, text, spec: "bright-black" },
		fullText: text,
		displayText: text,
		truncated: false,
		priority: options.priority ?? 50,
		pinned: false,
		colorMode: "themed",
	};
}

function measureNatural(
	visible: readonly StatusEntry[],
	summary: OverflowSummary | undefined,
): number {
	// Mirrors the footer: a bare summary is drawn as its own text, everything
	// else through the real pill renderer.
	if (summary?.bare) return visibleWidth(summary.text);
	const inputs = visible.map((item) => item.input);
	if (summary) {
		inputs.push({ key: OVERFLOW_SUMMARY_KEY, text: summary.text, spec: "bright-black" });
	}
	if (inputs.length === 0) return 0;
	return visibleWidth(renderPillBar(inputs, theme, "terminal", pillConfig, 100_000));
}

function layout(
	entries: StatusEntry[],
	width: number,
	overflow = pillConfig.overflow,
): OverflowLayout {
	return layoutStatusBar({ entries, overflow, width, measure: measureNatural });
}

const keys = (entries: readonly StatusEntry[]) => entries.map((item) => item.key);

describe("retention order", () => {
	it("is pinned, then priority, then bar order", () => {
		const a = entry(0, "a", { key: "a", priority: 50 });
		const b = entry(1, "b", { key: "b", priority: 90 });
		const c = entry(2, "c", { key: "c", priority: 50 });
		const overflow = { ...pillConfig.overflow, pinned: ["c"] };
		const order = overflowRetentionOrder([a, b, c], overflow);
		expect(keys(order)).toEqual(["c", "b", "a"]);
	});
});

describe("layout outcomes", () => {
	it("draws everything when it fits, with no summary", () => {
		const entries = [entry(0, "model"), entry(1, "cwd"), entry(2, "git")];
		const result = layout(entries, 200);
		expect(keys(result.visible)).toEqual(["seg-0", "seg-1", "seg-2"]);
		expect(result.hidden).toEqual([]);
		expect(result.summary).toBeUndefined();
	});

	it("draws nothing for an empty bar or no room", () => {
		expect(layout([], 80)).toEqual({ visible: [], hidden: [], summary: undefined });
		const entries = [entry(0, "model")];
		expect(layout(entries, 0)).toEqual({ visible: [], hidden: entries, summary: undefined });
	});

	it("keeps the higher priority entry in place of its own order", () => {
		const entries = [
			entry(0, "aaaa", { key: "a", priority: 50 }),
			entry(1, "bbbb", { key: "b", priority: 90 }),
		];
		// One pill plus "+1" fits; the high-priority one is the survivor.
		const width = measureNatural([entries[1]!], { kind: "count", text: "+1", hidden: 1 });
		const result = layout(entries, width);
		expect(keys(result.visible)).toEqual(["b"]);
		expect(result.summary?.text).toBe("+1");
	});

	it("draws survivors back in bar order, not priority order", () => {
		const entries = [
			entry(0, "aa", { key: "a", priority: 90 }),
			entry(1, "bbbbbbbbbbbb", { key: "b", priority: 10 }),
			entry(2, "cc", { key: "c", priority: 80 }),
		];
		// Room for two pills plus "+1": a and c outrank b, but keep their order.
		const width = measureNatural([entries[0]!, entries[2]!], {
			kind: "count",
			text: "+1",
			hidden: 1,
		});
		expect(measureNatural(entries, undefined)).toBeGreaterThan(width);
		const result = layout(entries, width);
		expect(keys(result.visible)).toEqual(["a", "c"]);
		expect(keys(result.hidden)).toEqual(["b"]);
	});

	it("never lets a later short pill jump an earlier long one of the same rank", () => {
		const long = entry(0, "x".repeat(30), { key: "long" });
		const short = entry(1, "y", { key: "short" });
		// Room for the short pill alone, but not for the long one: a strict prefix
		// would have to keep the long pill to reach the short one, so neither stays.
		const width = measureNatural([short], { kind: "count", text: "+1", hidden: 1 });
		const result = layout([long, short], width);
		expect(result.visible).toEqual([]);
		expect(keys(result.hidden)).toEqual(["long", "short"]);
	});

	it("degrades decorated pill, then bare count, then bare glyph, then nothing", () => {
		const entries = [entry(0, "model")];
		// Room for the decorated pill: it keeps its caps.
		const countWidth = measureNatural([], { kind: "count", text: "+1", hidden: 1 });
		expect(layout(entries, countWidth).summary).toEqual({
			kind: "count",
			text: "+1",
			hidden: 1,
		});
		// Two columns: the count survives without its decoration.
		expect(layout(entries, 2).summary).toEqual({
			kind: "count",
			text: "+1",
			hidden: 1,
			bare: true,
		});
		// One column: only the glyph fits, and it is drawn bare.
		expect(layout(entries, 1).summary).toEqual({
			kind: "glyph",
			text: "+",
			hidden: 1,
			bare: true,
		});
		// No room at all: nothing is drawn, nothing is claimed.
		const zero = layout(entries, 0);
		expect(zero.summary).toBeUndefined();
		expect(zero.visible).toEqual([]);
	});
});

describe("layout invariants", () => {
	const counts = [0, 1, 5, 20, 100];
	const widths = [0, 1, 20, 40, 80, 120, 200];

	it("conserves entries and never repeats one", () => {
		for (const count of counts) {
			for (const width of widths) {
				const entries = Array.from({ length: count }, (_, index) =>
					entry(index, index % 3 === 0 ? "a-long-status-text" : "x"),
				);
				const result = layout(entries, width);
				const all = [...keys(result.visible), ...keys(result.hidden)];
				expect(new Set(all).size).toBe(all.length);
				expect(all.length).toBe(count);
				// The summary, when there is one, counts exactly what left the row; the
				// empty-row fallback still keeps the entries readable in the panel.
				if (result.summary) expect(result.summary.hidden).toBe(result.hidden.length);
				else expect(result.visible.length === 0 || result.hidden.length === 0).toBe(true);
			}
		}
	});

	it("only ever draws a candidate that fits the width", () => {
		for (const count of counts) {
			for (const width of widths) {
				const entries = Array.from({ length: count }, (_, index) => entry(index, "status"));
				const result = layout(entries, width);
				if (result.summary) {
					expect(measureNatural(result.visible, result.summary)).toBeLessThanOrEqual(width);
				}
				if (result.visible.length > 0) {
					expect(measureNatural(result.visible, result.summary)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("never leaves a half-drawn pill inside the fitted row", () => {
		for (const width of widths.slice(2)) {
			const entries = Array.from({ length: 8 }, (_, index) => entry(index, `pill-${index}`));
			const result = layout(entries, width);
			if (result.visible.length === 0 && !result.summary) continue;
			// Natural width equals the width-limited render: nothing was cut.
			expect(measureNatural(result.visible, result.summary)).toBeLessThanOrEqual(width);
			const inputs = [
				...result.visible.map((item) => item.input),
				...(result.summary
					? [{ key: OVERFLOW_SUMMARY_KEY, text: result.summary.text, spec: "bright-black" }]
					: []),
			];
			const natural = renderPillBar(inputs, theme, "terminal", pillConfig, 100_000);
			const clipped = renderPillBar(inputs, theme, "terminal", pillConfig, width);
			expect(clipped).toBe(natural);
		}
	});

	it("keeps the summary label equal to the number it hides at digit boundaries", () => {
		for (const count of [10, 100]) {
			const entries = Array.from({ length: count }, (_, index) => entry(index, "x"));
			for (const width of [
				measureNatural([], { kind: "count", text: `+${count}`, hidden: count }),
				40,
			]) {
				const result = layout(entries, width);
				const hidden = result.hidden.length;
				expect(result.summary?.text).toBe(hidden > 0 ? overflowSummaryLabel(hidden) : undefined);
				if (hidden === 0) expect(result.summary).toBeUndefined();
			}
		}
	});

	it("is deterministic for identical input", () => {
		const entries = Array.from({ length: 12 }, (_, index) => entry(index, `p${index}`));
		const first = layout(entries, 40);
		const second = layout(entries, 40);
		expect(keys(first.visible)).toEqual(keys(second.visible));
		expect(keys(first.hidden)).toEqual(keys(second.hidden));
		expect(first.summary).toEqual(second.summary);
	});
});
