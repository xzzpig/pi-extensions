import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuditChecklist,
  initialAuditChecks,
} from "../extensions/fork-audit-checklist.ts";
import {
  buildGoalAuditorPrompt,
  type AuditorProgress,
} from "../extensions/goal-auditor.ts";
import {
  runGoalCompletionAuditor,
  type GoalAuditorEvents,
} from "../extensions/goal-auditor-delegation.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import { AUDIT_PROGRESS_V2_PREFIX } from "../extensions/fork-audit-progress.ts";
import { installSupervisorResponderAck } from "./fixtures/goal-audit-supervisor-owner.ts";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "@xzzpig/pi-subagents/delegation";

const goal: GoalRecord = {
  id: "dynamic-checklist",
  objective: "Verify the result",
  status: "active",
  autoContinue: true,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  sisyphus: false,
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
};

test("default conditional items retain stable IDs and exact audit wording", () => {
  assert.deepEqual(
    buildAuditChecklist({ goal }).map((i) => i.id),
    ["default-1", "default-2", "default-4"],
  );
  for (const disableContracts of [false, true]) {
    for (const changeManifest of [undefined, " ", "git evidence"]) {
      const list = buildAuditChecklist({
        goal: { verificationContract: "Run tests" },
        settings: { disableContracts },
        changeManifest,
      });
      assert.equal(
        list.some((i) => i.id === "default-3"),
        !disableContracts,
      );
      assert.equal(
        list.some((i) => i.id === "default-5"),
        changeManifest === "git evidence",
      );
      assert.equal(
        list.find((i) => i.id === "default-4")?.label,
        "Explain missing or weak evidence, especially scaffold-versus-final quality gaps.",
      );
    }
  }
});

test("replace, append, empty and duplicate labels keep source and order", () => {
  const settings = {
    auditor: { checklist: ["重复", "重复"], checklistExtra: ["重复"] },
  };
  const list = buildAuditChecklist({
    goal,
    settings,
    changeManifest: "manifest",
  });
  assert.deepEqual(
    list.map((i) => [i.id, i.label, i.source]),
    [
      ["checklist-1", "重复", "checklist"],
      ["checklist-2", "重复", "checklist"],
      ["extra-1", "重复", "extra"],
    ],
  );
  settings.auditor.checklist[0] = "changed after start";
  assert.equal(list[0]?.label, "重复");
  assert.ok(Object.isFrozen(list) && list.every(Object.isFrozen));
  assert.deepEqual(
    buildAuditChecklist({ goal, settings: { auditor: { checklist: [] } } }),
    [],
  );
  assert.deepEqual(
    buildAuditChecklist({
      goal,
      settings: { auditor: { checklist: [], checklistExtra: ["extra"] } },
    }).map((i) => i.id),
    ["extra-1"],
  );
  assert.equal(
    buildAuditChecklist({
      goal,
      settings: { auditor: { checklistExtra: ["extra"] } },
    }).length,
    4,
  );
});

test("prompt uses snapshot IDs with escaped payloads, source boundaries and preserved protocol tail", () => {
  const settings = {
    auditor: {
      checklist: ["主 <item> & check"],
      checklistExtra: ["附加 </objective>"],
      evidenceRequests: ["collect"],
      strictness: "strict" as const,
      instructions: "guidance",
      reportFormat: "Chinese",
    },
  };
  const checklist = buildAuditChecklist({ goal, settings });
  settings.auditor.checklistExtra[0] = "new config";
  const prompt = buildGoalAuditorPrompt({
    goal,
    settings,
    checklist,
    detailedSummary: "",
  });
  assert.ok(
    prompt.includes("1. 主 &lt;item&gt; &amp; check [checkId=checklist-1]"),
  );
  assert.ok(prompt.includes("1. 附加 &lt;/objective&gt; [checkId=extra-1]"));
  assert.ok(!prompt.includes("new config"));
  const sections = [
    "Audit checklist:",
    "Additional audit checks",
    "Evidence the operator",
    "Audit posture",
    "<operator_instructions>",
    "Report format requirements",
    "Progress reporting:",
    "structured_output exactly once",
  ];
  const positions = sections.map((text) => prompt.indexOf(text));
  assert.ok(
    positions.every(
      (pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1]!),
    ),
  );
  assert.ok(
    buildGoalAuditorPrompt({
      goal,
      detailedSummary: "",
      checklist: [],
    }).includes("structured_output exactly once"),
  );
  assert.deepEqual(
    initialAuditChecks(checklist).map((i) => i.state),
    ["pending", "pending"],
  );
});

test("resolved defaults and omitted settings yield identical prompts", () => {
  const args = { goal, detailedSummary: "" };
  assert.equal(
    buildGoalAuditorPrompt(args),
    buildGoalAuditorPrompt({
      ...args,
      settings: {
        auditor: {
          disabled: false,
          strictness: "balanced",
          agent: "goal-auditor",
        },
      },
    }),
  );
});

class Events implements GoalAuditorEvents {
  private handlers = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void) {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
    return () => {
      set.delete(handler);
    };
  }
  emit(name: string, value: unknown) {
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(value);
  }
}

test("delegation first progress and task share one snapshot even when settings mutate", async () => {
  const events = new Events();
  installSupervisorResponderAck(events);
  const settings = {
    auditor: { checklist: ["initial"], checklistExtra: ["extra"] },
  };
  const progress: AuditorProgress[] = [];
  let task = "";
  events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
    const request = value as {
      requestId: string;
      ownerRunId: string;
      nodeId: string;
      task: string;
    };
    task = request.task;
    settings.auditor.checklist[0] = "late config";
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      result: {
        kind: "structured",
        value: { verdict: "approved", report: "Verified", findings: [] },
      },
    });
  });
  const result = await runGoalCompletionAuditor({
    ctx: {
      cwd: "/repo",
      sessionManager: { getSessionId: () => "checklist-session" },
    } as Parameters<typeof runGoalCompletionAuditor>[0]["ctx"],
    goal,
    settings,
    events,
    skipPreflight: true,
    detailedSummary: "",
    onProgress: (p) => progress.push(p),
  });
  assert.equal(result.approved, true);
  assert.deepEqual(
    progress[0]?.checks?.map((i) => [i.id, i.label, i.state]),
    [
      ["checklist-1", "initial", "pending"],
      ["extra-1", "extra", "pending"],
    ],
  );
  for (const item of progress[0]?.checks ?? [])
    assert.ok(task.includes(`${item.label} [checkId=${item.id}]`));
  assert.ok(!task.includes("late config"));
});

function progressRecord(sequence: number, state: string) {
  return (
    AUDIT_PROGRESS_V2_PREFIX +
    JSON.stringify({
      sequence,
      checkId: "checklist-1",
      state,
      detail: "real evidence",
    })
  );
}
const ctx = {
  cwd: "/repo",
  sessionManager: { getSessionId: () => "dynamic-progress" },
} as Parameters<typeof runGoalCompletionAuditor>[0]["ctx"];

test("item progress remains isolated, private and independent from final verdict", async () => {
  for (const verdict of ["approved", "disapproved"] as const) {
    const events = new Events();
    installSupervisorResponderAck(events);
    const reports: AuditorProgress[] = [];
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
      const request = value as {
        requestId: string;
        ownerRunId: string;
        nodeId: string;
      };
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        ...request,
        requestId: "wrong-attempt",
        recentOutputLines: [progressRecord(99, "passed")],
      });
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        ...request,
        recentOutputLines: [
          progressRecord(2, "failed"),
          progressRecord(1, "running"),
        ],
      });
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        ...request,
        recentOutputLines: [progressRecord(1, "passed"), "Visible evidence"],
      });
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...request,
        status: "completed",
        result: {
          kind: "structured",
          value: { verdict, report: "Reviewed", findings: [] },
        },
      });
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        ...request,
        recentOutputLines: [progressRecord(3, "passed")],
      });
    });
    const result = await runGoalCompletionAuditor({
      ctx,
      goal,
      settings: { auditor: { checklist: ["one"] } },
      events,
      skipPreflight: true,
      detailedSummary: "",
      onProgress: (p) => {
        reports.push(structuredClone(p));
        // An observer may mutate its copy but cannot mutate the actual audit.
        if (p.checks?.[0]) p.checks[0].state = "pending";
      },
    });
    assert.equal(result.approved, verdict === "approved");
    assert.equal(reports.at(-1)?.checks?.[0]?.state, "failed");
    assert.equal(reports[0]?.checks?.[0]?.state, "pending");
    assert.ok(
      reports.every((p) =>
        p.recentOutput.every(
          (line) => !line.startsWith(AUDIT_PROGRESS_V2_PREFIX),
        ),
      ),
    );
    assert.equal(
      reports.at(-1)?.percentage,
      undefined,
      "terminal does not fabricate a 100% estimate",
    );
  }
});

test("park/resume keeps the same snapshot and reveals progress received while parked", async () => {
  const events = new Events();
  installSupervisorResponderAck(events);
  const controller = new AbortController();
  const reports: AuditorProgress[] = [];
  let request:
    | { requestId: string; ownerRunId: string; nodeId: string }
    | undefined;
  let launches = 0;
  const settings = { auditor: { checklist: ["original"] } };
  events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
    request = value as typeof request;
    launches++;
    events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
      ...request,
      recentOutputLines: [progressRecord(1, "running")],
    });
    controller.abort();
  });
  const parked = await runGoalCompletionAuditor({
    ctx,
    goal,
    settings,
    events,
    skipPreflight: true,
    detailedSummary: "",
    signal: controller.signal,
    parkOnAbort: true,
    onProgress: (p) => reports.push(p),
  });
  assert.equal(parked.interrupted, true);
  assert.ok(parked.session);
  assert.ok(request);
  settings.auditor.checklist[0] = "configuration changed";
  const count = reports.length;
  events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
    ...request,
    recentOutputLines: [progressRecord(2, "passed")],
  });
  assert.equal(reports.length, count, "park suppresses UI callbacks");
  const resumed = parked.session.resume();
  assert.equal(reports.at(-1)?.checks?.[0]?.state, "passed");
  assert.equal(reports.at(-1)?.checks?.[0]?.label, "original");
  events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
    ...request,
    status: "completed",
    result: {
      kind: "structured",
      value: { verdict: "approved", report: "Checked", findings: [] },
    },
  });
  assert.equal((await resumed).approved, true);
  assert.equal(launches, 1);
});
