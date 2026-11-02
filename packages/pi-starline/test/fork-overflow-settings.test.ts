import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import type { PillOverflowConfig } from "../extensions/starline/fork-overflow-config";
import {
	clearStatusPanelModel,
	configureStatusView,
} from "../extensions/starline/fork-status-view";
import { registerStarlineSettingsCommand } from "../extensions/starline/settings-command";

type Component = {
	render(width: number): string[];
	handleInput(data: string): void;
};

function setup(
	options: {
		statuses?: Map<string, string>;
		config?: PolishedTuiConfig;
		requestRender?: () => void;
	} = {},
) {
	let config = options.config ?? defaultConfig;
	const requestRenderSpy = vi.fn(options.requestRender);
	const patches: Partial<PillOverflowConfig>[] = [];
	const custom: { factory: (...args: unknown[]) => unknown; options?: Record<string, unknown> }[] =
		[];
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;

	registerStarlineSettingsCommand(
		{
			registerCommand(_name: string, next: unknown) {
				command = next as typeof command;
			},
		} as never,
		{
			sessionLifecycle: {
				defer: (fn: () => void) => fn(),
				shutdown: () => {},
				isCurrent: () => true,
			} as never,
			getConfig: () => config,
			setColorSources() {},
			setUiFeatures: () => ({ applied: true }),
			setIconMode() {},
			setContextStyle() {},
			setPathDisplay() {},
			setPillSegments() {},
			setPillOverflow(patch) {
				patches.push(patch);
				config = mergeConfig({
					pill: { overflow: patch as Record<string, unknown> },
				});
			},
			setGitBranch() {},
			getActiveExtensionStatuses: () => options.statuses ?? new Map<string, string>(),
			setExtensionStatusPlacement() {},
			setExtensionStatusColorMode() {},
			setMouseConfig() {},
			requestRender: requestRenderSpy,
			settingsListTheme: {
				label: (text) => text,
				value: (text) => text,
				description: (text) => text,
				cursor: "> ",
				hint: (text) => text,
			},
		},
	);

	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			notify: vi.fn(),
			custom: vi.fn((factory: (...args: unknown[]) => unknown, overlayOptions: unknown) => {
				custom.push({ factory, options: overlayOptions as Record<string, unknown> });
				return Promise.resolve(undefined);
			}),
		},
	};

	const openSettings = async () => {
		await command?.handler("", ctx);
		const mount = custom.at(-1);
		if (!mount) throw new Error("settings UI was not mounted");
		return mount.factory({ requestRender() {} }, ctx.ui.theme, {}, () => {}) as Component;
	};

	return {
		ctx,
		custom,
		patches,
		requestRender: requestRenderSpy,
		openSettings,
		run: (args: string) => command?.handler(args, ctx),
	};
}

/** Layout is the third tab: coloring → features → layout. */
function goToLayout(component: Component): string[] {
	component.handleInput("\t");
	component.handleInput("\t");
	return component.render(120);
}

function rows(lines: string[]): string {
	return lines.join("\n");
}

describe("the overflow rows in /starline", () => {
	it("lists the switch, the width cap and the panel entry on Layout", async () => {
		const { openSettings } = setup();
		const component = await openSettings();
		const text = rows(goToLayout(component));
		expect(text).toContain("Layout");
		expect(text).toContain("Overflow handling");
		expect(text).toContain("Status width cap");
		expect(text).toContain("All statuses");
	});

	it("saves the switch and asks for an immediate redraw", async () => {
		const { openSettings, patches, requestRender } = setup();
		const component = await openSettings();
		component.render(120);
		// Layout rows start with the cursor on context style; five steps reach the switch.
		component.handleInput("\t");
		component.handleInput("\t");
		for (let index = 0; index < 5; index += 1) component.handleInput("\u001b[B");
		component.handleInput(" ");
		expect(patches.at(-1)).toEqual({ enabled: false });
		expect(requestRender).toHaveBeenCalled();
	});

	it("keeps the Layout rows inside the width", async () => {
		const { openSettings } = setup();
		const component = await openSettings();
		const lines = goToLayout(component);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("offers priority and pinning for each published status", async () => {
		const { openSettings } = setup({ statuses: new Map([["mcp", "MCP 1/2"]]) });
		const component = await openSettings();
		component.render(120);
		// coloring → features → layout → pills → extension segments
		for (let index = 0; index < 4; index += 1) component.handleInput("\t");
		const text = rows(component.render(120));
		expect(text).toContain("mcp priority");
		expect(text).toContain("mcp pinned");
	});
});

describe("/starline statuses", () => {
	it("opens the panel instead of the usage warning", async () => {
		// No footer in this harness, so the panel reads the live statuses through
		// the fallback source, exactly as it does with `statusLine` switched off.
		clearStatusPanelModel();
		configureStatusView({
			getConfig: () => defaultConfig,
			getStatuses: () => new Map([["mcp", "MCP 1/2"]]),
		});
		const { ctx, custom, run } = setup({ statuses: new Map([["mcp", "MCP 1/2"]]) });
		await run("statuses");
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(custom).toHaveLength(1);
		const mount = custom[0]!;
		expect(mount.options?.overlay).toBe(true);
		const component = mount.factory(
			{ requestRender() {} },
			ctx.ui.theme,
			{},
			() => {},
		) as Component;
		const text = rows(component.render(60));
		expect(text).toContain("状态");
		expect(text).toContain("mcp");
		expect(text).toContain("MCP 1/2");
		configureStatusView(undefined);
	});

	it("still warns for an unknown word", async () => {
		const { ctx, custom, run } = setup();
		await run("nonsense");
		expect(ctx.ui.notify).toHaveBeenCalled();
		expect(custom).toHaveLength(0);
	});
});
