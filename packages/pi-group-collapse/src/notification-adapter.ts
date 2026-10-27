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
 * - an info tail is a host `ThemedText` whose builder reads the receiver's
 *   shared `lastStatusMessage`. The host reuses the line in place only while
 *   it is still the last child; every other status *appends*, and the older
 *   line keeps its cached text until some later `invalidate()` (theme
 *   change, resize, chat invalidate) rebuilds it — from whatever that shared
 *   field holds *then*. **A moved tail is therefore a state-change signal,
 *   not a verdict**: the line's own visible text has not changed, so the
 *   observer reports *which version the line may render next* and the
 *   consumer re-classifies instead of reflexively revealing;
 * - that report is only made when it is provable, read-only: the line's own
 *   builder is invoked once per status change and compared (ANSI stripped)
 *   with the new shared text. A builder that returns the shared text will
 *   repaint (`shared`); one that returns the line's own text keeps it
 *   (`own`). With no readable builder the outcome is unprovable, and the
 *   line is reported as invalidated so the consumer reveals it;
 * - a status that cannot be attributed to the extension entry (a core
 *   status) is never a candidate, but the same builder probe decides each
 *   line: a line that may repaint to the core text (or cannot be proven
 *   either way) is reported as invalidated, while an independent snapshot
 *   builder that provably keeps its own notification text keeps its source
 *   and membership — unattributable *new* text alone is not a revocation;
 * - tracked lines are held as `WeakRef`s and pruned when they leave the chat
 *   container or the observer is cleaned up, so nothing accumulates across
 *   `/compact`, `/reload`, or session replacement;
 * - nothing here writes host state: no `chatContainer.children` edit, no
 *   builder replacement, no `lastStatusMessage` write. The observer only
 *   reads what the host itself changed and calls a pure builder function.
 *
 * All per-receiver entry state lives in a `WeakMap`, so a torn-down host
 * instance drops it with no explicit unregistration.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  installPrototypePatch,
  type PatchInstallResult,
} from "./patch-registry.ts";
import type { NotificationLevel } from "./rules.ts";

/** The host slice the observer reads after an exit ran. */
type StatusReceiver = {
  chatContainer: { children: readonly unknown[]; clear?(): void };
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
  /**
   * `overwritten`: the host repainted this line in place with newer content.
   * `tail-moved`: the line kept its place but a newer status took the shared
   * field; this trackable line cannot be proven to keep its own text, so the
   * consumer must reveal it.
   */
  readonly reason: "overwritten" | "tail-moved";
};

/**
 * A proven content version a still-bound notification line may render from
 * now on (its builder reads the shared status field). The line's own visible
 * text has not changed yet: this is the *repaint target* an invalidation
 * would use.
 */
export type NotificationContentVersion = {
  readonly component: unknown;
  readonly receiver: unknown;
  readonly level: NotificationLevel;
  readonly text: string;
};

export type NotificationObserverCallbacks = {
  onNotification: (notification: ObservedNotification) => void;
  onInvalidated: (invalidation: NotificationInvalidation) => void;
  /**
   * Optional: a bound line lost the tail pointer and may now render this
   * newer *proven* notification version. Consumers re-classify the member
   * under it (a tail move alone must not drop a group member). When this
   * callback is absent every such move falls back to `onInvalidated`.
   */
  onContentVersion?: (version: NotificationContentVersion) => void;
  /**
   * Optional batch form of `onInvalidated`: every line one host status
   * change invalidated, in one call. When present, `onInvalidated` is not
   * called for that status change — a consumer providing both sees each
   * line exactly once, through the batch. Same items, same order.
   */
  onInvalidations?: (
    invalidations: readonly NotificationInvalidation[],
  ) => void;
  /**
   * Optional batch form of `onContentVersion`: every line one host status
   * change may repaint, in one call. One model pass instead of one per line.
   */
  onContentVersions?: (versions: readonly NotificationContentVersion[]) => void;
};

export type NotificationObserver = {
  install(): PatchInstallResult;
  /** Test/probe: bound status lines still tracked for this receiver. */
  trackedLineCount(receiver: StatusReceiver): number;
};

/**
 * The only host field the observer reads on a status line: its builder.
 * Everything else (cached text, geometry) stays the host's business.
 */
type StatusLine = { build?: unknown };

type ReceiverState = {
  /** Reentrancy depth of showExtensionNotify for this receiver. */
  entryDepth: number;
  /** The most recent component bound as an extension info notification. */
  boundStatusComponent: StatusLine | undefined;
};

const receiverStates = new WeakMap<StatusReceiver, ReceiverState>();

function stateFor(receiver: StatusReceiver): ReceiverState {
  let state = receiverStates.get(receiver);
  if (!state) {
    state = { entryDepth: 0, boundStatusComponent: undefined };
    receiverStates.set(receiver, state);
  }
  return state;
}

/** What a tracked line was last proven to render. */
type LineRecord = {
  text: string;
  level: NotificationLevel;
};

/**
 * How a line's own builder relates to the newest shared status text, in the
 * only terms that can be proven without writing host state.
 */
type ContentCoupling = "shared" | "own" | "unknown";

/**
 * Which text the line will render after the host rebuilds it. `shared` and
 * `own` are both *stable classifications*: a shared line renders the newer
 * notification version (which the consumer classifies), an own line keeps
 * the version it was bound with. Anything else is unprovable.
 */
function contentCouplingOf(
  component: StatusLine,
  sharedText: string,
  ownText: string,
): ContentCoupling {
  const build = component.build;
  if (typeof build !== "function") return "unknown";
  let built: unknown;
  try {
    built = (build as () => unknown).call(component);
  } catch {
    return "unknown";
  }
  if (typeof built !== "string") return "unknown";
  const plain = stripTerminalSequences(built);
  if (plain === sharedText) return "shared";
  if (plain === ownText) return "own";
  return "unknown";
}

/** Narrow a host tail reference to the slice the observer reads. */
function statusLineOf(value: unknown): StatusLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as StatusLine;
}

/**
 * Build the observer. `install()` patches the host prototype methods; the
 * returned cleanup restores them. All callbacks fire synchronously inside
 * the observed call.
 */
export function createNotificationObserver(
  callbacks: NotificationObserverCallbacks,
): NotificationObserver {
  // Per install: every line this observer bound, weakly, plus the version
  // each one was last proven to render. WeakRefs keep `/compact`, `/reload`
  // and session replacement free of strong component retention; dead and
  // cleared lines are pruned on the next status change.
  let trackedLines = new WeakMap<StatusReceiver, Set<WeakRef<StatusLine>>>();
  const lineRecords = new WeakMap<StatusLine, LineRecord>();

  function trackLine(
    receiver: StatusReceiver,
    component: StatusLine,
    level: NotificationLevel,
    text: string,
  ): void {
    lineRecords.set(component, { text, level });
    let lines = trackedLines.get(receiver);
    if (!lines) {
      lines = new Set();
      trackedLines.set(receiver, lines);
    }
    for (const reference of lines) {
      if (reference.deref() === component) return;
    }
    lines.add(new WeakRef(component));
  }

  function untrack(
    receiver: StatusReceiver,
    reference: WeakRef<StatusLine>,
    component: StatusLine,
  ): void {
    trackedLines.get(receiver)?.delete(reference);
    lineRecords.delete(component);
  }

  /**
   * A status exit just ran and moved the shared field. Re-derive, for every
   * line this observer still tracks, what it may render next:
   *
   * - `version` present: a proven extension notification version the line
   *   may repaint to. Report it so the consumer re-classifies the member;
   *   a consumer that cannot re-classify gets the conservative reveal.
   * - `version` absent: the newer status is core (or otherwise unproven) and
   *   is never claimed. Each tracked line is probed: `own` (an independent
   *   snapshot builder) provably keeps its own text and is left alone;
   *   `shared`/`unknown` may repaint to the core text and are invalidated —
   *   the line the host repainted in place is `overwritten`, any other line
   *   that merely lost the tail is `tail-moved`.
   *
   * The reports of one status change are collected and handed over as a
   * batch when the consumer accepts one: a status change can touch every
   * tracked line, and the consumer must be able to drop or re-classify them
   * in one model pass instead of one full transcript scan per line. A line
   * is reported exactly once and appears in at most one of the two batches
   * (a line is either re-classified or invalidated), so the two batches can
   * be delivered in either order.
   */
  function reconcileTail(
    receiver: StatusReceiver,
    version: { level: NotificationLevel; text: string } | undefined,
    reusedComponent: StatusLine | undefined,
  ): void {
    const lines = trackedLines.get(receiver);
    if (!lines || lines.size === 0) return;
    // One membership snapshot per status change: O(children + tracked),
    // never a per-line linear scan of the whole transcript.
    const present = new Set<unknown>(receiver.chatContainer.children);
    const invalidations: NotificationInvalidation[] = [];
    const versions: NotificationContentVersion[] = [];
    for (const reference of [...lines]) {
      const component = reference.deref();
      if (component === undefined) {
        lines.delete(reference);
        continue;
      }
      if (!present.has(component)) {
        // Cleared or rebuilt transcript: nothing to repaint, nothing to
        // keep referencing.
        untrack(receiver, reference, component);
        continue;
      }
      const known = lineRecords.get(component);
      if (!known) {
        lines.delete(reference);
        continue;
      }
      if (version === undefined) {
        // A status the extension entry did not originate. The shared field
        // now holds unattributable text, but that alone does not change what
        // *this* line renders: probe its own builder against the current
        // shared value, exactly as on the proven path.
        const sharedText = String(receiver.lastStatusMessage ?? "");
        const coupling = contentCouplingOf(component, sharedText, known.text);
        if (coupling === "own") {
          // An independent (snapshot) builder: it provably keeps its own
          // notification text, so it keeps its source and its membership.
          // Nothing on screen changes and no foreign content is hidden.
          continue;
        }
        // `shared` (may repaint to the core text — an actual overwrite when
        // the host reused this very line) and `unknown` must reveal.
        untrack(receiver, reference, component);
        invalidations.push({
          component,
          receiver,
          reason: component === reusedComponent ? "overwritten" : "tail-moved",
        });
        continue;
      }
      if (known.text === version.text && known.level === version.level) {
        // Same version: nothing on screen or in the classification moves.
        continue;
      }
      switch (contentCouplingOf(component, version.text, known.text)) {
        case "shared": {
          known.text = version.text;
          known.level = version.level;
          if (callbacks.onContentVersion || callbacks.onContentVersions) {
            versions.push({
              component,
              receiver,
              level: version.level,
              text: version.text,
            });
          } else {
            // No re-classification handler: do not keep the line on a
            // guess. Reveal it and forget the binding.
            untrack(receiver, reference, component);
            invalidations.push({
              component,
              receiver,
              reason: "tail-moved",
            });
          }
          break;
        }
        case "own":
          // Proven to keep its own recorded text: its classification is
          // unchanged, so it stays exactly where it is.
          break;
        case "unknown":
          untrack(receiver, reference, component);
          invalidations.push({
            component,
            receiver,
            reason: "tail-moved",
          });
          break;
      }
    }
    if (versions.length > 0) {
      if (callbacks.onContentVersions) callbacks.onContentVersions(versions);
      else for (const entry of versions) callbacks.onContentVersion?.(entry);
    }
    if (invalidations.length > 0) {
      if (callbacks.onInvalidations) callbacks.onInvalidations(invalidations);
      else for (const entry of invalidations) callbacks.onInvalidated(entry);
    }
  }

  // SAFETY: the registry probes each method before wrapping this host prototype.
  const prototype = InteractiveMode.prototype as unknown as Record<
    PropertyKey,
    unknown
  >;
  return {
    install() {
      trackedLines = new WeakMap();
      const cleanups: (() => void)[] = [];
      const results = [
        installPrototypePatch(
          prototype,
          "showExtensionNotify",
          "notification-entry",
          ({ predecessor, receiver, args }) => {
            const record = receiver as StatusReceiver;
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
            const record = receiver as StatusReceiver;
            const childrenBefore = record.chatContainer.children.length;
            try {
              return predecessor.apply(receiver, args);
            } finally {
              const fromExtension = stateFor(record).entryDepth > 0;
              // Any child append moves the visual tail away from the
              // previously bound line: reuse only happens in place.
              const reusedTail =
                record.chatContainer.children.length === childrenBefore;
              const text = String(args[0] ?? "");
              const tail = statusLineOf(record.lastStatusText);
              const state = stateFor(record);

              if (fromExtension && tail !== undefined) {
                // A proven notification owns this line at its current
                // version; a reused line is the same member with new
                // content (the notification callback reveals that update).
                state.boundStatusComponent = tail;
                trackLine(record, tail, "info", text);
                callbacks.onNotification({
                  level: "info",
                  text,
                  component: tail,
                  receiver: record,
                  reusedTail,
                });
                reconcileTail(record, { level: "info", text }, tail);
              } else {
                // A status the extension entry did not originate: the
                // shared field now holds unattributable content, so every
                // tracked line may repaint to it. No extension line is the
                // bound tail anymore.
                state.boundStatusComponent = undefined;
                reconcileTail(record, undefined, reusedTail ? tail : undefined);
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
                receiver as StatusReceiver,
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
                receiver as StatusReceiver,
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
      const teardown = () => {
        for (const cleanup of cleanups) cleanup();
        // Drop tracking with the observer: no line stays bound and no
        // reference survives teardown.
        trackedLines = new WeakMap();
      };
      if (!available) teardown();
      return { available, cleanup: teardown };
    },
    trackedLineCount(receiver: StatusReceiver): number {
      const lines = trackedLines.get(receiver);
      if (!lines) return 0;
      let live = 0;
      for (const reference of lines) {
        if (reference.deref() !== undefined) live += 1;
      }
      return live;
    },
  };
}

function reportAppend(
  receiver: StatusReceiver,
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
export function isInExtensionEntry(receiver: StatusReceiver): boolean {
  return (receiverStates.get(receiver)?.entryDepth ?? 0) > 0;
}

/** Test/probe helper: the component currently bound as an info tail. */
export function boundStatusComponentOf(receiver: StatusReceiver): unknown {
  return receiverStates.get(receiver)?.boundStatusComponent;
}
