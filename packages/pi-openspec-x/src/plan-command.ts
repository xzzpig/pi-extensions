/**
 * `/opsx:plan` command and turn_end injection wiring (design D5; openspec
 * change add-pi-openspec-x, task 7.1).
 *
 * Entering the plan mode appends one mode-contract message (never a system
 * prompt rewrite), and each turn_end appends at most one new phase block
 * through the BoundaryResult `entries` channel — the append-only discipline
 * that keeps the prompt-prefix cache intact. Skill registration is untouched.
 *
 * All CLI access is injectable: the default fetchers run the real `openspec
 * status` / `openspec instructions` commands, while tests supply data or
 * failures. A CLI failure degrades to the built-in skeleton and a notice; it
 * never stops the flow.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  TurnEndEvent,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  getOpenspecArtifactInstructions,
  runOpenspecJson,
  type OpenspecArtifactInstructions,
  type OpenspecCliOptions,
} from "./cli.ts";
import { describeError } from "./dependencies.ts";
import { sendNotice, sessionKey } from "./command-util.ts";
import { appendFlowEntry, OPSX_ENTRY_TYPES } from "./flow-entries.ts";
import { publishLifecycle, type EventEmitterLike } from "./lifecycle.ts";
import { enterOpsxMode } from "./mode.ts";
import {
  nextPlanPhase,
  renderPlanModeContract,
  renderPlanPhaseBlock,
  type PlanStatus,
} from "./plan-flow.ts";

/** customType of the appended mode-contract message. */
export const PLAN_MODE_CONTRACT_CUSTOM_TYPE =
  "pi-openspec-x/plan-mode-contract";
/** customType of an appended phase instruction block. */
export const PLAN_PHASE_CUSTOM_TYPE = "pi-openspec-x/plan-phase";
/** customType of a plan-flow notice. */
export const PLAN_NOTICE_CUSTOM_TYPE = "pi-openspec-x/plan-notice";

export interface PlanFlowDeps {
  /** CLI options (env/cwd/spawn) forwarded to the default fetchers. */
  cliOptions?: OpenspecCliOptions;
  /** Injectable status fetcher; defaults to `openspec status --json`. */
  fetchStatus?: (changeId: string) => PlanStatus;
  /** Injectable instructions fetcher; defaults to `openspec instructions`. */
  fetchInstructions?: (
    artifact: string,
    changeId: string,
  ) => OpenspecArtifactInstructions | undefined;
  /** Injectable restricted-mode entry; defaults to the planner sandbox mode. */
  enterMode?: (
    pi: Pick<ExtensionAPI, "appendEntry">,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  /** Lifecycle bus; defaults to `pi.events` at call time. */
  events?: EventEmitterLike;
}

interface PlanSession {
  changeId: string;
  /** Artifacts whose block was already appended (once per phase). */
  injected: Set<string>;
  degradedNotified: boolean;
  reviewNotified: boolean;
}

const planSessions = new Map<string, PlanSession>();

/** Reset the per-session plan-flow state. Test-only. */
export function resetPlanFlowStateForTests(): void {
  planSessions.clear();
}

/** The active plan session for a session id (status snapshot wiring). */
export function activePlanSession(
  sessionId: string,
): { changeId: string } | undefined {
  const session = planSessions.get(sessionId);
  return session ? { changeId: session.changeId } : undefined;
}

/**
 * End the plan session because the implementation flow takes over. Returns
 * the change id of the ended session, or undefined when none was active.
 */
export function endPlanFlow(sessionId: string): string | undefined {
  const session = planSessions.get(sessionId);
  if (!session) return undefined;
  planSessions.delete(sessionId);
  return session.changeId;
}

function defaultFetchStatus(
  changeId: string,
  options: OpenspecCliOptions,
): PlanStatus {
  return runOpenspecJson<PlanStatus>(
    ["status", "--change", changeId, "--json"],
    options,
  );
}

function defaultFetchInstructions(
  artifact: string,
  changeId: string,
  options: OpenspecCliOptions,
): OpenspecArtifactInstructions | undefined {
  try {
    return getOpenspecArtifactInstructions(artifact, changeId, options);
  } catch {
    return undefined;
  }
}

/**
 * Build the turn_end handler that appends the next phase block. Returns an
 * empty result while the change is unchanged, the block once per artifact,
 * and `continue: true` so the agent picks the block up in the same run.
 */
function createPlanTurnEndHandler(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
  deps: Required<Pick<PlanFlowDeps, "fetchStatus" | "fetchInstructions">>,
): ExtensionHandler<TurnEndEvent, TurnEndEventResult> {
  return (
    _event: TurnEndEvent,
    ctx: ExtensionContext,
  ): TurnEndEventResult | void => {
    const session = planSessions.get(sessionKey(ctx));
    if (!session) return;

    let status: PlanStatus;
    try {
      status = deps.fetchStatus(session.changeId);
    } catch (error) {
      sendNotice(
        pi,
        PLAN_NOTICE_CUSTOM_TYPE,
        `Could not read the change status for "${session.changeId}": ${describeError(error)}. Fix the CLI/change id, then continue the plan flow.`,
      );
      return;
    }

    const phase = nextPlanPhase(status);
    if (phase.kind === "review") {
      if (!session.reviewNotified) {
        session.reviewNotified = true;
        sendNotice(
          pi,
          PLAN_NOTICE_CUSTOM_TYPE,
          `Every artifact for change "${session.changeId}" is done. Dispatch the read-only opsx-plan-review plan reviewer and record each verdict with the opsx_plan_verdict tool; it applies the review-loop policy and opens the user approval dialog on OKAY.`,
        );
      }
      return;
    }

    if (session.injected.has(phase.artifact)) return;
    const instructions = deps.fetchInstructions(
      phase.artifact,
      session.changeId,
    );
    const block = renderPlanPhaseBlock(phase.artifact, instructions);
    session.injected.add(phase.artifact);
    appendFlowEntry(pi, OPSX_ENTRY_TYPES.phaseChanged, {
      changeId: session.changeId,
      phase: phase.artifact,
    });
    publishLifecycle(pi.events, {
      type: "phase_changed",
      change: session.changeId,
      mode: "plan",
      phase: phase.artifact,
    });
    if (block.degraded && !session.degradedNotified) {
      session.degradedNotified = true;
      sendNotice(
        pi,
        PLAN_NOTICE_CUSTOM_TYPE,
        `Live instructions for artifact "${phase.artifact}" were unavailable; the built-in skeleton was injected instead. Re-run \`openspec instructions ${phase.artifact} --change "${session.changeId}" --json\` when the CLI answers.`,
      );
    }
    return {
      entries: [
        {
          type: "custom_message",
          customType: PLAN_PHASE_CUSTOM_TYPE,
          content: block.content,
          display: true,
        },
      ],
      continue: true,
    };
  };
}

/**
 * Register the `/opsx:plan` command and the turn_end injection handler. The
 * command enters the restricted planner mode (fail-closed) before appending
 * the mode contract.
 */
export function registerPlanFlow(
  pi: ExtensionAPI,
  deps: PlanFlowDeps = {},
): void {
  const cliOptions = deps.cliOptions ?? {};
  const fetchStatus =
    deps.fetchStatus ??
    ((changeId: string) => defaultFetchStatus(changeId, cliOptions));
  const fetchInstructions =
    deps.fetchInstructions ??
    ((artifact: string, changeId: string) =>
      defaultFetchInstructions(artifact, changeId, cliOptions));
  const enterMode =
    deps.enterMode ??
    ((
      target: Pick<ExtensionAPI, "appendEntry">,
      ctx: ExtensionCommandContext,
    ) =>
      enterOpsxMode(target as ExtensionAPI, "planner", {
        sessionId: () => ctx.sessionManager.getSessionId(),
      }).then(() => undefined));

  pi.registerCommand("opsx:plan", {
    description:
      "Run the enhanced OpenSpec planning flow for a change (planner mode, gap-analysis / plan-review gates, user approval).",
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const changeId = args.trim();
      if (!changeId) {
        sendNotice(
          pi,
          PLAN_NOTICE_CUSTOM_TYPE,
          "Usage: /opsx:plan <change-id>",
        );
        return;
      }
      try {
        await enterMode(pi, ctx);
      } catch (error) {
        sendNotice(
          pi,
          PLAN_NOTICE_CUSTOM_TYPE,
          `Cannot enter plan mode: ${describeError(error)}`,
        );
        return;
      }
      planSessions.set(sessionKey(ctx), {
        changeId,
        injected: new Set(),
        degradedNotified: false,
        reviewNotified: false,
      });
      pi.sendMessage(
        {
          customType: PLAN_MODE_CONTRACT_CUSTOM_TYPE,
          content: renderPlanModeContract(changeId),
          display: true,
        },
        { deliverAs: "steer" },
      );
      appendFlowEntry(pi, OPSX_ENTRY_TYPES.modeEntered, {
        changeId,
        mode: "plan",
      });
      publishLifecycle(deps.events ?? pi.events, {
        type: "plan_started",
        change: changeId,
        mode: "plan",
      });
    },
  });

  pi.on(
    "turn_end",
    createPlanTurnEndHandler(pi, { fetchStatus, fetchInstructions }),
  );
}
