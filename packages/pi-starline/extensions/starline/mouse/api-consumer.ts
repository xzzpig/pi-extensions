/**
 * The consumer-side accessor for the `pi-mouse-events` extension's API.
 *
 * All Starline needs from that package is its published runtime object, and
 * the package publishes it under a process-global `Symbol.for` key precisely
 * so consumers do not have to import it: Pi loads every extension through a
 * jiti instance with `moduleCache: false`, so a static value import of
 * `@xzzpig/pi-mouse-events/api` would both give Starline its own fresh copy
 * of the module *and* make the whole extension fail to load when the package
 * is not installed — the one situation this integration must survive
 * gracefully. A type-only import carries the contract's types at development
 * time; this duplicated key string is the only runtime surface, and
 * `test/contract/mouse-api.test.ts` asserts it matches the real package's.
 *
 * `Symbol.for()` is process-global by spec, so the accessor observes exactly
 * what the extension wrote, whatever module copy this file was loaded in.
 */

import type { MouseEventsApi } from "@xzzpig/pi-mouse-events/api";

/**
 * MUST match `MOUSE_EVENTS_API_KEY` in `@xzzpig/pi-mouse-events/api` — the
 * contract test above is what keeps that true.
 */
const MOUSE_EVENTS_API_KEY = Symbol.for("pi-mouse-events.api.v1");

export function getMouseEventsApi(): MouseEventsApi | undefined {
	return (globalThis as Record<symbol, unknown>)[MOUSE_EVENTS_API_KEY] as
		| MouseEventsApi
		| undefined;
}
