import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalCore } from "./goal-state.ts";
import type { GoalSettings } from "./goal-settings.ts";
import {
  getKeybindings,
  matchesKey,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";
import { fullscreenDashboardReservedKeys } from "./fork-dashboard-host-keys.ts";
import {
  dashboardKeyIsSupported,
  dashboardKeyOverlaps,
} from "./fork-dashboard-key-overlap.ts";
import {
  GOAL_KEY_ACTIONS,
  bindingKeys,
  keyActionBinding,
} from "./goal-controls.ts";

const actions = new Map(
  GOAL_KEY_ACTIONS.map((action) => [action.path.slice(1).join("."), action]),
);

interface DashboardKeyState {
  settings: unknown;
  goal?: { status: string; autoContinue: boolean } | null;
  audit: boolean;
  expanded: boolean;
  isIdle: () => boolean;
  host?: TUI;
  keyboardAvailable?: boolean;
}

type Route =
  | "interruptAudit"
  | "collapse"
  | "pause"
  | "interruptTurn"
  | "toggleExpand"
  | "toggleAuditor";

function keysFor(settings: unknown, path: string): KeyId[] {
  return bindingKeys(keyActionBinding(settings, actions.get(path)!));
}

function hostInterruptKeys(): KeyId[] {
  try {
    const keys = getKeybindings().getKeys("app.interrupt");
    if (keys.length) return keys;
  } catch {
    /* Embeddings without an application keymap retain Escape. */
  }
  return ["escape"];
}

/** The prioritized dashboard actions that run before list navigation. Input
 * matches the raw event; the footer projects only keys not owned earlier. */
function* dashboardKeyRoutes(
  state: DashboardKeyState,
): Generator<readonly [Route, KeyId[]]> {
  const { goal, audit, expanded, settings } = state;
  if (audit) yield ["interruptAudit", keysFor(settings, "interruptAudit")];
  if (expanded) yield ["collapse", keysFor(settings, "dashboard.collapse")];
  const mayInterrupt = goal?.status === "active" && goal.autoContinue;
  const pause = keysFor(settings, "pause");
  if (
    pause.length &&
    (mayInterrupt || (goal?.status === "paused" && !state.isIdle()))
  )
    yield ["pause", pause];
  // For an active goal any matching pause key was already offered above.
  if (mayInterrupt) yield ["interruptTurn", hostInterruptKeys()];
  yield ["toggleExpand", keysFor(settings, "dashboard.toggleExpand")];
  yield ["toggleAuditor", keysFor(settings, "toggleAuditor")];
}

export function dispatchDashboardKey(
  data: string,
  settings: GoalSettings,
  core: GoalCore,
  ctx: ExtensionContext,
): "consume" | "pass" | undefined {
  for (const [route, keys] of dashboardKeyRoutes({
    settings,
    goal: core.state.goal,
    audit: !!core.auditProgress,
    expanded: core.isDashboardExpanded(),
    isIdle: () => ctx.isIdle(),
  })) {
    if (!keys.some((key) => matchesKey(data, key))) continue;
    switch (route) {
      case "interruptAudit":
        core.abortAudit(ctx);
        break;
      case "collapse":
      case "toggleExpand":
        core.toggleDashboardExpanded();
        break;
      case "pause":
        core.interruption.pause(ctx);
        // Preserve Pi's ordinary Escape handling for the default combined stop.
        if (matchesKey(data, "escape") && settings.pauseOrder === "together")
          return "pass";
        break;
      case "interruptTurn":
        core.interruption.interruptTurn(ctx);
        break;
      case "toggleAuditor":
        core.toggleGoalAuditor(ctx);
        core.goalWidgetComponentRef.current?.invalidate();
        break;
    }
    return "consume";
  }
  return undefined;
}

export interface DashboardFooterKeys {
  toggle: KeyId[];
  stopAudit: KeyId[];
  toggleAuditor: KeyId[];
  scrollUp: KeyId[];
  scrollDown: KeyId[];
}

export function dashboardFooterKeys(
  state: DashboardKeyState,
): DashboardFooterKeys {
  const claimed = fullscreenDashboardReservedKeys(state.host);
  const available = (keys: KeyId[]) =>
    keys.filter(
      (key) =>
        dashboardKeyIsSupported(key) &&
        !claimed.some((earlier) => dashboardKeyOverlaps(key, earlier)),
    );
  const hints: DashboardFooterKeys = {
    toggle: [],
    stopAudit: [],
    toggleAuditor: [],
    scrollUp: [],
    scrollDown: [],
  };
  if (state.keyboardAvailable === false) return hints;
  for (const [route, keys] of dashboardKeyRoutes(state)) {
    const effective = available(keys);
    if (route === "interruptAudit") hints.stopAudit = effective;
    else if (route === "collapse" || route === "toggleExpand")
      hints.toggle.push(...effective);
    else if (route === "toggleAuditor") hints.toggleAuditor = effective;
    claimed.push(...keys);
  }
  if (!state.audit || state.expanded) {
    hints.scrollUp = available(
      keysFor(
        state.settings,
        state.expanded ? "dashboard.up" : "dashboard.scrollUp",
      ),
    );
    claimed.push(...hints.scrollUp);
    hints.scrollDown = available(
      keysFor(
        state.settings,
        state.expanded ? "dashboard.down" : "dashboard.scrollDown",
      ),
    );
  }
  return hints;
}
