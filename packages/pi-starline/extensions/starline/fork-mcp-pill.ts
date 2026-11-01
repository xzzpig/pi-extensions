/**
 * Fork-only: make `pi-mcp-adapter`'s `mcp` status pill open the adapter's own
 * panel.
 *
 * The adapter publishes `ctx.ui.setStatus("mcp", …)`, which Starline already
 * draws as a pill; what it cannot publish is what a click means. This adapter
 * supplies exactly that, through the same `registerExternalPillAction` bridge
 * any other extension would use — it is not a builtin segment, and the builtin
 * `PILL_ACTIONS` table stays untouched.
 *
 * Three rules shape the implementation:
 *
 * - The adapter owns the text. `MCP 0/1` (its `mcpFooterStatus: "compact"`
 *   setting) is what the pill shows; nothing here parses or recounts it, and
 *   no configuration file is read or written.
 * - The panel is the adapter's. A click dispatches `/mcp-adapter`, the command
 *   the adapter already binds as a shortcut for the same panel. Calling
 *   `openMcpPanel()` directly would need the adapter's private state and skip
 *   the command's reload handling.
 * - Nothing is sent unless that command exists. `pi.getCommands()` reports the
 *   slash commands with their source, so a same-named prompt template or skill
 *   is not mistaken for the extension command, and an unknown `/mcp-adapter`
 *   never reaches the model as an ordinary prompt.
 *
 * There is no completion signal for the panel: `pi.sendUserMessage()` returns
 * `void`. The reopen guard is therefore bounded and honest — a shared 300 ms
 * cooldown for mouse and keyboard, plus a visible-overlay probe when the shared
 * mouse layer can answer one. It never claims to single-flight a slow
 * initialization.
 *
 * See FORK-CHANGELOG.md; `test/fork-mcp-pill.test.ts` covers it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMouseEventsApi } from "./mouse/api-consumer";
import { externalPillAction, registerExternalPillAction } from "./pill-api";
import { activePillBubbleGeometry, closePillBubble } from "./pill-bubble";

/** The status key `pi-mcp-adapter` publishes through `ctx.ui.setStatus`. */
export const MCP_STATUS_KEY = "mcp";

/**
 * The adapter's own command. Not `/mcp`: Pi's built-in MCP support registers
 * that name too, and the adapter only claims it for its own panel when Pi has
 * no built-in MCP.
 */
export const MCP_COMMAND_NAME = "mcp-adapter";

/** A click and its synthesized release land together; a double click does not. */
export const MCP_REOPEN_COOLDOWN_MS = 300;

/** The command metadata this adapter reads, matching Pi's `SlashCommandInfo`. */
export type McpCommandInfo = { name: string; source?: string };

/**
 * What the adapter needs from the host. Every member has a production default,
 * so tests can replace one without an entire fake host.
 */
export type McpPillRuntime = {
	/** Monotonic milliseconds, for the reopen cooldown. */
	now: () => number;
	/** The session's slash commands, with their source. */
	commands: () => readonly McpCommandInfo[];
	/** Dispatch the adapter's command. */
	send: () => void;
	/** Close an open Starline pill bubble, if any. */
	closeBubble: () => void;
	/** Whether a Starline pill bubble is open right now. */
	bubbleOpen: () => boolean;
	/** Whether the renderer has a visible overlay; `undefined` when unknowable. */
	overlayVisible: () => boolean | undefined;
	/** A short, non-throwing notice for the user. */
	notify: (ctx: ExtensionContext, message: string) => void;
};

export type McpPillAdapter = {
	/** Register the default `mcp` action for a session, replacing its own older one. */
	start: (ctx: ExtensionContext) => void;
	/** Release the registration and invalidate any in-flight action. */
	stop: () => void;
	/** Run the action. Returns whether the command was dispatched. */
	trigger: (ctx: ExtensionContext) => boolean;
};

/** Only the interactive TUI can show a panel; RPC/JSON/print have no overlay UI. */
export function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasUI === true && (ctx.mode === undefined || ctx.mode === "tui");
	} catch {
		return false;
	}
}

/**
 * True when the adapter's command is present *as an extension command*.
 *
 * A template or skill of the same name is not it: dispatching that one would
 * expand a prompt instead of opening the panel. A read failure means "not
 * available" — the safe direction, since the alternative is sending text.
 */
export function hasMcpCommand(commands: readonly McpCommandInfo[]): boolean {
	return commands.some(
		(command) => command.name === MCP_COMMAND_NAME && command.source === "extension",
	);
}

/**
 * Ask the shared mouse layer whether an overlay is visible.
 *
 * Optional by design: without `@xzzpig/pi-mouse-events`, or on a Pi without
 * component mouse events, the cooldown alone guards the entry point.
 */
function readOverlayVisible(): boolean | undefined {
	try {
		const receiver = getMouseEventsApi()?.liveReceiver?.() as { hasOverlay?: unknown } | undefined;
		const probe = receiver?.hasOverlay;
		if (typeof probe !== "function") return undefined;
		return probe.call(receiver) === true;
	} catch {
		return undefined;
	}
}

function defaultNotify(ctx: ExtensionContext, message: string): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "info");
	} catch {
		// A notice must never be the reason a click throws.
	}
}

/** Read a probe, treating a broken one as "unknown" rather than an error. */
function probe<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

/** Build the adapter. `installMcpPillAdapter` wires it to a live `pi`. */
export function createMcpPillAdapter(
	pi: ExtensionAPI,
	overrides: Partial<McpPillRuntime> = {},
): McpPillAdapter {
	const runtime: McpPillRuntime = {
		now: () => performance.now(),
		commands: () => pi.getCommands(),
		send: () => pi.sendUserMessage(`/${MCP_COMMAND_NAME}`, { expandPromptTemplates: true }),
		closeBubble: () => closePillBubble(),
		bubbleOpen: () => activePillBubbleGeometry() !== undefined,
		overlayVisible: readOverlayVisible,
		notify: defaultNotify,
		...overrides,
	};

	/** Our registration, and nothing else's: disposing it cannot remove a newer owner. */
	let dispose: (() => void) | undefined;
	/** Generation of the session the registered action belongs to. */
	let generation = 0;
	/** Monotonic time of the last dispatch; shared by mouse and keyboard. */
	let lastSentAt: number | undefined;

	const readCommands = (): readonly McpCommandInfo[] | undefined => {
		try {
			return runtime.commands();
		} catch {
			return undefined;
		}
	};

	const stop = (): void => {
		// Bump first: an action already mid-flight must not reach the old session.
		generation += 1;
		const owned = dispose;
		dispose = undefined;
		lastSentAt = undefined;
		owned?.();
	};

	const trigger = (ctx: ExtensionContext): boolean => {
		if (!isTuiContext(ctx)) return false;
		const commands = readCommands();
		if (!commands || !hasMcpCommand(commands)) {
			runtime.notify(
				ctx,
				`pi-mcp-adapter is not installed, so /${MCP_COMMAND_NAME} cannot open the MCP panel`,
			);
			return false;
		}
		const now = runtime.now();
		if (lastSentAt !== undefined && now - lastSentAt < MCP_REOPEN_COOLDOWN_MS) return false;

		// Close ours first, then look at what is still on screen. Pi's overlay
		// close is synchronous (`showExtensionCustom.close` calls
		// `overlayHandle.hide()` before resolving), so after this the probe only
		// sees overlays Starline does not own.
		const hadBubble = probe(runtime.bubbleOpen, false);
		if (hadBubble) {
			try {
				runtime.closeBubble();
			} catch {
				// The bubble is a convenience; the panel is the point.
			}
		}
		const overlay = probe(runtime.overlayVisible, undefined);
		if (overlay === true) return false;

		lastSentAt = now;
		try {
			runtime.send();
		} catch {
			runtime.notify(ctx, `pi-mcp-adapter could not open the MCP panel from /${MCP_COMMAND_NAME}`);
			return false;
		}
		return true;
	};

	const start = (ctx: ExtensionContext): void => {
		stop();
		if (!isTuiContext(ctx)) return;
		const commands = readCommands();
		if (!commands || !hasMcpCommand(commands)) return;
		// Another extension already owns this pill's click; the default stays out.
		if (externalPillAction(MCP_STATUS_KEY) !== undefined) return;

		const ownGeneration = generation;
		dispose = registerExternalPillAction(MCP_STATUS_KEY, (actionContext) => {
			if (ownGeneration !== generation) return;
			trigger(actionContext.ctx);
		});
	};

	return {
		start,
		stop,
		trigger,
	};
}

/**
 * Install the adapter on a live Pi.
 *
 * The module owns its own lifecycle handlers so the extension entry keeps a
 * two-line seam: one import, one call. Registration happens in `session_start`,
 * after every extension has registered its commands, and is released in
 * `session_shutdown` so a reload or session switch cannot leave an old context
 * behind.
 */
export function installMcpPillAdapter(pi: ExtensionAPI): void {
	const adapter = createMcpPillAdapter(pi);
	pi.on("session_start", (_event, ctx) => {
		adapter.start(ctx);
	});
	pi.on("session_shutdown", () => {
		adapter.stop();
	});
}
