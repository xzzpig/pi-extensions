/**
 * Starline's mouse feature set — fork seam.
 *
 * The implementation is fork-only (`fork-consumer.ts`): the fork consumes the
 * `@xzzpig/pi-mouse-events` v2 API instead of patching `TuiAltScreen.prototype`.
 * This file keeps the upstream module's import surface stable so callers and
 * upstream changes stay sign-only.
 */

export * from "./fork-consumer.ts";
