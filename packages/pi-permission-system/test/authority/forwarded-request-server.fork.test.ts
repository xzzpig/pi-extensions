import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ForwardedRequestServer } from "#src/authority/forwarded-request-server";
import type { ForwardedPermissionResponse } from "#src/authority/permission-forwarding";
import { PERMISSIONS_FORWARDED_DECISION_CHANNEL } from "#src/service/permission-events";
import { DECIDED_BY_HUMAN } from "#test/helpers/decision-fixtures";
import {
  createForwardingTempDir,
  type ForwardingTempDir,
  makeForwarderContext,
  makeServerDeps,
} from "#test/helpers/forwarding-fixtures";
import { makeCheckResult, makeEvents } from "#test/helpers/handler-fixtures";

let temp: ForwardingTempDir | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
  vi.unstubAllEnvs();
});

function readResponse(
  dir: ForwardingTempDir,
  requestId: string,
): ForwardedPermissionResponse {
  const raw = readFileSync(
    join(dir.location.responsesDir, `${requestId}.json`),
    "utf-8",
  );
  try {
    return JSON.parse(raw) as ForwardedPermissionResponse;
  } catch (error) {
    throw new Error(
      `Forwarded permission response '${requestId}' was not valid JSON.`,
      { cause: error },
    );
  }
}

// Fork-only tests: the persisted forwarded-decision broadcast (upstream
// `forwarded-request-server.test.ts` covers the file-based response flow).

describe("forwarded decision broadcasts", () => {
  test("emits once after the response is persisted and does not emit a gate decision", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({
      id: "req-event",
      source: "tool_call",
      surface: "bash",
      value: "git push",
    });
    const events = makeEvents();
    const responseSeenWhenEmitted = vi.fn((channel: string) => {
      if (channel === PERMISSIONS_FORWARDED_DECISION_CHANNEL) {
        expect(readResponse(temp!, "req-event")).toMatchObject({
          approved: true,
          state: "approved",
        });
      }
    });
    events.emit.mockImplementation(responseSeenWhenEmitted);
    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        events,
        policy: { resolve: vi.fn(() => makeCheckResult({ state: "ask" })) },
        escalator: {
          escalate: vi.fn().mockResolvedValue({
            approved: true,
            state: "approved",
            decidedBy: DECIDED_BY_HUMAN,
          }),
        },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(responseSeenWhenEmitted).toHaveBeenCalledWith(
      PERMISSIONS_FORWARDED_DECISION_CHANNEL,
      expect.anything(),
    );
    expect(events.emit).toHaveBeenCalledWith(
      PERMISSIONS_FORWARDED_DECISION_CHANNEL,
      expect.objectContaining({
        requestId: "req-event",
        source: "tool_call",
        surface: "bash",
        value: "git push",
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
        responderSessionId: "parent-session",
        result: "allow",
        resolution: "user_approved",
      }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      "permissions:decision",
      expect.anything(),
    );
  });

  test("does not emit when persisting the response fails", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({ id: "req-write-failure" });
    const events = makeEvents();
    const writeResponse = vi.fn(() => {
      throw new Error("disk full");
    });
    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        events,
        writeResponse,
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(writeResponse).toHaveBeenCalledOnce();
    expect(events.emit).not.toHaveBeenCalledWith(
      PERMISSIONS_FORWARDED_DECISION_CHANNEL,
      expect.anything(),
    );
  });

  test("does not rebroadcast a request id when the request is processed again", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({ id: "req-duplicate" });
    const events = makeEvents();
    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        events,
      }),
    );
    const context = makeForwarderContext({
      hasUI: true,
      sessionId: "parent-session",
    });

    await server.processInbox(context);
    mkdirSync(temp.location.requestsDir, { recursive: true });
    temp.writeRequest({ id: "req-duplicate" });
    await server.processInbox(context);

    expect(
      events.emit.mock.calls.filter(
        ([channel]) => channel === PERMISSIONS_FORWARDED_DECISION_CHANNEL,
      ),
    ).toHaveLength(1);
  });
});
