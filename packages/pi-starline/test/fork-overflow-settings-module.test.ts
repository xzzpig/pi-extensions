import { describe, expect, it, vi } from "vitest";
import { mergeConfig } from "../extensions/starline/config";
import {
	applyOverflowSetting,
	DEFAULT_STATUS_PRIORITY,
	handleStatusPanelCommand,
	type OverflowSettingDeps,
	overflowLayoutItems,
	overflowStatusItems,
} from "../extensions/starline/fork-overflow-settings";
import { EXTENSION_STATUS_PREFIX } from "../extensions/starline/pill-config";

const prefix = "thirdPartyStatus:";

function deps(overrides: Partial<OverflowSettingDeps> = {}) {
	const patches: Record<string, unknown>[] = [];
	let config = mergeConfig({});
	const handle: OverflowSettingDeps = {
		getConfig: () => config,
		requestRender: vi.fn(),
		sessionLifecycle: { defer: (task: () => void) => task() },
		setPillOverflow: (patch) => {
			patches.push(patch as Record<string, unknown>);
			config = mergeConfig({ pill: { overflow: patch as never } });
		},
		...overrides,
	};
	return { handle, patches, config: () => config };
}

function screen() {
	const updateValue = vi.fn();
	const requestRender = vi.fn();
	const notify = vi.fn();
	const closeSettings = vi.fn();
	return {
		updateValue,
		requestRender,
		notify,
		closeSettings,
		ctx: { ui: { notify } } as never,
	};
}

describe("the overflow settings rows", () => {
	it("describes the live configuration", () => {
		const config = mergeConfig({
			pill: { overflow: { enabled: false, extensionMaxContentWidth: 20 } },
		});
		const items = overflowLayoutItems(config);
		expect(items.map((item) => item.id)).toEqual([
			"overflowEnabled",
			"overflowExtensionWidth",
			"statusesPanel",
		]);
		expect(items[0]?.currentValue).toBe("disabled");
		expect(items[1]?.currentValue).toBe("20");
		// A hand-written width outside the presets stays selectable.
		expect(items[1]?.values).toContain("20");
	});

	it("keeps a non-preset width in front of the presets", () => {
		const config = mergeConfig({ pill: { overflow: { extensionMaxContentWidth: 21 } } });
		expect(overflowLayoutItems(config)[1]?.values?.at(0)).toBe("21");
	});

	it("adds the retention rows with the default tier and pin state", () => {
		const config = mergeConfig({});
		const items = overflowStatusItems({ config, key: "mcp", statusSettingPrefix: prefix });
		expect(items.map((item) => item.id)).toEqual([`${prefix}priority:mcp`, `${prefix}pinned:mcp`]);
		expect(items[0]?.currentValue).toBe(String(DEFAULT_STATUS_PRIORITY));
		expect(items[1]?.currentValue).toBe("disabled");
	});

	it("reads a configured tier and pin back into the rows", () => {
		const config = mergeConfig({
			pill: {
				overflow: {
					priorities: { [`${EXTENSION_STATUS_PREFIX}mcp`]: 90 },
					pinned: [`${EXTENSION_STATUS_PREFIX}mcp`],
				},
			},
		});
		const items = overflowStatusItems({ config, key: "mcp", statusSettingPrefix: prefix });
		expect(items[0]?.currentValue).toBe("90");
		expect(items[1]?.currentValue).toBe("enabled");
	});
});

describe("applying an overflow setting", () => {
	const apply = (
		id: string,
		newValue: string,
		handle: OverflowSettingDeps,
		captured = screen(),
	) => {
		const handled = applyOverflowSetting({
			id,
			newValue,
			deps: handle,
			ctx: captured.ctx,
			statusSettingPrefix: prefix,
			updateValue: captured.updateValue,
			requestRender: captured.requestRender,
			closeSettings: captured.closeSettings,
		});
		return { handled, ...captured };
	};

	it("toggles governance and reports it", () => {
		const { handle, patches } = deps();
		const result = apply("overflowEnabled", "disabled", handle);
		expect(result.handled).toBe(true);
		expect(patches).toEqual([{ enabled: false }]);
		expect(result.updateValue).toHaveBeenCalledWith("disabled");
		expect(result.notify).toHaveBeenCalledWith("Overflow handling: disabled", "info");
	});

	it("ignores a state word it cannot apply", () => {
		const { handle, patches } = deps();
		const result = apply("overflowEnabled", "maybe", handle);
		expect(result.handled).toBe(false);
		expect(patches).toEqual([]);
	});

	it("writes a positive integer width and ignores anything else", () => {
		const { handle, patches } = deps();
		expect(apply("overflowExtensionWidth", "24", handle).handled).toBe(true);
		expect(patches).toEqual([{ extensionMaxContentWidth: 24 }]);
		for (const bad of ["0", "-4", "x", "1.5"]) {
			expect(apply("overflowExtensionWidth", bad, handle).handled).toBe(true);
		}
		expect(patches).toHaveLength(1);
	});

	it("closes the screen before mounting the panel", () => {
		const deferred: (() => void)[] = [];
		const { handle } = deps({ sessionLifecycle: { defer: (task) => deferred.push(task) } });
		const result = apply("statusesPanel", "open", handle);
		expect(result.handled).toBe(true);
		expect(result.closeSettings).toHaveBeenCalledTimes(1);
		expect(deferred).toHaveLength(1);
	});

	it("writes a retention tier", () => {
		const { handle, patches } = deps();
		const result = apply(`${prefix}priority:mcp`, "90", handle);
		expect(result.handled).toBe(true);
		expect(patches).toEqual([{ priorities: { [`${EXTENSION_STATUS_PREFIX}mcp`]: 90 } }]);
		expect(result.updateValue).toHaveBeenCalledWith("90");
	});

	it("pins and unpins without duplicating the entry", () => {
		const { handle, patches, config } = deps();
		apply(`${prefix}pinned:mcp`, "enabled", handle);
		apply(`${prefix}pinned:mcp`, "enabled", handle);
		expect(config().pill.overflow.pinned).toEqual([`${EXTENSION_STATUS_PREFIX}mcp`]);
		apply(`${prefix}pinned:mcp`, "disabled", handle);
		expect(config().pill.overflow.pinned).toEqual([]);
		expect(patches).toHaveLength(3);
	});

	it("leaves the rest of the screen's rows alone", () => {
		const { handle, patches } = deps();
		const result = apply(`${prefix}placement:mcp`, "left", handle);
		expect(result.handled).toBe(false);
		expect(patches).toEqual([]);
		expect(result.updateValue).not.toHaveBeenCalled();
		expect(apply("unrelated", "x", handle).handled).toBe(false);
	});
});

describe("the status panel command", () => {
	function panelCtx() {
		const mounted: unknown[] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: (factory: unknown) => {
					mounted.push(factory);
					return Promise.resolve(undefined);
				},
			},
		};
		return { ctx: ctx as never, mounted };
	}

	it("accepts the spellings the help text advertises", () => {
		for (const args of ["statuses", " statuses ", "STATUSES", "status list", "status_list"]) {
			const { ctx, mounted } = panelCtx();
			expect(handleStatusPanelCommand(args, ctx)).toBe(true);
			expect(mounted).toHaveLength(1);
		}
	});

	it("leaves other arguments to the rest of the command", () => {
		for (const args of ["", "editor enable", "status", "statusesx"]) {
			const { ctx, mounted } = panelCtx();
			expect(handleStatusPanelCommand(args, ctx)).toBe(false);
			expect(mounted).toHaveLength(0);
		}
	});
});
