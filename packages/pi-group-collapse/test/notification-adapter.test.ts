/**
 * Notification observer tests (change task 1.6).
 *
 * Drives the real InteractiveMode prototype methods (patched by the
 * observer) against stub receivers that carry a real Container, exactly as
 * the 1.2 contract tests do. Pins: raw text and level capture, core-origin
 * separation, tail-reuse as one member, and the invalidation / content
 * version contract that lets a consumer re-classify a moved line instead of
 * reflexively dropping it:
 *
 * - a tail move caused by another *proven* notification reports the newer
 *   version (`onContentVersion`) so the consumer can keep a line that is
 *   still group-eligible;
 * - a tail move caused by an unproven (core) status, or a line whose builder
 *   cannot be proven to read its own text, is reported as an invalidation;
 * - children are never touched beyond the host's own edits, and cleanup
 *   restores the prototype methods and forgets every tracked line.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
  boundStatusComponentOf,
  createNotificationObserver,
  type NotificationContentVersion,
  type NotificationInvalidation,
  type NotificationObserver,
  type ObservedNotification,
} from "../src/notification-adapter.ts";

type Receiver = {
  chatContainer: Container;
  ui: { requestRender(): void };
  outputPad: number;
  lastStatusMessage?: string;
  lastStatusText?: unknown;
  lastStatusSpacer?: unknown;
  showError(message: string): void;
  showWarning(message: string): void;
  showStatus(message: string): void;
  showExtensionNotify(
    message: string,
    type?: "info" | "warning" | "error",
  ): void;
};

const prototype = InteractiveMode.prototype as unknown as {
  showExtensionNotify: (
    this: Receiver,
    message: string,
    type?: "info" | "warning" | "error",
  ) => void;
  showStatus: (this: Receiver, message: string) => void;
  showError: (this: Receiver, message: string) => void;
  showWarning: (this: Receiver, message: string) => void;
};

function makeReceiver(): Receiver {
  const base = {
    chatContainer: new Container(),
    ui: { requestRender: () => {} },
    outputPad: 1,
  };
  const receiver = base as Receiver;
  // The entry dispatches through the receiver's own properties, so they
  // must be the (patched) prototype methods, as real instances have.
  receiver.showError = prototype.showError;
  receiver.showWarning = prototype.showWarning;
  receiver.showStatus = prototype.showStatus;
  receiver.showExtensionNotify = prototype.showExtensionNotify;
  return receiver;
}

/** Something the host appended between two status lines. */
function interveningChild(): unknown {
  return { render: () => ["intervening"], invalidate: () => {} };
}

describe("notification observer", () => {
  let observer: NotificationObserver;
  let cleanup: (() => void) | undefined;
  let notifications: ObservedNotification[];
  let invalidations: NotificationInvalidation[];
  let contentVersions: NotificationContentVersion[];

  beforeAll(() => {
    initTheme();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    observer = createNotificationObserver({
      onNotification: (notification) => notifications.push(notification),
      onInvalidated: (invalidation) => invalidations.push(invalidation),
      onContentVersion: (version) => contentVersions.push(version),
    });
    const install = observer.install();
    expect(install.available).toBe(true);
    cleanup = install.cleanup;
  });

  afterAll(() => {
    cleanup?.();
  });

  test("captures raw text and level from the extension entry", () => {
    const receiver = makeReceiver();
    prototype.showExtensionNotify.call(receiver, "plain message");
    prototype.showExtensionNotify.call(receiver, "a warning", "warning");
    prototype.showExtensionNotify.call(receiver, "an error", "error");

    expect(notifications.map((n) => [n.level, n.text])).toEqual([
      ["info", "plain message"],
      ["warning", "a warning"],
      ["error", "an error"],
    ]);
    // Levels map to real components appended by the host exits.
    const [info, warning, error] = notifications;
    expect(receiver.chatContainer.children).toContain(info.component);
    expect(receiver.chatContainer.children).toContain(warning.component);
    expect(receiver.chatContainer.children).toContain(error.component);
    for (const item of [info, warning, error]) {
      const index = receiver.chatContainer.children.indexOf(
        item.component as never,
      );
      expect(item.spacer).toBe(receiver.chatContainer.children[index - 1]);
      expect(item.spacer).toBeInstanceOf(Spacer);
    }
  });

  test("an unproven replacement beside a notification is never claimed as its spacer", () => {
    const receiver = makeReceiver();
    notifications = [];
    const foreign = new Text("foreign component", 0, 0);
    receiver.ui.requestRender = () => {
      const children = receiver.chatContainer.children;
      if (children.length >= 2) children[children.length - 2] = foreign;
    };
    prototype.showExtensionNotify.call(receiver, "unproven spacer", "info");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].spacer).toBeUndefined();
    expect(receiver.chatContainer.children).toContain(foreign);
    expect(foreign.render(80).join("\n")).toContain("foreign component");
  });

  test("core-originated status lines are never claimed", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showStatus.call(receiver, "core status");
    prototype.showError.call(receiver, "core error");
    prototype.showWarning.call(receiver, "core warning");
    expect(notifications).toEqual([]);
    // The host exits still did their own work.
    expect(receiver.chatContainer.children.length).toBe(6);
  });

  test("tail reuse reports one member, not one per call", () => {
    const receiver = makeReceiver();
    notifications = [];
    prototype.showExtensionNotify.call(receiver, "first");
    prototype.showExtensionNotify.call(receiver, "second");

    expect(notifications.length).toBe(2);
    const [first, second] = notifications;
    expect(first.reusedTail).toBe(false);
    expect(second.reusedTail).toBe(true);
    expect(second.component).toBe(first.component);
    expect(second.spacer).toBe(first.spacer);
    expect(second.spacer).toBe(receiver.chatContainer.children[0]);
    // Still exactly one Spacer/ThemedText pair in the container.
    expect(receiver.chatContainer.children.length).toBe(2);
    expect(boundStatusComponentOf(receiver)).toBe(first.component);
  });

  test("a core overwrite of the bound tail invalidates it once", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const bound = notifications[0].component;
    expect(invalidations).toEqual([]);

    prototype.showStatus.call(receiver, "core overwrites");
    expect(invalidations).toEqual([
      { component: bound, receiver, reason: "overwritten" },
    ]);
    expect(contentVersions).toEqual([]);
    expect(boundStatusComponentOf(receiver)).toBeUndefined();

    // Further core reuses of the tail produce no duplicate invalidation.
    prototype.showStatus.call(receiver, "core again");
    expect(invalidations.length).toBe(1);
    expect(notifications.length).toBe(1);
  });

  test("a proven tail move reports the newer version instead of invalidating", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const first = notifications[0].component;
    receiver.chatContainer.addChild(interveningChild() as never);

    prototype.showExtensionNotify.call(receiver, "beta notification");
    const second = notifications[1];
    expect(second.reusedTail).toBe(false);
    expect(second.component).not.toBe(first);
    expect(boundStatusComponentOf(receiver)).toBe(second.component);
    // The old line lost the tail pointer; a plain notification replacement
    // is not by itself a reason to drop it — the consumer gets the version
    // the line may now render and decides with its policy.
    expect(invalidations).toEqual([]);
    expect(contentVersions).toEqual([
      { component: first, receiver, level: "info", text: "beta notification" },
    ]);
  });

  test("a core status after a tail move invalidates the moved line", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const first = notifications[0].component;
    receiver.chatContainer.addChild(interveningChild() as never);

    prototype.showStatus.call(receiver, "Session compacted 1 time");
    // An unproven status may repaint the old line to unrelated content: the
    // consumer must reveal it instead of guessing.
    expect(invalidations).toEqual([
      { component: first, receiver, reason: "tail-moved" },
    ]);
    expect(contentVersions).toEqual([]);
    // The old line is no longer tracked: a later proven move has nothing to
    // reclassify.
    expect(observer.trackedLineCount(receiver)).toBe(0);
  });

  test("a core status does not revoke an own-coupled notification line", () => {
    // The user's decision: an independent snapshot builder provably keeps
    // its own notification text, so an unrelated core status arriving on the
    // tail must not drop it from its group. Only text the line may actually
    // render can invalidate it.
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const first = notifications[0].component as { build?: () => string };
    // An independent builder: a real content update elsewhere cannot repaint
    // this line because it never reads the shared field.
    first.build = () => "alpha notification";
    receiver.chatContainer.addChild(interveningChild() as never);

    prototype.showStatus.call(receiver, "Session compacted 1 time");
    expect(invalidations).toEqual([]);
    expect(contentVersions).toEqual([]);
    // Still tracked with its own version: a later proven move still
    // re-classifies it rather than assuming it is gone.
    expect(observer.trackedLineCount(receiver)).toBe(1);
  });

  test("a shared-coupled line still fails on a core status", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const first = notifications[0].component;
    receiver.chatContainer.addChild(interveningChild() as never);

    prototype.showStatus.call(receiver, "Session compacted 1 time");
    expect(invalidations).toEqual([
      { component: first, receiver, reason: "tail-moved" },
    ]);
  });

  test("a real core overwrite of the tail line is still reported", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const bound = notifications[0].component;

    // No child appended: the host reuses this very line for the core text.
    prototype.showStatus.call(receiver, "Session compacted 1 time");
    expect(invalidations).toEqual([
      { component: bound, receiver, reason: "overwritten" },
    ]);
    expect(contentVersions).toEqual([]);
    expect(observer.trackedLineCount(receiver)).toBe(0);
  });

  test("one status change scans the children once, not once per line", () => {
    // Cost evidence for reconcileTail: materialize the children snapshot once
    // (O(children)) and test membership with Set.has; never a per-line
    // Array.includes over the transcript, and no per-frame rescan.
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    const calls = { includes: 0, iterate: 0 };
    const container = receiver.chatContainer;
    const proxy = new Proxy(container.children, {
      get(target, property, proxyReceiver) {
        if (property === "includes") calls.includes += 1;
        if (property === Symbol.iterator) calls.iterate += 1;
        return Reflect.get(target, property, proxyReceiver) as unknown;
      },
    });
    Object.defineProperty(container, "children", {
      configurable: true,
      get: () => proxy,
    });

    prototype.showExtensionNotify.call(receiver, "alpha notification");
    // A child between the two statuses forces the host to append a second
    // line (otherwise it reuses the tail and there is only one line).
    receiver.chatContainer.addChild(interveningChild() as never);
    prototype.showExtensionNotify.call(receiver, "beta notification");
    expect(observer.trackedLineCount(receiver)).toBe(2);
    expect(calls.includes).toBe(0);

    calls.includes = 0;
    calls.iterate = 0;
    receiver.chatContainer.addChild(interveningChild() as never);
    calls.includes = 0;
    calls.iterate = 0;
    prototype.showExtensionNotify.call(receiver, "gamma notification");
    // Exactly one traversal of the children per status change...
    expect(calls.iterate).toBe(1);
    // ...and no per-tracked-line linear membership scan.
    expect(calls.includes).toBe(0);
    expect(observer.trackedLineCount(receiver)).toBe(3);
  });

  test("a line whose builder keeps its own text is not reclassified", () => {
    // A host that snapshots the message, as ThemedText's own contract
    // recommends, never repaints: the line keeps the classification it was
    // bound with, so a later status must not touch it.
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const first = notifications[0].component as { build?: () => string };
    first.build = () => "alpha notification";
    receiver.chatContainer.addChild(interveningChild() as never);

    prototype.showExtensionNotify.call(receiver, "beta notification");
    expect(invalidations).toEqual([]);
    expect(contentVersions).toEqual([]);
    expect(observer.trackedLineCount(receiver)).toBe(2);
  });

  test("a line without a readable builder is revealed on a tail move", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    const first = notifications[0].component as { build?: unknown };
    delete first.build;
    receiver.chatContainer.addChild(interveningChild() as never);

    prototype.showExtensionNotify.call(receiver, "beta notification");
    expect(invalidations).toEqual([
      { component: first, receiver, reason: "tail-moved" },
    ]);
    expect(contentVersions).toEqual([]);
  });

  test("a line that left the chat container is dropped from tracking", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    contentVersions = [];
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    receiver.chatContainer.clear();
    receiver.chatContainer.addChild(interveningChild() as never);

    prototype.showExtensionNotify.call(receiver, "beta notification");
    // The removed component cannot be repainted into the transcript, so no
    // reveal is due and nothing accumulates behind it.
    expect(invalidations).toEqual([]);
    expect(contentVersions).toEqual([]);
    expect(observer.trackedLineCount(receiver)).toBe(1);
  });

  test("a fresh receiver starts unbound", () => {
    const receiver = makeReceiver();
    expect(boundStatusComponentOf(receiver)).toBeUndefined();
    expect(observer.trackedLineCount(receiver)).toBe(0);
  });

  test("observed calls leave the children array to the host's own edits", () => {
    const receiver = makeReceiver();
    notifications = [];
    const before = [...receiver.chatContainer.children];
    prototype.showExtensionNotify.call(receiver, "observe me");
    // One pair appended by the host; nothing added or reordered by us.
    const after = receiver.chatContainer.children;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBe(before.length + 2);
  });
});

describe("notification observer cleanup", () => {
  test("cleanup forgets tracked lines and restores the prototype methods", () => {
    const originalEntry = prototype.showExtensionNotify;
    const originalStatus = prototype.showStatus;
    const events: string[] = [];
    const observer = createNotificationObserver({
      onNotification: () => events.push("notification"),
      onInvalidated: () => events.push("invalidated"),
      onContentVersion: () => events.push("version"),
    });
    const install = observer.install();
    // A receiver must be built against the *patched* prototype: the host
    // entry dispatches through `this.showStatus`.
    const receiver = makeReceiver();
    prototype.showExtensionNotify.call(receiver, "tracked notification");
    expect(events).toEqual(["notification"]);
    expect(observer.trackedLineCount(receiver)).toBe(1);
    install.cleanup();

    expect(prototype.showExtensionNotify).toBe(originalEntry);
    expect(prototype.showStatus).toBe(originalStatus);
    expect(observer.trackedLineCount(receiver)).toBe(0);

    events.length = 0;
    prototype.showExtensionNotify.call(receiver, "after cleanup");
    expect(events).toEqual([]);
  });

  test("a later observer takes over; an out-of-order cleanup does not break it", () => {
    // The patch registry is deliberately single-owner per host method
    // (reload-safe): a second install replaces the behavior slot instead of
    // stacking wrappers. What must hold is that the retired observer stops
    // reporting and keeps no tracked lines, and that cleaning it up out of
    // order leaves the active observer working.
    const pristineStatus = prototype.showStatus;
    const first: string[] = [];
    const second: string[] = [];
    const observerA = createNotificationObserver({
      onNotification: () => first.push("notified"),
      onInvalidated: () => first.push("invalidated"),
      onContentVersion: () => first.push("version"),
    });
    const installA = observerA.install();
    const observerB = createNotificationObserver({
      onNotification: () => second.push("notified"),
      onInvalidated: () => second.push("invalidated"),
      onContentVersion: () => second.push("version"),
    });
    const installB = observerB.install();
    const receiver = makeReceiver();
    prototype.showExtensionNotify.call(receiver, "alpha notification");
    expect(second).toEqual(["notified"]);
    expect(first).toEqual([]);
    // Only the active observer tracks, and it tracks the one live line.
    expect(observerA.trackedLineCount(receiver)).toBe(0);
    expect(observerB.trackedLineCount(receiver)).toBe(1);

    installA.cleanup();
    second.length = 0;
    prototype.showExtensionNotify.call(receiver, "beta notification");
    expect(second).toEqual(["notified"]);
    installB.cleanup();
    expect(observerB.trackedLineCount(receiver)).toBe(0);
    // The last owner restores the host method.
    expect(prototype.showStatus).toBe(pristineStatus);
  });
});
