import type { PointerShape } from "@xzzpig/pi-mouse-events/api";
import { getMouseEventsApi } from "./api-consumer";

/** Use the shared pointer owner when the installed v2 API supports it. */
export function requestSharedPointer(shape: PointerShape): boolean {
	const api = getMouseEventsApi();
	if (!api?.requestPointerShape) return false;
	api.requestPointerShape(shape);
	return true;
}
