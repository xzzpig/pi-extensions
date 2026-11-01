import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../extensions/starline/config";
import {
	createMcpPillAdapter,
	hasMcpCommand,
	isTuiContext,
	MCP_COMMAND_NAME,
	MCP_REOPEN_COOLDOWN_MS,
	MCP_STATUS_KEY,
	type McpCommandInfo,
	type McpPillRuntime,
} from "../extensions/starline/fork-mcp-pill";
import { pillActionFor, runPillAction } from "../extensions/starline/pill-actions";
import { PILL_API_SYMBOL, registerExternalPillAction } from "../extensions/starline/pill-api";
import { registerStarlineSettingsCommand } from "../extensions/starline/settings-command";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	delete (globalThis as Record<PropertyKey, unknown>)[PILL_API_SYMBOL];
});

type FakePi = {
	getCommands: () => readonly McpCommandInfo[];
	sendUserMessage: ReturnType<typeof vi.fn>;
};

const EXTENSION_COMMAND: McpCommandInfo = { name: MCP_COMMAND_NAME, source: "extension" };

function fakePi(commands: readonly McpCommandInfo[] = [EXTENSION_COMMAND]): FakePi {
	return {
		getCommands: () => commands,
		sendUserMessage: vi.fn(),
	};
}

function tuiContext(overrides: Record<string, unknown> = {}) {
	const notify = vi.fn();
	const ctx = { hasUI: true, mode: "tui", ui: { notify }, ...overrides } as never;
	return { ctx, notify };
}

/** A runtime whose probes are spies, so ordering and skips are observable. */
function runtime(overrides: Partial<McpPillRuntime> = {}) {
	const calls: string[] = [];
	const base: McpPillRuntime = {
		now: () => 0,
		commands: () => [EXTENSION_COMMAND],
		send: () => calls.push("send"),
		closeBubble: () => calls.push("close"),
		bubbleOpen: () => false,
		overlayVisible: () => {
			calls.push("probe");
			return false;
		},
		notify: (_ctx, message) => calls.push(`notify:${message}`),
	};
	return { calls, runtime: { ...base, ...overrides } };
}

describe("hasMcpCommand", () => {
	it("accepts the adapter's extension command", () => {
		expect(hasMcpCommand([EXTENSION_COMMAND])).toBe(true);
	});

	it("rejects a template or skill with the same name", () => {
		expect(hasMcpCommand([{ name: MCP_COMMAND_NAME, source: "prompt" }])).toBe(false);
		expect(hasMcpCommand([{ name: MCP_COMMAND_NAME, source: "skill" }])).toBe(false);
	});

	it("rejects an unknown or nameless source", () => {
		expect(hasMcpCommand([{ name: MCP_COMMAND_NAME }])).toBe(false);
	});

	it("rejects the built-in /mcp command", () => {
		expect(hasMcpCommand([{ name: MCP_COMMAND_NAME, source: "extension" }])).toBe(true);
		expect(hasMcpCommand([{ name: "mcp", source: "extension" }])).toBe(false);
	});
});

describe("isTuiContext", () => {
	it("accepts interactive contexts only", () => {
		expect(isTuiContext({ hasUI: true, mode: "tui" } as never)).toBe(true);
		expect(isTuiContext({ hasUI: true } as never)).toBe(true);
		expect(isTuiContext({ hasUI: false, mode: "tui" } as never)).toBe(false);
		expect(isTuiContext({ hasUI: true, mode: "json" } as never)).toBe(false);
		expect(isTuiContext({ hasUI: true, mode: "print" } as never)).toBe(false);
		expect(isTuiContext({ hasUI: true, mode: "rpc" } as never)).toBe(false);
	});
});

describe("the MCP pill default action", () => {
	it("registers a clickable mcp action when the adapter command exists", () => {
		const adapter = createMcpPillAdapter(fakePi() as never);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();

		adapter.start(ctx);
		expect(pillActionFor(MCP_STATUS_KEY)).toBeTypeOf("function");
	});

	it("stays out when the command is missing", () => {
		const adapter = createMcpPillAdapter(fakePi([]) as never);
		cleanups.push(adapter.stop);
		adapter.start(tuiContext().ctx);

		expect(pillActionFor(MCP_STATUS_KEY)).toBeUndefined();
	});

	it("does not mistake a same-named prompt template for the command", () => {
		const adapter = createMcpPillAdapter(
			fakePi([{ name: MCP_COMMAND_NAME, source: "prompt" }]) as never,
		);
		cleanups.push(adapter.stop);
		adapter.start(tuiContext().ctx);

		expect(pillActionFor(MCP_STATUS_KEY)).toBeUndefined();
	});

	it("treats a throwing command query as unavailable", () => {
		const pi = fakePi();
		pi.getCommands = () => {
			throw new Error("runtime gone");
		};
		const adapter = createMcpPillAdapter(pi as never);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();

		adapter.start(ctx);
		expect(pillActionFor(MCP_STATUS_KEY)).toBeUndefined();
		expect(adapter.trigger(ctx)).toBe(false);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("stays out of non-interactive sessions", () => {
		for (const mode of ["rpc", "json", "print"] as const) {
			const adapter = createMcpPillAdapter(fakePi() as never);
			adapter.start(tuiContext({ mode }).ctx);
			expect(pillActionFor(MCP_STATUS_KEY)).toBeUndefined();
			adapter.stop();
		}
	});
});

describe("dispatching the adapter command", () => {
	it("sends exactly /mcp-adapter with prompt expansion, never /mcp", () => {
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		runPillAction(pillActionFor(MCP_STATUS_KEY) as never, ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).toHaveBeenCalledWith(`/${MCP_COMMAND_NAME}`, {
			expandPromptTemplates: true,
		});
		expect(pi.sendUserMessage).not.toHaveBeenCalledWith("/mcp", expect.anything());
	});

	it("reports instead of sending when the command disappeared after registration", () => {
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		cleanups.push(adapter.stop);
		const { ctx, notify } = tuiContext();
		adapter.start(ctx);
		pi.getCommands = () => [];

		expect(adapter.trigger(ctx)).toBe(false);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("sends nothing from a non-interactive context", () => {
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		cleanups.push(adapter.stop);
		adapter.start(tuiContext().ctx);

		expect(adapter.trigger(tuiContext({ mode: "json" }).ctx)).toBe(false);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("survives a send failure without throwing", () => {
		const pi = fakePi();
		pi.sendUserMessage.mockImplementation(() => {
			throw new Error("dispatch failed");
		});
		const adapter = createMcpPillAdapter(pi as never);
		cleanups.push(adapter.stop);
		const { ctx, notify } = tuiContext();
		adapter.start(ctx);

		expect(() => adapter.trigger(ctx)).not.toThrow();
		expect(adapter.trigger(ctx)).toBe(false);
		expect(notify).toHaveBeenCalled();
	});

	it("is reachable from the keyboard as /starline mcp", async () => {
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: { handler: typeof handler }) {
					handler = options.handler;
				},
			} as never,
			{ getConfig: () => defaultConfig, requestRender() {} } as never,
		);

		await handler?.(MCP_STATUS_KEY, ctx);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});
});

describe("reopen guarding", () => {
	it("merges a repeat click inside the cooldown and reopens after it", () => {
		let clock = 0;
		const { calls, runtime: deps } = runtime({ now: () => clock });
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		adapter.trigger(ctx);
		clock = MCP_REOPEN_COOLDOWN_MS - 1;
		adapter.trigger(ctx);
		expect(calls.filter((call) => call === "send")).toHaveLength(1);

		clock = MCP_REOPEN_COOLDOWN_MS;
		adapter.trigger(ctx);
		expect(calls.filter((call) => call === "send")).toHaveLength(2);
	});

	it("shares one cooldown between the mouse action and the keyboard path", () => {
		let clock = 0;
		const { calls, runtime: deps } = runtime({ now: () => clock });
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		runPillAction(pillActionFor(MCP_STATUS_KEY) as never, ctx);
		clock = 10;
		adapter.trigger(ctx);
		expect(calls.filter((call) => call === "send")).toHaveLength(1);
	});

	it("closes a Starline bubble before it looks at what is still on screen", () => {
		const { calls, runtime: deps } = runtime({ bubbleOpen: () => true });
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		adapter.trigger(ctx);
		// Design order: close ours, then probe, then dispatch.
		expect(calls).toEqual(["close", "probe", "send"]);
	});

	it("does not treat its own bubble as an obstacle once it is closed", () => {
		let bubble = true;
		const { calls, runtime: deps } = runtime({
			bubbleOpen: () => bubble,
			closeBubble: () => {
				calls.push("close");
				// Pi hides an overlay synchronously when its close runs.
				bubble = false;
			},
			overlayVisible: () => {
				calls.push("probe");
				return bubble;
			},
		});
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		adapter.trigger(ctx);
		expect(calls).toEqual(["close", "probe", "send"]);
	});

	it("refuses when an overlay is still visible after its own bubble closed", () => {
		const { calls, runtime: deps } = runtime({
			bubbleOpen: () => true,
			overlayVisible: () => {
				calls.push("probe");
				return true;
			},
		});
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		adapter.trigger(ctx);
		expect(calls).toEqual(["close", "probe"]);
	});

	it("refuses to stack on a visible foreign overlay", () => {
		const { calls, runtime: deps } = runtime({ overlayVisible: () => true });
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		adapter.trigger(ctx);
		expect(calls).toEqual([]);
	});
	it("still opens when the overlay probe is unavailable", () => {
		const { calls, runtime: deps } = runtime({ overlayVisible: () => undefined });
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		adapter.trigger(ctx);
		expect(calls).toEqual(["send"]);
	});

	it("degrades when a probe throws", () => {
		const { calls, runtime: deps } = runtime({
			overlayVisible: () => {
				throw new Error("no renderer");
			},
			bubbleOpen: () => {
				throw new Error("no renderer");
			},
		});
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		expect(() => adapter.trigger(ctx)).not.toThrow();
		expect(calls).toEqual(["send"]);
	});
});

describe("session lifecycle and registration ownership", () => {
	it("leaves an existing mcp action alone", () => {
		const existing = vi.fn();
		cleanups.push(registerExternalPillAction(MCP_STATUS_KEY, existing));
		const adapter = createMcpPillAdapter(fakePi() as never);
		cleanups.push(adapter.stop);

		adapter.start(tuiContext().ctx);
		expect(pillActionFor(MCP_STATUS_KEY)).toBe(existing);
	});

	it("does not delete a newer owner when its own registration is released", () => {
		const adapter = createMcpPillAdapter(fakePi() as never);
		const { ctx } = tuiContext();
		adapter.start(ctx);

		const newer = vi.fn();
		cleanups.push(registerExternalPillAction(MCP_STATUS_KEY, newer));
		adapter.stop();

		expect(pillActionFor(MCP_STATUS_KEY)).toBe(newer);
	});

	it("ignores an action captured before the session ended", () => {
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		const { ctx } = tuiContext();
		adapter.start(ctx);
		const captured = pillActionFor(MCP_STATUS_KEY) as never;

		adapter.stop();
		runPillAction(captured, ctx);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("resets the cooldown for a new session", () => {
		let clock = 0;
		const { calls, runtime: deps } = runtime({ now: () => clock });
		const adapter = createMcpPillAdapter(fakePi() as never, deps);
		cleanups.push(adapter.stop);
		const first = tuiContext().ctx;
		adapter.start(first);
		adapter.trigger(first);

		clock = 5;
		const second = tuiContext().ctx;
		adapter.start(second);
		adapter.trigger(second);

		expect(calls.filter((call) => call === "send")).toHaveLength(2);
	});

	it("releases the action when the session ends", () => {
		const adapter = createMcpPillAdapter(fakePi() as never);
		adapter.start(tuiContext().ctx);
		expect(pillActionFor(MCP_STATUS_KEY)).toBeTypeOf("function");

		adapter.stop();
		expect(pillActionFor(MCP_STATUS_KEY)).toBeUndefined();
	});

	it("replaces its own earlier registration on a session switch", () => {
		const pi = fakePi();
		const adapter = createMcpPillAdapter(pi as never);
		cleanups.push(adapter.stop);
		const first = tuiContext().ctx;
		adapter.start(first);
		const afterFirst = pillActionFor(MCP_STATUS_KEY);

		adapter.start(tuiContext().ctx);
		expect(pillActionFor(MCP_STATUS_KEY)).toBeTypeOf("function");
		expect(pillActionFor(MCP_STATUS_KEY)).not.toBe(afterFirst);
	});
});
