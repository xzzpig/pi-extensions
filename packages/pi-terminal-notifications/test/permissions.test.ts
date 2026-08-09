import { describe, expect, it, vi } from "vitest";

import {
  createPermissionPromptTracker,
  parseForwardedPermissionDecision,
  parsePermissionDecision,
} from "../extensions/permissions.js";

function decision(overrides: Record<string, unknown> = {}) {
  return parsePermissionDecision({
    agentName: "Worker",
    resolution: "user_approved",
    surface: "bash",
    value: "git status",
    ...overrides,
  });
}

function forwardedDecision(overrides: Record<string, unknown> = {}) {
  return parseForwardedPermissionDecision({
    forwarding: {
      requesterAgentName: "Worker",
      requesterSessionId: "child-session",
    },
    requestId: "forwarded-request",
    responderSessionId: "parent-session",
    respondedAt: 1_700_000_000_000,
    resolution: "user_approved",
    result: "allow",
    ...overrides,
  });
}

describe("permission prompt tracking", () => {
  it("resolves a direct permission prompt only from an interactive decision", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    tracker.track({
      agentName: "Worker",
      requestId: "direct-request",
      surface: "bash",
      value: "git status",
    });

    expect(
      tracker.resolveDecision(decision({ resolution: "policy_allow" })!),
    ).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();

    expect(tracker.resolveDecision(decision()!)).toBe(true);
    expect(onResolved).toHaveBeenCalledWith("direct-request");
  });

  it("matches concurrent direct prompts by their public decision projection", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    tracker.track({
      agentName: "Worker",
      requestId: "request-bash",
      surface: "bash",
      value: "git status",
    });
    tracker.track({
      agentName: "Worker",
      requestId: "request-read",
      surface: "read",
      value: "/tmp/file",
    });

    expect(
      tracker.resolveDecision(
        decision({ surface: "read", value: "/tmp/file" })!,
      ),
    ).toBe(true);
    expect(onResolved).toHaveBeenCalledWith("request-read");
    expect(tracker.resolveDecision(decision()!)).toBe(true);
    expect(onResolved).toHaveBeenCalledWith("request-bash");
  });

  it("resolves a sole direct prompt when display and decision projections differ", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    const command = "find ~/.pi -name package.json";
    tracker.track({
      agentName: "Worker",
      requestId: "external-directory-request",
      surface: "bash",
      value: command,
    });

    expect(
      tracker.resolveDecision(
        decision({
          resolution: "user_approved_for_session",
          surface: "external_directory",
          value: command,
        })!,
      ),
    ).toBe(true);
    expect(onResolved).toHaveBeenCalledWith("external-directory-request");
  });

  it("does not use projection fallback when multiple direct prompts remain", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    tracker.track({
      agentName: "Worker",
      requestId: "first-request",
      surface: "bash",
      value: "first command",
    });
    tracker.track({
      agentName: "Worker",
      requestId: "second-request",
      surface: "bash",
      value: "second command",
    });

    expect(
      tracker.resolveDecision(
        decision({
          surface: "external_directory",
          value: "unmatched command",
        })!,
      ),
    ).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("does not use projection fallback for a different agent", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    tracker.track({
      agentName: "Other worker",
      requestId: "other-agent-request",
      surface: "bash",
      value: "command",
    });

    expect(
      tracker.resolveDecision(
        decision({
          surface: "external_directory",
          value: "command",
        })!,
      ),
    ).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("resolves same-projection direct prompts in order when agentName is omitted", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    tracker.track({
      agentName: "Worker",
      requestId: "request-first",
      surface: "bash",
      value: "git status",
    });
    tracker.track({
      agentName: "Worker",
      requestId: "request-second",
      surface: "bash",
      value: "git status",
    });

    const agentlessDecision = decision({ agentName: null })!;
    expect(tracker.resolveDecision(agentlessDecision)).toBe(true);
    expect(onResolved).toHaveBeenCalledExactlyOnceWith("request-first");
    expect(tracker.resolveDecision(agentlessDecision)).toBe(true);
    expect(onResolved).toHaveBeenLastCalledWith("request-second");
  });

  it("resolves a forwarded prompt only from its correlated parent response", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    tracker.track({
      forwarding: { requesterSessionId: "child-session" },
      requestId: "forwarded-request",
      surface: "bash",
      value: "git status",
    });

    expect(tracker.resolveDecision(decision()!)).toBe(false);
    expect(
      tracker.resolveForwardedDecision(
        forwardedDecision({ requestId: "other-request" })!,
      ),
    ).toBe(false);
    expect(tracker.resolveForwardedDecision(forwardedDecision()!)).toBe(true);
    expect(onResolved).toHaveBeenCalledWith("forwarded-request");
    expect(tracker.resolveForwardedDecision(forwardedDecision()!)).toBe(false);
  });

  it("rejects malformed forwarded-decision payloads", () => {
    expect(
      parseForwardedPermissionDecision({
        requestId: "forwarded-request",
        result: "allow",
      }),
    ).toBeUndefined();
    expect(
      parseForwardedPermissionDecision({
        forwarding: {},
        requestId: "forwarded-request",
        responderSessionId: "parent-session",
        respondedAt: 1,
        resolution: "user_approved",
        result: "unknown",
      }),
    ).toBeUndefined();
  });

  it("clears pending prompts without resolving them at session shutdown", () => {
    const onResolved = vi.fn();
    const tracker = createPermissionPromptTracker({ onResolved });
    tracker.track({
      forwarding: { requesterSessionId: "child-session" },
      requestId: "forwarded-request",
    });
    tracker.shutdown();

    expect(tracker.resolveForwardedDecision(forwardedDecision()!)).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });
});
