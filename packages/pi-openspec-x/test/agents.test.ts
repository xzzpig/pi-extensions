/**
 * Runtime agent registration tests (design D3).
 *
 * The pi-subagents bus protocol (packages/pi-subagents/src/agents/
 * runtime-agent-events.ts) is exercised with the REAL client function:
 * `registerAgentViaEvents` emits `pi-subagents:runtime-agent-register:v1`
 * synchronously and reads the `result` field the owner listener mutates. The
 * fake owner below mirrors the owner side of that contract (version check,
 * `result = { ok, registration | error }`), while the failure cases pin what
 * happens when no listener answers or the owner reports an error.
 *
 * Pure definition tests pin the four agents' tool allowlists, acceptance
 * roles, isolation fields, and the mandatory prompt slices, so a drifted
 * allowlist (edit/write in a read-only agent, a dropped protocol tool) or a
 * dropped discipline fails loudly.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  RUNTIME_AGENT_REGISTER_EVENT,
  registerAgentViaEvents,
  type RuntimeAgentDefinition,
} from "@xzzpig/pi-subagents/agents";
import { beforeEach, describe, expect, test } from "vitest";

import {
  createOpsxAgentsSessionStartHandler,
  lastOpsxAgentsRegistration,
  OPSX_AGENT_DEFINITIONS,
  OPSX_AGENT_NAMES,
  registerOpsxAgents,
  resetAgentsRegistrationForTests,
  REVIEWER_PROGRESS_TOOL_NAME,
} from "../src/agents.ts";
import {
  GAP_ANALYSIS_SYSTEM_PROMPT,
  PLAN_REVIEW_SYSTEM_PROMPT,
  OPSX_REVIEWER_SYSTEM_PROMPT,
  WORKER_SYSTEM_PROMPT,
} from "../src/agent-prompts.ts";
import {
  probeSubagentsDependency,
  resetDependencyStateForTests,
} from "../src/dependencies.ts";
import {
  REPORT_GAP_ANALYSIS_TOOL_NAME,
  REPORT_PLAN_REVIEW_TOOL_NAME,
  REPORT_WORK_TOOL_NAME,
} from "../src/report-tools.ts";

beforeEach(() => {
  resetDependencyStateForTests();
  resetAgentsRegistrationForTests();
});

interface FakeBus {
  on(channel: string, handler: (value: unknown) => void): () => void;
  emit(channel: string, value: unknown): void;
}

function createBus(): FakeBus {
  const handlers = new Map<string, Array<(value: unknown) => void>>();
  return {
    on(channel, handler) {
      const entries = handlers.get(channel) ?? [];
      entries.push(handler);
      handlers.set(channel, entries);
      return () =>
        handlers.set(
          channel,
          (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
        );
    },
    emit(channel, value) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(value);
    },
  };
}

interface FakeOwner {
  names: string[];
  definitions: RuntimeAgentDefinition[];
  disposed: () => number;
  /** Make the owner reject registrations for the given names. */
  failFor: (names: string[], error?: Error) => void;
}

/**
 * Simulate the installed pi-subagents owner answering registration requests
 * (the owner side of runtime-agent-events.ts's contract).
 */
function installFakeOwner(bus: FakeBus): FakeOwner {
  const names: string[] = [];
  const definitions: RuntimeAgentDefinition[] = [];
  let disposed = 0;
  const failing = new Set<string>();
  bus.on(RUNTIME_AGENT_REGISTER_EVENT, (rawRequest) => {
    const request = rawRequest as {
      name: string;
      definition: RuntimeAgentDefinition;
      result?: unknown;
    };
    if (request.result !== undefined) return;
    if (failing.has(request.name)) {
      request.result = {
        ok: false,
        error: new Error(
          `Runtime agent '${request.name}' collides with runtime agent '${request.name}'.`,
        ),
      };
      return;
    }
    names.push(request.name);
    definitions.push(request.definition);
    request.result = {
      ok: true,
      registration: { dispose: () => (disposed += 1) },
    };
  });
  return {
    names,
    definitions,
    disposed: () => disposed,
    failFor(failedNames) {
      for (const name of failedNames) failing.add(name);
    },
  };
}

/** Probe the dependency state with the real bus-protocol client. */
async function probeWithRealClient(): Promise<void> {
  const probe = await probeSubagentsDependency(async () => ({
    registerAgentViaEvents,
  }));
  if (!probe.available) throw new Error("fake module probe must succeed");
}

describe("agent definitions", () => {
  test("exactly the four opsx agents are defined", () => {
    expect(Object.keys(OPSX_AGENT_DEFINITIONS).sort()).toEqual(
      [...OPSX_AGENT_NAMES].sort(),
    );
    expect(OPSX_AGENT_NAMES).toEqual([
      "opsx-gap-analysis",
      "opsx-plan-review",
      "opsx-worker",
      "opsx-reviewer",
    ]);
  });

  test("read-only agents never carry write tools; only the worker does", () => {
    for (const name of [
      "opsx-gap-analysis",
      "opsx-plan-review",
      "opsx-reviewer",
    ] as const) {
      const tools = OPSX_AGENT_DEFINITIONS[name].tools ?? [];
      expect(tools, `${name} must not allow edit`).not.toContain("edit");
      expect(tools, `${name} must not allow write`).not.toContain("write");
      expect(OPSX_AGENT_DEFINITIONS[name].acceptanceRole).toBe("read-only");
    }
    const worker = OPSX_AGENT_DEFINITIONS["opsx-worker"];
    expect(worker.tools).toContain("edit");
    expect(worker.tools).toContain("write");
    expect(worker.acceptanceRole).toBe("writer");
  });

  test("gap-analysis: inspection allowlist plus its report tool, deep thinking", () => {
    const gapAnalysis = OPSX_AGENT_DEFINITIONS["opsx-gap-analysis"];
    expect(gapAnalysis.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      REPORT_GAP_ANALYSIS_TOOL_NAME,
    ]);
    expect(gapAnalysis.thinking).toBe("high");
    expect(gapAnalysis.systemPrompt).toBe(GAP_ANALYSIS_SYSTEM_PROMPT);
  });

  test("plan-review: no bash, its report tool, deep thinking", () => {
    const planReview = OPSX_AGENT_DEFINITIONS["opsx-plan-review"];
    expect(planReview.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      REPORT_PLAN_REVIEW_TOOL_NAME,
    ]);
    expect(planReview.thinking).toBe("high");
    expect(planReview.systemPrompt).toBe(PLAN_REVIEW_SYSTEM_PROMPT);
  });

  test("worker: full write surface plus its report tool", () => {
    const worker = OPSX_AGENT_DEFINITIONS["opsx-worker"];
    expect(worker.tools).toEqual([
      "read",
      "edit",
      "write",
      "bash",
      "grep",
      "find",
      "ls",
      REPORT_WORK_TOOL_NAME,
    ]);
    expect(worker.systemPrompt).toBe(WORKER_SYSTEM_PROMPT);
  });

  test("reviewer: carries the goal-x protocol progress tool and its child extension", () => {
    const reviewer = OPSX_AGENT_DEFINITIONS["opsx-reviewer"];
    expect(reviewer.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      REVIEWER_PROGRESS_TOOL_NAME,
    ]);
    expect(REVIEWER_PROGRESS_TOOL_NAME).toBe("report_auditor_progress");
    expect(reviewer.thinking).toBe("high");
    expect(reviewer.systemPrompt).toBe(OPSX_REVIEWER_SYSTEM_PROMPT);
    expect(reviewer.subagentOnlyExtensions).toHaveLength(1);
    expect(reviewer.subagentOnlyExtensions?.[0]).toMatch(
      /goal-auditor-progress\.ts$/,
    );
  });

  test("all four share the goal-auditor isolation defaults", () => {
    for (const name of OPSX_AGENT_NAMES) {
      const definition = OPSX_AGENT_DEFINITIONS[name];
      expect(definition.inheritSkills, name).toBe(false);
      expect(definition.inheritProjectContext, name).toBe(true);
      expect(definition.systemPromptMode, name).toBe("replace");
      expect(definition.defaultContext, name).toBe("fresh");
      expect(definition.systemPrompt.length, name).toBeGreaterThan(200);
    }
  });

  test("gap-analysis prompt carries the gap-analysis disciplines", () => {
    const prompt = OPSX_AGENT_DEFINITIONS["opsx-gap-analysis"].systemPrompt;
    expect(prompt).toMatch(/ZERO USER INTERVENTION/);
    expect(prompt).toMatch(/user manually tests/);
    expect(prompt).toMatch(/refactor/);
    expect(prompt).toMatch(/build-from-scratch/);
    expect(prompt).toMatch(/mid-sized/);
    expect(prompt).toMatch(/collaborative/);
    expect(prompt).toMatch(/architecture/);
    expect(prompt).toMatch(/research/);
    expect(prompt).toMatch(/Contradictions/);
    expect(prompt).toMatch(/Missing constraints/);
    expect(prompt).toMatch(/Scope risks/);
    expect(prompt).toMatch(/Unvalidated assumptions/);
    expect(prompt).toMatch(/Missing acceptance criteria/);
    expect(prompt).toMatch(/AI-slop/);
    expect(prompt).toMatch(/premature abstraction/);
    expect(prompt).toMatch(/over-validation/);
    expect(prompt).toMatch(/report_gap_analysis/);
    expect(prompt).toMatch(/NEVER modify/);
  });

  test("plan-review prompt carries the approval-bias review disciplines", () => {
    const prompt = OPSX_AGENT_DEFINITIONS["opsx-plan-review"].systemPrompt;
    expect(prompt).toMatch(/without getting stuck/);
    expect(prompt).toMatch(/Reference validity/);
    expect(prompt).toMatch(/starting point/);
    expect(prompt).toMatch(/Critical blockers/);
    expect(prompt).toMatch(/Acceptance scenario executability/);
    expect(prompt).toMatch(/APPROVAL BIAS/);
    expect(prompt).toMatch(/80% clear is enough/);
    expect(prompt).toMatch(
      /At most 3 blocking issues|at most 3 blocking issues/,
    );
    expect(prompt).toMatch(/report_plan_review/);
    expect(prompt).toMatch(/OKAY/);
    expect(prompt).toMatch(/ITERATE/);
    expect(prompt).toMatch(/REJECT/);
  });

  test("worker prompt carries the execution discipline", () => {
    const prompt = OPSX_AGENT_DEFINITIONS["opsx-worker"].systemPrompt;
    expect(prompt).toMatch(/exactly ONE dispatched task/);
    expect(prompt).toMatch(/do not delegate/i);
    expect(prompt).toMatch(/minimum changes|minimum reasonable/);
    expect(prompt).toMatch(/READ-ONLY/);
    expect(prompt).toMatch(/tasks\.md/);
    expect(prompt).toMatch(/report_work/);
    expect(prompt).toMatch(/Subagents lie/);
    expect(prompt).toMatch(/real command output/);
  });

  test("reviewer prompt carries the audit disciplines and the structured verdict", () => {
    const prompt = OPSX_AGENT_DEFINITIONS["opsx-reviewer"].systemPrompt;
    expect(prompt).toMatch(/Plan compliance/);
    expect(prompt).toMatch(/Code quality/);
    expect(prompt).toMatch(/Verification evidence/);
    expect(prompt).toMatch(/Scope fidelity/);
    expect(prompt).toMatch(/untrusted input/);
    expect(prompt).toMatch(/window delta/);
    expect(prompt).toMatch(/report_auditor_progress/);
    expect(prompt).toMatch(/structured_output/);
    expect(prompt).toMatch(/approved" \| "disapproved|approved/);
    expect(prompt).not.toMatch(/report_final_review/);
  });
});

describe("registerOpsxAgents", () => {
  test("registers all four agents through the bus protocol", async () => {
    await probeWithRealClient();
    const bus = createBus();
    const owner = installFakeOwner(bus);
    const pi = { events: bus } as unknown as ExtensionAPI;

    const result = registerOpsxAgents(pi);

    expect(result).toEqual({ registered: true, agents: [...OPSX_AGENT_NAMES] });
    expect(owner.names).toEqual([...OPSX_AGENT_NAMES]);
    expect(owner.definitions[0].tools).toContain(REPORT_GAP_ANALYSIS_TOOL_NAME);
    expect(lastOpsxAgentsRegistration()?.registered).toBe(true);
  });

  test("re-registration is idempotent: previous handles are disposed first", async () => {
    await probeWithRealClient();
    const bus = createBus();
    const owner = installFakeOwner(bus);
    const pi = { events: bus } as unknown as ExtensionAPI;

    registerOpsxAgents(pi);
    const second = registerOpsxAgents(pi);

    expect(second.registered).toBe(true);
    expect(owner.disposed()).toBe(OPSX_AGENT_NAMES.length);
    expect(owner.names).toEqual([...OPSX_AGENT_NAMES, ...OPSX_AGENT_NAMES]);
  });

  test("a missing pi-subagents dependency fails typed and never emits", async () => {
    await probeSubagentsDependency(async () => {
      throw new Error("Cannot find package '@xzzpig/pi-subagents'");
    });
    const bus = createBus();
    const owner = installFakeOwner(bus);
    const pi = { events: bus } as unknown as ExtensionAPI;

    const result = registerOpsxAgents(pi);

    expect(result.registered).toBe(false);
    expect(result.agents).toEqual([]);
    expect(result.reason).toContain("@xzzpig/pi-subagents");
    expect(result.reason).toContain("dynamic import failed");
    expect(owner.names).toEqual([]);
    expect(lastOpsxAgentsRegistration()?.registered).toBe(false);
  });

  test("no owner listener (pi-subagents not loaded yet) fails and is retried on session_start", async () => {
    await probeWithRealClient();
    const bus = createBus();
    const pi = { events: bus } as unknown as ExtensionAPI;

    const first = registerOpsxAgents(pi);
    expect(first.registered).toBe(false);
    expect(first.reason).toMatch(/pi-subagents is not installed, not ready/);

    // pi-subagents loads later; its owner listener answers the next attempt.
    const owner = installFakeOwner(bus);
    const handler = createOpsxAgentsSessionStartHandler(pi);
    handler(
      { type: "session_start", reason: "startup" },
      {} as ExtensionContext,
    );

    expect(owner.names).toEqual([...OPSX_AGENT_NAMES]);
    expect(lastOpsxAgentsRegistration()?.registered).toBe(true);

    handler(
      { type: "session_start", reason: "resume" },
      {} as ExtensionContext,
    );
    expect(owner.names).toEqual([...OPSX_AGENT_NAMES]);
  });

  test("an owner-reported error surfaces and partial registrations roll back", async () => {
    await probeWithRealClient();
    const bus = createBus();
    const owner = installFakeOwner(bus);
    owner.failFor(["opsx-worker"]);
    const pi = { events: bus } as unknown as ExtensionAPI;

    const result = registerOpsxAgents(pi);

    expect(result.registered).toBe(false);
    expect(result.agents).toEqual(["opsx-gap-analysis", "opsx-plan-review"]);
    expect(result.reason).toMatch(/collides/);
    expect(owner.disposed()).toBe(2);
    expect(lastOpsxAgentsRegistration()?.registered).toBe(false);
  });

  test("resetAgentsRegistrationForTests disposes active registrations", async () => {
    await probeWithRealClient();
    const bus = createBus();
    const owner = installFakeOwner(bus);
    const pi = { events: bus } as unknown as ExtensionAPI;

    registerOpsxAgents(pi);
    resetAgentsRegistrationForTests();

    expect(owner.disposed()).toBe(OPSX_AGENT_NAMES.length);
    expect(lastOpsxAgentsRegistration()).toBeUndefined();
  });
});
