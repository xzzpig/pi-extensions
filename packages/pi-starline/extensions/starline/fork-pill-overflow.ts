/**
 * Single-row space allocation for the pill bar (fork-only).
 *
 * The bar has one row and no scrolling. Given more pills than fit, something
 * has to leave the row — the question this module answers is *which*, and the
 * answer must be the same on every frame and never a half-drawn pill.
 *
 * The rule is a strict retention prefix: fix the order in which entries earn
 * their place (pinned, then priority, then the order the user configured), keep
 * the first k of that order, and draw them back in their original order. A
 * later short pill never jumps ahead of an earlier long one, because that would
 * make the bar reshuffle whenever a text length changed.
 *
 * Widths are not estimated. The caller measures a candidate with the same
 * renderer that will draw it, so separators, caps and same-background dividers
 * are exactly what the terminal gets.
 */

import type { PillOverflowConfig } from "./fork-overflow-config";
import { isOverflowPinned } from "./fork-overflow-config";
import type { StatusEntry } from "./fork-status-snapshot";

/**
 * Private identity of the `+N` pill.
 *
 * It is not a public pill key: the footer recognises it before asking the
 * action registry, so no third-party status can be shadowed by it.
 */
export const OVERFLOW_SUMMARY_KEY = "@starline/status-overflow";

export type OverflowSummary = {
	/** `count` is the usual `+N`; `glyph` is the last-resort `+`. */
	kind: "count" | "glyph";
	text: string;
	/** How many entries the bar is not drawing. */
	hidden: number;
	/**
	 * Draw the text alone, without the pill's padding, caps or separator. Used
	 * when the terminal is too narrow for a decorated pill at all, so a one- or
	 * two-column bar can still say that content was hidden.
	 */
	bare?: boolean;
};

export type OverflowLayout = {
	/** Entries drawn, in bar order. */
	visible: StatusEntry[];
	/** Entries replaced by the summary, in bar order. */
	hidden: StatusEntry[];
	/** The summary pill, or undefined when the bar is empty. */
	summary: OverflowSummary | undefined;
};

export type OverflowLayoutOptions = {
	entries: readonly StatusEntry[];
	overflow: PillOverflowConfig;
	/** Available columns for the whole bar. */
	width: number;
	/**
	 * Measure a candidate with the real renderer: the entries to draw plus the
	 * summary pill (undefined when every entry is drawn or the row is empty).
	 */
	measure: (visible: readonly StatusEntry[], summary: OverflowSummary | undefined) => number;
};

export function overflowSummaryLabel(hidden: number): string {
	return `+${hidden}`;
}

/**
 * Rank entries by how much they deserve a slot: pinned first, then higher
 * priority, then the earlier entry. The index is the tie-breaker so the prefix
 * is total and deterministic.
 */
export function overflowRetentionOrder(
	entries: readonly StatusEntry[],
	overflow: PillOverflowConfig,
): StatusEntry[] {
	return [...entries].sort((a, b) => {
		const pinnedA = isOverflowPinned(overflow, a.key) ? 1 : 0;
		const pinnedB = isOverflowPinned(overflow, b.key) ? 1 : 0;
		if (pinnedA !== pinnedB) return pinnedB - pinnedA;
		const priorityA = a.priority;
		const priorityB = b.priority;
		if (priorityA !== priorityB) return priorityB - priorityA;
		return a.index - b.index;
	});
}

type Candidate = { visible: StatusEntry[]; summary: OverflowSummary | undefined };

function candidateFor(
	entries: readonly StatusEntry[],
	retention: readonly StatusEntry[],
	keep: number,
): Candidate {
	const kept = new Set(retention.slice(0, keep).map((entry) => entry.key));
	const visible = entries.filter((entry) => kept.has(entry.key));
	const hidden = entries.length - visible.length;
	return {
		visible,
		summary: hidden > 0 ? { kind: "count", text: overflowSummaryLabel(hidden), hidden } : undefined,
	};
}

/**
 * Choose the pills for one row.
 *
 * `width <= 0` draws nothing: a bar with no room must not paint a summary the
 * terminal cannot hold, and the status panel remains the way to read everything.
 */
export function layoutStatusBar(options: OverflowLayoutOptions): OverflowLayout {
	const { entries, overflow, width, measure } = options;
	if (entries.length === 0) return { visible: [], hidden: [], summary: undefined };
	if (width <= 0) {
		return { visible: [], hidden: [...entries], summary: undefined };
	}

	const fits = (candidate: Candidate) => measure(candidate.visible, candidate.summary) <= width;

	const everything: Candidate = { visible: [...entries], summary: undefined };
	if (fits(everything)) {
		return { visible: [...entries], hidden: [], summary: undefined };
	}

	// A summary is always present in this branch, so keeping every entry is not a
	// candidate: at least one pill must leave the row.
	const retention = overflowRetentionOrder(entries, overflow);
	let best: Candidate | undefined;
	// Width grows with the number of kept pills (the summary shrinks by at most a
	// digit while a pill adds several columns), so the largest fitting prefix can
	// be found by binary search over keep counts.
	let low = 0;
	let high = entries.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = candidateFor(entries, retention, middle);
		if (fits(candidate)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	if (best) {
		return {
			visible: best.visible,
			hidden: entries.filter((entry) => !best.visible.includes(entry)),
			summary: best.summary,
		};
	}

	// Not even the bare `+N` pill fits beside a kept entry: fall back to the
	// smallest thing that still says content was hidden, then to an empty row.
	const overflowAll = (summary: OverflowSummary): OverflowLayout => ({
		visible: [],
		hidden: [...entries],
		summary,
	});
	const countOnly = overflowAll({
		kind: "count",
		text: overflowSummaryLabel(entries.length),
		hidden: entries.length,
	});
	if (fits(countOnly)) return countOnly;
	// Shed the decoration before the count: `+N` alone, then `+`, and only then
	// give up. Each step is measured the way it will be drawn.
	const bareCount = overflowAll({
		kind: "count",
		text: overflowSummaryLabel(entries.length),
		hidden: entries.length,
		bare: true,
	});
	if (fits(bareCount)) return bareCount;
	const bareGlyph = overflowAll({ kind: "glyph", text: "+", hidden: entries.length, bare: true });
	if (fits(bareGlyph)) return bareGlyph;
	return { visible: [], hidden: [...entries], summary: undefined };
}
