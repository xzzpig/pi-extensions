import { Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import starline from "../extensions/starline/index";
import { STARLINE_PROTOTYPE_PATCH_REGISTRY } from "../extensions/starline/prototype-patch-registry";
import { installUserMessageStyle } from "../extensions/starline/user-message";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
const originalUserMessageRender = UserMessageComponent.prototype.render;
const originalUserMessageInvalidate = UserMessageComponent.prototype.invalidate;

function baseTheme(): Theme {
	const foregrounds = { text: "", muted: "", thinkingXhigh: "" } as ConstructorParameters<
		typeof Theme
	>[0];
	const backgrounds = { selectedBg: "" } as ConstructorParameters<typeof Theme>[1];
	return new Theme(foregrounds, backgrounds, "truecolor");
}

function makeTheme(): Theme {
	return Object.assign(baseTheme(), {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
		italic(text: string) {
			return text;
		},
		underline(text: string) {
			return text;
		},
		strikethrough(text: string) {
			return text;
		},
		getThinkingBorderColor() {
			return (text: string) => text;
		},
	});
}

function makeTaggedTheme(prefix = ""): Theme {
	return Object.assign(baseTheme(), {
		fg(color: string, text: string) {
			return `[${prefix}${color}]${text}`;
		},
		bold(text: string) {
			return `[${prefix}bold]${text}`;
		},
		italic(text: string) {
			return text;
		},
		underline(text: string) {
			return text;
		},
		strikethrough(text: string) {
			return text;
		},
		getThinkingBorderColor(level: string) {
			return (text: string) => `[${prefix}thinking:${level}]${text}`;
		},
	});
}

function makeUi(prefix = "") {
	let editorComponent: unknown;
	return {
		theme: makeTaggedTheme(prefix),
		setFooter() {},
		setEditorComponent(factory: unknown) {
			editorComponent = factory;
		},
		getEditorComponent() {
			return editorComponent;
		},
	};
}

function configWithColorSources(
	colorSources: Partial<PolishedTuiConfig["colorSources"]>,
): PolishedTuiConfig {
	return {
		...defaultConfig,
		colorSources: {
			...defaultConfig.colorSources,
			...colorSources,
		},
	};
}

function configWithFeatures(features: Partial<PolishedTuiConfig["features"]>): PolishedTuiConfig {
	return {
		...defaultConfig,
		features: {
			...defaultConfig.features,
			...features,
		},
	};
}

function stripPromptMarks(line: string): string {
	return line.replaceAll(/\x1b]133;[ABC]\x07/g, "").replaceAll(/\x1b\[[0-9;]*m/g, "");
}

function stripTestTags(line: string): string {
	return (
		stripPromptMarks(line)
			.replaceAll(/\[[^\]]+\]/g, "")
			// Pi's zero-width APC markers (the cursor: `pi:c` before 1.4, the
			// `pi:fc` … `pi:/fc` pair around the cursor cell from 1.4 on).
			.replaceAll(/\x1b_[^\x07]*\x07/g, "")
	);
}

function loadExtension(options: { thinkingLevel?: string; commands?: Map<string, unknown> } = {}) {
	const handlers = new Map<string, Handler[]>();
	starline({
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerCommand(name: string, command: unknown) {
			options.commands?.set(name, command);
		},
		getThinkingLevel() {
			return options.thinkingLevel ?? "off";
		},
	} as never);
	return handlers;
}

async function emit(handlers: Map<string, Handler[]>, eventName: string, ctx: unknown) {
	for (const handler of handlers.get(eventName) ?? []) {
		await handler({}, ctx);
	}
}

function makeContext(overrides: Record<string, unknown> = {}) {
	const theme = makeTheme();
	let editorComponent: unknown;
	const ui = {
		theme,
		setFooter() {},
		setEditorComponent(factory: unknown) {
			editorComponent = factory;
		},
		getEditorComponent() {
			return editorComponent;
		},
	};
	const overrideUi = overrides.ui && typeof overrides.ui === "object" ? overrides.ui : undefined;
	return {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		model: { id: "claude-sonnet", provider: "anthropic", contextWindow: 200_000 },
		sessionManager: { getBranch: () => [], getSessionName: () => undefined },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: overrideUi ? { ...ui, ...overrideUi } : ui,
		...overrides,
		...(overrideUi ? { ui: { ...ui, ...overrideUi } } : {}),
	};
}

afterEach(() => {
	UserMessageComponent.prototype.render = originalUserMessageRender;
	UserMessageComponent.prototype.invalidate = originalUserMessageInvalidate;
	Reflect.deleteProperty(UserMessageComponent.prototype, STARLINE_PROTOTYPE_PATCH_REGISTRY);
	Reflect.deleteProperty(
		UserMessageComponent.prototype,
		Symbol.for("pi-zentui.prototype-patch-registry"),
	);
});

describe("fork user-message renderer", () => {
	it("renders user messages like the Starline prompt box", () => {
		installUserMessageStyle(
			() => makeTaggedTheme(),
			() => defaultConfig,
		);

		const lines = new UserMessageComponent("hello **starline**").render(80).map(stripPromptMarks);
		const rendered = lines.join("\n");

		expect(stripTestTags(lines[0])).toMatch(/^─+$/);
		expect(stripTestTags(lines.at(-1) ?? "")).toMatch(/^─+$/);
		const raw = new UserMessageComponent("hello").render(80).join("\n");
		expect(raw).toMatch(/\[accent\]│|\u001b\[34m│\u001b\[0m/);
		expect(raw).toMatch(/\[borderMuted\]────|\u001b\[90m────/);
		expect(rendered).toContain("[userMessageText]");
		expect(rendered).toContain("[bold]");
		expect(rendered).not.toContain("**starline**");
		expect(rendered).not.toContain("claude-sonnet");
		expect(rendered).not.toContain("Anthropic");
		expect(rendered).not.toContain("xhigh");
	});

	it("passes user messages through registered markdown transformers", () => {
		installUserMessageStyle(
			() => makeTaggedTheme(),
			() => defaultConfig,
		);

		// pi-ide-context 这类扩展靠 registerMarkdownTransformer 往 user message 里挂内容;
		// starline 重写了 render,必须把这条官方管道接回去,否则 transformer 被旁路
		const transformer = (markdown: string, context: { messageType: string }) =>
			context.messageType === "user" ? `${markdown}\n\n> ↳ a.ts:1-1 · selected` : markdown;
		const rendered = new UserMessageComponent("我看看?", undefined, 1, [transformer])
			.render(80)
			.map(stripPromptMarks)
			.join("\n");

		expect(rendered).toContain("我看看?");
		expect(rendered).toContain("↳ a.ts:1-1 · selected");
	});

	it("hides previous user-message rails in copy-friendly mode", () => {
		installUserMessageStyle(
			() => makeTaggedTheme(),
			() => configWithFeatures({ copyFriendly: true }),
		);

		const lines = new UserMessageComponent("hello").render(80).map(stripPromptMarks);
		const rendered = lines.join("\n");

		expect(rendered).not.toContain("│");
		expect(rendered).not.toContain("❯");
		expect(rendered).toContain("hello");
		expect(stripTestTags(lines[0])).toMatch(/^─+$/);
		expect(stripTestTags(lines.at(-1) ?? "")).toMatch(/^─+$/);
	});

	it("renders the configured rail glyph on user messages", () => {
		const config: PolishedTuiConfig = {
			...defaultConfig,
			icons: { ...defaultConfig.icons, rail: "┃" },
		};
		installUserMessageStyle(
			() => makeTaggedTheme(),
			() => config,
		);

		const raw = new UserMessageComponent("hello").render(80).join("\n");

		expect(raw).toContain("[accent]┃");
		expect(raw).not.toContain("│");
	});

	it("caches rendered user messages across repeated renders", () => {
		const getChildren = vi.fn(() => [{ text: "hello ".repeat(2000) }]);
		const fg = vi.fn((color: string, text: string) => `[${color}]${text}`);
		const theme = Object.assign(makeTaggedTheme(), { fg });
		installUserMessageStyle(
			() => theme,
			() => defaultConfig,
		);
		const instance = {
			get children() {
				return getChildren();
			},
		};
		const renderMessage = (width: number) =>
			UserMessageComponent.prototype.render.call(instance, width);

		const firstRender = renderMessage(80);
		const fgCallsAfterFirstRender = fg.mock.calls.length;
		const secondRender = renderMessage(80);

		expect(secondRender).toEqual(firstRender);
		expect(getChildren).toHaveBeenCalledTimes(1);
		expect(fg).toHaveBeenCalledTimes(fgCallsAfterFirstRender);

		renderMessage(79);
		expect(getChildren).toHaveBeenCalledTimes(1);
		expect(fg.mock.calls.length).toBeGreaterThan(fgCallsAfterFirstRender);
	});

	it("clears cached user-message rendering on invalidate", () => {
		let colorPrefix = "first";
		const theme = Object.assign(makeTaggedTheme(), {
			fg(color: string, text: string) {
				return `[${colorPrefix}:${color}]${text}`;
			},
		});
		const originalInvalidate = UserMessageComponent.prototype.invalidate;
		const invalidate = vi.fn(function invalidate(this: UserMessageComponent) {
			return originalInvalidate.call(this);
		});
		UserMessageComponent.prototype.invalidate = invalidate;
		installUserMessageStyle(
			() => theme,
			() => defaultConfig,
		);
		const message = new UserMessageComponent("hello");

		const firstRender = message.render(80).join("\n");
		colorPrefix = "second";
		const cachedRender = message.render(80).join("\n");
		message.invalidate();
		const invalidatedRender = message.render(80).join("\n");

		expect(cachedRender).toBe(firstRender);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidatedRender).toContain("[second:userMessageText]hello");
		expect(invalidatedRender).not.toContain("[first:userMessageText]hello");
	});

	it("renders user-message borders from the user-message color source", () => {
		installUserMessageStyle(
			() => makeTaggedTheme(),
			() => configWithColorSources({ userMessages: "theme" }),
		);
		const themeRendered = new UserMessageComponent("hello").render(80).join("\n");
		expect(themeRendered).toContain("[borderMuted]────");

		installUserMessageStyle(
			() => makeTaggedTheme(),
			() => configWithColorSources({ userMessages: "terminal" }),
		);
		const terminalRendered = new UserMessageComponent("hello").render(80).join("\n");
		expect(terminalRendered).toContain("\u001b[90m────");
	});

	it("user-message cleanup restores exact render and invalidate predecessors", () => {
		const predecessorRender = UserMessageComponent.prototype.render;
		const predecessorInvalidate = UserMessageComponent.prototype.invalidate;
		const cleanup = installUserMessageStyle(
			() => makeTaggedTheme(),
			() => defaultConfig,
		);

		expect(UserMessageComponent.prototype.render).not.toBe(predecessorRender);
		expect(UserMessageComponent.prototype.invalidate).not.toBe(predecessorInvalidate);
		expect(new UserMessageComponent("hello").render(80).join("\n")).toContain("[borderMuted]────");
		cleanup();
		cleanup();

		expect(UserMessageComponent.prototype.render).toBe(predecessorRender);
		expect(UserMessageComponent.prototype.invalidate).toBe(predecessorInvalidate);
	});

	it("falls back to the predecessor user-message render when text cannot be found", () => {
		const predecessor = (width: number) => [`fallback:${width}`];
		UserMessageComponent.prototype.render = predecessor;
		const cleanup = installUserMessageStyle(
			() => makeTaggedTheme(),
			() => defaultConfig,
		);

		const lines = UserMessageComponent.prototype.render.call({ children: [] }, 42);

		expect(lines).toEqual(["fallback:42"]);
		cleanup();
		expect(UserMessageComponent.prototype.render).toBe(predecessor);
	});

	it("preserves OSC 133 prompt-zone markers around user-message output", async () => {
		const handlers = loadExtension();
		await emit(handlers, "session_start", makeContext({ ui: makeUi() }));

		const lines = new UserMessageComponent("hello").render(40);

		expect(lines[0].startsWith("\x1b]133;A\x07")).toBe(true);
		expect(lines.at(-1)).toContain("\x1b]133;B\x07\x1b]133;C\x07");
	});

	it("keeps user-message output within the requested render width", async () => {
		const handlers = loadExtension();
		await emit(handlers, "session_start", makeContext());

		const lines = new UserMessageComponent("hello ".repeat(20)).render(12).map(stripPromptMarks);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
	});

	it("reuses user-message wrappers while stale cleanup leaves the new registration active", () => {
		const predecessorRender = UserMessageComponent.prototype.render;
		const predecessorInvalidate = UserMessageComponent.prototype.invalidate;
		const firstCleanup = installUserMessageStyle(
			() => makeTaggedTheme("first:"),
			() => defaultConfig,
		);
		const renderWrapper = UserMessageComponent.prototype.render;
		const invalidateWrapper = UserMessageComponent.prototype.invalidate;
		const firstRender = new UserMessageComponent("hello").render(80).join("\n");
		expect(firstRender).toMatch(/\[first:accent\]│|\u001b\[34m│\u001b\[0m/);

		const secondCleanup = installUserMessageStyle(
			() => makeTaggedTheme("second:"),
			() => defaultConfig,
		);
		expect(UserMessageComponent.prototype.render).toBe(renderWrapper);
		expect(UserMessageComponent.prototype.invalidate).toBe(invalidateWrapper);
		firstCleanup();
		const secondRender = new UserMessageComponent("hello").render(80).join("\n");
		expect(secondRender).not.toContain("[first:accent]│");
		expect(secondRender).toMatch(/\[second:accent\]│|\u001b\[34m│\u001b\[0m/);

		secondCleanup();
		expect(UserMessageComponent.prototype.render).toBe(predecessorRender);
		expect(UserMessageComponent.prototype.invalidate).toBe(predecessorInvalidate);
	});

	it("deactivates an older user-message record hidden inside a third-party predecessor chain", () => {
		const prototype = UserMessageComponent.prototype;
		const predecessorRender = (width: number) => [`base:${width}`];
		const predecessorInvalidate = vi.fn();
		prototype.render = predecessorRender;
		prototype.invalidate = predecessorInvalidate;
		const firstTheme = vi.fn(() => makeTaggedTheme("first:"));
		const secondTheme = vi.fn(() => makeTaggedTheme("second:"));
		const cleanupFirst = installUserMessageStyle(firstTheme, () => defaultConfig);
		const firstWrapper = prototype.render;
		const thirdParty = function thirdParty(this: unknown, width: number): string[] {
			return ["third-party", ...firstWrapper.call(this as never, width)];
		};
		prototype.render = thirdParty;
		const cleanupSecond = installUserMessageStyle(secondTheme, () => defaultConfig);

		cleanupFirst();
		cleanupSecond();
		firstTheme.mockClear();
		secondTheme.mockClear();

		expect(prototype.render).toBe(thirdParty);
		expect(prototype.invalidate).toBe(predecessorInvalidate);
		expect(prototype.render.call({ children: [{ text: "hello" }] } as never, 12)).toEqual([
			"third-party",
			"base:12",
		]);
		expect(firstTheme).not.toHaveBeenCalled();
		expect(secondTheme).not.toHaveBeenCalled();
	});

	it("keeps a later user-message replacement and releases old theme closures", () => {
		const prototype = UserMessageComponent.prototype;
		const predecessorRender = (width: number) => [`base:${width}`];
		const predecessorInvalidate = vi.fn();
		prototype.render = predecessorRender;
		prototype.invalidate = predecessorInvalidate;
		const getTheme = vi.fn(() => makeTaggedTheme("old:"));
		const cleanup = installUserMessageStyle(getTheme, () => defaultConfig);
		const starlineWrapper = prototype.render;
		const thirdParty = function thirdParty(this: unknown, width: number): string[] {
			return ["third-party", ...starlineWrapper.call(this as never, width)];
		};
		prototype.render = thirdParty;

		cleanup();
		getTheme.mockClear();

		expect(prototype.render).toBe(thirdParty);
		expect(prototype.invalidate).toBe(predecessorInvalidate);
		expect(prototype.render.call({ children: [{ text: "hello" }] } as never, 12)).toEqual([
			"third-party",
			"base:12",
		]);
		expect(getTheme).not.toHaveBeenCalled();
	});
});
