/**
 * Pure tests for the `/opsx:plan` phase model and injection blocks (task 7.1).
 */
import { describe, expect, it } from "vitest";

import type { OpenspecArtifactInstructions } from "../src/cli.ts";
import {
  nextPlanPhase,
  renderPlanModeContract,
  renderPlanPhaseBlock,
} from "../src/plan-flow.ts";

const LIVE: OpenspecArtifactInstructions = {
  artifactId: "proposal",
  changeName: "add-pi-openspec-x",
  instruction: "Draft the proposal with Why / What Changes / Capabilities.",
  template: "# Proposal\n\n## Why\n",
  rules: ["Keep it concise."],
  resolvedOutputPath: "/p/openspec/changes/add-pi-openspec-x/proposal.md",
};

describe("nextPlanPhase", () => {
  it("returns the first artifact that is not done or skipped", () => {
    expect(
      nextPlanPhase({
        artifacts: [
          { id: "proposal", status: "done" },
          { id: "specs", status: "ready" },
          { id: "design", status: "blocked" },
          { id: "tasks", status: "blocked" },
        ],
      }),
    ).toEqual({ kind: "artifact", artifact: "specs" });
  });

  it("treats skipped as settled and returns review when all artifacts are done", () => {
    expect(
      nextPlanPhase({
        artifacts: [
          { id: "proposal", status: "done" },
          { id: "specs", status: "skipped" },
        ],
      }),
    ).toEqual({ kind: "review" });
    expect(nextPlanPhase({})).toEqual({ kind: "review" });
  });
});

describe("renderPlanModeContract", () => {
  it("names the change and the append-only planner discipline", () => {
    const contract = renderPlanModeContract("add-pi-openspec-x");
    expect(contract).toContain("[OPSX PLAN MODE change=add-pi-openspec-x]");
    expect(contract).toContain("opsx-planner sandbox profile");
    expect(contract).toContain("opsx-gap-analysis");
    expect(contract).toContain("opsx-plan-review");
    expect(contract).toContain("Do not implement code");
  });
});

describe("renderPlanPhaseBlock", () => {
  it("renders the live CLI instructions with the decision-complete slice", () => {
    const block = renderPlanPhaseBlock("proposal", LIVE);
    expect(block.degraded).toBe(false);
    expect(block.content).toContain("[OPSX PLAN PHASE: proposal]");
    expect(block.content).toContain(
      "Draft the proposal with Why / What Changes / Capabilities.",
    );
    expect(block.content).toContain("Write to: /p/openspec/changes");
    expect(block.content).toContain("Template:");
    expect(block.content).toContain("- Keep it concise.");
    expect(block.content).toContain("Decision-complete rules");
    expect(block.content).toContain("Must-NOT-Have");
  });

  it("degrades to the built-in skeleton when instructions are unavailable", () => {
    const block = renderPlanPhaseBlock("specs", undefined);
    expect(block.degraded).toBe(true);
    expect(block.content).toContain("built-in skeleton");
    expect(block.content).toContain("ADDED/MODIFIED/REMOVED");
    expect(block.content).toContain("Decision-complete rules");
  });

  it("falls back to a generic skeleton for an unknown artifact", () => {
    const block = renderPlanPhaseBlock("custom-artifact", undefined);
    expect(block.degraded).toBe(true);
    expect(block.content).toContain(
      "Follow the schema's artifact requirements",
    );
  });
});
