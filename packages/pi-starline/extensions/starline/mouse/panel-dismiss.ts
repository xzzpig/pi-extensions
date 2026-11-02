/**
 * A click anywhere outside the open status panel puts it away.
 *
 * Pi only delivers a press to the overlay when it lands inside the overlay's
 * rectangle, so "outside" cannot be seen from the panel's own `handleMouse`.
 * This reads the pointer stream the shared mouse patch publishes (see
 * `pointer-events.ts`), before Pi dispatches, and closes the panel when the press
 * is outside the box it last drew.
 *
 * The bar is not special: a press there dismisses the panel like any other. What
 * needs care is that the same press then reaches the pill under the pointer,
 * whose handler would open the panel again; `dismissStatusPanel` arms a short
 * guard so that one press closes and does not reopen.
 *
 * Nothing is consumed: the click still reaches whatever is under the pointer, so
 * the caret moves, the transcript selects, and a pill still gets its press.
 */

import {
	activeStatusPanelRect,
	dismissStatusPanel,
	isStatusPanelOpen,
	resetStatusPanelDismissGuard,
} from "../fork-status-panel";
import { isPointerPress, observePointerEvents, type PointerEventRaw } from "./pointer-events";

/**
 * Whether this pointer event lands outside the panel's rectangle.
 *
 * The rectangle is the one the panel last drew (it is re-derived on every frame,
 * so a resized window keeps the box and the dismissal in step). The bar is
 * included: a press there is outside the panel, and `dismissStatusPanel` makes
 * sure the press that dismisses cannot reopen it.
 */
export function isOutsideStatusPanel(
	event: PointerEventRaw,
	rect: { left: number; top: number; width: number; height: number } | undefined,
): boolean {
	if (!rect || rect.width <= 0 || rect.height <= 0) return false;
	if (!isPointerPress(event)) return false;
	return (
		event.y < rect.top ||
		event.y >= rect.top + rect.height ||
		event.x < rect.left ||
		event.x >= rect.left + rect.width
	);
}

/**
 * Close the open panel when a press lands outside it. Returns the disposer.
 *
 * Harmless on a Pi without component mouse events: nothing publishes, so nothing
 * happens and the panel keeps its keyboard, frame and bar ways out.
 */
export function installStatusPanelDismiss(): () => void {
	return observePointerEvents((event) => {
		// `isStatusPanelOpen` is the authority: the rectangle is only where it drew.
		if (!isStatusPanelOpen()) {
			// No panel is up: this press starts a new gesture, so an earlier
			// dismissal must not swallow the open it is about to cause.
			resetStatusPanelDismissGuard();
			return;
		}
		const rect = activeStatusPanelRect();
		if (!rect) {
			// No panel is up: this press starts a new gesture, so an earlier
			// dismissal must not swallow the open it is about to cause.
			resetStatusPanelDismissGuard();
			return;
		}
		if (!isOutsideStatusPanel(event, rect)) return;
		dismissStatusPanel();
	});
}
