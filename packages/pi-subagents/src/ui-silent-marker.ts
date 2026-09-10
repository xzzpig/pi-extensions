/**
 * pi-notify silent-span marker protocol.
 *
 * Dialogs that are NOT agent-waiting prompts (monitoring panels such as the
 * fleet inspector, admin management dialogs) claim the next core
 * `ui_prompt_start` span as silent, so pi-notify produces no notification
 * and no Herdr wait entry for it. The event name is a literal on purpose:
 * pi-notify may not be installed, in which case this emit is a harmless
 * no-op and pi-subagents must not depend on the pi-notify package.
 */
export const PI_NOTIFY_UI_SPAN_SILENT_EVENT = "pi-notify:ui_span_silent";

/** Minimal event bus accepted by `emitUiSpanSilent`. */
export interface UiSpanSilentEvents {
	emit(event: string, data: unknown): void;
}

/**
 * Observational emit: claims the next dialog span as silent. A missing or
 * failing bus must never break the dialog flow.
 */
export function emitUiSpanSilent(
	events: UiSpanSilentEvents | undefined,
	reason: string,
): void {
	if (!events) return;
	try {
		events.emit(PI_NOTIFY_UI_SPAN_SILENT_EVENT, { reason });
	} catch {
		// Observational only.
	}
}
