/**
 * Child report attempt and wrapper tests (design D1).
 *
 * The wrapper is the only place the parent can trust: it must keep the
 * business tool byte-for-byte (same name, same schema, same confirmation
 * text) and add attribution as *result metadata* only. These tests pin that
 * boundary from both sides — the model can never fill an `attemptId`, and a
 * report without a persisted attempt fails loudly instead of producing a
 * plausible-looking success the parent would silently discard.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";

import {
  attemptUnavailableMessage,
  beginChildReportAttempt,
  buildChildReportAttempt,
  CHILD_REPORT_ATTEMPT_ENTRY,
  CHILD_REPORT_ATTEMPT_VERSION,
  CHILD_REPORT_ENVELOPE_VERSION,
  type ChildSessionExpectation,
  MAX_REPORT_BYTES,
  MAX_REPORT_CALLS,
  MAX_SESSION_BYTES,
  MAX_SESSION_ENTRIES,
  MAX_SESSION_LINE_BYTES,
  promptDigest,
  readChildReportMessages,
  readChildReportSession,
  registerChildReportTool,
  scanDispatchMarkers,
  validateChildReport,
} from "../src/child-report-reader.ts";
import {
  REPORT_PLAN_REVIEW_TOOL_NAME,
  REPORT_WORK_TOOL_NAME,
  reportGapAnalysisTool,
  reportPlanReviewTool,
  reportWorkTool,
} from "../src/report-tools.ts";

const ctx = {
  sessionManager: { getSessionId: () => "child-session-42" },
} as unknown as ExtensionContext;

interface Captured {
  pi: ExtensionAPI;
  tools: ToolDefinition[];
  beforeStart: Array<(event: unknown, ctx: unknown) => unknown>;
  entries: Array<{ customType: string; data: unknown }>;
  failWrites?: boolean;
}

function capturePi(): Captured {
  const captured: Captured = {
    tools: [],
    beforeStart: [],
    entries: [],
    pi: undefined as unknown as ExtensionAPI,
  };
  captured.pi = {
    registerTool: (tool: ToolDefinition) => {
      captured.tools.push(tool);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "before_agent_start") captured.beforeStart.push(handler);
      return () => {};
    },
    appendEntry: (customType: string, data?: unknown) => {
      if (captured.failWrites) throw new Error("session is read-only");
      captured.entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return captured;
}

function startTurn(captured: Captured, prompt: string): void {
  captured.beforeStart[0]({ type: "before_agent_start", prompt }, ctx);
}

describe("dispatch marker extraction", () => {
  test("reads the marker wherever it appears, not only on its own line", () => {
    // A real model writes `Task: [OPSX WORKER DISPATCH task=1.1]`; requiring
    // a line start would make the wrapper throw and deadlock every task.
    expect(
      scanDispatchMarkers(
        `Task: [OPSX WORKER DISPATCH task=${encodeURIComponent("1.1")}]`,
      ),
    ).toEqual(["1.1"]);
  });

  test("decodes URI-encoded ids and keeps them unique in first-seen order", () => {
    expect(
      scanDispatchMarkers(
        `[OPSX WORKER DISPATCH task=${encodeURIComponent("任务 1.2")}]`,
      ),
    ).toEqual(["任务 1.2"]);
    expect(
      scanDispatchMarkers(
        "[OPSX WORKER DISPATCH task=a] and [OPSX WORKER DISPATCH task=a]",
      ),
    ).toEqual(["a"]);
  });

  test("a marker repeated with different ids stays ambiguous", () => {
    // Uniqueness, not line anchoring, is the safety property (design D3).
    expect(
      scanDispatchMarkers(
        "[OPSX WORKER DISPATCH task=1.1] [OPSX WORKER DISPATCH task=1.2]",
      ),
    ).toEqual(["1.1", "1.2"]);
  });

  test("prompts without a marker yield nothing", () => {
    expect(scanDispatchMarkers("just do the work")).toEqual([]);
    expect(scanDispatchMarkers("[OPSX WORKER DISPATCH task=]")).toEqual([]);
    expect(scanDispatchMarkers("[OPSX WORKER DISPATCH task=1.1")).toEqual([]);
  });
});

describe("attempt metadata", () => {
  test("a single marker becomes the task marker; none or several do not", () => {
    const one = buildChildReportAttempt({
      agent: "opsx-worker",
      prompt: "[OPSX WORKER DISPATCH task=3.4]",
    });
    expect(one.taskMarker).toBe("3.4");
    expect(
      buildChildReportAttempt({ agent: "opsx-worker", prompt: "no marker" })
        .taskMarker,
    ).toBeUndefined();
    expect(
      buildChildReportAttempt({
        agent: "opsx-worker",
        prompt: "[OPSX WORKER DISPATCH task=1] [OPSX WORKER DISPATCH task=2]",
      }).taskMarker,
    ).toBeUndefined();
  });

  test("the payload records the agent, session, digest and a fresh nonce", () => {
    const attempt = buildChildReportAttempt({
      agent: "opsx-plan-review",
      prompt: "review it",
      sessionId: "s-9",
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(attempt).toEqual({
      version: CHILD_REPORT_ATTEMPT_VERSION,
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      agent: "opsx-plan-review",
      sessionId: "s-9",
      startedAt: "2026-01-02T03:04:05.000Z",
      promptSha256: promptDigest("review it"),
    });
    expect(promptDigest("review it")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("beginChildReportAttempt persists the entry on the session", () => {
    const captured = capturePi();
    const outcome = beginChildReportAttempt(captured.pi, ctx, {
      agent: "opsx-worker",
      prompt: "[OPSX WORKER DISPATCH task=7.1]",
    });
    expect(outcome.ok).toBe(true);
    expect(captured.entries).toHaveLength(1);
    expect(captured.entries[0].customType).toBe(CHILD_REPORT_ATTEMPT_ENTRY);
    expect(captured.entries[0].data).toMatchObject({
      agent: "opsx-worker",
      sessionId: "child-session-42",
      taskMarker: "7.1",
    });
  });

  test("a failed entry write is reported, never swallowed", () => {
    const captured = capturePi();
    captured.failWrites = true;
    const outcome = beginChildReportAttempt(captured.pi, ctx, {
      agent: "opsx-worker",
      prompt: "task",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("session is read-only");
  });
});

describe("wrapped tool surface", () => {
  const CASES = [
    { agent: "opsx-gap-analysis", tool: reportGapAnalysisTool },
    { agent: "opsx-plan-review", tool: reportPlanReviewTool },
    { agent: "opsx-worker", tool: reportWorkTool },
  ] as const;

  test("the model-visible surface is unchanged: same name, schema and text", () => {
    for (const item of CASES) {
      const captured = capturePi();
      registerChildReportTool(captured.pi, {
        agent: item.agent,
        tool: item.tool,
      });
      const wrapped = captured.tools[0];
      expect(wrapped.name).toBe(item.tool.name);
      expect(wrapped.label).toBe(item.tool.label);
      expect(wrapped.description).toBe(item.tool.description);
      expect(wrapped.promptSnippet).toBe(item.tool.promptSnippet);
      expect(wrapped.promptGuidelines).toEqual(item.tool.promptGuidelines);
      expect(wrapped.executionMode).toBe("sequential");
      // Same schema object: no `attemptId` (or any envelope field) became a
      // model-fillable parameter.
      expect(wrapped.parameters).toBe(item.tool.parameters);
      expect(JSON.stringify(wrapped.parameters)).not.toContain("attemptId");
      expect(captured.beforeStart).toHaveLength(1);
    }
  });

  test("the envelope carries the current nonce and the untouched report", async () => {
    const captured = capturePi();
    registerChildReportTool(captured.pi, {
      agent: "opsx-worker",
      tool: reportWorkTool,
    });
    startTurn(captured, "[OPSX WORKER DISPATCH task=1.1]");
    const attemptId = (captured.entries[0].data as { attemptId: string })
      .attemptId;

    const report = {
      taskId: "1.1",
      changedFiles: ["src/a.ts"],
      claims: "done",
      selfVerification: { command: "node check.cjs", result: "exit 0" },
      verificationPassed: true,
    };
    const result = await captured.tools[0].execute(
      "call-1",
      report as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content[0]).toMatchObject({
      text: "Work report recorded for task 1.1 (1 changed files).",
    });
    expect(result.details).toEqual({
      version: CHILD_REPORT_ENVELOPE_VERSION,
      attemptId,
      agent: "opsx-worker",
      report,
    });
  });

  test("a later prompt never reuses the earlier nonce", async () => {
    const captured = capturePi();
    registerChildReportTool(captured.pi, {
      agent: "opsx-plan-review",
      tool: reportPlanReviewTool,
    });
    startTurn(captured, "first review");
    startTurn(captured, "second review");
    const nonces = captured.entries.map(
      (entry) => (entry.data as { attemptId: string }).attemptId,
    );
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);

    const result = await captured.tools[0].execute(
      "call-2",
      { verdict: "OKAY", issues: [], summary: "fine" } as never,
      undefined,
      undefined,
      {} as never,
    );
    // The envelope names the latest attempt, not the first one.
    expect((result.details as { attemptId: string }).attemptId).toBe(nonces[1]);
  });

  test("reporting before any attempt exists is refused, not faked", async () => {
    const captured = capturePi();
    registerChildReportTool(captured.pi, {
      agent: "opsx-worker",
      tool: reportWorkTool,
    });
    const result = await captured.tools[0].execute(
      "call-3",
      {
        taskId: "1.1",
        changedFiles: [],
        claims: "x",
        selfVerification: {},
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: attemptUnavailableMessage("opsx-worker"),
    });
  });

  test("a turn whose attempt write failed cannot report either", async () => {
    const captured = capturePi();
    captured.failWrites = true;
    registerChildReportTool(captured.pi, {
      agent: "opsx-worker",
      tool: reportWorkTool,
    });
    startTurn(captured, "[OPSX WORKER DISPATCH task=1.1]");
    const result = await captured.tools[0].execute(
      "call-4",
      {
        taskId: "1.1",
        changedFiles: [],
        claims: "x",
        selfVerification: {},
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D2: reading a report out of a run's messages
// ---------------------------------------------------------------------------

describe("readChildReportMessages", () => {
  const ATTEMPT = "11111111-2222-3333-4444-555555555555";
  const WORK = REPORT_WORK_TOOL_NAME;
  const expected = {
    agent: "opsx-worker",
    toolName: WORK,
    attemptId: ATTEMPT,
    taskId: "1.1",
  };

  const report = {
    taskId: "1.1",
    changedFiles: ["src/a.ts"],
    claims: "done",
    selfVerification: { command: "node check.cjs", result: "exit 0" },
    verificationPassed: true,
  };

  /** One assistant message making a report call. */
  function callMessage(id: string, args: unknown = report) {
    return {
      role: "assistant",
      content: [{ type: "toolCall", id, name: WORK, arguments: args }],
    };
  }

  /** One tool result for a call id. */
  function resultMessage(
    id: string,
    options: {
      details?: unknown;
      isError?: boolean;
      toolName?: string;
      content?: unknown;
    } = {},
  ) {
    // An explicitly passed `details` wins even when it is `undefined`, so a
    // test can express "this result carries no envelope".
    const hasExplicitDetails = Object.prototype.hasOwnProperty.call(
      options,
      "details",
    );
    return {
      role: "toolResult",
      toolCallId: id,
      toolName: options.toolName ?? WORK,
      isError: options.isError ?? false,
      content: options.content ?? [{ type: "text", text: "recorded" }],
      details: hasExplicitDetails
        ? options.details
        : {
            version: CHILD_REPORT_ENVELOPE_VERSION,
            attemptId: ATTEMPT,
            agent: "opsx-worker",
            report,
          },
    };
  }

  test("a valid call with its paired success yields the validated report", () => {
    const result = readChildReportMessages(
      [callMessage("c1"), resultMessage("c1")],
      expected,
    );
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.toolCallId).toBe("c1");
      expect(result.report).toEqual(report);
    }
  });

  test("a run with no report call reports none, not ready", () => {
    const result = readChildReportMessages(
      [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      expected,
    );
    expect(result.status).toBe("none");
  });

  test("arguments alone are not delivery: an unpaired call is rejected", () => {
    const result = readChildReportMessages([callMessage("c1")], expected);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("no paired tool result");
    }
  });

  test("a later failing call blocks the earlier success", () => {
    const result = readChildReportMessages(
      [
        callMessage("c1"),
        resultMessage("c1"),
        callMessage("c2"),
        resultMessage("c2", { isError: true }),
      ],
      expected,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("failed");
    }
  });

  test("a late-arriving result for an older call cannot override the newest call", () => {
    // The duplicate result for c1 arrives after c2's; ordering must follow the
    // call order, so c2 still decides.
    const result = readChildReportMessages(
      [
        callMessage("c1"),
        resultMessage("c1"),
        callMessage("c2", { ...report, claims: "second" }),
        resultMessage("c1", { details: undefined }),
      ],
      expected,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("no paired tool result");
    }
  });

  test("the last call decides even when an earlier call was fully valid", () => {
    const result = readChildReportMessages(
      [
        callMessage("c1"),
        resultMessage("c1"),
        callMessage("c2", { ...report, claims: "second" }),
        resultMessage("c2", {
          details: {
            version: CHILD_REPORT_ENVELOPE_VERSION,
            attemptId: "99999999-0000-0000-0000-000000000000",
            agent: "opsx-worker",
            report,
          },
        }),
      ],
      expected,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("different attempt");
    }
  });

  test("an envelope from another role is rejected", () => {
    const result = readChildReportMessages(
      [
        callMessage("c1"),
        resultMessage("c1", {
          details: {
            version: CHILD_REPORT_ENVELOPE_VERSION,
            attemptId: ATTEMPT,
            agent: "opsx-plan-review",
            report,
          },
        }),
      ],
      expected,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("opsx-plan-review");
    }
  });

  test("a report naming another task is rejected", () => {
    const result = readChildReportMessages(
      [
        callMessage("c1", { ...report, taskId: "9.9" }),
        resultMessage("c1", {
          details: {
            version: CHILD_REPORT_ENVELOPE_VERSION,
            attemptId: ATTEMPT,
            agent: "opsx-worker",
            report: { ...report, taskId: "9.9" },
          },
        }),
      ],
      expected,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("9.9");
    }
  });

  test("a schema-invalid report is rejected by the real validator", () => {
    const result = readChildReportMessages(
      [
        callMessage("c1", { ...report, changedFiles: [{ path: "a" }] }),
        resultMessage("c1", {
          details: {
            version: CHILD_REPORT_ENVELOPE_VERSION,
            attemptId: ATTEMPT,
            agent: "opsx-worker",
            report: { ...report, changedFiles: [{ path: "a" }] },
          },
        }),
      ],
      expected,
    );
    expect(result.status).toBe("rejected");
  });

  test("a result with free text but no envelope is not evidence", () => {
    const result = readChildReportMessages(
      [
        callMessage("c1"),
        resultMessage("c1", {
          details: undefined,
          content: [{ type: "text", text: "I finished task 1.1, all good" }],
        }),
      ],
      expected,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("no envelope");
    }
  });

  test("a result from a different tool name is rejected", () => {
    const result = readChildReportMessages(
      [callMessage("c1"), resultMessage("c1", { toolName: "read" })],
      expected,
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("read");
    }
  });

  test("reading the same messages twice is idempotent", () => {
    const messages = [callMessage("c1"), resultMessage("c1")];
    expect(readChildReportMessages(messages, expected)).toEqual(
      readChildReportMessages(messages, expected),
    );
    // A duplicated call/result pair still counts once.
    const duplicated = [
      callMessage("c1"),
      resultMessage("c1"),
      callMessage("c1"),
      resultMessage("c1"),
    ];
    expect(readChildReportMessages(duplicated, expected).status).toBe("ready");
  });

  test("a non-worker role ignores its own task expectation", () => {
    const planReviewReport = { verdict: "OKAY", issues: [], summary: "fine" };
    const result = readChildReportMessages(
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "p1",
              name: REPORT_PLAN_REVIEW_TOOL_NAME,
              arguments: planReviewReport,
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "p1",
          toolName: REPORT_PLAN_REVIEW_TOOL_NAME,
          isError: false,
          content: [{ type: "text", text: "recorded" }],
          details: {
            version: CHILD_REPORT_ENVELOPE_VERSION,
            attemptId: ATTEMPT,
            agent: "opsx-plan-review",
            report: planReviewReport,
          },
        },
      ],
      {
        agent: "opsx-plan-review",
        toolName: REPORT_PLAN_REVIEW_TOOL_NAME,
        attemptId: ATTEMPT,
      },
    );
    expect(result.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// D2: the canonical session record is the authority
// ---------------------------------------------------------------------------

describe("readChildReportSession", () => {
  const ATTEMPT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const WORK = REPORT_WORK_TOOL_NAME;
  const STEP_START = "2026-01-02T02:00:00.000Z";
  const STEP_END = "2026-01-02T04:00:00.000Z";

  const report = {
    taskId: "1.1",
    changedFiles: ["src/a.ts"],
    claims: "done",
    selfVerification: { command: "node check.cjs", result: "exit 0" },
    verificationPassed: true,
  };

  function attemptEntry(attemptId = ATTEMPT, agent = "opsx-worker") {
    return {
      version: CHILD_REPORT_ATTEMPT_VERSION,
      attemptId,
      agent,
      sessionId: "child-1",
      startedAt: "2026-01-02T03:00:00.000Z",
      promptSha256: "0".repeat(64),
    };
  }

  function envelope(
    attemptId = ATTEMPT,
    agent = "opsx-worker",
    body: unknown = report,
  ) {
    return {
      version: CHILD_REPORT_ENVELOPE_VERSION,
      attemptId,
      agent,
      report: body,
    };
  }

  const user = (text = "Task: [OPSX WORKER DISPATCH task=1.1]") =>
    ({ role: "user", content: text, timestamp: 1 }) as never;
  const call = (id: string, name: string, args: unknown) =>
    ({
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      api: "a",
      provider: "p",
      model: "m",
      usage: {},
      stopReason: "toolUse",
      timestamp: 2,
    }) as never;
  const result = (
    id: string,
    name: string,
    details: unknown,
    isError = false,
  ) =>
    ({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: "recorded" }],
      details,
      isError,
      timestamp: 3,
    }) as never;
  const stop = () =>
    ({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "a",
      provider: "p",
      model: "m",
      usage: {},
      stopReason: "endTurn",
      timestamp: 4,
    }) as never;

  function newDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "opsx-reader-"));
  }

  /** Build a real session file with the host's own SessionManager. */
  function buildSession(build: (manager: SessionManager) => void): {
    dir: string;
    file: string;
  } {
    const dir = newDir();
    const manager = SessionManager.create(dir, dir);
    build(manager);
    const file = manager.getSessionFile();
    if (!file) throw new Error("the session manager produced no session file");
    return { dir, file };
  }

  const HEADER = {
    type: "session",
    version: 3,
    id: "sess-1",
    timestamp: "2026-01-02T00:00:00.000Z",
    cwd: "/tmp/opsx-fixture",
  };

  /** Write a hand-crafted session file (for malformed / branched cases). */
  function writeRaw(dir: string, lines: readonly unknown[]): string {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    return file;
  }

  function expectation(
    dir: string,
    file: string,
    overrides: Partial<ChildSessionExpectation> = {},
  ): ChildSessionExpectation {
    return {
      agent: "opsx-worker",
      toolName: WORK,
      attemptId: ATTEMPT,
      taskId: "1.1",
      runId: "run-1",
      stepIndex: 0,
      sessionRoot: dir,
      sessionFile: file,
      stepStartedAt: STEP_START,
      stepEndedAt: STEP_END,
      stepTerminal: true,
      ...overrides,
    };
  }

  test("a session line beyond the line budget is refused", () => {
    const { dir, file } = buildSession(() => {});
    const huge = `{"type":"message","id":"x1","parentId":null,"timestamp":"2026-01-02T00:00:00.000Z","message":{"role":"user","content":"${"a".repeat(
      MAX_SESSION_LINE_BYTES,
    )}"}}`;
    fs.writeFileSync(file, `${JSON.stringify(HEADER)}\n${huge}\n`, "utf8");
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("line budget");
    }
  }, 60_000);

  test("a session beyond the entry budget is refused", () => {
    const { dir, file } = buildSession(() => {});
    const lines = [JSON.stringify(HEADER)];
    let parentId: string | null = null;
    for (let index = 0; index <= MAX_SESSION_ENTRIES; index += 1) {
      const id = `e${index}`;
      lines.push(
        JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp: "2026-01-02T00:00:00.000Z",
        }),
      );
      parentId = id;
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("entries");
    }
  }, 60_000);

  test("a session beyond the total byte budget is refused before parsing", () => {
    const { dir, file } = buildSession(() => {});
    // The size budget is checked from the file stat, before any line is parsed,
    // so an oversized record cannot be partially trusted. A sparse file keeps
    // this instant instead of writing 32 MiB into the test tree.
    fs.writeFileSync(file, `${JSON.stringify(HEADER)}\n`, "utf8");
    fs.truncateSync(file, MAX_SESSION_BYTES + 1);
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("byte budget");
    }
  }, 60_000);

  test("a complete canonical turn yields the report", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    expect(fs.existsSync(file)).toBe(true);
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("ready");
    if (outcome.status === "ready") {
      expect(outcome.report).toEqual(report);
      expect(outcome.attempt.attemptId).toBe(ATTEMPT);
    }
  });

  test("the attempt entry may precede the user dispatch (real hook ordering)", () => {
    // `before_agent_start` writes the attempt entry just before the host
    // persists the user message, so live the dispatch lands *after* the
    // attempt. Requiring the attempt to be "preceded by a user dispatch"
    // rejected every genuine report on the real path.
    const { dir, file } = buildSession((manager) => {
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(user());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("ready");
  });

  test("an attempt with no user dispatch anywhere is still rejected", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).not.toBe("ready");
  });

  test("an earlier nonce cannot authorize the current turn", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(
        CHILD_REPORT_ATTEMPT_ENTRY,
        attemptEntry("99999999-9999-9999-9999-999999999999"),
      );
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("no matching child report attempt");
    }
  });

  test("an attempt with no preceding user dispatch is refused", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(stop());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("user dispatch");
    }
  });

  test("a broken parent chain is refused", () => {
    const dir = newDir();
    const file = writeRaw(dir, [
      HEADER,
      {
        type: "message",
        id: "a1",
        parentId: "missing-parent",
        timestamp: "2026-01-02T03:00:00.000Z",
        message: user(),
      },
    ]);
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("missing parent");
    }
  });

  test("a malformed line is refused rather than skipped", () => {
    const dir = newDir();
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, `${JSON.stringify(HEADER)}\n{not json}\n`, "utf8");
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("not valid JSON");
    }
  });

  test("a duplicate entry id is refused", () => {
    const dir = newDir();
    const entry = {
      type: "message",
      id: "dup",
      parentId: null,
      timestamp: "2026-01-02T03:00:00.000Z",
      message: user(),
    };
    const file = writeRaw(dir, [HEADER, entry, entry]);
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("duplicate");
    }
  });

  test("an unsupported session version is refused", () => {
    const dir = newDir();
    const file = writeRaw(dir, [{ ...HEADER, version: 2 }]);
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("unsupported session version");
    }
  });

  test("an unanswered tool call leaves the run pending, not ready", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(call("c2", "read", { path: "x" }));
    });
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("pending");
  });

  test("an attempt on a non-leaf branch is not visible", () => {
    const dir = newDir();
    const file = writeRaw(dir, [
      HEADER,
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-01-02T02:00:00.000Z",
        message: user(),
      },
      {
        type: "custom",
        id: "b1",
        parentId: "a1",
        timestamp: "2026-01-02T02:30:00.000Z",
        customType: CHILD_REPORT_ATTEMPT_ENTRY,
        data: attemptEntry(),
      },
      {
        type: "message",
        id: "c1",
        parentId: "b1",
        timestamp: "2026-01-02T02:40:00.000Z",
        message: call("c1", WORK, report),
      },
      {
        type: "message",
        id: "d1",
        parentId: "c1",
        timestamp: "2026-01-02T02:50:00.000Z",
        message: result("c1", WORK, envelope()),
      },
      // A different branch from a1 becomes the leaf.
      {
        type: "message",
        id: "e1",
        parentId: "a1",
        timestamp: "2026-01-02T03:30:00.000Z",
        message: user("a different turn"),
      },
      {
        type: "message",
        id: "f1",
        parentId: "e1",
        timestamp: "2026-01-02T03:40:00.000Z",
        message: stop(),
      },
    ]);
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("no matching child report attempt");
    }
  });

  test("a session file outside the attributed root is refused", () => {
    const { file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    const otherRoot = newDir();
    const outcome = readChildReportSession(expectation(otherRoot, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("outside the attributed session root");
    }
  });

  test("a terminal step without an end boundary cannot bound the report", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    const outcome = readChildReportSession(
      expectation(dir, file, { stepEndedAt: undefined }),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("no end boundary");
    }
  });

  test("a report seen while the child still runs is only a candidate", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(stop());
    });
    const outcome = readChildReportSession(
      expectation(dir, file, { stepTerminal: false }),
    );
    expect(outcome.status).toBe("pending");
  });

  test("an unresolvable session path is refused", () => {
    const dir = newDir();
    const outcome = readChildReportSession(
      expectation(dir, path.join(dir, "does-not-exist.jsonl")),
    );
    expect(outcome.status).toBe("failed");
  });

  test("the best-effort diagnostic log is never the authority", () => {
    // The canonical record's last report call failed; a diagnostic log that
    // omits that failure must not let the earlier success through.
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(call("c2", WORK, report));
      manager.appendMessage(result("c2", WORK, envelope(), true));
      manager.appendMessage(stop());
    });
    fs.writeFileSync(
      path.join(dir, "events.jsonl"),
      `${JSON.stringify({ type: "report", status: "ok", toolCallId: "c1" })}\n`,
      "utf8",
    );
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("failed");
    }
  });

  test("dropping the canonical line of the last failure cannot revive the earlier success", () => {
    const { dir, file } = buildSession((manager) => {
      manager.appendMessage(user());
      manager.appendCustomEntry(CHILD_REPORT_ATTEMPT_ENTRY, attemptEntry());
      manager.appendMessage(call("c1", WORK, report));
      manager.appendMessage(result("c1", WORK, envelope()));
      manager.appendMessage(call("c2", WORK, { ...report, claims: "second" }));
      manager.appendMessage(
        result(
          "c2",
          WORK,
          envelope(ATTEMPT, "opsx-worker", { ...report, claims: "second" }),
        ),
      );
      manager.appendMessage(stop());
    });
    // Remove the c2 result line: the newest call is now unpaired, and the
    // entries that followed it are orphaned. Either way the run is not ready —
    // the earlier success must never be used as a fallback.
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const kept = lines.filter(
      (line) => !(line.includes('"c2"') && line.includes("toolResult")),
    );
    fs.writeFileSync(file, kept.join("\n"), "utf8");
    const outcome = readChildReportSession(expectation(dir, file));
    expect(outcome.status).not.toBe("ready");
    expect(["pending", "failed"]).toContain(outcome.status);
  });
});

// ---------------------------------------------------------------------------
// Incremental reading and resource budgets (design D4)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Report budgets: enforced, not merely declared (design D4)
// ---------------------------------------------------------------------------

describe("report budgets", () => {
  const ATTEMPT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const baseReport = {
    taskId: "1.1",
    changedFiles: ["src/a.ts"],
    claims: "done",
    selfVerification: { command: "node check.cjs", result: "exit 0" },
    verificationPassed: true,
  };

  function callAndResult(index: number): unknown[] {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `c${index}`,
            name: REPORT_WORK_TOOL_NAME,
            arguments: baseReport,
          },
        ],
        api: "a",
        provider: "p",
        model: "m",
        usage: {},
        stopReason: "toolUse",
        timestamp: index,
      },
      {
        role: "toolResult",
        toolCallId: `c${index}`,
        toolName: REPORT_WORK_TOOL_NAME,
        content: [{ type: "text", text: "ok" }],
        details: {
          version: CHILD_REPORT_ENVELOPE_VERSION,
          attemptId: ATTEMPT,
          agent: "opsx-worker",
          report: baseReport,
        },
        isError: false,
        timestamp: index,
      },
    ];
  }

  test("a report within the byte budget is accepted", () => {
    const result = validateChildReport(REPORT_WORK_TOOL_NAME, baseReport);
    expect(result.ok).toBe(true);
  });

  test("a report beyond the byte budget is refused, not truncated", () => {
    const oversized = {
      ...baseReport,
      claims: "x".repeat(MAX_REPORT_BYTES + 1024),
    };
    const result = validateChildReport(REPORT_WORK_TOOL_NAME, oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("report budget");
  });

  test("more report calls than the call budget is a refusal", () => {
    const messages: unknown[] = [];
    for (let index = 0; index <= MAX_REPORT_CALLS; index += 1) {
      messages.push(...callAndResult(index));
    }
    const result = readChildReportMessages(messages, {
      agent: "opsx-worker",
      toolName: REPORT_WORK_TOOL_NAME,
      attemptId: ATTEMPT,
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("report-call budget");
    }
  });

  test("a run exactly at the call budget is still readable", () => {
    const messages: unknown[] = [];
    for (let index = 0; index < MAX_REPORT_CALLS; index += 1) {
      messages.push(...callAndResult(index));
    }
    const result = readChildReportMessages(messages, {
      agent: "opsx-worker",
      toolName: REPORT_WORK_TOOL_NAME,
      attemptId: ATTEMPT,
    });
    expect(result.status).toBe("ready");
  });
});

describe("dispatch marker tolerance (design D3)", () => {
  // The marker is the attribution key. Live, every dispatch was recorded
  // `taskUnknown` because the model wrote a shape the strict prefix scan did
  // not recognise, so a well-meant marker was silently ignored.
  const accepted: Array<[string, string]> = [
    ["canonical", "## Task\n[OPSX WORKER DISPATCH task=1.1]"],
    ["labelled", "Task: [OPSX WORKER DISPATCH task=1.1]"],
    ["backticked", "`[OPSX WORKER DISPATCH task=1.1]`"],
    ["spaces around =", "[OPSX WORKER DISPATCH task = 1.1]"],
    ["colon variant", "[OPSX WORKER DISPATCH: task=1.1]"],
    ["lowercase", "[opsx worker dispatch task=1.1]"],
    ["percent-encoded", "[OPSX WORKER DISPATCH task=1%2E1]"],
  ];

  for (const [label, prompt] of accepted) {
    test(`accepts the ${label} form`, () => {
      expect(scanDispatchMarkers(prompt)).toEqual(["1.1"]);
    });
  }

  test("still rejects an unbracketed mention", () => {
    expect(scanDispatchMarkers("OPSX WORKER DISPATCH task=1.1")).toEqual([]);
  });

  test("still rejects two different task ids", () => {
    expect(
      scanDispatchMarkers(
        "[OPSX WORKER DISPATCH task=1.1] and [OPSX WORKER DISPATCH task=1.2]",
      ),
    ).toEqual(["1.1", "1.2"]);
  });
});
