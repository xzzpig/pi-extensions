/**
 * Tests for the final review gate (task 8.3): the per-goal auditor override,
 * the cross-extension resolver, the verdict mapping, and the archive guidance.
 */
import { describe, expect, it } from "vitest";

import {
  buildOpsxAuditorOverride,
  createOpsxAuditorResolver,
  decideFinalGate,
  installOpsxAuditorForGoal,
  OPSX_REVIEWER_AGENT_NAME,
  OPSX_REVIEW_CHECKLIST,
  renderArchiveGuidance,
  type OpsxAuditorInstaller,
} from "../src/final-gate.ts";

describe("buildOpsxAuditorOverride", () => {
  it("points the audit at opsx-reviewer with the four-dimension checklist", () => {
    const override = buildOpsxAuditorOverride();
    expect(override.agent).toBe(OPSX_REVIEWER_AGENT_NAME);
    expect(override.checklistExtra).toEqual(OPSX_REVIEW_CHECKLIST);
    expect(override.checklistExtra).toHaveLength(4);
    expect(override.instructions).toContain("window delta");
  });
});

describe("createOpsxAuditorResolver", () => {
  it("answers only for opsx-reviewer, leaving goal-auditor a miss", () => {
    const resolver = createOpsxAuditorResolver();
    const definition = resolver(OPSX_REVIEWER_AGENT_NAME);
    expect(definition).toBeDefined();
    expect(definition?.tools).toContain("report_auditor_progress");
    expect(resolver("goal-auditor")).toBeUndefined();
    expect(resolver("someone-else")).toBeUndefined();
  });
});

describe("installOpsxAuditorForGoal", () => {
  it("sets the per-goal override and registers the resolver", () => {
    const calls: Array<{ goalId: string; override: Record<string, unknown> }> =
      [];
    let disposed = false;
    const goalX: OpsxAuditorInstaller = {
      setGoalAuditorOverride(goalId, override) {
        calls.push({ goalId, override });
      },
      registerAuditorAgentResolver(resolver) {
        expect(resolver(OPSX_REVIEWER_AGENT_NAME)).toBeDefined();
        return () => {
          disposed = true;
        };
      },
    };

    const { disposeResolver } = installOpsxAuditorForGoal(goalX, "goal-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.goalId).toBe("goal-1");
    expect(calls[0]?.override.agent).toBe(OPSX_REVIEWER_AGENT_NAME);
    disposeResolver();
    expect(disposed).toBe(true);
  });
});

describe("decideFinalGate", () => {
  it("approves a passing audit", () => {
    expect(
      decideFinalGate({ approved: true, report: "All good.", findings: [] }),
    ).toEqual({ kind: "approved", report: "All good." });
  });

  it("returns the fix round for a disapproved audit", () => {
    expect(
      decideFinalGate({
        approved: false,
        report: "Not yet.",
        findings: ["scope violation in src/x.ts"],
      }),
    ).toEqual({ kind: "fix", findings: ["scope violation in src/x.ts"] });
  });

  it("keeps a default finding when the audit named none", () => {
    const decision = decideFinalGate({
      approved: false,
      report: "",
      findings: [],
    });
    expect(decision.kind).toBe("fix");
    if (decision.kind !== "fix") return;
    expect(decision.findings).toHaveLength(1);
  });
});

describe("renderArchiveGuidance", () => {
  it("guides archiving without performing it", () => {
    const text = renderArchiveGuidance("add-pi-openspec-x");
    expect(text).toContain(
      "[OPSX FINAL AUDIT APPROVED change=add-pi-openspec-x]",
    );
    expect(text).toContain("openspec archive");
    expect(text).toContain("never archives for you");
  });
});
