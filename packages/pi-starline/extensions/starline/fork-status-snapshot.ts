/**
 * One snapshot of everything the bar can draw, with both texts kept
 * (fork-only).
 *
 * The bar only ever needed the styled text of a pill, so `extensionStatus`
 * formats such as `value` convert `MCP: 8 servers` to `8` before anything else
 * sees it. The status panel needs the opposite: the text as published, safe to
 * read, never truncated. Deriving that back from the rendered pill is
 * impossible, so the snapshot is built from the published map before any
 * format conversion or width limit runs, and the display text is derived from
 * it.
 *
 * Order is reproduced exactly as `collectPillInputs` expands the configured
 * segments, including the explicit-then-wildcard de-duplication, so a span's
 * key always names the entry that produced it.
 */

import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	ColorSpec,
	ExtensionStatusColorMode,
	ExtensionStatusPlacement,
	PolishedTuiConfig,
} from "./config";
import {
	getExtensionStatusColorMode,
	getExtensionStatusFormat,
	getExtensionStatusIcon,
	getExtensionStatusPlacement,
} from "./config";
import {
	sanitizeExtensionStatusOriginalText,
	sanitizeExtensionStatusText,
} from "./extension-status";
import {
	isOverflowPinned,
	overflowContentLimit,
	overflowPriority,
	type PillOverflowConfig,
} from "./fork-overflow-config";
import { statusValueText } from "./format";
import type { PillInput } from "./pill";
import {
	EXTENSION_STATUS_PREFIX,
	EXTENSION_STATUS_SEGMENT,
	PILL_SEGMENT_VARIABLES,
} from "./pill-config";

export type StatusEntryKind = "builtin" | "extension";

export type StatusEntry = {
	/** Canonical configuration key: a segment name, or `extensionStatus:<key>`. */
	key: string;
	/** Key the action registry and pill spans use. */
	actionKey: string;
	/** Short name shown as the panel title. */
	title: string;
	kind: StatusEntryKind;
	/** Position among the placed entries, in bar order. */
	index: number;
	/** The pill as the bar draws it, after the width limit. */
	input: PillInput;
	/** Safe published text, before `value` conversion and before truncation. */
	fullText: string;
	/** What the bar would say with no width limit (icon included). */
	displayText: string;
	/** The width limit cut this entry's content. */
	truncated: boolean;
	priority: number;
	pinned: boolean;
	colorMode: ExtensionStatusColorMode;
};

export type StatusSnapshot = {
	entries: StatusEntry[];
	/** Third-party statuses that the bar does not place at all. */
	others: StatusEntry[];
};

export type SnapshotOptions = {
	statuses: ReadonlyMap<string, string>;
	config: PolishedTuiConfig;
	/** Styled label for a built-in segment, exactly as the bar would draw it. */
	renderBuiltin: (segment: string) => string;
	/** Colour spec for a built-in segment. */
	builtinSpec: (segment: string) => ColorSpec;
	/** Colour spec for a third-party status. */
	statusSpec: (key: string) => ColorSpec;
	/** Ellipsis used when a content width limit cuts a pill. */
	ellipsis?: string;
};

type PlacedStatus = {
	key: string;
	published: string;
	display: string;
	placement: ExtensionStatusPlacement;
	colorMode: ExtensionStatusColorMode;
};

/**
 * The third-party statuses the bar may draw, in bar order: left, then middle,
 * then right, sorted by key inside each placement.
 *
 * `off` placement is answered separately by the caller, because a status the
 * user turned off still has to be readable in the panel.
 */
function readPlacedStatuses(
	statuses: ReadonlyMap<string, string>,
	config: PolishedTuiConfig,
): { placed: PlacedStatus[]; disabled: PlacedStatus[] } {
	const byPlacement: Record<ExtensionStatusPlacement, PlacedStatus[]> = {
		left: [],
		middle: [],
		right: [],
		off: [],
	};

	for (const [key, value] of statuses.entries()) {
		const placement = getExtensionStatusPlacement(config, key);
		const colorMode = getExtensionStatusColorMode(config, key);
		const published =
			colorMode === "original"
				? sanitizeExtensionStatusOriginalText(value)
				: sanitizeExtensionStatusText(value);
		if (!published) continue;
		const display =
			getExtensionStatusFormat(config, key) === "value" ? statusValueText(published) : published;
		byPlacement[placement].push({ key, published, display, placement, colorMode });
	}

	const sortByKey = (entries: PlacedStatus[]) =>
		entries.sort((a, b) => {
			if (a.key === b.key) return 0;
			return a.key < b.key ? -1 : 1;
		});
	const placed = [
		...sortByKey(byPlacement.left),
		...sortByKey(byPlacement.middle),
		...sortByKey(byPlacement.right),
	];
	return { placed, disabled: sortByKey(byPlacement.off) };
}

function truncatedContent(
	text: string,
	limit: number,
	ellipsis: string,
): { text: string; truncated: boolean } {
	if (limit <= 0) return { text: "", truncated: visibleWidth(text) > 0 };
	if (visibleWidth(text) <= limit) return { text, truncated: false };
	return { text: truncateToWidth(text, limit, ellipsis), truncated: true };
}

function extensionEntry(
	status: PlacedStatus,
	index: number,
	overflow: PillOverflowConfig,
	statusSpec: (key: string) => ColorSpec,
	statusIcon: (key: string) => string,
	ellipsis: string,
): StatusEntry {
	const key = `${EXTENSION_STATUS_PREFIX}${status.key}`;
	const icon = status.colorMode === "original" ? "" : statusIcon(status.key);
	// `original` keeps the extension's own styling, which the bar renders on a
	// neutral background, so an icon is not spliced into pre-styled output.
	const displayText = icon ? `${icon} ${status.display}` : status.display;
	const limit = overflowContentLimit(overflow, key, "extension");
	const cut = truncatedContent(displayText, limit, ellipsis);
	return {
		key,
		actionKey: status.key,
		title: status.key,
		kind: "extension",
		index,
		input:
			status.colorMode === "original"
				? { key: status.key, text: cut.text, spec: "", keepStyling: true }
				: { key: status.key, text: cut.text, spec: statusSpec(status.key) },
		fullText: stripVTControlCharacters(status.published).trim(),
		displayText: stripVTControlCharacters(displayText).trim(),
		truncated: cut.truncated,
		priority: overflowPriority(overflow, key),
		pinned: isOverflowPinned(overflow, key),
		colorMode: status.colorMode,
	};
}

function builtinEntry(
	segment: string,
	index: number,
	overflow: PillOverflowConfig,
	options: SnapshotOptions,
): StatusEntry | undefined {
	const styled = options.renderBuiltin(segment);
	const plain = stripVTControlCharacters(styled).trim();
	if (!plain) return undefined;
	const key = segment;
	const limit = overflowContentLimit(overflow, key, "builtin");
	const cut = truncatedContent(styled, limit, options.ellipsis ?? "…");
	return {
		key,
		actionKey: segment,
		title: segment,
		kind: "builtin",
		index,
		input: { key: segment, text: cut.text, spec: options.builtinSpec(segment) },
		fullText: plain,
		displayText: plain,
		truncated: cut.truncated,
		priority: overflowPriority(overflow, key),
		pinned: isOverflowPinned(overflow, key),
		colorMode: "themed",
	};
}

/**
 * Build the snapshot the governed bar and the status panel share.
 *
 * Built-in entries follow `pill.segments` directly; third-party entries expand
 * wherever `extensionStatus` appears, minus the ones the user placed by name,
 * and every status keeps the order `collectPillInputs` would give it.
 */
export function collectStatusSnapshot(options: SnapshotOptions): StatusSnapshot {
	const { config } = options;
	const overflow = config.pill.overflow;
	const segments = config.pill.segments;
	const { placed, disabled } = readPlacedStatuses(options.statuses, config);
	const explicitlyPlaced = new Set<string>();
	for (const segment of segments) {
		if (segment.startsWith(EXTENSION_STATUS_PREFIX)) {
			explicitlyPlaced.add(segment.slice(EXTENSION_STATUS_PREFIX.length));
		}
	}
	const expandsAll = segments.includes(EXTENSION_STATUS_SEGMENT);
	const statusIcon = (key: string) => getExtensionStatusIcon(config, key);
	const ellipsis = options.ellipsis ?? "…";

	const entries: StatusEntry[] = [];
	const usedStatusKeys = new Set<string>();
	const pushStatus = (status: PlacedStatus) => {
		if (usedStatusKeys.has(status.key)) return;
		usedStatusKeys.add(status.key);
		entries.push(
			extensionEntry(status, entries.length, overflow, options.statusSpec, statusIcon, ellipsis),
		);
	};

	for (const segment of segments) {
		if (segment === EXTENSION_STATUS_SEGMENT) {
			if (!expandsAll) continue;
			for (const status of placed) {
				if (explicitlyPlaced.has(status.key)) continue;
				pushStatus(status);
			}
			continue;
		}

		if (segment.startsWith(EXTENSION_STATUS_PREFIX)) {
			const key = segment.slice(EXTENSION_STATUS_PREFIX.length);
			const status = placed.find((candidate) => candidate.key === key);
			if (status) pushStatus(status);
			continue;
		}

		if (!PILL_SEGMENT_VARIABLES[segment]) continue;
		const entry = builtinEntry(segment, entries.length, overflow, options);
		if (entry) entries.push(entry);
	}

	const others = [...disabled, ...placed.filter((status) => !usedStatusKeys.has(status.key))]
		.sort((a, b) => {
			if (a.key === b.key) return 0;
			return a.key < b.key ? -1 : 1;
		})
		.map((status, index) =>
			extensionEntry(status, index, overflow, options.statusSpec, statusIcon, ellipsis),
		);

	return { entries, others };
}

/** Digest of a snapshot, so a render can skip rebuilding an identical model. */
export function snapshotSignature(snapshot: StatusSnapshot): string {
	const describe = (entry: StatusEntry) =>
		`${entry.key}\u0000${entry.input.text}\u0000${entry.fullText}\u0000${entry.truncated ? 1 : 0}`;
	return `${snapshot.entries.map(describe).join("\u0001")}\u0002${snapshot.others
		.map(describe)
		.join("\u0001")}`;
}
