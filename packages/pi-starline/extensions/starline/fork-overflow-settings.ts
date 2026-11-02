/**
 * Fork-only: the status-overflow rows of the `/starline` settings screen and
 * the changes they apply.
 *
 * `settings-command.ts` is an upstream file, so the whole of this feature's
 * screen logic lives here and the upstream file only splices the items in and
 * hands each change over. The id encoding stays upstream's
 * (`thirdPartyStatusSettingId`) and is passed in, so both sides agree.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "./config";
import {
	DEFAULT_OVERFLOW_EXTENSION_MAX_CONTENT_WIDTH,
	type PillOverflowConfig,
} from "./fork-overflow-config";
import { openStatusPanel } from "./fork-status-panel";
import { EXTENSION_STATUS_PREFIX } from "./pill-config";

type FeatureState = "enabled" | "disabled";

const featureStateValues: FeatureState[] = ["enabled", "disabled"];
/** Preset retention tiers; a hand-written value outside them is kept in the list. */
const overflowPriorityPresets = ["10", "30", "50", "70", "90", "100"] as const;
const overflowExtensionWidthPresets = ["16", "20", "24", "28", "32", "40"] as const;

/** The default retention tier of a status that has no `priorities` entry. */
export const DEFAULT_STATUS_PRIORITY = 50;

function isFeatureState(value: string): value is FeatureState {
	return value === "enabled" || value === "disabled";
}

function featureValue(enabled: boolean): FeatureState {
	return enabled ? "enabled" : "disabled";
}

function overflowWidthValues(current: number): string[] {
	const value = String(current);
	return (overflowExtensionWidthPresets as readonly string[]).includes(value)
		? [...overflowExtensionWidthPresets]
		: [value, ...overflowExtensionWidthPresets];
}

function overflowPriorityValues(current: number): string[] {
	const value = String(current);
	return (overflowPriorityPresets as readonly string[]).includes(value)
		? [...overflowPriorityPresets]
		: [value, ...overflowPriorityPresets];
}

function statusConfigKey(key: string): string {
	return `${EXTENSION_STATUS_PREFIX}${key}`;
}

/** The overflow rows of the layout tab, in the order they appear. */
export function overflowLayoutItems(config: PolishedTuiConfig): SettingItem[] {
	return [
		{
			id: "overflowEnabled",
			label: "Overflow handling",
			description:
				"Cap long pills and summarise the ones that do not fit as +N. Off restores the old single cut; /starline statuses still reads everything.",
			currentValue: featureValue(config.pill.overflow.enabled),
			values: featureStateValues,
		},
		{
			id: "overflowExtensionWidth",
			label: "Status width cap",
			description: `Content columns for third-party statuses, icon included (default ${DEFAULT_OVERFLOW_EXTENSION_MAX_CONTENT_WIDTH}).`,
			currentValue: String(config.pill.overflow.extensionMaxContentWidth),
			values: overflowWidthValues(config.pill.overflow.extensionMaxContentWidth),
		},
		{
			id: "statusesPanel",
			label: "All statuses...",
			description: "Open the full, untruncated text of every status this session published.",
			currentValue: "open",
			values: ["open"],
		},
	];
}

/** The retention rows each published third-party status gains. */
export function overflowStatusItems(args: {
	config: PolishedTuiConfig;
	key: string;
	/** Upstream's `thirdPartyStatus:` prefix, so the ids are upstream's ids. */
	statusSettingPrefix: string;
}): SettingItem[] {
	const { config, key, statusSettingPrefix } = args;
	const idFor = (name: string, kind: "priority" | "pinned") =>
		`${statusSettingPrefix}${kind}:${name}`;
	const configKey = statusConfigKey(key);
	const priority = config.pill.overflow.priorities[configKey] ?? DEFAULT_STATUS_PRIORITY;
	return [
		{
			id: idFor(key, "priority"),
			label: `${key} priority`,
			description: "Retention tier: higher stays on the bar when space runs out.",
			currentValue: String(priority),
			values: overflowPriorityValues(priority),
		},
		{
			id: idFor(key, "pinned"),
			label: `${key} pinned`,
			description: "Keep this status ahead of unpinned statuses of the same priority.",
			currentValue: featureValue(config.pill.overflow.pinned.includes(configKey)),
			values: featureStateValues,
		},
	];
}

export type OverflowSettingDeps = {
	/** Writes the patch and refreshes the config the screen reads. */
	setPillOverflow?: (patch: Partial<PillOverflowConfig>) => void;
	getConfig: () => PolishedTuiConfig;
	requestRender: () => void;
	/** Defers work until after the settings screen has closed. */
	sessionLifecycle: { defer: (task: () => void) => void };
};

export type OverflowSettingContext = {
	id: string;
	newValue: string;
	deps: OverflowSettingDeps;
	/** Upstream's `thirdPartyStatus:` prefix, so its ids are recognised here. */
	statusSettingPrefix: string;
	updateValue: (value: string) => void;
	requestRender: () => void;
	ctx: ExtensionContext;
	closeSettings: () => void;
};

/**
 * Apply a change to one of the overflow rows. Returns false when the id is not
 * ours, so the caller can continue with the rest of the screen.
 */
export function applyOverflowSetting(context: OverflowSettingContext): boolean {
	const {
		id,
		newValue,
		deps,
		statusSettingPrefix,
		ctx,
		updateValue,
		requestRender,
		closeSettings,
	} = context;
	const notify = (message: string, level: "info" | "error") => ctx.ui.notify(message, level);
	const applied = (message: string, value: string) => {
		updateValue(value);
		deps.requestRender();
		notify(message, "info");
		requestRender();
	};

	if (id === "overflowEnabled") {
		if (!isFeatureState(newValue)) return false;
		deps.setPillOverflow?.({ enabled: newValue === "enabled" });
		applied(`Overflow handling: ${newValue}`, newValue);
		return true;
	}

	if (id === "overflowExtensionWidth") {
		const width = Number(newValue);
		if (Number.isInteger(width) && width > 0) {
			deps.setPillOverflow?.({ extensionMaxContentWidth: width });
			applied(`Status width cap: ${width}`, String(width));
		}
		return true;
	}

	// A settings list cannot open a second custom component while it owns the
	// screen: close it first, then mount the panel.
	if (id === "statusesPanel") {
		closeSettings();
		deps.sessionLifecycle.defer(() => openStatusPanel(ctx));
		return true;
	}

	if (!id.startsWith(statusSettingPrefix)) return false;
	const rest = id.slice(statusSettingPrefix.length);
	const separatorIndex = rest.indexOf(":");
	const kind = separatorIndex < 0 ? "" : rest.slice(0, separatorIndex);
	const statusKey = separatorIndex < 0 ? "" : rest.slice(separatorIndex + 1);

	if (kind === "priority") {
		const priority = Number(newValue);
		if (!Number.isInteger(priority)) return false;
		deps.setPillOverflow?.({ priorities: { [statusConfigKey(statusKey)]: priority } });
		applied(`Third-party status ${statusKey} priority: ${priority}`, String(priority));
		return true;
	}

	if (kind === "pinned") {
		if (!isFeatureState(newValue)) return false;
		const configKey = statusConfigKey(statusKey);
		const pinned = deps.getConfig().pill.overflow.pinned;
		deps.setPillOverflow?.({
			pinned:
				newValue === "enabled"
					? [...new Set([...pinned, configKey])]
					: pinned.filter((entry) => entry !== configKey),
		});
		applied(`Third-party status ${statusKey}: ${newValue}`, newValue);
		return true;
	}

	return false;
}

/**
 * `/starline statuses` (and `/starline status list`): the panel's keyboard
 * entrance, which exists even when the bar hides nothing because the panel is
 * also how the full text is read. Returns true when the argument was ours.
 */
export function handleStatusPanelCommand(args: string, ctx: ExtensionContext): boolean {
	const command = args.trim().toLowerCase().replaceAll(/[_-]+/g, " ").trim();
	if (command !== "statuses" && command !== "status list") return false;
	openStatusPanel(ctx);
	return true;
}
