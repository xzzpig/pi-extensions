/**
 * Reload-safe prototype patching for pi's component classes.
 *
 * Pi re-evaluates extension entry points on session replacement (`/new`,
 * fork, switch, reload), and each copy of this package may be loaded more
 * than once in the same process. Naively wrapping a prototype method twice
 * stacks wrappers; restoring in the wrong order tears the chain. This module
 * makes patching idempotent and restorable by keeping the patch records on
 * the patched target itself, under a `Symbol.for` key shared by every copy
 * of this package in the process:
 *
 * - the first `installPrototypePatch` call for an adapter wraps the method
 *   once and stores `{ predecessor, wrapper }` on the target;
 * - later calls (other copies, later sessions) reuse the same wrapper and
 *   only replace the *behavior* slot — the wrapper dispatches to whichever
 *   behavior was registered last;
 * - the returned cleanup restores the predecessor only when its own
 *   behavior is still the active one, so an out-of-order cleanup cannot
 *   break a newer registration.
 *
 * The pattern mirrors `pi-starline`'s `prototype-patch-registry.ts`; the key
 * is this package's own.
 */

export const THINKING_COLLAPSE_PATCH_REGISTRY = Symbol.for(
  "pi-thinking-collapse.prototype-patch-registry",
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

function registryFor(target: PrototypeLike): PatchRegistry {
  const existing = target[THINKING_COLLAPSE_PATCH_REGISTRY];
  if (existing instanceof Map) return existing as PatchRegistry;
  const registry: PatchRegistry = new Map();
  Object.defineProperty(target, THINKING_COLLAPSE_PATCH_REGISTRY, {
    value: registry,
    configurable: true,
  });
  return registry;
}

function createCleanup(
  target: PrototypeLike,
  method: string,
  adapter: string,
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

    const current = registry.get(adapter);
    if (current !== record) return;
    if (target[method] === record.wrapper) target[method] = record.predecessor;
    registry.delete(adapter);
    if (registry.size === 0) {
      delete target[THINKING_COLLAPSE_PATCH_REGISTRY];
    }
  };
}

/**
 * Install (or re-register) a behavior for `method` on `target`, returning a
 * cleanup that restores the original method. Safe to call any number of
 * times from any copy of this package: the underlying prototype is wrapped
 * exactly once per adapter.
 */
export function installPrototypePatch(
  targetValue: PrototypeLike,
  method: string,
  adapter: string,
  behavior: PatchBehavior,
): () => void {
  const target = targetValue;
  const registry = registryFor(target);
  let record = registry.get(adapter);

  if (
    !(record && record.method === method && target[method] === record.wrapper)
  ) {
    const predecessor = target[method];
    if (typeof predecessor !== "function") {
      // Structure drift: a future pi may rename or remove the method. Degrade
      // silently — no patch, no-op cleanup — instead of crashing the
      // extension on every session replacement.
      return () => {};
    }
    const nextRecord: PatchRecord = {
      method,
      predecessor: predecessor as PatchMethod,
      wrapper: () => undefined,
    };
    const wrapper: PatchMethod = function thinkingCollapsePrototypeWrapper(
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
    registry.set(adapter, record);
    target[method] = wrapper;
  }

  const token = Symbol(adapter);
  record.registration = { token, behavior };
  return createCleanup(target, method, adapter, registry, record, token);
}
