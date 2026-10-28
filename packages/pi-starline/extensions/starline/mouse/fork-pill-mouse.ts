import type { MouseEventsApi } from "@xzzpig/pi-mouse-events/api";
import { installPillBubbleDismiss } from "./bubble-dismiss";
import { type PointerReceiver, publishPointerEvent } from "./pointer-events";

/** Feed the upstream bubble observer from the shared, non-consuming mouse slot. */
export function installSharedPillMouse(api: MouseEventsApi): () => void {
	const stopDismiss = installPillBubbleDismiss();
	const stopEvents = api.addMouseHandler(
		({ event, tui }) => {
			// SAFETY: the shared API supplies the live TuiAltScreen; the observer only reads terminal.rows.
			publishPointerEvent(event, tui as unknown as PointerReceiver);
		},
		{ priority: Number.MAX_SAFE_INTEGER },
	);
	return () => {
		stopEvents();
		stopDismiss();
	};
}
