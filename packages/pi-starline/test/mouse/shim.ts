/**
 * A test shim that stands in for the `pi-mouse-events` extension's dispatch.
 *
 * Starline's mouse features used to be prototype patches, and the behavioural
 * suites drove them through the patched methods (`handleViewportInput`,
 * `handleSelectionMouseEvent`, `routeWheel`,
 * `copyActiveSelectionToClipboard`). The features are API consumers now, and
 * the extension owns those methods — its own suite covers the real dispatch.
 * What this shim does is replay that dispatch for a fixture prototype: parse
 * mouse reports the way the extension does, run the registered handlers in
 * priority order, consume on `{ handled: true }`, and fall through to the
 * fixture's own "Pi" methods when nobody took the event. That keeps the
 * behavioural assertions about Starline's features intact while the plumbing
 * they ride on changed.
 *
 * The keyboard path replays Pi's listener chain too: an extension
 * `onTerminalInput` listener sees keystrokes before the focused component, so
 * the shim runs the registered listener ahead of the fixture's
 * `handleViewportInput`.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MouseEventsApi } from "@xzzpig/pi-mouse-events/api";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import { installMouseFeaturesOn } from "../../extensions/starline/mouse/index";

/** SGR: `\x1b[<button;column;row(M|m)`. */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

type UnifiedEvent = {
	kind: "wheel" | "down" | "up" | "motion";
	button: number;
	x: number;
	y: number;
	release: boolean;
	wheel?: -1 | 1;
	handled: boolean;
};

function parseMouse(data: string): UnifiedEvent | undefined {
	const sgr = SGR_MOUSE_RE.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1], 10);
		const x = Number.parseInt(sgr[2], 10) - 1;
		const y = Number.parseInt(sgr[3], 10) - 1;
		const release = sgr[4] === "m";
		if ((button & 64) !== 0) {
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			const wheel = direction === 0 ? -1 : 1;
			return {
				kind: "wheel",
				button: wheel === -1 ? 64 : 65,
				x,
				y,
				release: false,
				wheel,
				handled: false,
			};
		}
		return {
			kind: release ? "up" : (button & 32) !== 0 ? "motion" : "down",
			button,
			x,
			y,
			release,
			handled: false,
		};
	}
	return undefined;
}

function fromMouseEvent(event: {
	button: number;
	x: number;
	y: number;
	release?: boolean;
}): UnifiedEvent {
	const release = event.release === true;
	return {
		kind: release ? "up" : (event.button & 32) !== 0 ? "motion" : "down",
		button: event.button,
		x: event.x,
		y: event.y,
		release,
		handled: false,
	};
}

type Handler = (context: {
	event: UnifiedEvent;
	tui: unknown;
}) => { handled?: boolean } | undefined | void;
type CopyHandler = (context: { tui: unknown }) => { handled?: boolean } | undefined | void;

/**
 * Installs Starline's features on a fixture prototype and wraps the
 * prototype's mouse methods with the extension-shaped dispatch. Returns a
 * disposer that unwraps everything, exactly as `installMouse` used to.
 */
export function installMouseShim(
	prototype: Record<string, unknown>,
	deps: { getConfig: () => PolishedTuiConfig },
): () => void {
	const mouseHandlers: Array<{ priority: number; handler: Handler }> = [];
	const copyHandlers: Array<{ priority: number; handler: CopyHandler }> = [];
	const inputListeners: Array<(data: string) => unknown> = [];

	const api = {
		version: 1,
		eventChannel: "pi-mouse-events:mouse",
		copySlotAvailable: true,
		// The fixture prototype is the receiver throughout, so the live
		// reference is trivially constant — the real API binds it on first
		// input instead.
		liveReceiver: () => prototype,
		addMouseHandler(handler: Handler, options?: { priority?: number }) {
			const entry = { priority: options?.priority ?? 0, handler };
			mouseHandlers.push(entry);
			return () => {
				const index = mouseHandlers.indexOf(entry);
				if (index !== -1) mouseHandlers.splice(index, 1);
			};
		},
		addCopyHandler(handler: CopyHandler, options?: { priority?: number }) {
			const entry = { priority: options?.priority ?? 0, handler };
			copyHandlers.push(entry);
			return () => {
				const index = copyHandlers.indexOf(entry);
				if (index !== -1) copyHandlers.splice(index, 1);
			};
		},
	} as unknown as MouseEventsApi;

	// The keyboard listener registers through `ctx.ui.onTerminalInput` — on
	// the fixture the prototype carries it, as Pi's real extension-UI does.
	prototype.onTerminalInput = (handler: (data: string) => unknown) => {
		inputListeners.push(handler);
		return () => {
			const index = inputListeners.indexOf(handler);
			if (index !== -1) inputListeners.splice(index, 1);
		};
	};
	const disposeFeatures = installMouseFeaturesOn(
		api,
		{ ui: prototype } as unknown as ExtensionContext,
		deps,
	);

	const runHandlers = (event: UnifiedEvent): boolean => {
		const sorted = [...mouseHandlers].sort((a, b) => b.priority - a.priority);
		for (const entry of sorted) {
			if (entry.handler({ event, tui: prototype })?.handled) return true;
		}
		return false;
	};

	const original = {
		handleViewportInput: prototype.handleViewportInput,
		handleSelectionMouseEvent: prototype.handleSelectionMouseEvent,
		routeWheel: prototype.routeWheel,
		copyActiveSelectionToClipboard: prototype.copyActiveSelectionToClipboard,
	};

	prototype.handleViewportInput = (data: string) => {
		const mouse = parseMouse(data);
		if (!mouse) {
			// Keystrokes: the extension's input listener runs before the focused
			// component, then Pi's own viewport input runs.
			for (const listener of [...inputListeners]) {
				if ((listener(data) as { consume?: boolean } | undefined)?.consume) {
					return { consume: true };
				}
			}
			return (original.handleViewportInput as (this: unknown, data: string) => unknown).call(
				prototype,
				data,
			);
		}
		if (runHandlers(mouse)) return { consume: true };
		return (original.handleViewportInput as (this: unknown, data: string) => unknown).call(
			prototype,
			data,
		);
	};

	prototype.handleSelectionMouseEvent = (event: {
		button: number;
		x: number;
		y: number;
		release?: boolean;
	}) => {
		// The extension runs its handlers before Pi's built-in selection
		// handling — replaying that order here keeps "consumed the press" tests
		// honest.
		if (runHandlers(fromMouseEvent(event))) return undefined;
		return (original.handleSelectionMouseEvent as (this: unknown, event: unknown) => unknown).call(
			prototype,
			event,
		);
	};

	prototype.routeWheel = (event: { direction: number; x: number; y: number }) => {
		const wheel = (event.direction === -1 ? -1 : 1) as -1 | 1;
		if (
			runHandlers({
				kind: "wheel",
				button: wheel === -1 ? 64 : 65,
				x: event.x,
				y: event.y,
				release: false,
				wheel,
				handled: false,
			})
		) {
			return undefined;
		}
		return (original.routeWheel as (this: unknown, event: unknown) => unknown).call(
			prototype,
			event,
		);
	};

	prototype.copyActiveSelectionToClipboard = async () => {
		for (const entry of [...copyHandlers]) {
			if (entry.handler({ tui: prototype })?.handled) return true;
		}
		return (original.copyActiveSelectionToClipboard as (this: unknown) => unknown).call(prototype);
	};

	return () => {
		prototype.handleViewportInput = original.handleViewportInput;
		prototype.handleSelectionMouseEvent = original.handleSelectionMouseEvent;
		prototype.routeWheel = original.routeWheel;
		prototype.copyActiveSelectionToClipboard = original.copyActiveSelectionToClipboard;
		delete prototype.onTerminalInput;
		disposeFeatures();
	};
}
