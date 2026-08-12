/**
 * Optional live ntfy smoke test.
 *
 * Skipped by default. Enable it explicitly with:
 *   PI_NOTIFY_SMOKE_TEST=1 \
 *   PI_NOTIFY_SMOKE_URL=https://ntfy.sh \
 *   PI_NOTIFY_SMOKE_TOPIC=<topic> \
 *   PI_NOTIFY_SMOKE_TOKEN=<token> \   # optional
 *   pnpm --filter @xzzpig/pi-notify test
 */
import { describe, expect, it } from "vitest";

import { createNtfySender } from "../extensions/channels/ntfy.js";
import { createNotificationEvent } from "../extensions/events.js";

const enabled = process.env.PI_NOTIFY_SMOKE_TEST === "1";
const serverUrl = process.env.PI_NOTIFY_SMOKE_URL ?? "https://ntfy.sh";
const topic = process.env.PI_NOTIFY_SMOKE_TOPIC ?? "";
const token = process.env.PI_NOTIFY_SMOKE_TOKEN;

const smokeEnabled =
  enabled && topic.length > 0 && /^[-_A-Za-z0-9]{1,64}$/.test(topic);

describe.skipIf(!smokeEnabled)("live ntfy smoke test", () => {
  it("delivers a test notification to the configured topic", async () => {
    const sender = createNtfySender({
      config: {
        serverUrl,
        topic,
        ...(token ? { token } : {}),
        timeoutMs: 10_000,
        eventOptions: {},
      },
      defaultIconUrl:
        "https://cdn.jsdelivr.net/npm/@xzzpig/pi-notify@0.1.0/assets/pi.png",
    });

    await expect(
      sender.send(
        createNotificationEvent({
          id: "task-completed",
          source: "pi-notify-smoke-test",
          label: "pi-notify live smoke test",
          projectName: "smoke",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
