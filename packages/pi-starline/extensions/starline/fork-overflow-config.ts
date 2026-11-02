/**
 * Overflow governance for the pill bar (fork-only).
 *
 * The bar owns one terminal row. Without a policy, a long status or a crowd of
 * them pushes later pills past the right edge, where the row truncation deletes
 * them without a trace. This module owns the configuration half: the defaults,
 * the per-key resolution, and the tolerant normalisation that keeps one bad
 * value from discarding the rest of the block.
 *
 * Resolution order is deliberate: an explicit per-key width wins, then the
 * category default. The built-in `cwd`/`git` limits are themselves entries in
 * that per-key layer, so a user who overrides one keeps the other.
 */

export type PillOverflowConfig = {
	/** Draw the governed bar. False restores the pre-overflow single-row layout. */
	enabled: boolean;
	/** Content width cap for built-in pills, icon included. */
	maxContentWidth: number;
	/** Content width cap for third-party statuses, icon included. */
	extensionMaxContentWidth: number;
	/** Per-key overrides, keyed by segment name or `extensionStatus:<key>`. */
	maxWidths: Record<string, number>;
	/** Per-key retention priorities; higher is kept first when space runs out. */
	priorities: Record<string, number>;
	/** Keys that are kept ahead of unpinned keys of the same priority. */
	pinned: string[];
};

export const DEFAULT_OVERFLOW_MAX_CONTENT_WIDTH = 32;
export const DEFAULT_OVERFLOW_EXTENSION_MAX_CONTENT_WIDTH = 28;
export const DEFAULT_OVERFLOW_PRIORITY = 50;
export const MIN_OVERFLOW_CONTENT_WIDTH = 1;
export const MAX_OVERFLOW_CONTENT_WIDTH = 4096;
export const MIN_OVERFLOW_PRIORITY = -1000;
export const MAX_OVERFLOW_PRIORITY = 1000;

/** Per-key widths that ship as defaults rather than as the category value. */
export const DEFAULT_OVERFLOW_MAX_WIDTHS: Readonly<Record<string, number>> = {
	cwd: 24,
	git: 24,
};

/** Priorities that ship as defaults; every other key falls back to 50. */
export const DEFAULT_OVERFLOW_PRIORITIES: Readonly<Record<string, number>> = {
	queue: 100,
	model: 80,
	context: 80,
};

export const DEFAULT_PILL_OVERFLOW: PillOverflowConfig = {
	enabled: true,
	maxContentWidth: DEFAULT_OVERFLOW_MAX_CONTENT_WIDTH,
	extensionMaxContentWidth: DEFAULT_OVERFLOW_EXTENSION_MAX_CONTENT_WIDTH,
	maxWidths: { ...DEFAULT_OVERFLOW_MAX_WIDTHS },
	priorities: { ...DEFAULT_OVERFLOW_PRIORITIES },
	pinned: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContentWidth(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= MIN_OVERFLOW_CONTENT_WIDTH &&
		value <= MAX_OVERFLOW_CONTENT_WIDTH
	);
}

function isPriority(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= MIN_OVERFLOW_PRIORITY &&
		value <= MAX_OVERFLOW_PRIORITY
	);
}

function normalizeWidthMap(value: unknown): Record<string, number> {
	const widths: Record<string, number> = {};
	if (!isRecord(value)) return widths;
	for (const [key, entry] of Object.entries(value)) {
		if (!key) continue;
		if (isContentWidth(entry)) widths[key] = entry;
	}
	return widths;
}

function normalizePriorityMap(value: unknown): Record<string, number> {
	const priorities: Record<string, number> = {};
	if (!isRecord(value)) return priorities;
	for (const [key, entry] of Object.entries(value)) {
		if (!key) continue;
		if (isPriority(entry)) priorities[key] = entry;
	}
	return priorities;
}

function normalizePinned(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const pinned: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const key = entry.trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		pinned.push(key);
	}
	return pinned;
}

/**
 * Normalise the `pill.overflow` block.
 *
 * Each field falls back on its own: an out-of-range width must not discard a
 * valid priority list, and an unknown key is kept as written so a status that
 * has not been published yet still finds its setting once it is.
 */
export function normalizePillOverflow(value: unknown): PillOverflowConfig {
	if (!isRecord(value)) {
		return {
			...DEFAULT_PILL_OVERFLOW,
			maxWidths: { ...DEFAULT_PILL_OVERFLOW.maxWidths },
			priorities: { ...DEFAULT_PILL_OVERFLOW.priorities },
			pinned: [],
		};
	}

	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_PILL_OVERFLOW.enabled,
		maxContentWidth: isContentWidth(value.maxContentWidth)
			? value.maxContentWidth
			: DEFAULT_OVERFLOW_MAX_CONTENT_WIDTH,
		extensionMaxContentWidth: isContentWidth(value.extensionMaxContentWidth)
			? value.extensionMaxContentWidth
			: DEFAULT_OVERFLOW_EXTENSION_MAX_CONTENT_WIDTH,
		maxWidths: {
			...DEFAULT_OVERFLOW_MAX_WIDTHS,
			...normalizeWidthMap(value.maxWidths),
		},
		priorities: {
			...DEFAULT_OVERFLOW_PRIORITIES,
			...normalizePriorityMap(value.priorities),
		},
		pinned: normalizePinned(value.pinned),
	};
}

/**
 * Content width cap for one key: per-key override first, then the category
 * default. `kind` distinguishes a built-in segment from a third-party status.
 */
export function overflowContentLimit(
	config: PillOverflowConfig,
	key: string,
	kind: "builtin" | "extension",
): number {
	const override = config.maxWidths[key];
	if (override !== undefined) return override;
	return kind === "extension" ? config.extensionMaxContentWidth : config.maxContentWidth;
}

/** Retention priority for one key; unlisted keys share the default tier. */
export function overflowPriority(config: PillOverflowConfig, key: string): number {
	return config.priorities[key] ?? DEFAULT_OVERFLOW_PRIORITY;
}

/** Whether the user pinned this key ahead of unpinned keys of the same tier. */
export function isOverflowPinned(config: PillOverflowConfig, key: string): boolean {
	return config.pinned.includes(key);
}

/**
 * Stable digest of the governed settings, used to key layout memoisation. It
 * carries every field that changes which pills are kept or how wide they are.
 *//**
 * Merge a patch into the raw `pill.overflow` record for saving.
 *
 * The record is edited in place rather than regenerated from the normalised
 * config, so keys this build does not know about survive a settings change and
 * a status that is not published yet keeps its entry.
 */
export function applyOverflowPatch(
	existing: Record<string, unknown>,
	patch: Partial<PillOverflowConfig>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...existing };
	if (patch.enabled !== undefined) next.enabled = patch.enabled;
	if (patch.maxContentWidth !== undefined) next.maxContentWidth = patch.maxContentWidth;
	if (patch.extensionMaxContentWidth !== undefined) {
		next.extensionMaxContentWidth = patch.extensionMaxContentWidth;
	}
	if (patch.maxWidths !== undefined) {
		next.maxWidths = {
			...(isRecord(existing.maxWidths) ? existing.maxWidths : {}),
			...patch.maxWidths,
		};
	}
	if (patch.priorities !== undefined) {
		next.priorities = {
			...(isRecord(existing.priorities) ? existing.priorities : {}),
			...patch.priorities,
		};
	}
	if (patch.pinned !== undefined) next.pinned = [...patch.pinned];
	return next;
}

export function overflowSignature(config: PillOverflowConfig): string {
	const widths = Object.entries(config.maxWidths)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, width]) => `${key}=${width}`)
		.join(",");
	const priorities = Object.entries(config.priorities)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, priority]) => `${key}=${priority}`)
		.join(",");
	return [
		config.enabled ? "on" : "off",
		config.maxContentWidth,
		config.extensionMaxContentWidth,
		widths,
		priorities,
		config.pinned.join(","),
	].join("|");
}
