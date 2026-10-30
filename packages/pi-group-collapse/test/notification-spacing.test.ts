import { describe, expect, test, vi } from "vitest";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
  bindComponent,
  bindNotificationSpacer,
  installRenderProjection,
  refreshNotificationSpacer,
  unbindComponent,
  type NotificationSpacerHost,
} from "../src/host-adapter.ts";

const WIDTH = 80;

describe("notification spacer ownership", () => {
  test("out-of-order cleanup preserves the current installation and restores the host", () => {
    const original = Spacer.prototype.render;
    const host = { chatContainer: new Container() };
    const spacer = new Spacer(1);
    const notification = new Text("notification", 0, 0);
    host.chatContainer.addChild(spacer);
    host.chatContainer.addChild(notification);
    bindComponent(notification);
    const plan = () => ({ kind: "hide" as const });
    const options = {
      isNotificationReceiver: (candidate: NotificationSpacerHost) =>
        candidate === host,
    };
    const first = installRenderProjection(plan, options);
    const second = installRenderProjection(plan, options);
    try {
      bindNotificationSpacer(spacer, notification, host, 0);
      expect(spacer.render(WIDTH)).toEqual([]);
      first.cleanup();
      expect(spacer.render(WIDTH)).toEqual([]);
      expect(new Spacer(1).render(WIDTH)).toHaveLength(1);
    } finally {
      second.cleanup();
      unbindComponent(notification);
    }
    expect(Spacer.prototype.render).toBe(original);
    expect(spacer.render(WIDTH)).toHaveLength(1);
  });

  test("a moved or detached spacer fails safe until its known pair is rescanned", () => {
    const host = { chatContainer: new Container() };
    const spacer = new Spacer(1);
    const notification = new Text("notification", 0, 0);
    host.chatContainer.addChild(spacer);
    host.chatContainer.addChild(notification);
    bindComponent(notification);
    const install = installRenderProjection(() => ({ kind: "hide" }), {
      isNotificationReceiver: (candidate) => candidate === host,
    });
    try {
      bindNotificationSpacer(spacer, notification, host, 0);
      expect(spacer.render(WIDTH)).toEqual([]);
      host.chatContainer.children.unshift(new Spacer(1));
      // The cached index is no longer authoritative: never hide by guess.
      expect(spacer.render(WIDTH)).toHaveLength(1);
      refreshNotificationSpacer(spacer, notification, host, 1);
      expect(spacer.render(WIDTH)).toEqual([]);
      host.chatContainer.children.splice(2, 1);
      expect(spacer.render(WIDTH)).toHaveLength(1);
    } finally {
      install.cleanup();
      unbindComponent(notification);
    }
  });

  test("a missing spacer seam reports degradation and other projections clean up", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Spacer.prototype,
      "render",
    );
    if (!descriptor) throw new Error("host has no own Spacer.render method");
    const notify = vi.fn();
    Object.defineProperty(Spacer.prototype, "render", {
      ...descriptor,
      value: undefined,
    });
    try {
      const install = installRenderProjection(() => undefined, {
        onNotificationSpacerUnavailable: notify,
      });
      expect(install.available).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
      install.cleanup();
    } finally {
      Object.defineProperty(Spacer.prototype, "render", descriptor);
    }
  });
});
