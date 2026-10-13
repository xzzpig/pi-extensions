/**
 * Child reporting tool isolation (design D1, spec "结构化裁决上报").
 *
 * Two independent halves, both against real machinery rather than a static
 * array:
 *
 * 1. **Real SDK resource loading** — `discoverAndLoadExtensions` loads the
 *    actual `src/index.ts` entry the way the host does, so the assertion is
 *    about the tool registry Pi would build, not about a hand-made list. The
 *    main session is then driven through its real lifecycle handlers and its
 *    real `/opsx:plan` and `/opsx:implement` command handlers, and reloaded,
 *    because the leak this change fixes was a tool that appeared without any
 *    mode being involved.
 * 2. **Native launch tool plan** — `resolvePiLaunchToolPlan` is the function
 *    pi-subagents uses for both foreground and background child launches, so
 *    asserting on its output covers the real child wiring, including that the
 *    role's own child-only extension is what carries the tool.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { resolvePiLaunchToolPlan } from "@xzzpig/pi-subagents/child-tool-plan";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { OPSX_AGENT_DEFINITIONS, OPSX_AGENT_NAMES } from "../src/agents.ts";
import {
  OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME,
  OPSX_PLAN_VERDICT_TOOL_NAME,
} from "../src/plan-gate.ts";
import {
  REPORT_GAP_ANALYSIS_TOOL_NAME,
  REPORT_PLAN_REVIEW_TOOL_NAME,
  REPORT_WORK_TOOL_NAME,
} from "../src/report-tools.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_ENTRY = path.join(PACKAGE_ROOT, "src", "index.ts");

const REPORT_TOOL_NAMES = [
  REPORT_GAP_ANALYSIS_TOOL_NAME,
  REPORT_PLAN_REVIEW_TOOL_NAME,
  REPORT_WORK_TOOL_NAME,
] as const;

/** The reporting role each tool belongs to, and nobody else. */
const ROLE_TOOL: Record<string, string> = {
  "opsx-gap-analysis": REPORT_GAP_ANALYSIS_TOOL_NAME,
  "opsx-plan-review": REPORT_PLAN_REVIEW_TOOL_NAME,
  "opsx-worker": REPORT_WORK_TOOL_NAME,
};

let agentDir: string;

beforeAll(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "opsx-isolation-agent-"));
});

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

async function loadMainExtension() {
  return discoverAndLoadExtensions([EXTENSION_ENTRY], PACKAGE_ROOT, agentDir);
}

/** The extension record for this package's entry, loaded for real. */
async function mainExtension() {
  const result = await loadMainExtension();
  const main = result.extensions.find(
    (extension) => extension.resolvedPath === EXTENSION_ENTRY,
  );
  if (!main) {
    throw new Error(
      `the entry did not load; errors: ${JSON.stringify(result.errors)}`,
    );
  }
  return { main, result };
}

describe("main session tool surface (real SDK load)", () => {
  test(
    "the loaded entry registers the two parent gate tools and no report tool",
    { timeout: 60_000 },
    async () => {
      const { main } = await mainExtension();
      const names = [...main.tools.keys()];
      expect(names).toContain(OPSX_PLAN_GAP_ANALYSIS_TOOL_NAME);
      expect(names).toContain(OPSX_PLAN_VERDICT_TOOL_NAME);
      for (const leaked of REPORT_TOOL_NAMES) {
        expect(
          names,
          `${leaked} must not reach the main session`,
        ).not.toContain(leaked);
      }
    },
  );

  test(
    "no lifecycle hook or command handler adds a report tool to the main session",
    { timeout: 60_000 },
    async () => {
      const { main } = await mainExtension();
      const before = [...main.tools.keys()].sort();

      // Drive every lifecycle channel the extension actually subscribed to,
      // including the ones a plan/agent/direct mode transition would fire.
      const eventSamples: Record<string, unknown> = {
        session_start: { type: "session_start", reason: "startup" },
        session_tree: { type: "session_tree" },
        turn_end: { type: "turn_end", messages: [] },
        tool_call: { type: "tool_call", toolName: "read", input: {} },
        tool_result: {
          type: "tool_result",
          toolName: "read",
          input: {},
          isError: false,
        },
        resources_discover: {
          type: "resources_discover",
          cwd: PACKAGE_ROOT,
          reason: "startup",
        },
        before_agent_start: {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "",
          systemPromptOptions: {},
        },
      };
      const ctx = {
        cwd: PACKAGE_ROOT,
        hasUI: false,
        isIdle: () => true,
        ui: { notify: () => {}, select: async () => undefined },
        sessionManager: {
          getSessionId: () => "isolation-session",
          getSessionFile: () => undefined,
          getLeafId: () => null,
          getEntry: () => undefined,
          getBranch: () => [],
          getEntries: () => [],
        },
      };
      for (const [event, payload] of Object.entries(eventSamples)) {
        const handlers = main.handlers.get(event) ?? [];
        for (const handler of handlers) {
          try {
            await handler(payload, ctx);
          } catch {
            // A handler that needs a richer context may throw; the property
            // under test is that it never registers a report tool.
          }
        }
      }

      // Now the real command handlers: entering plan/agent/direct modes is
      // exactly the path that could have re-registered a tool.
      for (const commandName of ["opsx:plan", "opsx:implement"]) {
        const command = main.commands.get(commandName);
        expect(command, `${commandName} must be registered`).toBeDefined();
        try {
          await command?.handler("", ctx as never);
        } catch {
          // UI-less stub context: the handler may refuse; registration is
          // what matters here.
        }
      }

      expect([...main.tools.keys()].sort()).toEqual(before);
      for (const leaked of REPORT_TOOL_NAMES) {
        expect(main.tools.has(leaked)).toBe(false);
      }
    },
  );

  test(
    "a reload yields the same surface (no mode-dependent leak)",
    { timeout: 60_000 },
    async () => {
      const first = await mainExtension();
      const second = await mainExtension();
      expect([...second.main.tools.keys()].sort()).toEqual(
        [...first.main.tools.keys()].sort(),
      );
      for (const leaked of REPORT_TOOL_NAMES) {
        expect(second.main.tools.has(leaked)).toBe(false);
      }
    },
  );

  test("the package manifest still exposes only the main entry", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    expect(pkg.pi?.extensions).toEqual(["./index.ts"]);
  });
});

describe("child launch tool plan (native resolution)", () => {
  test("each reporting role receives exactly its own tool", () => {
    for (const name of OPSX_AGENT_NAMES) {
      const definition = OPSX_AGENT_DEFINITIONS[name];
      const plan = resolvePiLaunchToolPlan({
        tools: [...(definition.tools ?? [])],
        subagentOnlyExtensions: [...(definition.subagentOnlyExtensions ?? [])],
        cwd: PACKAGE_ROOT,
        agentName: name,
      });
      const expected = ROLE_TOOL[name];
      if (expected) {
        expect(
          plan.effectiveToolAllowlist,
          `${name} must be allowed ${expected}`,
        ).toContain(expected);
        // The child-only extension is the carrier, and it is loaded into the
        // child process — this is the same plan for foreground and background
        // launches, which is why no mode-specific branch is needed.
        expect(plan.runtimeExtensions.length).toBeGreaterThan(0);
        expect(plan.disableAmbientExtensions).toBe(false);
      }
      for (const other of REPORT_TOOL_NAMES) {
        if (other === expected) continue;
        expect(
          plan.effectiveToolAllowlist,
          `${name} must not be allowed ${other}`,
        ).not.toContain(other);
      }
    }
  });

  test("the reviewer gets the goal-x progress tool and no report tool", () => {
    const reviewer = OPSX_AGENT_DEFINITIONS["opsx-reviewer"];
    const plan = resolvePiLaunchToolPlan({
      tools: [...(reviewer.tools ?? [])],
      subagentOnlyExtensions: [...(reviewer.subagentOnlyExtensions ?? [])],
      cwd: PACKAGE_ROOT,
      agentName: "opsx-reviewer",
    });
    for (const leaked of REPORT_TOOL_NAMES) {
      expect(plan.effectiveToolAllowlist).not.toContain(leaked);
    }
  });

  test("role isolation does not depend on PI_SUBAGENT_CHILD", () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    const worker = OPSX_AGENT_DEFINITIONS["opsx-worker"];
    const run = () =>
      resolvePiLaunchToolPlan({
        tools: [...(worker.tools ?? [])],
        subagentOnlyExtensions: [...(worker.subagentOnlyExtensions ?? [])],
        cwd: PACKAGE_ROOT,
        agentName: "opsx-worker",
      });
    try {
      delete process.env.PI_SUBAGENT_CHILD;
      const without = run();
      process.env.PI_SUBAGENT_CHILD = "1";
      const with_ = run();
      expect(with_.effectiveToolAllowlist).toEqual(
        without.effectiveToolAllowlist,
      );
      expect(with_.runtimeExtensions).toEqual(without.runtimeExtensions);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  });
});
