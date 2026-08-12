import { describe, expect, it } from "vitest";

import {
  classifyAgentEnd,
  createAgentRunTracker,
} from "../extensions/agent-events.js";

describe("classifyAgentEnd", () => {
  it("uses the last assistant message stop reason", () => {
    expect(
      classifyAgentEnd({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "done", stopReason: "stop" },
        ],
      }),
    ).toBe("completed");
    expect(
      classifyAgentEnd({
        messages: [
          { role: "assistant", content: "x", stopReason: "tool_use" },
          { role: "toolResult", content: "ok", isError: false },
          { role: "assistant", content: "y", stopReason: "error" },
        ],
      }),
    ).toBe("error");
  });

  it("maps length to error and aborted to silent", () => {
    expect(
      classifyAgentEnd({
        messages: [{ role: "assistant", stopReason: "length" }],
      }),
    ).toBe("error");
    expect(
      classifyAgentEnd({
        messages: [{ role: "assistant", stopReason: "aborted" }],
      }),
    ).toBe("silent");
  });

  it("treats an unknown or missing reason as completed", () => {
    expect(classifyAgentEnd({})).toBe("completed");
    expect(classifyAgentEnd({ messages: [{ role: "assistant" }] })).toBe(
      "completed",
    );
    expect(
      classifyAgentEnd({
        messages: [{ role: "assistant", stopReason: "strange" }],
      }),
    ).toBe("completed");
  });
});

describe("agent run tracker", () => {
  it("produces one completed result across retries", () => {
    const tracker = createAgentRunTracker();
    tracker.onAgentStart();
    tracker.onAgentEnd({
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    // Pi retries inside the same visible run.
    tracker.onAgentEnd({
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    expect(tracker.onSettled()).toBe("completed");
    expect(tracker.onSettled()).toBeUndefined();
  });

  it("produces agent-error for a final error", () => {
    const tracker = createAgentRunTracker();
    tracker.onAgentStart();
    tracker.onAgentEnd({
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    expect(tracker.onSettled()).toBe("error");
  });

  it("stays silent on aborted and when no run was active", () => {
    const tracker = createAgentRunTracker();
    expect(tracker.onSettled()).toBeUndefined();

    tracker.onAgentStart();
    tracker.onAgentEnd({
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    expect(tracker.onSettled()).toBe("silent");
  });

  it("treats an active run without any agent_end as completed", () => {
    const tracker = createAgentRunTracker();
    tracker.onAgentStart();
    expect(tracker.onSettled()).toBe("completed");
  });

  it("shutdown clears state", () => {
    const tracker = createAgentRunTracker();
    tracker.onAgentStart();
    tracker.shutdown();
    expect(tracker.onSettled()).toBeUndefined();
  });
});
