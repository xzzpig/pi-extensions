import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";

import {
  CHILD_REPORT_ATTEMPT_ENTRY,
  readChildReportSession,
  registerChildReportTool,
} from "../src/child-report-reader.ts";
import { reportPlanReviewTool } from "../src/report-tools.ts";

/** Exercise a real Pi session and real extension hooks, without a network model. */
test("a custom wake reports under its dispatch attempt and a later user prompt gets a new one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-custom-wake-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const errors: unknown[] = [];
  const triggers: string[] = [];
  let wake: (() => void) | undefined;
  let settled: (() => void) | undefined;
  let settledCount = 0;
  let request = 0;
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        registerChildReportTool(pi, {
          agent: "opsx-plan-review",
          tool: reportPlanReviewTool,
        });
        wake = () =>
          pi.sendMessage(
            {
              customType: "subagent-notice",
              content: "child finished",
              display: false,
            },
            { triggerTurn: true },
          );
        pi.on("before_agent_start", (event) => {
          triggers.push(
            "messageType" in event ? String(event.messageType) : "user",
          );
        });
        pi.on("agent_settled", () => {
          settledCount += 1;
          // The hook itself runs inside Pi's settle phase. Wait one event-loop
          // turn before submitting the next prompt, rather than queueing it.
          if (settledCount === 2 && settled) setImmediate(settled);
        });
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("opsx-wake-test", {
    api: "opsx-wake-test-api",
    baseUrl: "http://127.0.0.1:1/unused",
    apiKey: "unused",
    models: [
      {
        id: "local",
        name: "Local fake",
        api: "opsx-wake-test-api",
        input: ["text"],
        output: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
      },
    ],
    streamSimple(model: { api: string; provider: string; id: string }) {
      const report = request++ === 1;
      const message: AssistantMessage = {
        role: "assistant",
        content: report
          ? [
              {
                type: "toolCall",
                id: "wake-report",
                name: reportPlanReviewTool.name,
                arguments: { verdict: "OKAY", issues: [], summary: "fine" },
              },
            ]
          : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: report ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.end(message);
      });
      return stream;
    },
  } as never);
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  try {
    await resourceLoader.reload();
    const model = modelRuntime.getModel("opsx-wake-test", "local");
    expect(model).toBeDefined();
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader,
      modelRuntime,
      model: model!,
      sessionManager: manager,
      noTools: "builtin",
    }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    const stepStartedAt = new Date().toISOString();
    await session.prompt("review the plan");
    const entries = () =>
      manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === CHILD_REPORT_ATTEMPT_ENTRY,
        );
    const first = entries();
    expect(first).toHaveLength(1);
    const attemptId = (first[0] as { data: { attemptId: string } }).data
      .attemptId;

    const woken = new Promise<void>((resolve) => {
      settled = resolve;
    });
    expect(wake).toBeDefined();
    wake!();
    await woken;
    await session.waitForIdle();
    expect(errors).toEqual([]);
    expect(entries()).toHaveLength(1);
    const report = session.messages.find(
      (message) =>
        message.role === "toolResult" && message.toolCallId === "wake-report",
    );
    expect(report).toMatchObject({
      isError: false,
      details: { attemptId, agent: "opsx-plan-review" },
    });
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const read = readChildReportSession({
      agent: "opsx-plan-review",
      toolName: reportPlanReviewTool.name,
      runId: "wake-test-run",
      stepIndex: 0,
      sessionRoot: sessionDir,
      sessionFile: sessionFile as string,
      stepStartedAt,
      stepEndedAt: new Date().toISOString(),
      stepTerminal: true,
    });
    expect(read).toMatchObject({
      status: "ready",
      toolCallId: "wake-report",
      attempt: { attemptId },
      report: { verdict: "OKAY" },
    });
    if (process.env.PI_COMPAT_EXPECT_CUSTOM_HOOK === "1") {
      expect(triggers).toEqual(["user", "custom"]);
    }

    await session.prompt("review again");
    expect(entries()).toHaveLength(2);
    expect(
      (entries()[1] as { data: { attemptId: string } }).data.attemptId,
    ).not.toBe(attemptId);
    expect(errors).toEqual([]);
  } finally {
    session?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
