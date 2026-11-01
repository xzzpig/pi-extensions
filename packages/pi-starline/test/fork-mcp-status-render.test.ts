import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import { installFooter } from "../extensions/starline/footer";
import { createMcpPillAdapter, MCP_STATUS_KEY } from "../extensions/starline/fork-mcp-pill";
import { emptyGitStatus } from "../extensions/starline/git";
import { PILL_ACTIONS } from "../extensions/starline/pill-actions";
import { registerExternalPillAction } from "../extensions/starline/pill-api";
import { closePillBubble } from "../extensions/starline/pill-bubble";
import { createInitialState } from "../extensions/starline/state";
import type { ThemeLike } from "../extensions/starline/style";

/** Colours are irrelevant here, so this theme renders everything as plain text. */
const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const plain = (text: string) => stripVTControlCharacters(text);

afterEach(() => {
	closePillBubble();
});

type FooterFactory = (...args: unknown[]) => {
	render(width: number): string[];
	handleMouse?: (event: Record<string, unknown>) => { handled?: boolean } | undefined;
	dispose?: () => void;
};

const WIDTH = 80;

function makeFooter(options: {
	statuses: ReadonlyMap<string, string>;
	extensionStatuses?: Record<string, unknown>;
	segments?: string[];
}) {
	let factory: FooterFactory | undefined;
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp/project",
		model: { id: "kimi", provider: "deepseek", contextWindow: 200_000 },
		sessionManager: { getSessionName: () => undefined },
		getContextUsage: () => undefined,
		hasPendingMessages: () => false,
		ui: {
			theme,
			setFooter(next: FooterFactory | undefined) {
				factory = next;
			},
			custom: vi.fn(),
			notify,
		},
	};

	const state = createInitialState(emptyGitStatus());
	state.modelLabel = "kimi";
	const config = mergeConfig({
		footerStyle: "pill",
		pill: { segments: options.segments ?? ["cwd", "extensionStatus"] },
		colorSources: { starship: "theme" },
		extensionStatuses: options.extensionStatuses as never,
	});

	installFooter(ctx as never, state, () => config, {
		setRequestRender() {},
		scheduleProjectRefresh() {},
	});

	const footer = factory?.({ requestRender() {} }, theme, {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => options.statuses,
	});
	if (!footer) throw new Error("footer factory was not registered");
	return { footer, ctx, notify };
}

function columnOf(line: string, needle: string): number {
	const index = plain(line).indexOf(needle);
	if (index < 0) throw new Error(`"${needle}" is not on the footer line`);
	return index;
}

function fakePi(commands = [{ name: "mcp-adapter", source: "extension" }]) {
	return {
		getCommands: () => commands,
		sendUserMessage: vi.fn(),
	};
}

describe("the mcp status as a pill", () => {
	it("shows the adapter's compact text verbatim", () => {
		const { footer } = makeFooter({
			statuses: new Map([[MCP_STATUS_KEY, "MCP 0/1"]]),
		});

		const line = plain(footer.render(WIDTH)[0] ?? "");
		// The `value` format would leave a bare `0/1`; the default keeps the label.
		expect(line).toContain(" MCP 0/1 ");
	});

	it("keeps a special status message instead of replacing it with a count", () => {
		const message = "MCP: connecting to docs... (1 blocked by project trust)";
		const { footer } = makeFooter({ statuses: new Map([[MCP_STATUS_KEY, message]]) });

		// Wider than the terminal: truncation is the footer's, not a rewrite.
		const line = plain(footer.render(200)[0] ?? "");
		expect(line).toContain("MCP: connecting to docs...");
	});

	it("renders nothing for mcp when the status is placed off or absent", () => {
		const off = makeFooter({
			statuses: new Map([[MCP_STATUS_KEY, "MCP 0/1"]]),
			extensionStatuses: { placements: { mcp: "off" } },
		});
		expect(plain(off.footer.render(WIDTH)[0] ?? "")).not.toContain("MCP");

		const absent = makeFooter({ statuses: new Map() });
		const line = plain(absent.footer.render(WIDTH)[0] ?? "");
		expect(line).not.toContain("MCP");

		// With no pill drawn there is no cell to click, even with an action registered.
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		adapter.start(off.ctx as never);
		expect(off.footer.handleMouse?.({ type: "press", x: 0, y: 0, width: WIDTH })).toBeUndefined();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		adapter.stop();
	});

	it("keeps the other pills' cells where they were", () => {
		const withMcp = makeFooter({ statuses: new Map([[MCP_STATUS_KEY, "MCP 0/1"]]) });
		const without = makeFooter({ statuses: new Map() });

		const withLine = plain(withMcp.footer.render(WIDTH)[0] ?? "");
		const withoutLine = plain(without.footer.render(WIDTH)[0] ?? "");
		expect(columnOf(withLine, "project")).toBe(columnOf(withoutLine, "project"));
	});

	it("does not add mcp to the builtin action table", () => {
		expect(MCP_STATUS_KEY in PILL_ACTIONS).toBe(false);
	});
});

describe("clicking the mcp pill", () => {
	it("dispatches the adapter command exactly once for press plus synthesized click", () => {
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		const { footer, ctx } = makeFooter({ statuses: new Map([[MCP_STATUS_KEY, "MCP 0/1"]]) });
		adapter.start(ctx as never);

		const line = footer.render(WIDTH)[0] ?? "";
		const x = columnOf(line, "MCP 0/1");

		expect(footer.handleMouse?.({ type: "press", x, y: 0, width: WIDTH })).toEqual({
			handled: true,
		});
		expect(footer.handleMouse?.({ type: "click", x, y: 0, width: WIDTH })).toEqual({
			handled: true,
		});

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("/mcp-adapter", {
			expandPromptTemplates: true,
		});
		adapter.stop();
	});

	it("stays inert when another extension already owns the mcp action", () => {
		const pi = fakePi();
		const existing = vi.fn();
		const dispose = registerExternalPillAction(MCP_STATUS_KEY, existing);
		const adapter = createMcpPillAdapter(pi as never);
		const { footer, ctx } = makeFooter({ statuses: new Map([[MCP_STATUS_KEY, "MCP 0/1"]]) });
		adapter.start(ctx as never);

		const line = footer.render(WIDTH)[0] ?? "";
		footer.handleMouse?.({ type: "press", x: columnOf(line, "MCP 0/1"), y: 0, width: WIDTH });

		expect(existing).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		adapter.stop();
		dispose();
	});

	it("leaves the visible width of the bar unchanged", () => {
		const { footer } = makeFooter({ statuses: new Map([[MCP_STATUS_KEY, "MCP 0/1"]]) });
		const line = footer.render(WIDTH)[0] ?? "";
		expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		expect(defaultConfig.pill.segments.length).toBeGreaterThan(0);
	});
});
