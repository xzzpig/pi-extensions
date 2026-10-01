/**
 * Parent-side plan gate tools (openspec change add-pi-openspec-x, tasks 7.2 and
 * 7.3): ledger recording, the review-loop policy, and the user approval gate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME,
  OPSX_PLAN_VERDICT_TOOL_NAME,
  approvalInstruction,
  registerPlanGateTools,
} from "../src/plan-gate.ts";
import {
  readPlanApproval,
  readPlanReviewLedger,
  recordPlanApproval,
} from "../src/plan-review.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeChangeDir(changeId = "change-a"): {
  root: string;
  changeDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openspec-x-gate-"));
  roots.push(root);
  const changeDir = path.join(root, "openspec", "changes", changeId);
  fs.mkdirSync(changeDir, { recursive: true });
  return { root, changeDir };
}

interface ToolLike {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function createPi() {
  const tools = new Map<string, ToolLike>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    registerTool(tool: ToolLike) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      return [];
    },
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };
  return { pi, tools, emitted };
}

function makeCtx(
  cwd: string,
  options: { hasUI?: boolean; select?: () => Promise<string | undefined> } = {},
) {
  return {
    cwd,
    hasUI: options.hasUI ?? false,
    sessionManager: { getSessionId: () => "s1" },
    ui: { select: options.select ?? (async () => undefined) },
  };
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("opsx_plan_gap_analysis", () => {
  it("appends a gap-analysis entry to the change ledger", async () => {
    const { root, changeDir } = makeChangeDir();
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);

    const result = await tools.get(OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME)!.execute(
      "call-1",
      {
        findings: ["missing constraint"],
        summary: "one gap",
        changeId: "change-a",
      },
      undefined,
      undefined,
      makeCtx(root),
    );

    expect(textOf(result)).toContain("Gap analysis recorded");
    const entries = readPlanReviewLedger(changeDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("gap_analysis");
    expect(entries[0]!.findings).toEqual(["missing constraint"]);
  });
});

describe("opsx_plan_verdict", () => {
  it("records an ITERATE verdict and tells the agent to revise", async () => {
    const { root, changeDir } = makeChangeDir();
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);

    const result = await tools.get(OPSX_PLAN_VERDICT_TOOL_NAME)!.execute(
      "call-1",
      {
        verdict: "ITERATE",
        blockers: ["vague step 2"],
        changeId: "change-a",
      },
      undefined,
      undefined,
      makeCtx(root),
    );

    expect(textOf(result)).toContain("round 1");
    expect(textOf(result)).toContain("revise");
    const entries = readPlanReviewLedger(changeDir);
    expect(entries[0]!.verdict).toBe("ITERATE");
    expect(entries[0]!.round).toBe(1);
    // No approval is recorded before OKAY.
    expect(readPlanApproval(changeDir)).toBeUndefined();
  });

  it("escalates a repeated REJECT blocker and records the escalation", async () => {
    const { root, changeDir } = makeChangeDir();
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);
    const tool = tools.get(OPSX_PLAN_VERDICT_TOOL_NAME)!;
    const ctx = makeCtx(root);

    await tool.execute(
      "call-1",
      { verdict: "REJECT", blockers: ["bad ref"], changeId: "change-a" },
      undefined,
      undefined,
      ctx,
    );
    const second = await tool.execute(
      "call-2",
      { verdict: "REJECT", blockers: ["bad ref"], changeId: "change-a" },
      undefined,
      undefined,
      ctx,
    );

    expect(textOf(second)).toContain("escalated");
    const types = readPlanReviewLedger(changeDir).map((entry) => entry.type);
    expect(types).toContain("escalation");
  });

  it("opens the approval dialog on OKAY and records an approved decision", async () => {
    const { root, changeDir } = makeChangeDir();
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);
    const select = vi.fn(async () => "Approve the plan");

    const result = await tools
      .get(OPSX_PLAN_VERDICT_TOOL_NAME)!
      .execute(
        "call-1",
        { verdict: "OKAY", blockers: [], changeId: "change-a" },
        undefined,
        undefined,
        makeCtx(root, { hasUI: true, select }),
      );

    expect(select).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain("approved the plan");
    expect(readPlanApproval(changeDir)?.decision).toBe("approved");
    // The approval is persisted, not only in memory.
    expect(
      readPlanReviewLedger(changeDir).some(
        (entry) => entry.type === "plan_approval",
      ),
    ).toBe(true);
  });

  it("does not re-open the dialog when the plan is already approved", async () => {
    const { root, changeDir } = makeChangeDir();
    // Pre-approve the plan on disk: a second OKAY round must not re-open the
    // dialog or append a duplicate approval entry (ledger is the truth).
    recordPlanApproval(changeDir, {
      changeId: "change-a",
      decision: "approved",
      via: "select",
    });
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);
    const select = vi.fn(async () => "Approve the plan");

    const result = await tools
      .get(OPSX_PLAN_VERDICT_TOOL_NAME)!
      .execute(
        "call-1",
        { verdict: "OKAY", blockers: [], changeId: "change-a" },
        undefined,
        undefined,
        makeCtx(root, { hasUI: true, select }),
      );

    expect(select).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("approved the plan");
    expect(
      readPlanReviewLedger(changeDir).filter(
        (entry) => entry.type === "plan_approval",
      ),
    ).toHaveLength(1);
  });

  it("records a revise decision when the user requests changes", async () => {
    const { root, changeDir } = makeChangeDir();
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);

    const result = await tools.get(OPSX_PLAN_VERDICT_TOOL_NAME)!.execute(
      "call-1",
      { verdict: "OKAY", blockers: [], changeId: "change-a" },
      undefined,
      undefined,
      makeCtx(root, {
        hasUI: true,
        select: async () => "Request changes",
      }),
    );

    expect(textOf(result)).toContain("requested changes");
    expect(readPlanApproval(changeDir)?.decision).toBe("revise");
  });

  it("stays pending without a UI and never unlocks implementation", async () => {
    const { root, changeDir } = makeChangeDir();
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);

    const result = await tools
      .get(OPSX_PLAN_VERDICT_TOOL_NAME)!
      .execute(
        "call-1",
        { verdict: "OKAY", blockers: [], changeId: "change-a" },
        undefined,
        undefined,
        makeCtx(root, { hasUI: false }),
      );

    expect(textOf(result)).toContain("still pending");
    expect(readPlanApproval(changeDir)?.decision).toBe("pending");
  });

  it("refuses to guess a change when none is supplied or active", async () => {
    const { root, changeDir } = makeChangeDir();
    const { pi, tools } = createPi();
    registerPlanGateTools(pi as unknown as ExtensionAPI);

    const result = await tools
      .get(OPSX_PLAN_VERDICT_TOOL_NAME)!
      .execute(
        "call-1",
        { verdict: "OKAY", blockers: [] },
        undefined,
        undefined,
        makeCtx(root),
      );

    expect(textOf(result)).toContain("No plan flow is active");
    expect(readPlanReviewLedger(changeDir)).toHaveLength(0);
  });
});

describe("approvalInstruction", () => {
  it("points an approved plan at the separate implement command", () => {
    const text = approvalInstruction("change-a", {
      changeId: "change-a",
      decision: "approved",
      at: "2026-01-01T00:00:00.000Z",
      via: "select",
    });
    expect(text).toContain("/opsx:implement");
    expect(text).toContain("change-a");
  });

  it("tells a rejected plan to stop", () => {
    expect(
      approvalInstruction("change-a", {
        changeId: "change-a",
        decision: "rejected",
        at: "2026-01-01T00:00:00.000Z",
        via: "select",
      }),
    ).toContain("rejected the plan");
  });
});
