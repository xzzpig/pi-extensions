/**
 * Render the pill row, governed or not, and describe what it decided
 * (fork-only).
 *
 * The footer keeps its colour/state logic and hands the finished labels here;
 * this module owns the layout question only. It returns the spans the click
 * handler needs, plus the panel model for exactly the row it just drew, so the
 * two can never disagree.
 *
 * With governance off the old pipeline runs unchanged — same input collection,
 * same single truncation — and the panel is described from the spans that line
 * produced, including which pill the edge cut.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ColorSource, ColorSpec, PolishedTuiConfig } from "./config";
import { overflowSignature, type PillOverflowConfig } from "./fork-overflow-config";
import { layoutStatusBar, OVERFLOW_SUMMARY_KEY, type OverflowSummary } from "./fork-pill-overflow";
import type { StatusEntry, StatusSnapshot } from "./fork-status-snapshot";
import { collectStatusSnapshot, snapshotSignature } from "./fork-status-snapshot";
import {
	buildLegacyStatusPanelModel,
	buildStatusPanelModel,
	type StatusPanelModel,
} from "./fork-status-view";
import { type PillInput, type PillSpan, renderPillBar } from "./pill";
import type { ThemeLike } from "./style";

export type StatusBarHit = {
	/** Entry behind a span key (a segment name or a status key). */
	entryByKey: Map<string, StatusEntry>;
	/** Present when the row had to summarise entries. */
	summary: { key: string; hidden: number; firstHiddenKey?: string } | undefined;
	/**
	 * Columns of the summary pill as drawn. A third-party status may legitimately
	 * be published under the same key, so the summary is identified by where it
	 * is, not only by what it is called; the footer fills this in from the clamped
	 * spans of the frame it just drew.
	 */
	summarySpan?: { startColumn: number; endColumn: number };
};

export type StatusBarRender = {
	/** The row as drawn, already cut to `width`. */
	line: string;
	spans: PillSpan[];
	hit: StatusBarHit;
	model: StatusPanelModel;
};

export type StatusBarMemo = {
	layoutKey?: string;
	/**
	 * The cached decision holds *keys*, never entries: the snapshot is rebuilt on
	 * every frame, so a cache hit rehydrates the selection against the entries of
	 * this frame instead of redrawing last frame's objects.
	 */
	layout?: { visible: string[]; hidden: string[]; summary: OverflowSummary | undefined };
};

export type StatusBarOptions = {
	config: PolishedTuiConfig;
	theme: ThemeLike;
	colorSource: ColorSource;
	statuses: ReadonlyMap<string, string>;
	width: number;
	iconMode: "auto" | "ascii" | "nerd";
	/** Styled label for a built-in segment, exactly as the old footer built it. */
	renderBuiltin: (segment: string) => string;
	builtinSpec: (segment: string) => ColorSpec;
	statusSpec: (key: string) => ColorSpec;
	/** Persisted between renders so a stable bar does not re-solve the layout. */
	memo: StatusBarMemo;
	/** The pre-overflow input list, used when governance is off. */
	legacyInputs: () => PillInput[];
};

const ellipsisFor = (iconMode: StatusBarOptions["iconMode"]) =>
	iconMode === "ascii" ? "..." : "…";

function summaryInput(text: string, config: PolishedTuiConfig): PillInput {
	return {
		key: OVERFLOW_SUMMARY_KEY,
		text,
		spec: config.colors.extensionStatus,
	};
}

function inputsFor(
	visible: readonly StatusEntry[],
	summaryText: string | undefined,
	config: PolishedTuiConfig,
): PillInput[] {
	const inputs = visible.map((entry) => entry.input);
	if (summaryText !== undefined) inputs.push(summaryInput(summaryText, config));
	return inputs;
}

/**
 * Everything the layout decision depends on: what each entry would say and how
 * this session's renderer would draw it. Caching on the snapshot alone is not
 * enough — the same entries are a different row when the icon mode, the caps or
 * the separator change, and `/starline` changes those live.
 */
function renderSignature(snapshot: StatusSnapshot, options: StatusBarOptions): string {
	const { config, iconMode, theme, colorSource } = options;
	const ascii = iconMode === "ascii";
	const entries = snapshot.entries
		.map(
			(entry) =>
				`${entry.input.key}\u0000${entry.input.spec}\u0000${entry.input.keepStyling ? 1 : 0}\u0000${entry.input.text}\u0000${entry.truncated ? 1 : 0}`,
		)
		.join("\u0001");
	// The renderer's own geometry — caps, separators, same-background dividers,
	// theme-derived colours — is measured rather than enumerated: a two-pill probe
	// at a width nothing can reach folds all of it into one number.
	const probe: PillInput[] = [
		{ key: "@render-signature/a", text: "a", spec: config.colors.extensionStatus },
		{ key: "@render-signature/b", text: "a", spec: config.colors.extensionStatus },
	];
	const geometry = visibleWidth(
		renderPillBar(probe, theme, colorSource, config.pill, 1_000_000, { ascii }),
	);
	return `${snapshotSignature(snapshot)}\u0002${entries}\u0003${iconMode}\u0004${config.pill.caps}\u0005${config.pill.separator}\u0006${geometry}`;
}

/** Draw the governed row: caps and separators here, a bare summary when the
 * terminal is too narrow for them. */
function governedRender(options: StatusBarOptions): StatusBarRender {
	const { config, theme, colorSource, statuses, width, iconMode, memo } = options;
	const ascii = iconMode === "ascii";
	const snapshot = collectStatusSnapshot({
		statuses,
		config,
		renderBuiltin: options.renderBuiltin,
		builtinSpec: options.builtinSpec,
		statusSpec: options.statusSpec,
		ellipsis: ellipsisFor(iconMode),
	});

	const measure = (visible: readonly StatusEntry[], summary: OverflowSummary | undefined) => {
		// A bare summary is drawn as its own text, so it is measured that way.
		if (summary?.bare) return visibleWidth(summary.text);
		const inputs = inputsFor(visible, summary?.text, config);
		if (inputs.length === 0) return 0;
		// The real renderer, at a width nothing can reach, is the measurement: caps,
		// separators and same-background dividers are exactly what will be drawn.
		return visibleWidth(
			renderPillBar(inputs, theme, colorSource, config.pill, 1_000_000, { ascii }),
		);
	};

	const layoutKey = `${renderSignature(snapshot, options)}|${overflowSignature(config.pill.overflow)}|${width}`;
	const byKey = new Map(snapshot.entries.map((entry) => [entry.key, entry]));
	const rehydrate = (keys: readonly string[]): StatusEntry[] | undefined => {
		const entries: StatusEntry[] = [];
		for (const key of keys) {
			const entry = byKey.get(key);
			if (!entry) return undefined;
			entries.push(entry);
		}
		return entries;
	};
	let layout: ReturnType<typeof layoutStatusBar> | undefined;
	if (memo.layout && memo.layoutKey === layoutKey) {
		const visible = rehydrate(memo.layout.visible);
		const hidden = rehydrate(memo.layout.hidden);
		if (visible && hidden) layout = { visible, hidden, summary: memo.layout.summary };
	}
	if (!layout) {
		const solved = layoutStatusBar({
			entries: snapshot.entries,
			overflow: config.pill.overflow,
			width,
			measure,
		});
		layout = solved;
		memo.layoutKey = layoutKey;
		memo.layout = {
			visible: solved.visible.map((entry) => entry.key),
			hidden: solved.hidden.map((entry) => entry.key),
			summary: solved.summary,
		};
	}

	const spans: PillSpan[] = [];
	let line = "";
	// A bare summary bypasses the pill renderer entirely: at one or two columns a
	// cap and its padding are all that would fit, and the count is the point.
	if (layout.summary?.bare) {
		line = truncateToWidth(layout.summary.text, width, "");
		const end = visibleWidth(line);
		if (end > 0) {
			spans.push({
				key: OVERFLOW_SUMMARY_KEY,
				startColumn: 0,
				endColumn: end,
				bodyStartColumn: 0,
				bodyEndColumn: end,
				bg: "",
				fg: "",
			});
		}
	} else {
		const bar = renderPillBar(
			inputsFor(layout.visible, layout.summary?.text, config),
			theme,
			colorSource,
			config.pill,
			width,
			{ ascii, onSpan: (span) => spans.push(span) },
		);
		line = bar ? truncateToWidth(bar, width, "") : "";
	}

	return {
		line,
		spans,
		hit: {
			entryByKey: new Map(snapshot.entries.map((entry) => [entry.actionKey, entry])),
			summary: layout.summary
				? {
						key: OVERFLOW_SUMMARY_KEY,
						hidden: layout.summary.hidden,
						...(layout.hidden[0] ? { firstHiddenKey: layout.hidden[0].key } : {}),
					}
				: undefined,
		},
		model: buildStatusPanelModel(snapshot, layout),
	};
}

function legacyRender(options: StatusBarOptions): StatusBarRender {
	const { config, theme, colorSource, statuses, width, iconMode } = options;
	const ascii = iconMode === "ascii";
	const snapshot = collectStatusSnapshot({
		statuses,
		config,
		renderBuiltin: options.renderBuiltin,
		builtinSpec: options.builtinSpec,
		statusSpec: options.statusSpec,
		ellipsis: ellipsisFor(iconMode),
	});

	const spans: PillSpan[] = [];
	const bar = renderPillBar(
		// The legacy pipeline, unchanged: this is what `enabled: false` promises.
		options.legacyInputs(),
		theme,
		colorSource,
		config.pill,
		width,
		{ ascii, onSpan: (span) => spans.push(span) },
	);
	if (!bar) {
		return {
			line: "",
			spans,
			hit: { entryByKey: new Map(), summary: undefined },
			model: buildLegacyStatusPanelModel(snapshot, {
				visibleKeys: new Set(),
				hiddenCount: snapshot.entries.length,
			}),
		};
	}

	const line = truncateToWidth(bar, width, "");
	const visibleKeys = new Set(spans.map((span) => span.key));
	let truncatedKey: string | undefined;
	// Only the pill the edge lands in can be cut; a row narrower than the
	// terminal lost nothing.
	if (visibleWidth(line) >= width && spans.length > 0) {
		const natural = visibleWidth(
			renderPillBar(options.legacyInputs(), theme, colorSource, config.pill, 1_000_000, {
				ascii,
			}),
		);
		if (natural > width) truncatedKey = spans.at(-1)?.key;
	}

	return {
		line,
		spans,
		// Governance off means the old behaviour, including its click behaviour: a
		// pill carries only the action it registered. The panel is still reachable
		// from the command, and its labels come from the spans above.
		hit: { entryByKey: new Map(), summary: undefined },
		model: buildLegacyStatusPanelModel(snapshot, {
			visibleKeys,
			...(truncatedKey ? { truncatedKey } : {}),
			hiddenCount: Math.max(0, snapshot.entries.length - visibleKeys.size),
		}),
	};
}

export function renderStatusBar(options: StatusBarOptions): StatusBarRender {
	return options.config.pill.overflow.enabled ? governedRender(options) : legacyRender(options);
}

/** Re-exported for the footer's own tests and the settings surface. */
export type { PillOverflowConfig };
