/**
 * Notification source observation and component binding (change task 1.6).
 *
 * The host has no typed notification entry: `ctx.ui.notify` ends in
 * `InteractiveMode.showExtensionNotify`, which dispatches to the very same
 * `showStatus`/`showWarning`/`showError` exits the core uses for its own
 * status lines. Owning a notification therefore requires *provenance*, not
 * text similarity:
 *
 * - the extension entry is observed through the recoverable patch registry,
 *   and a per-receiver synchronous marker (set in a `try/finally`) tags the
 *   exits it calls; core-initiated calls carry no marker and are never
 *   claimed;
 * - the exit calls run first (the original chain is fully preserved), then
 *   the observer reads what the host actually did: which component was
 *   appended or reused, so a reused tail line is one member, not one per
 *   `notify()` call;
 * - the info tail reads the receiver's shared `lastStatusMessage` field,
 *   so any later `showStatus` that moves the tail invalidates a previously
 *   bound line (it may repaint to unrelated content). Invalidation is
 *   surfaced immediately so consumers reveal the affected content instead
 *   of hiding it;
 * - all per-receiver state lives in a `WeakMap`, so a torn-down host
 *   instance drops its bindings with no explicit unregistration;
 * - nothing here mutates `chatContainer.children` or any plugin's `ctx.ui`;
 *   the observer only reads what the host itself changed.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  installPrototypePatch,
  type PatchInstallResult,
} from "./patch-registry.ts";
import type { NotificationLevel } from "./rules.ts";

/** The host slice the observer reads after an exit ran. */
type StatusReceiver = {
  chatContainer: { children: unknown[] };
  lastStatusMessage?: string;
  lastStatusText?: unknown;
  lastStatusSpacer?: unknown;
};

export type ObservedNotification = {
  readonly level: NotificationLevel;
  /** The message exactly as the extension passed it — no host prefix. */
  readonly text: string;
  /** The ThemedText the host rendered it into (runtime handle). */
  readonly component: unknown;
  readonly receiver: unknown;
  /** True when the host reused the existing tail line instead of appending. */
  readonly reusedTail: boolean;
};

export type NotificationInvalidation = {
  readonly component: unknown;
  readonly receiver: unknown;
  /** `overwritten`: the tail was reused for newer content. */
  readonly reason: "overwritten" | "tail-moved";
};

export type NotificationObserverCallbacks = {
  onNotification: (notification: ObservedNotification) => void;
  onInvalidated: (invalidation: NotificationInvalidation) => void;
};

export type NotificationObserver = {
  install(): PatchInstallResult;
};

type ReceiverState = {
  /** Reentrancy depth of showExtensionNotify for this receiver. */
  entryDepth: number;
  /** The component currently bound as an extension info notification. */
  boundStatusComponent: unknown | undefined;
};

const receiverStates = new WeakMap<object, ReceiverState>();

function stateFor(receiver: object): ReceiverState {
  let state = receiverStates.get(receiver);
  if (!state) {
    state = { entryDepth: 0, boundStatusComponent: undefined };
    receiverStates.set(receiver, state);
  }
  return state;
}

/**
 * Build the observer. `install()` patches the host prototype methods; the
 * returned cleanup restores them. All callbacks fire synchronously inside
 * the observed call.
 */
export function createNotificationObserver(
  callbacks: NotificationObserverCallbacks,
): NotificationObserver {
  // SAFETY: the registry probes each method before wrapping this host prototype.
  const prototype = InteractiveMode.prototype as unknown as Record<
    PropertyKey,
    unknown
  >;
  return {
    install() {
      const cleanups: (() => void)[] = [];
      const results = [
        installPrototypePatch(
          prototype,
          "showExtensionNotify",
          "notification-entry",
          ({ predecessor, receiver, args }) => {
            const record = receiver as object;
            const state = stateFor(record);
            state.entryDepth += 1;
            try {
              return predecessor.apply(receiver, args);
            } finally {
              state.entryDepth -= 1;
            }
          },
        ),
        installPrototypePatch(
          prototype,
          "showStatus",
          "notification-status-exit",
          ({ predecessor, receiver, args }) => {
            const record = receiver as StatusReceiver & object;
            const childrenBefore = record.chatContainer.children.length;
            const boundBefore = stateFor(record).boundStatusComponent;
            try {
              const result = predecessor.apply(receiver, args);
              return result;
            } finally {
              const fromExtension = stateFor(record).entryDepth > 0;
              const childrenAfter = record.chatContainer.children.length;
              const tail = record.lastStatusText;
              const reusedTail = childrenAfter === childrenBefore;
              const state = stateFor(record);

              if (reusedTail) {
                // The tail line was updated in place. Whatever was bound
                // there before has been overwritten by newer content.
                if (
                  !fromExtension &&
                  boundBefore !== undefined &&
                  boundBefore === tail
                ) {
                  state.boundStatusComponent = undefined;
                  callbacks.onInvalidated({
                    component: boundBefore,
                    receiver: record,
                    reason: "overwritten",
                  });
                }
              } else {
                // A new tail pair was appended. The previous binding, if
                // any, no longer owns the shared field: the host may
                // repaint it to whatever lastStatusMessage holds later.
                if (boundBefore !== undefined) {
                  state.boundStatusComponent = undefined;
                  callbacks.onInvalidated({
                    component: boundBefore,
                    receiver: record,
                    reason: "tail-moved",
                  });
                }
              }

              if (fromExtension && tail !== undefined) {
                state.boundStatusComponent = tail;
                callbacks.onNotification({
                  level: "info",
                  text: String(args[0] ?? ""),
                  component: tail,
                  receiver: record,
                  reusedTail,
                });
              }
            }
          },
        ),
        installPrototypePatch(
          prototype,
          "showError",
          "notification-error-exit",
          ({ predecessor, receiver, args }) => {
            try {
              return predecessor.apply(receiver, args);
            } finally {
              reportAppend(
                receiver as StatusReceiver & object,
                "error",
                args[0],
                callbacks,
              );
            }
          },
        ),
        installPrototypePatch(
          prototype,
          "showWarning",
          "notification-warning-exit",
          ({ predecessor, receiver, args }) => {
            try {
              return predecessor.apply(receiver, args);
            } finally {
              reportAppend(
                receiver as StatusReceiver & object,
                "warning",
                args[0],
                callbacks,
              );
            }
          },
        ),
      ];
      for (const result of results) {
        if (result.available) cleanups.push(result.cleanup);
      }
      // Provenance requires the entry and every exit. Do not leave a
      // partial observer active when a host upgrade removes one of them:
      // a later unobserved status update could otherwise stay hidden.
      const available = results.every((result) => result.available);
      if (!available) {
        for (const cleanup of cleanups) cleanup();
      }
      return {
        available,
        cleanup: () => {
          for (const cleanup of cleanups) cleanup();
        },
      };
    },
  };
}

function reportAppend(
  receiver: StatusReceiver & object,
  level: NotificationLevel,
  message: unknown,
  callbacks: NotificationObserverCallbacks,
): void {
  if (stateFor(receiver).entryDepth <= 0) return;
  const children = receiver.chatContainer.children;
  const component = children[children.length - 1];
  if (component === undefined) return;
  callbacks.onNotification({
    level,
    text: String(message ?? ""),
    component,
    receiver,
    reusedTail: false,
  });
}

/** Test/probe helper: is this receiver currently inside the entry? */
export function isInExtensionEntry(receiver: object): boolean {
  return (receiverStates.get(receiver)?.entryDepth ?? 0) > 0;
}

/** Test/probe helper: the component currently bound as an info tail. */
export function boundStatusComponentOf(receiver: object): unknown {
  return receiverStates.get(receiver)?.boundStatusComponent;
}
