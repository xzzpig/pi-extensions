import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeStatusPanel } from "./fork-status-panel";
import { activeEditor } from "./mouse/editor-mouse";
import { closePillBubble } from "./pill-bubble";

type EntrySession = { id: string; warned: boolean };
let session: EntrySession | undefined;

/** Called only from Starline's existing session install/cleanup path. */
export function configureNativeModelEntry(ctx: ExtensionContext | undefined): void {
	const id = ctx?.sessionManager?.getSessionId?.();
	session = typeof id === "string" ? { id, warned: false } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Open the host's own action, without ever submitting draft or command text. */
export function openNativeModelSelector(ctx: ExtensionContext): boolean {
	const mode = (ctx as ExtensionContext & { mode?: string }).mode;
	if (!ctx.hasUI || (mode !== undefined && mode !== "tui")) return false;
	const current = session;
	if (!current || ctx.sessionManager?.getSessionId?.() !== current.id) return false;
	closePillBubble();
	closeStatusPanel();
	const editor = activeEditor();
	const mounted = editor?.component;
	const base = editor?.scrollable;
	if (isRecord(mounted) && mounted.focused === false) return false;
	// The editor owns the injected native TUI. Read only its optional overlay
	// probe; the wrapped editor's scrollable is its original base instance.
	if (
		isRecord(base) &&
		isRecord(base.tui) &&
		typeof base.tui.hasOverlay === "function" &&
		base.tui.hasOverlay()
	)
		return false;
	const actions = isRecord(mounted) ? mounted.actionHandlers : undefined;
	const action: unknown = actions instanceof Map ? actions.get("app.model.select") : undefined;
	if (typeof action !== "function") {
		if (!current.warned) {
			current.warned = true;
			ctx.ui.notify(
				"Model picker unavailable: the current editor has no native model selection action. Use /model.",
				"warning",
			);
		}
		return false;
	}
	action();
	return true;
}
