/**
 * Versioned explicit expand-target protocol (change task 4.1).
 *
 * A component that draws a group summary publishes, on its own instance, a
 * resolver under the process-wide symbol below. Consumers (pi-starline's
 * click resolution, or this package's own mouse handling when Starline is
 * absent) ask the resolver for a *local* row of that component and receive
 * an independent group object plus the direction to toggle — never the
 * carrier's own expansion state.
 *
 * Contract (see the mouse-api spec delta):
 *
 * - `version` is `1`; anything else is not this protocol.
 * - `resolveLocalTarget(localRow, width)` is read-only: it never consumes
 *   events and never changes state. It returns a target only for the
 *   summary/title rows the carrier actually renders at that width; every
 *   other row misses.
 * - The returned `component` is the group's own handle (`expanded` +
 *   `setExpanded`), stable across repeated resolutions for the same group.
 * - `expanded` is the *direction to set* — the opposite of the group's
 *   current state — so a plain click maps to `setExpanded(result.expanded)`.
 * - A summary that does not fit the terminal width does not resolve: the
 *   group kept its original display, so there is no summary row to click.
 */

export const EXPAND_TARGET_KEY = Symbol.for(
  "@xzzpig/transcript-expand-target.v1",
);

/** The independent group object a summary click toggles. */
export type GroupTarget = {
  readonly expanded: boolean;
  setExpanded(expanded: boolean): void;
};

export type ExpandTarget = {
  readonly component: GroupTarget;
  /** What `setExpanded` should be called with on a plain click. */
  readonly expanded: boolean;
};

export type ExpandTargetResolver = (
  localRow: number,
  width: number,
) => ExpandTarget | undefined;

export type ExpandTargetProtocol = {
  readonly version: 1;
  readonly resolveLocalTarget: ExpandTargetResolver;
};

/** Publish the protocol on a carrier component instance. */
export function publishExpandTarget(
  component: object,
  resolver: ExpandTargetResolver,
): void {
  (component as Record<PropertyKey, unknown>)[EXPAND_TARGET_KEY] = {
    version: 1,
    resolveLocalTarget: resolver,
  } satisfies ExpandTargetProtocol;
}

/** Stop publishing (component left the view or the epoch died). */
export function retractExpandTarget(component: object): void {
  delete (component as Record<PropertyKey, unknown>)[EXPAND_TARGET_KEY];
}

/**
 * Consumer-side safe reader: validates the shape before use so an invalid
 * or throwing provider degrades to "no target" instead of breaking the
 * consumer's click handling. Version, callable resolver, and — once
 * resolved — a callable `setExpanded` on a boolean-`expanded` object are
 * all checked.
 */
export function readExpandTarget(
  component: unknown,
): ExpandTargetProtocol | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const candidate = (component as Record<PropertyKey, unknown>)[
    EXPAND_TARGET_KEY
  ] as Partial<ExpandTargetProtocol> | undefined;
  if (!candidate || candidate.version !== 1) return undefined;
  if (typeof candidate.resolveLocalTarget !== "function") return undefined;
  return candidate as ExpandTargetProtocol;
}

/** Validate a resolved target the same defensive way consumers must. */
export function isValidExpandTarget(value: unknown): value is ExpandTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ExpandTarget>;
  const component = candidate.component as Partial<GroupTarget> | undefined;
  if (!component || typeof component.setExpanded !== "function") return false;
  if (typeof component.expanded !== "boolean") return false;
  if (typeof candidate.expanded !== "boolean") return false;
  if (candidate.component === undefined) return false;
  return true;
}
