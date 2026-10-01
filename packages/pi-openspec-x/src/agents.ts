/**
 * Runtime registration of the four opsx subagents (design D3).
 *
 * opsx-gap-analysis / opsx-plan-review / opsx-worker / opsx-reviewer are registered with
 * the installed pi-subagents owner through `registerAgentViaEvents` (the
 * pi-goal-x goal-auditor pattern): no agent markdown files, definitions owned
 * by this package, tool allowlists enforced by pi-subagents.
 *
 * Registration goes through the recorded pi-subagents facet
 * (dependencies.ts): when pi-subagents is missing the extension still loads,
 * the official-track skills keep working, and later dispatch attempts fail
 * closed with a typed OpsxDependencyMissingError. The event bus carries the
 * registration to pi-subagents' owner listener — that part works regardless
 * of extension load order — but pi-subagents may simply not be loaded yet
 * when this extension initializes, so a failed attempt (and only a failed
 * attempt) is retried on the next `session_start`, mirroring the goal-auditor
 * precedent of registering when the host is fully up.
 *
 * Re-registration is dispose-first idempotent: every previous registration is
 * disposed before new ones are created, so a reload or a session_start retry
 * never collides with itself.
 */
import { createRequire } from "node:module";
import type {
  ExtensionAPI,
  ExtensionHandler,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeAgentDefinition } from "@xzzpig/pi-subagents/agents";

import {
  GAP_ANALYSIS_SYSTEM_PROMPT,
  PLAN_REVIEW_SYSTEM_PROMPT,
  OPSX_REVIEWER_SYSTEM_PROMPT,
  WORKER_SYSTEM_PROMPT,
} from "./agent-prompts.ts";
import { describeError, requireSubagentsSupport } from "./dependencies.ts";
import type { SubagentsModuleFacet } from "./dependencies.ts";

import {
  REPORT_GAP_ANALYSIS_TOOL_NAME,
  REPORT_PLAN_REVIEW_TOOL_NAME,
  REPORT_WORK_TOOL_NAME,
} from "./report-tools.ts";

/**
 * Protocol tool goal-x's completion audit requires its auditor to carry
 * (preflight fails without it). The tool itself is registered by goal-x's
 * child-only progress extension; the reviewer's definition loads that
 * extension via `subagentOnlyExtensions` below, exactly like the default
 * goal-auditor does.
 */
export const REVIEWER_PROGRESS_TOOL_NAME = "report_auditor_progress";

/** The four agent names, in registration order. */
export const OPSX_AGENT_NAMES = [
  "opsx-gap-analysis",
  "opsx-plan-review",
  "opsx-worker",
  "opsx-reviewer",
] as const;

type OpsxAgentName = (typeof OPSX_AGENT_NAMES)[number];

/**
 * Absolute path of goal-x's child-only progress extension, resolved the same
 * way the default goal-auditor resolves its own copy: an absolute path on
 * purpose, because child pi processes run in the audited workspace, not this
 * package's directory. Resolved lazily-tolerantly: goal-x is an optional
 * peer, and an unresolvable path only defers the (already specified)
 * delegation preflight failure — it must not break extension load.
 */
const GOAL_AUDITOR_PROGRESS_MODULE =
  "@xzzpig/pi-goal-x/extensions/goal-auditor-progress.ts";

function resolveGoalAuditorProgressPath(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(GOAL_AUDITOR_PROGRESS_MODULE);
  } catch {
    return undefined;
  }
}

/** Isolation defaults shared by all four agents (goal-auditor precedent). */
const SHARED_ISOLATION = {
  systemPromptMode: "replace",
  inheritProjectContext: true,
  inheritSkills: false,
  defaultContext: "fresh",
} as const;

const reviewerProgressExtensionPath = resolveGoalAuditorProgressPath();

/** The four canonical runtime definitions, keyed by agent name. */
export const OPSX_AGENT_DEFINITIONS: Record<
  OpsxAgentName,
  RuntimeAgentDefinition
> = {
  "opsx-gap-analysis": {
    description:
      "Read-only pre-planning gap analyst for the opsx planning flow",
    systemPrompt: GAP_ANALYSIS_SYSTEM_PROMPT,
    tools: [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      REPORT_GAP_ANALYSIS_TOOL_NAME,
    ],
    ...SHARED_ISOLATION,
    acceptanceRole: "read-only",
    thinking: "high",
  },
  "opsx-plan-review": {
    description: "Read-only work-plan reviewer for the opsx planning flow",
    systemPrompt: PLAN_REVIEW_SYSTEM_PROMPT,
    tools: ["read", "grep", "find", "ls", REPORT_PLAN_REVIEW_TOOL_NAME],
    ...SHARED_ISOLATION,
    acceptanceRole: "read-only",
    thinking: "high",
  },
  "opsx-worker": {
    description:
      "Full-write single-task executor for the opsx implementation flow",
    systemPrompt: WORKER_SYSTEM_PROMPT,
    tools: [
      "read",
      "edit",
      "write",
      "bash",
      "grep",
      "find",
      "ls",
      REPORT_WORK_TOOL_NAME,
    ],
    ...SHARED_ISOLATION,
    acceptanceRole: "writer",
  },
  "opsx-reviewer": {
    description:
      "Read-only final holistic reviewer for the opsx implementation flow",
    systemPrompt: OPSX_REVIEWER_SYSTEM_PROMPT,
    tools: ["read", "grep", "find", "ls", "bash", REVIEWER_PROGRESS_TOOL_NAME],
    ...(reviewerProgressExtensionPath
      ? { subagentOnlyExtensions: [reviewerProgressExtensionPath] }
      : {}),
    ...SHARED_ISOLATION,
    acceptanceRole: "read-only",
    thinking: "high",
  },
};

/** Outcome of one registration attempt. */
export interface OpsxAgentsRegistrationResult {
  /** True when all four agents were registered in this attempt. */
  registered: boolean;
  /** Names registered before the attempt concluded (all four on success). */
  agents: OpsxAgentName[];
  /** Why the attempt failed; undefined on success. */
  reason?: string;
}

let activeDisposers: Array<() => void> = [];
let lastResult: OpsxAgentsRegistrationResult | undefined;

/** The last registration attempt's outcome, for the session_start retry gate. */
export function lastOpsxAgentsRegistration():
  | OpsxAgentsRegistrationResult
  | undefined {
  return lastResult;
}

function disposeActiveRegistrations(): void {
  for (const dispose of activeDisposers) {
    try {
      dispose();
    } catch {
      // A failed dispose must not block re-registration; the next
      // registration would collide only if dispose silently no-opped, which
      // pi-subagents' registry does not do.
    }
  }
  activeDisposers = [];
}

/** Reset registration state and drop active registrations. Test-only. */
export function resetAgentsRegistrationForTests(): void {
  disposeActiveRegistrations();
  lastResult = undefined;
}

/**
 * Register all four opsx agents with the installed pi-subagents owner. On any
 * failure the partial registration is rolled back and the typed reason
 * returned — this function never throws.
 */
export function registerOpsxAgents(
  pi: ExtensionAPI,
): OpsxAgentsRegistrationResult {
  disposeActiveRegistrations();
  lastResult = undefined;

  let registerAgentViaEvents: SubagentsModuleFacet["registerAgentViaEvents"];
  try {
    ({ registerAgentViaEvents } = requireSubagentsSupport());
  } catch (error) {
    lastResult = {
      registered: false,
      agents: [],
      reason: describeError(error),
    };
    return lastResult;
  }

  const agents: OpsxAgentName[] = [];
  const disposers: Array<() => void> = [];
  try {
    for (const name of OPSX_AGENT_NAMES) {
      const registration = registerAgentViaEvents({
        pi,
        name,
        definition: OPSX_AGENT_DEFINITIONS[name],
      });
      disposers.push(() => registration.dispose());
      agents.push(name);
    }
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Rollback is best-effort; the reported reason is what matters.
      }
    }
    lastResult = {
      registered: false,
      agents,
      reason: describeError(error),
    };
    return lastResult;
  }

  activeDisposers = disposers;
  lastResult = { registered: true, agents };
  return lastResult;
}

/**
 * Build the `session_start` handler that retries a failed registration once
 * the host is fully up (pi-subagents may load after this extension, so the
 * init-time attempt can find no listener yet). A no-op when the init attempt
 * already succeeded. Register alongside the other session handlers.
 */
export function createOpsxAgentsSessionStartHandler(
  pi: ExtensionAPI,
): ExtensionHandler<SessionStartEvent> {
  return (_event: SessionStartEvent, _ctx: unknown): void => {
    if (lastResult?.registered) return;
    registerOpsxAgents(pi);
  };
}
