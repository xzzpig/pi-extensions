import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadOpsxConfig, type OpsxConfig } from "./config.ts";
import {
  createOpsxAgentsSessionStartHandler,
  registerOpsxAgents,
} from "./agents.ts";
import {
  probeGoalXDependency,
  probeSandboxDependency,
  probeSubagentsDependency,
  noteSandboxUnavailable,
  describeError,
  requireGoalXSupport,
} from "./dependencies.ts";
import { createResourcesDiscoverHandler } from "./discover.ts";
import { createOpsxRecoverySessionStartHandler } from "./goal-base.ts";
import { readGoalBaseSummaries } from "./goal-base.ts";
import { registerChildReportIngestion } from "./child-report-ingestion.ts";
import { childReportFlowId } from "./child-report-ingestion.ts";
import {
  registerOpsxAuditorResolver,
  buildOpsxAuditorOverride,
} from "./final-gate.ts";
import {
  registerFlowRenderers,
  createStatusSnapshotTurnEndHandler,
  type OpsxFlowState,
} from "./flow-entries.ts";
import {
  registerImplementFlow,
  activeImplementFlow,
  rebindImplementFlow,
} from "./implement-command.ts";
import { createOpsxSessionStartHandler } from "./mode.ts";
import {
  registerPlanFlow,
  activePlanSession,
  rebindPlanFlow,
} from "./plan-command.ts";
import { registerRollbackFlow } from "./rollback-command.ts";
import { registerPlanGateTools } from "./plan-gate.ts";
import { recordChildReportProgress } from "./progress-observer.ts";
import { buildSandboxProfiles } from "./sandbox-profiles.ts";

// Read once at extension load (merge semantics in loadOpsxConfig).
const config: OpsxConfig = loadOpsxConfig();

/**
 * pi-openspec-x extension entry point.
 *
 * pi-sandbox is probed lazily through a dynamic import (dependencies.ts): on
 * success the three opsx sandbox profiles (D4: opsx-planner / opsx-agent /
 * opsx-reviewer) are registered into pi-sandbox's runtime registry — in-memory
 * for the session lifetime, never written to a user's sandbox.json, a
 * user-defined same-name profile always keeping priority. On failure the
 * reason is recorded as dependency state and the extension continues: the
 * official-track skills and every other capability keep working, and a later
 * request for a restricted mode is refused with a typed
 * OpsxDependencyMissingError (fail-closed) instead of the extension (or the
 * official track) dying at load time.
 *
 * Registers the resources_discover handler, which:
 * - generates (and caches, keyed by CLI version) the official-track
 *   openspec-* skills under `<agentDir>/cache/pi-openspec-x/skills/` and
 *   exposes the directory to pi via `skillPaths`;
 * - warns once per project when static `<cwd>/.pi/skills/openspec-*`
 *   directories collide with the generated skills.
 *
 * Registers the session_start handler that clears a stale `active_agent`
 * identity left in the session file by an earlier session (pi-agent-role's
 * semantics; see mode.ts).
 *
 * Registers the three child reporting tools (report_gap_analysis,
 * report_plan_review, report_work) through the role-specific child-only
 * extensions declared in agents.ts (design D1): each tool is registered into
 * its own subagent's process and never into the main session, so the parent's
 * tool declaration and prompt rules stay free of them.
 *
 * pi-subagents is probed the same lazy way: on success the four opsx
 * subagents (opsx-gap-analysis / opsx-plan-review / opsx-worker / opsx-reviewer) are
 * registered into pi-subagents' runtime registry via the owner's event bus
 * (D3). A missing pi-subagents costs only the enhanced flow's subagents —
 * the official track and direct main-session implementation are unaffected.
 * Because the owner listener only exists once pi-subagents has loaded (load
 * order between extensions is not guaranteed), a failed init-time attempt is
 * retried on session_start.
 *
 * Missing openspec CLI: no skills are registered and no error escapes — a
 * one-time notice is sent instead.
 */
export default async function piOpenspecX(pi: ExtensionAPI): Promise<void> {
  const probe = await probeSandboxDependency();
  if (probe.module) {
    try {
      probe.module.registerSandboxProfiles(buildSandboxProfiles(config));
    } catch (error) {
      // Invalid profile definitions are recorded like any other sandbox
      // failure: the official track keeps working, restricted modes are
      // refused with the actual reason.
      noteSandboxUnavailable(
        `registering the opsx sandbox profiles failed: ${describeError(error)}`,
      );
    }
  }

  // Progress lines for the flow entries (task 9.1).
  //
  // The progress board is no longer fed by a main-session `tool_result`
  // listener: the report tools are not registered here any more (design D1),
  // so the only honest source is an accepted child report, delivered through
  // the ingestion callback below (task 4.4).
  registerFlowRenderers(pi);
  // `/opsx:plan`: planner mode + append-only phase injection (task 7.1).
  registerPlanFlow(pi);
  // REJECT rollback with backup (spec: REJECT 回滚带备份).
  registerRollbackFlow(pi);
  // Parent-side plan gate tools: ledger recording + user approval (7.2/7.3).
  registerPlanGateTools(pi);
  // `/opsx:implement`: mode selection + goal-based implementation (task 8.1).
  registerImplementFlow(pi);

  await probeSubagentsDependency();
  // Record goal-x availability for the /opsx:implement fail-closed gate
  // (task 6.6). A missing/incompatible goal-x never blocks extension load.
  const goalXProbe = await probeGoalXDependency();
  if (goalXProbe.available) {
    // S2 seam: make the custom opsx-reviewer visible to goal-x's completion
    // audit preflight for the whole session (task 8.3). Ordinary goals never
    // resolve through this resolver (it only answers "opsx-reviewer").
    registerOpsxAuditorResolver(goalXProbe.module);
  }
  registerOpsxAgents(pi);
  const disposeAgentsSessionStart = pi.on(
    "session_start",
    createOpsxAgentsSessionStartHandler(pi),
  );

  const disposeResourcesDiscover = pi.on(
    "resources_discover",
    createResourcesDiscoverHandler(pi),
  );
  const disposeSessionStart = pi.on(
    "session_start",
    createOpsxSessionStartHandler(pi),
  );
  // Read-only recovery entry: if the goal base holds an unfinished opsx
  // implementation goal, point the user at goal-x's /goal-resume (task 6.4).
  const disposeRecoverySessionStart = pi.on(
    "session_start",
    createOpsxRecoverySessionStartHandler(pi, {
      // The S1 override is in-memory; re-install it (task 8.3).
      installAuditor: (goalId) => {
        requireGoalXSupport().setGoalAuditorOverride(goalId, {
          ...buildOpsxAuditorOverride(),
        });
      },
    }),
  );
  // Per-turn status snapshot (custom entry; survives compaction) — task 9.1.
  const disposeStatusSnapshot = pi.on(
    "turn_end",
    createStatusSnapshotTurnEndHandler(
      pi,
      (sessionId): OpsxFlowState | undefined => {
        const plan = activePlanSession(sessionId);
        if (plan) return { mode: "plan", changeId: plan.changeId };
        const impl = activeImplementFlow(sessionId);
        if (impl)
          return {
            mode: impl.mode,
            changeId: impl.changeId,
            phase: impl.phase,
          };
        return undefined;
      },
    ),
  );
  void disposeAgentsSessionStart;
  void disposeResourcesDiscover;
  void disposeSessionStart;
  void disposeRecoverySessionStart;
  void disposeStatusSnapshot;

  // Flow recovery (design D5): the flow registries are process memory, so a
  // cold start leaves them empty while the branch still holds the flow's own
  // entries. Re-bind on every session boundary and, as a lazy fallback, on the
  // first tool call of a session that missed them — otherwise a restored
  // session would silently skip the completion gate.
  const rebindKeys = new Set<string>();
  const rebindFlows = async (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const key = `${sessionId}:${ctx.sessionManager.getLeafId() ?? "?"}`;
    if (rebindKeys.has(key)) return;
    rebindKeys.add(key);
    try {
      rebindPlanFlow(sessionId, ctx);
    } catch {
      // Recovery is best-effort; an unbound flow stays unbound rather than
      // being bound to the wrong thing.
    }
    try {
      const result = await rebindImplementFlow(ctx, {
        readGoals: (innerCtx: ExtensionContext) =>
          readGoalBaseSummaries({
            cwd: innerCtx.cwd,
            sessionManager: innerCtx.sessionManager,
          }),
      });
      if (!result.ok) {
        pi.sendMessage(
          {
            customType: "pi-openspec-x/recovery-notice",
            content: result.reason,
            display: true,
          },
          { deliverAs: "followUp" },
        );
      }
    } catch {
      // Best-effort: never break a session boundary.
    }
  };
  const disposeRebindStart = pi.on(
    "session_start",
    (_event, ctx: ExtensionContext) => rebindFlows(ctx),
  );
  const disposeRebindSwitch = pi.on(
    "session_before_switch",
    (_event, ctx: ExtensionContext) => rebindFlows(ctx),
  );
  const disposeRebindTree = pi.on(
    "session_tree",
    (_event, ctx: ExtensionContext) => rebindFlows(ctx),
  );
  const disposeRebindToolCall = pi.on(
    "tool_call",
    (_event, ctx: ExtensionContext) => rebindFlows(ctx),
  );
  void disposeRebindStart;
  void disposeRebindSwitch;
  void disposeRebindTree;
  void disposeRebindToolCall;

  // Automatic child-report ingestion (design D3): the report tools live only in
  // their own child processes, so the parent reconstructs delivery from its own
  // launch records plus the child's canonical session record.
  registerChildReportIngestion(pi, {
    activeFlow: (sessionId) => {
      const flow = activeImplementFlow(sessionId);
      if (!flow) return undefined;
      return {
        flowId: childReportFlowId(sessionId, flow.changeId),
        changeId: flow.changeId,
        goalId: flow.goalId,
      };
    },
    // Display-only projection of an accepted report's structured progress.
    // It never gates, completes, or approves anything (task 4.4).
    onProgress: ({ sessionId, toolName, report }) => {
      recordChildReportProgress(pi, sessionId, { toolName, report });
    },
    // A durable record that cannot be confirmed is a real gap — the receipt
    // will not survive a restart. Surfacing it keeps a silent persistence
    // failure from looking like persistence was never wired (design D5).
    onDiagnostic: (message) => {
      pi.sendMessage({
        customType: "pi-openspec-x/recovery-notice",
        content: `[OPSX CHILD REPORT] ${message}`,
        display: true,
      });
    },
  });
}
