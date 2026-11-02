/**
 * The model the status panel reads (fork-only).
 *
 * The panel must show exactly what the bar decided: which entries are drawn,
 * which were shortened, and which were replaced by the `+N` pill. That decision
 * lives in the footer's render, so the footer publishes the model it just
 * computed and the panel reads it; nothing is derived a second way, and nothing
 * here calls `requestRender` (a publish from inside a render must not start
 * another frame).
 *
 * When no footer is mounted — `statusLine` turned off — there is no bar to
 * describe, so the fallback model lists the third-party statuses the session
 * published, with no built-in rows to pretend about.
 */

import type { PolishedTuiConfig } from "./config";
import { getExtensionStatusColorMode, getExtensionStatusPlacement } from "./config";
import {
	sanitizeExtensionStatusOriginalText,
	sanitizeExtensionStatusText,
} from "./extension-status";
import type { OverflowLayout } from "./fork-pill-overflow";
import { type StatusSnapshot, snapshotSignature } from "./fork-status-snapshot";
import { pillActionFor } from "./pill-actions";

export type StatusPanelState = "full" | "truncated" | "hidden" | "off";

export type StatusPanelItem = {
	/** Canonical key: segment name or `extensionStatus:<key>`. */
	key: string;
	title: string;
	/** Safe published text, never truncated. */
	text: string;
	state: StatusPanelState;
	/** Whether the session currently has an action for this key. */
	actionable: boolean;
};

export type StatusPanelModel = {
	/** Placed entries, in bar order. */
	items: StatusPanelItem[];
	/** Statuses the bar does not place, or that were placed off. */
	others: StatusPanelItem[];
	/** Number of entries the bar replaced with the summary pill. */
	hiddenCount: number;
	/** Cheap digest, so a panel render can skip rebuilding its layout. */
	signature: string;
};

/**
 * Everything about a model row that changes its rendered height or its action
 * availability. Used for the fallback and legacy signatures, which have no
 * snapshot digest to lean on.
 */
function describeModelItems(items: readonly StatusPanelItem[]): string {
	return items
		.map((item) => `${item.key}:${item.state}:${item.actionable ? 1 : 0}:${item.text}`)
		.join(",");
}

const EMPTY_MODEL: StatusPanelModel = {
	items: [],
	others: [],
	hiddenCount: 0,
	signature: "empty",
};

function isActionable(actionKey: string): boolean {
	try {
		return pillActionFor(actionKey) !== undefined;
	} catch {
		return false;
	}
}

/**
 * Build the panel model from the same snapshot and layout the bar just drew.
 */
export function buildStatusPanelModel(
	snapshot: StatusSnapshot,
	layout: OverflowLayout,
): StatusPanelModel {
	const visible = new Set(layout.visible.map((entry) => entry.key));
	const items = snapshot.entries.map((entry) => ({
		key: entry.key,
		title: entry.title,
		text: entry.fullText || entry.displayText,
		state: visible.has(entry.key)
			? entry.truncated
				? ("truncated" as const)
				: ("full" as const)
			: ("hidden" as const),
		actionable: isActionable(entry.actionKey),
	}));
	const others = snapshot.others.map((entry) => ({
		key: entry.key,
		title: entry.title,
		text: entry.fullText || entry.displayText,
		state: "off" as const,
		actionable: isActionable(entry.actionKey),
	}));
	const flags = items
		.map((item) => `${item.key}:${item.state}:${item.actionable ? 1 : 0}`)
		.join(",");
	const otherFlags = others.map((item) => `${item.key}:${item.actionable ? 1 : 0}`).join(",");
	return {
		items,
		others,
		hiddenCount: layout.hidden.length,
		signature: `${snapshotSignature(snapshot)}|${flags}|${otherFlags}|${layout.hidden.length}`,
	};
}

let latest: StatusPanelModel | undefined;

/** Called by the footer after it laid the bar out. Never triggers a render. */
export function publishStatusPanelModel(model: StatusPanelModel | undefined): void {
	latest = model;
}

export function clearStatusPanelModel(): void {
	latest = undefined;
}

type StatusViewSource = {
	getConfig: () => PolishedTuiConfig;
	getStatuses: () => ReadonlyMap<string, string>;
};

let source: StatusViewSource | undefined;

/**
 * Register how to read the live statuses when no footer has published a model,
 * so `/starline statuses` works with `statusLine` turned off.
 */
export function configureStatusView(next: StatusViewSource | undefined): void {
	source = next;
	if (!next) latest = undefined;
}

/**
 * Extension-only fallback: no bar, so nothing is on screen; every published
 * status is listed under its own group and none is claimed as displayed.
 */
export function buildExtensionOnlyModel(
	config: PolishedTuiConfig,
	statuses: ReadonlyMap<string, string>,
): StatusPanelModel {
	const items: StatusPanelItem[] = [];
	const others: StatusPanelItem[] = [];

	for (const [key, value] of statuses.entries()) {
		const colorMode = getExtensionStatusColorMode(config, key);
		const published =
			colorMode === "original"
				? sanitizeExtensionStatusOriginalText(value)
				: sanitizeExtensionStatusText(value);
		if (!published) continue;
		// The panel reads what the extension published. `formats: value` only
		// changes the pill, so converting here would silently drop the full text
		// from the one place that is supposed to keep it.
		const placement = getExtensionStatusPlacement(config, key);
		const item: StatusPanelItem = {
			key: `extensionStatus:${key}`,
			title: key,
			text: published,
			state: placement === "off" ? "off" : "hidden",
			actionable: isActionable(key),
		};
		if (placement === "off") others.push(item);
		else items.push(item);
	}

	items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	others.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return {
		items,
		others,
		hiddenCount: items.length,
		// The signature gates the panel's reading-position restore, so it has to
		// cover the text and the state, not just the keys: a status whose body grew
		// re-wraps every row below it.
		signature: `fallback|${describeModelItems(items)}|${describeModelItems(others)}`,
	};
}

/**
 * The model to draw: the footer's latest, or the extension-only fallback when
 * nothing has been published this session.
 */
export function readStatusPanelModel(): StatusPanelModel {
	if (latest) return latest;
	if (!source) return EMPTY_MODEL;
	try {
		return buildExtensionOnlyModel(source.getConfig(), source.getStatuses());
	} catch {
		return EMPTY_MODEL;
	}
}

/**
 * Describe a row drawn by the pre-overflow pipeline.
 *
 * That pipeline has no retention policy, so "was it shown" comes straight from
 * the spans the renderer produced, and only the pill the edge lands in can be
 * shortened.
 */
export function buildLegacyStatusPanelModel(
	snapshot: StatusSnapshot,
	options: { visibleKeys: ReadonlySet<string>; truncatedKey?: string; hiddenCount: number },
): StatusPanelModel {
	const items = snapshot.entries.map((entry) => ({
		key: entry.key,
		title: entry.title,
		text: entry.fullText || entry.displayText,
		state: options.visibleKeys.has(entry.actionKey)
			? options.truncatedKey === entry.actionKey
				? ("truncated" as const)
				: ("full" as const)
			: ("hidden" as const),
		actionable: isActionable(entry.actionKey),
	}));
	const others = snapshot.others.map((entry) => ({
		key: entry.key,
		title: entry.title,
		text: entry.fullText || entry.displayText,
		state: "off" as const,
		actionable: isActionable(entry.actionKey),
	}));
	return {
		items,
		others,
		hiddenCount: options.hiddenCount,
		signature: `legacy|${describeModelItems(items)}|${describeModelItems(others)}|${options.hiddenCount}`,
	};
}
