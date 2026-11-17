import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import registerProgress, {
  reportAuditorProgressParams,
  REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX,
} from "../extensions/goal-auditor-progress.ts";
import {
  createAuditProgressReducer,
  AUDIT_PROGRESS_V2_PREFIX,
  type AuditProgressTarget,
} from "../extensions/fork-audit-progress.ts";
import {
  buildAuditChecklist,
  initialAuditChecks,
} from "../extensions/fork-audit-checklist.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

const record = (
  sequence: number,
  checkId = "checklist-1",
  state = "passed",
  extra = {},
) =>
  AUDIT_PROGRESS_V2_PREFIX +
  JSON.stringify({ sequence, checkId, state, ...extra });
function target(): AuditProgressTarget {
  return {
    phase: "running",
    checks: initialAuditChecks(
      buildAuditChecklist({
        goal: {},
        settings: { auditor: { checklist: ["one", "two"] } },
      }),
    ),
  };
}

test("progress schema accepts old calls and requires paired valid item fields", () => {
  for (const value of [
    { label: "Legacy", percentage: 20 },
    { checkId: "checklist-1", state: "running" },
    { checkId: "extra-1", state: "failed", detail: "证据".repeat(256) },
  ])
    assert.equal(Check(reportAuditorProgressParams, value), true);
  for (const value of [
    { checkId: "x" },
    { state: "passed" },
    { checkId: "x", state: "unknown" },
    { checkId: "x", state: "passed", sequence: 1 },
    { label: "x", percentage: 101 },
    { checkId: "x", state: "passed", detail: "x".repeat(513) },
    { checkId: "x".repeat(81), state: "passed" },
  ])
    assert.equal(Check(reportAuditorProgressParams, value), false);
});

test("reducer processes sorted multiple records and ignores cumulative replay", () => {
  const p = target();
  const apply = createAuditProgressReducer();
  apply(p, [
    record(2, "checklist-2", "failed", { detail: "gap" }),
    record(1, "checklist-1", "running"),
  ]);
  assert.deepEqual(
    p.checks?.map((i) => i.state),
    ["running", "failed"],
  );
  apply(p, [
    record(1, "checklist-1", "pending"),
    record(3, "checklist-1", "passed", { detail: "proven" }),
    record(3, "checklist-1", "failed"),
  ]);
  assert.deepEqual(
    p.checks?.map((i) => i.state),
    ["passed", "failed"],
  );
  assert.equal(p.checks?.[0]?.detail, "proven");
  apply(p, [record(4, "checklist-2", "passed")]);
  assert.equal(p.checks?.[1]?.detail, undefined);
  assert.equal(p.checks?.[1]?.state, "passed");
});

test("unknown IDs, malformed or oversized fields do not change checks and do not leak payloads", () => {
  for (const line of [
    record(1, "unknown"),
    record(1, "checklist-1", "invalid"),
    record(1, "checklist-1", "passed", { detail: "secret".repeat(900) }),
    record(1, "checklist-1", "passed", { percentage: 101 }),
    record(1, "checklist-1", "passed", { unexpected: true }),
    record(0),
    AUDIT_PROGRESS_V2_PREFIX + "{bad JSON",
  ]) {
    const p = target();
    createAuditProgressReducer()(p, [line]);
    assert.deepEqual(
      p.checks?.map((i) => i.state),
      ["pending", "pending"],
    );
    assert.ok(p.progressDiagnostic);
    assert.ok(!p.progressDiagnostic.includes("secret"));
    assert.ok(p.progressDiagnostic.length < 100);
  }
});

test("detail allows exactly 512 Unicode codepoints, sequence and attempt states are isolated", () => {
  const one = target();
  const two = target();
  const first = createAuditProgressReducer();
  const second = createAuditProgressReducer();
  first(one, [
    record(10, "checklist-1", "failed", { detail: "😀".repeat(512) }),
  ]);
  second(two, [record(1, "checklist-1", "passed")]);
  assert.equal(one.checks?.[0]?.state, "failed");
  assert.equal(two.checks?.[0]?.state, "passed");
  one.phase = "done";
  first(one, [record(11, "checklist-1", "passed")]);
  assert.equal(one.checks?.[0]?.state, "failed");
});

test("legacy values or preview text cannot mark a checklist item", () => {
  const p = target();
  createAuditProgressReducer()(p, [
    "checkId=checklist-1 state=passed",
    REPORT_AUDITOR_PROGRESS_PROTOCOL_PREFIX +
      JSON.stringify({ label: "done", percentage: 100 }),
  ]);
  assert.deepEqual(
    p.checks?.map((i) => i.state),
    ["pending", "pending"],
  );
});

interface CapturedTool {
  execute(
    id: string,
    args:
      | { checkId: string; state: "running" | "passed"; detail?: string }
      | { label: string; percentage: number },
  ): Promise<AgentToolResult<unknown>>;
}
function provider(): CapturedTool {
  let tool: CapturedTool | undefined;
  registerProgress({
    registerTool(value) {
      // SAFETY: this fixture registers only the concrete progress provider above;
      // its execute implementation consumes just id and the schema-tested args.
      tool = value as unknown as CapturedTool;
    },
  });
  assert.ok(tool);
  return tool;
}

test("child provider owns sequence; old results are byte-compatible and another child resets it", async () => {
  const tool = provider();
  const old = await tool.execute("legacy", {
    label: "Inspect",
    percentage: 20,
  });
  assert.equal(old.content[0]?.type, "text");
  assert.deepEqual(old.details, { label: "Inspect", percentage: 20 });
  for (const [index, state] of (["running", "passed"] as const).entries()) {
    const out = await tool.execute(String(index), {
      checkId: "checklist-1",
      state,
    });
    const part = out.content[0];
    assert.equal(part?.type, "text");
    if (part?.type !== "text") throw new Error("Expected progress record");
    assert.deepEqual(
      JSON.parse(part.text.slice(AUDIT_PROGRESS_V2_PREFIX.length)),
      { sequence: index + 1, checkId: "checklist-1", state },
    );
  }
  const fresh = await provider().execute("new", {
    checkId: "checklist-1",
    state: "running",
  });
  assert.deepEqual(fresh.details, {
    sequence: 1,
    checkId: "checklist-1",
    state: "running",
  });
  await assert.rejects(
    tool.execute("huge", {
      checkId: "checklist-1",
      state: "passed",
      detail: "x".repeat(513),
    }),
    /exceeds/,
  );
});

test("default auditor and tool guidelines describe IDs, rechecks and independent verdict", async () => {
  const { DEFAULT_AUDITOR_DEFINITION } = await import(
    "../extensions/goal-auditor-registration.ts"
  );
  const prompt = DEFAULT_AUDITOR_DEFINITION.systemPrompt ?? "";
  assert.match(prompt, /checkId=<supplied ID>/);
  assert.match(prompt, /Rechecking may revise/);
  assert.match(prompt, /never substitutes for your final verdict/);
  assert.ok(!prompt.includes("percentage=40"));
});
