import { CORE_EVENT_PREFIX } from "./config.js";

/**
 * Reference-counted subscription registry for `event` triggers.
 *
 * Subscriptions are keyed by the configured event name verbatim (`core:`
 * prefixed host events or bare bus channels). Multiple rules pointing at the
 * same event share one host subscription, so the registry never sees rules —
 * the runtime feeds it the deduplicated set of active event names on every
 * rebuild, and `clear()` at session shutdown is the only other lifecycle
 * touchpoint. Subscriptions are configuration-level wiring: session switches
 * and tree navigation must not call into this module.
 */

/** Subscription primitive for host extension events (`pi.on` behind a cast). */
export type CoreSubscriber = (
  eventName: string,
  handler: (event: unknown, ctx: unknown) => void,
) => () => void;

/** Subscription primitive for plugin bus channels (`pi.events.on`). */
export type BusSubscriber = (
  channel: string,
  handler: (data: unknown) => void,
) => () => void;

/**
 * Fan-out callback invoked when a subscribed event arrives. `ctx` is only
 * forwarded for `core:` events (the host handler's second argument); bus
 * handlers receive the payload only, so `ctx` stays absent.
 */
export type EventDispatch = (
  name: string,
  payload: unknown,
  ctx?: unknown,
) => void;

export class EventSubscriptionRegistry {
  /** Key: configured event name verbatim; value: unsubscribe function. */
  private readonly subscriptions = new Map<string, () => void>();

  constructor(
    private readonly subscribeCore: CoreSubscriber,
    private readonly subscribeBus: BusSubscriber,
    private readonly dispatch: EventDispatch,
  ) {}

  /**
   * Align subscriptions with `names`, the set of event names referenced by
   * the currently active event rules. New names subscribe once; names already
   * in the table are left untouched; names that dropped out unsubscribe
   * immediately (their unsubscribe function runs exactly once).
   */
  reconcile(names: Iterable<string>): void {
    const active = new Set(names);
    for (const name of active) {
      if (this.subscriptions.has(name)) continue;
      this.subscriptions.set(name, this.subscribeName(name));
    }
    for (const [name, unsubscribe] of this.subscriptions) {
      if (active.has(name)) continue;
      this.subscriptions.delete(name);
      unsubscribe();
    }
  }

  /** Unsubscribe every name and empty the table (session shutdown). */
  clear(): void {
    const unsubscribes = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const unsubscribe of unsubscribes) unsubscribe();
  }

  /** Snapshot of the currently subscribed names (configured form verbatim). */
  subscribedNames(): string[] {
    return [...this.subscriptions.keys()];
  }

  private subscribeName(name: string): () => void {
    if (name.startsWith(CORE_EVENT_PREFIX)) {
      // The host routes `pi.on` by bare event names; the `core:` prefix only
      // exists in sentinel configuration, so it is stripped before subscribing
      // and kept in dispatch so rules match their configured name.
      const unsubscribe = this.subscribeCore(
        name.slice(CORE_EVENT_PREFIX.length),
        (event, ctx) => {
          this.dispatch(name, event, ctx);
        },
      );
      return unsubscribe;
    }
    // Bus handlers only receive the payload; ctx is intentionally absent.
    const unsubscribe = this.subscribeBus(name, (data) => {
      this.dispatch(name, data);
    });
    return unsubscribe;
  }
}
