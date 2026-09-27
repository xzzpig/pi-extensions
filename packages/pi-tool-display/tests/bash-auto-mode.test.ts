import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveBashAutoOutputMode } from "../src/bash-auto-mode.ts";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RegisteredToolLike {
	name: string;
	renderResult?: (result: unknown, options: unknown, theme: unknown) => RenderComponentLike;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

function buildConfig(overrides: Partial<ToolDisplayConfig>): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createExtensionApiStub(): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RegisteredToolLike[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): unknown[] {
			return [];
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, eventHandlers };
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function normalizeRenderedText(component: RenderComponentLike): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(
	tool: RegisteredToolLike | undefined,
	input: {
		text: string;
		details?: unknown;
		expanded?: boolean;
		isPartial?: boolean;
		isError?: boolean;
	},
): string {
	assert.ok(tool?.renderResult, `expected renderResult for tool '${tool?.name ?? "unknown"}'`);
	return normalizeRenderedText(
		tool.renderResult(
			{
				content: [{ type: "text", text: input.text }],
				details: input.details ?? {},
				isError: input.isError ?? false,
			},
			{ isPartial: input.isPartial ?? false, expanded: input.expanded ?? false },
			createTheme(),
		),
	);
}

async function registerBashTool(config: ToolDisplayConfig): Promise<RegisteredToolLike> {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();
	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bashTool, "expected the bash tool override to be registered");
	return bashTool;
}

test("resolveBashAutoOutputMode leaves non-auto configs untouched", () => {
	const config = buildConfig({ bashOutputMode: "summary" });
	assert.equal(resolveBashAutoOutputMode(config, { isPartial: true }, false), config);
	assert.equal(resolveBashAutoOutputMode(config, { isPartial: false }, true), config);
});

test("resolveBashAutoOutputMode copies instead of mutating the auto config", () => {
	const config = buildConfig({ bashOutputMode: "auto", bashLivePreviewMode: "head" });
	const resolved = resolveBashAutoOutputMode(config, { isPartial: true }, false);
	assert.equal(config.bashOutputMode, "auto");
	assert.equal(config.bashLivePreviewMode, "head");
	assert.equal(resolved.bashOutputMode, "opencode");
	assert.equal(resolved.bashLivePreviewMode, "tail");
	assert.notEqual(resolved, config);
});

test("resolveBashAutoOutputMode maps auto to opencode while running and summary when done", () => {
	const running = resolveBashAutoOutputMode(buildConfig({ bashOutputMode: "auto" }), { isPartial: true }, false);
	assert.equal(running.bashOutputMode, "opencode");

	const failed = resolveBashAutoOutputMode(buildConfig({ bashOutputMode: "auto" }), { isPartial: false }, true);
	assert.equal(failed.bashOutputMode, "opencode");

	const done = resolveBashAutoOutputMode(buildConfig({ bashOutputMode: "auto" }), { isPartial: false }, false);
	assert.equal(done.bashOutputMode, "summary");
});

test("auto mode streams a live tail preview using bashCollapsedLines even when head is configured", async () => {
	const bashTool = await registerBashTool(
		buildConfig({
			bashOutputMode: "auto",
			bashCollapsedLines: 1,
			previewLines: 4,
			bashLivePreviewMode: "head",
		}),
	);
	assert.equal(
		renderToolResult(bashTool, { text: "alpha\nbeta\ngamma\n", isPartial: true }),
		"gamma\n... (2 earlier lines • Ctrl+O to expand)",
	);
});

test("auto mode collapses to the summary line count after completion", async () => {
	const bashTool = await registerBashTool(
		buildConfig({
			bashOutputMode: "auto",
			bashCollapsedLines: 1,
		}),
	);
	assert.equal(
		renderToolResult(bashTool, { text: "alpha\nbeta\ngamma\n" }),
		"↳ 3 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(bashTool, { text: "alpha\nbeta\ngamma\n", expanded: true }),
		"alpha\nbeta\ngamma",
	);
});

test("auto mode hides the live preview when bashCollapsedLines is 0 but still summarizes completion", async () => {
	const bashTool = await registerBashTool(
		buildConfig({
			bashOutputMode: "auto",
			bashCollapsedLines: 0,
		}),
	);
	assert.equal(renderToolResult(bashTool, { text: "alpha\nbeta\ngamma\n", isPartial: true }), "");
	assert.equal(
		renderToolResult(bashTool, { text: "alpha\nbeta\ngamma\n" }),
		"↳ 3 lines returned • Ctrl+O to expand",
	);
});

test("auto mode renders failures with the opencode collapse budget", async () => {
	const bashTool = await registerBashTool(
		buildConfig({
			bashOutputMode: "auto",
			bashCollapsedLines: 1,
			previewLines: 4,
		}),
	);
	assert.equal(
		renderToolResult(bashTool, {
			text: "npm ERR! missing script: test\nSee npm help run-script\n",
			isError: true,
		}),
		"↳ command failed\nnpm ERR! missing script: test\n... (1 more line • Ctrl+O to expand)",
	);
});

test("config normalization keeps the auto bash output mode", () => {
	const normalized = normalizeToolDisplayConfig({ bashOutputMode: "auto" });
	assert.equal(normalized.bashOutputMode, "auto");
	assert.equal(normalizeToolDisplayConfig({}).bashOutputMode, "opencode");
});
