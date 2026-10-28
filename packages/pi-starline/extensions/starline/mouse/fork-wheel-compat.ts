import type {
	MouseEventsApi,
	MouseHandlerContext,
	MouseHandlerRegistrationOptions,
	MouseHandlerResult,
} from "@xzzpig/pi-mouse-events/api";

/** v2 publishers before the post-component wheel slot do not declare it. */
export type SharedWheelHandler = (
	context: MouseHandlerContext & { readonly wheelDelta?: number },
) => MouseHandlerResult;

type WheelRegistrar = (
	handler: SharedWheelHandler,
	options?: MouseHandlerRegistrationOptions,
) => () => void;

/** Read the optional capability without requiring a newer v2 type package. */
export function sharedWheelRegistrar(api: MouseEventsApi): WheelRegistrar | undefined {
	const candidate = (api as MouseEventsApi & { addWheelHandler?: WheelRegistrar }).addWheelHandler;
	return typeof candidate === "function" ? candidate.bind(api) : undefined;
}
