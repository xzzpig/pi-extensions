import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
} from "./implement-command.ts";
import { createOpsxSessionStartHandler } from "./mode.ts";
import { registerPlanFlow, activePlanSession } from "./plan-command.ts";
import { registerRollbackFlow } from "./rollback-command.ts";
import { registerPlanGateTools } from "./plan-gate.ts";
import { registerProgressObserver } from "./progress-observer.ts";
import { registerReportTools } from "./report-tools.ts";
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
 * report_plan_review, report_work) that the opsx subagents submit their
 * structured results through.
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

  registerReportTools(pi);
  // Parent-side projection of the subagents' structured progress (task 9.2).
  registerProgressObserver(pi);
  // Progress lines for the flow entries (task 9.1).
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
}
