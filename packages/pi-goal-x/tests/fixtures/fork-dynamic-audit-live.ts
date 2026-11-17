/** Real-runtime fixture: seed isolated input, observe native events, and pace UI review.
 * It never fabricates a verdict, provider response, or reported checklist state. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { AUDIT_PROGRESS_V2_PREFIX } from "../../extensions/fork-audit-progress.ts";

const prefix = "/tmp/pi-e2e-dynamic-audit-";
const self = fileURLToPath(import.meta.url);

export default function liveFixture(pi: ExtensionAPI): void {
  let cwd = "";
  let sessionId = "";
  const trace = (data: object) => {
    if (cwd.startsWith(prefix))
      appendFileSync(
        path.join(cwd, "audit-trace.jsonl"),
        JSON.stringify({ at: Date.now(), sessionId, ...data }) + "\n",
      );
  };
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
    if (!cwd.startsWith(prefix))
      throw new Error(
        "Dynamic audit fixture requires its isolated /tmp environment.",
      );
    if (process.env.PI_SUBAGENT_PARENT_SESSION) return;
    if (existsSync(path.join(cwd, "seeded"))) return;
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const extras = Array.from(
      { length: 10 },
      (_, i) =>
        `核验 evidence.txt 中存在 CHECK-${String(i + 1).padStart(2, "0")}，并说明实际读取结果`,
    );
    writeFileSync(
      path.join(cwd, "evidence.txt"),
      "DELIVERY-READY\n" +
        extras
          .map(
            (_, i) =>
              `CHECK-${String(i + 1).padStart(2, "0")}: verified fixture line`,
          )
          .join("\n") +
        "\n",
    );
    writeFileSync(
      path.join(cwd, ".pi", "pi-goal-x-settings.json"),
      JSON.stringify(
        {
          disableTasks: true,
          maxAutonomousRuns: 0,
          auditor: {
            timeoutMs: 420000,
            thinkingLevel: "off",
            changeManifest: "off",
            checklist: ["读取 evidence.txt，确认交付标记 DELIVERY-READY 存在"],
            checklistExtra: extras,
            tools: ["read", "grep", "find", "ls", "audit_review_barrier"],
            subagentOnlyExtensions: [self],
            instructions:
              "逐项使用给定 checkId 上报 running，然后根据实际读取 evidence.txt 的证据上报 passed 或 failed 和 detail。不要用百分比替代逐项状态。所有项目核验并上报后，必须调用一次 audit_review_barrier 等待测试观察结束，再独立判断并调用 structured_output。barrier 只控制测试观察时间，不是证据，也不授权批准。",
          },
        },
        null,
        2,
      ),
    );
    const goal = createGoal({
      objective:
        "验证 evidence.txt 包含 DELIVERY-READY 及 CHECK-01 到 CHECK-10 全部十行。通过实际读取确认这些内容后请求独立完成审计。",
      autoContinue: false,
      sisyphus: false,
    });
    writeActiveGoalFile({ cwd }, goal);
    pi.appendEntry("pi-goal-focus", goalFocusDetails(goal.id, "created"));
    writeFileSync(path.join(cwd, "seeded"), goal.id);
    trace({
      kind: "seed",
      goalId: goal.id,
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });
  pi.on("agent_end", () => trace({ kind: "agent_end" }));
  pi.registerTool(
    defineTool({
      name: "audit_review_barrier",
      label: "Wait for dashboard observation",
      description:
        "Wait for the isolated E2E dashboard observation. This is pacing only, not evidence or approval.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute(_id, _params, signal) {
        if (!cwd.startsWith(prefix))
          throw new Error("Not an isolated dynamic audit test.");
        trace({ kind: "barrier_enter" });
        const end = Date.now() + 600000;
        while (!existsSync(path.join(cwd, "review-ready"))) {
          if (signal?.aborted) throw new Error("Review observation cancelled.");
          if (Date.now() > end)
            throw new Error("Review observation timed out.");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        trace({ kind: "barrier_exit" });
        return {
          content: [
            {
              type: "text",
              text: "Dashboard observation finished. Independently decide the verdict from actual evidence; this signal is not evidence or approval.",
            },
          ],
          details: {},
        };
      },
    }),
  );
  for (const [event, kind] of [
    ["prompt-template:subagent:request", "request"],
    ["prompt-template:subagent:started", "started"],
    ["prompt-template:subagent:update", "update"],
    ["prompt-template:subagent:response", "response"],
    ["prompt-template:subagent:cancel", "cancel"],
  ] as const) {
    pi.events.on(event, (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const data = raw as Record<string, unknown>;
      if (kind !== "update") {
        const result = data.result as
          | { value?: { verdict?: string } }
          | undefined;
        trace({
          kind,
          requestId: data.requestId,
          runId: data.runId,
          nodeId: data.nodeId,
          status: data.status,
          verdict: result?.value?.verdict,
        });
      }
      for (const line of Array.isArray(data.recentOutputLines)
        ? data.recentOutputLines
        : []) {
        if (
          typeof line !== "string" ||
          !line.startsWith(AUDIT_PROGRESS_V2_PREFIX)
        )
          continue;
        try {
          const record = JSON.parse(
            line.slice(AUDIT_PROGRESS_V2_PREFIX.length),
          ) as { sequence?: number; checkId?: string; state?: string };
          trace({
            kind: "progress",
            requestId: data.requestId,
            sequence: record.sequence,
            checkId: record.checkId,
            state: record.state,
          });
        } catch {
          trace({ kind: "progress_parse_error" });
        }
      }
    });
  }
}
