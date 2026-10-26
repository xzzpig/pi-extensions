/**
 * Fork-only consumer for the versioned explicit expand-target protocol
 * (`@xzzpig/transcript-expand-target.v1`).
 *
 * Providers (pi-group-collapse today) publish a resolver on the component
 * instance that draws a group summary. Starline checks that resolver for
 * the component's *local* row before its own `setExpanded`/hint logic, so a
 * click on a summary toggles the group object instead of the first tool
 * inside it.
 *
 * The contract is defensive by requirement (see the mouse-api spec):
 * no published protocol, a wrong version, a non-callable resolver, a
 * thrown resolution, or an invalid resolved shape all fall back to the
 * existing component path — installing the provider is never required and
 * a broken provider cannot break clicks that used to work.
 *
 * This module deliberately depends on nothing: the symbol key is its only
 * tie to the provider, so Starline keeps working with the provider absent,
 * and any number of providers can publish the same key.
 */

/** The shared protocol key; `Symbol.for` so every copy in the process agrees. */
export const EXPAND_TARGET_KEY = Symbol.for("@xzzpig/transcript-expand-target.v1");

/** The slice of the protocol Starline reads. */
type ExpandTargetProtocol = {
	version: 1;
	resolveLocalTarget: (localRow: number, width: number) => unknown;
};

/** The resolved target, validated before use. */
export type ExplicitExpandTarget = {
	component: { setExpanded(expanded: boolean): void };
	expanded: boolean;
};

/**
 * Resolve an explicit expand target for a component's local row, or
 * undefined when there is no provider, no hit, or anything invalid.
 */
export function explicitExpandTargetAt(
	component: unknown,
	localRow: number,
	width: number,
): ExplicitExpandTarget | undefined {
	if (typeof component !== "object" || component === null) return undefined;
	let protocol: unknown;
	try {
		protocol = (component as Record<PropertyKey, unknown>)[EXPAND_TARGET_KEY];
	} catch {
		return undefined;
	}
	if (
		typeof protocol !== "object" ||
		protocol === null ||
		(protocol as ExpandTargetProtocol).version !== 1 ||
		typeof (protocol as ExpandTargetProtocol).resolveLocalTarget !== "function"
	) {
		return undefined;
	}
	let resolved: unknown;
	try {
		resolved = (protocol as ExpandTargetProtocol).resolveLocalTarget(localRow, width);
	} catch {
		return undefined;
	}
	if (
		typeof resolved !== "object" ||
		resolved === null ||
		typeof (resolved as ExplicitExpandTarget).expanded !== "boolean"
	) {
		return undefined;
	}
	const target = resolved as {
		component?: { setExpanded?: unknown };
		expanded: boolean;
	};
	if (
		typeof target.component !== "object" ||
		target.component === null ||
		typeof target.component.setExpanded !== "function"
	) {
		return undefined;
	}
	return {
		component: target.component as { setExpanded(expanded: boolean): void },
		expanded: target.expanded,
	};
}
