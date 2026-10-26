/**
 * Notification observer tests (change task 1.6).
 *
 * Drives the real InteractiveMode prototype methods (patched by the
 * observer) against stub receivers that carry a real Container, exactly as
 * the 1.2 contract tests do. Pins: raw text and level capture, core-origin
 * separation, tail-reuse as one member, immediate invalidation when the
 * tail is overwritten or moves, untouched children beyond the host's own
 * edits, and full restoration after cleanup.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import {
  boundStatusComponentOf,
  createNotificationObserver,
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
  return receiver;
}

describe("notification observer", () => {
  let cleanup: (() => void) | undefined;
  let notifications: ObservedNotification[];
  let invalidations: NotificationInvalidation[];

  beforeAll(() => {
    initTheme();
    notifications = [];
    invalidations = [];
    const observer: NotificationObserver = createNotificationObserver({
      onNotification: (notification) => notifications.push(notification),
      onInvalidated: (invalidation) => invalidations.push(invalidation),
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
  });

  test("core-originated status lines are never claimed", () => {
    const receiver = makeReceiver();
    notifications = [];
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
    // Still exactly one Spacer/ThemedText pair in the container.
    expect(receiver.chatContainer.children.length).toBe(2);
    expect(boundStatusComponentOf(receiver)).toBe(first.component);
  });

  test("a core overwrite of the bound tail invalidates it once", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    prototype.showExtensionNotify.call(receiver, "ext note");
    const bound = notifications[0].component;
    expect(invalidations).toEqual([]);

    prototype.showStatus.call(receiver, "core overwrites");
    expect(invalidations).toEqual([
      { component: bound, receiver, reason: "overwritten" },
    ]);
    expect(boundStatusComponentOf(receiver)).toBeUndefined();

    // Further core reuses of the tail produce no duplicate invalidation.
    prototype.showStatus.call(receiver, "core again");
    expect(invalidations.length).toBe(1);
    expect(notifications.length).toBe(1);
  });

  test("an appended tail pair invalidates the previous binding first", () => {
    const receiver = makeReceiver();
    notifications = [];
    invalidations = [];
    prototype.showExtensionNotify.call(receiver, "ext note");
    const first = notifications[0].component;

    // Something lands after the tail, so the next status appends.
    receiver.chatContainer.addChild({
      render: () => ["intervening"],
      invalidate: () => {},
    } as never);

    prototype.showExtensionNotify.call(receiver, "ext note two");
    expect(invalidations).toEqual([
      { component: first, receiver, reason: "tail-moved" },
    ]);
    const second = notifications[1];
    expect(second.reusedTail).toBe(false);
    expect(second.component).not.toBe(first);
    expect(boundStatusComponentOf(receiver)).toBe(second.component);
  });

  test("a fresh receiver starts unbound", () => {
    const receiver = makeReceiver();
    expect(boundStatusComponentOf(receiver)).toBeUndefined();
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
  test("after cleanup the prototype methods are restored and silent", () => {
    const originalEntry = prototype.showExtensionNotify;
    const originalStatus = prototype.showStatus;
    const events: string[] = [];
    const observer = createNotificationObserver({
      onNotification: () => events.push("notification"),
      onInvalidated: () => events.push("invalidated"),
    });
    const install = observer.install();
    install.cleanup();

    expect(prototype.showExtensionNotify).toBe(originalEntry);
    expect(prototype.showStatus).toBe(originalStatus);

    const receiver = makeReceiver();
    prototype.showExtensionNotify.call(receiver, "after cleanup");
    expect(events).toEqual([]);
  });
});
