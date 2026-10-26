/**
 * Reload-safe prototype patching for pi's component classes.
 *
 * Pi re-evaluates extension entry points on session replacement (`/new`,
 * fork, switch, reload), so this package may be loaded more than once in the
 * same process. Naively wrapping a prototype method twice stacks wrappers;
 * restoring in the wrong order tears the chain other plugins built on top.
 * This module makes patching idempotent and restorable by keeping the patch
 * records on the patched target itself, under a `Symbol.for` key shared by
 * every copy of this package in the process:
 *
 * - the first `installPrototypePatch` call for an adapter wraps the method
 *   once and stores `{ predecessor, wrapper }` on the target;
 * - later calls (other copies, later sessions) reuse the same wrapper and
 *   only replace the *behavior* slot — the wrapper dispatches to whichever
 *   behavior was registered last;
 * - the returned cleanup restores the predecessor only while this
 *   registration still owns the active behavior slot *and* our wrapper is
 *   still the outermost method, so an out-of-order cleanup or a plugin that
 *   wrapped on top of us cannot have its chain broken.
 *
 * The pattern mirrors `pi-thinking-collapse`'s and `pi-starline`'s prototype
 * patch registries; the registry key is this package's own.
 */

export const GROUP_COLLAPSE_PATCH_REGISTRY = Symbol.for(
  "pi-group-collapse.prototype-patch-registry",
);

/**
 * A class prototype this module patches. Class instances are not assignable
 * to `Record<PropertyKey, unknown>` directly, so callers reach in with a
 * single documented cast.
 */
export type PrototypeLike = Record<PropertyKey, unknown>;

/** Whatever the wrapped method returns — this module never inspects it. */
type PatchMethod = (this: unknown, ...args: unknown[]) => unknown;

type PatchResult = ReturnType<PatchMethod>;

export type PatchInvocation = {
  predecessor: PatchMethod;
  receiver: unknown;
  args: unknown[];
};

export type PatchBehavior = (invocation: PatchInvocation) => PatchResult;

type PatchRegistration = {
  token: symbol;
  behavior?: PatchBehavior;
};

type PatchRecord = {
  method: string;
  predecessor: PatchMethod;
  wrapper: PatchMethod;
  registration?: PatchRegistration;
};

type PatchRegistry = Map<string, PatchRecord>;

export type PatchInstallResult = {
  /** False when the host lacks the capability; nothing was patched. */
  available: boolean;
  /** Restores the pre-patch state. Safe to call more than once. */
  cleanup: () => void;
};

/** Reported at most once per adapter while the capability stays missing. */
export type UnavailableListener = (info: {
  target: PrototypeLike;
  method: string;
  adapter: string;
}) => void;

const unavailableAdapters = new Set<string>();
let onUnavailable: UnavailableListener | undefined;

/** Set the process-wide deduplicated "capability missing" sink. */
export function setUnavailableListener(
  listener: UnavailableListener | undefined,
): void {
  onUnavailable = listener;
}

/** Test-only: forget which adapters were already reported. */
export function resetUnavailableReports(): void {
  unavailableAdapters.clear();
}

/**
 * Whether `target[method]` is still a callable the patch could wrap. A
 * renamed or removed host method means the structure drifted; the adapter
 * must degrade to pass-through instead of crashing every session start.
 */
export function probeCapability(
  target: PrototypeLike,
  method: string,
): boolean {
  return typeof target[method] === "function";
}

function registryFor(target: PrototypeLike): PatchRegistry {
  const existing = target[GROUP_COLLAPSE_PATCH_REGISTRY];
  if (existing instanceof Map) return existing as PatchRegistry;
  const registry: PatchRegistry = new Map();
  Object.defineProperty(target, GROUP_COLLAPSE_PATCH_REGISTRY, {
    value: registry,
    configurable: true,
  });
  return registry;
}

function reportUnavailable(
  target: PrototypeLike,
  method: string,
  adapter: string,
): void {
  if (unavailableAdapters.has(adapter)) return;
  unavailableAdapters.add(adapter);
  onUnavailable?.({ target, method, adapter });
}

function createCleanup(
  target: PrototypeLike,
  method: string,
  registry: PatchRegistry,
  record: PatchRecord,
  token: symbol,
): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (record.registration?.token !== token) return;
    record.registration.behavior = undefined;
    record.registration = undefined;

    // Restore the predecessor only when nobody wrapped on top of us: if
    // another plugin's wrapper is the current method, removing ourselves
    // from underneath it would tear its chain. Our wrapper becomes a plain
    // pass-through instead, which is the least surprising state for them.
    const current = registry.get(record.method);
    if (current !== record) return;
    if (target[method] === record.wrapper) target[method] = record.predecessor;
    registry.delete(record.method);
    if (registry.size === 0) {
      delete target[GROUP_COLLAPSE_PATCH_REGISTRY];
    }
  };
}

/**
 * Install (or re-register) a behavior for `method` on `target`. Safe to call
 * any number of times from any copy of this package: the underlying
 * prototype is wrapped exactly once per method.
 *
 * When the method is missing or not callable, nothing is patched, the
 * degradation is reported once through the unavailable listener, and the
 * returned cleanup is a no-op.
 */
export function installPrototypePatch(
  targetValue: PrototypeLike,
  method: string,
  adapter: string,
  behavior: PatchBehavior,
): PatchInstallResult {
  const target = targetValue;
  if (!probeCapability(target, method)) {
    reportUnavailable(target, method, adapter);
    return { available: false, cleanup: () => {} };
  }

  const registry = registryFor(target);
  let record = registry.get(method);

  if (
    !(record && record.method === method && target[method] === record.wrapper)
  ) {
    const predecessor = target[method] as PatchMethod;
    const nextRecord: PatchRecord = {
      method,
      predecessor,
      wrapper: () => undefined,
    };
    const wrapper: PatchMethod = function groupCollapsePrototypeWrapper(
      this: unknown,
      ...args: unknown[]
    ): PatchResult {
      const activeBehavior = nextRecord.registration?.behavior;
      return activeBehavior
        ? activeBehavior({
            predecessor: nextRecord.predecessor,
            receiver: this,
            args,
          })
        : nextRecord.predecessor.apply(this, args);
    };
    nextRecord.wrapper = wrapper;
    record = nextRecord;
    registry.set(method, record);
    target[method] = wrapper;
  }

  const token = Symbol(adapter);
  record.registration = { token, behavior };
  return {
    available: true,
    cleanup: createCleanup(target, method, registry, record, token),
  };
}
