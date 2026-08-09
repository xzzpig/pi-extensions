import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createDefaultTerminalNotificationConfig,
  loadTerminalNotificationConfig,
  resolveNotificationProtocol,
  type TerminalNotificationConfig,
} from "./config.js";
import { emitTerminalNotification } from "./notifications.js";
import {
  createPermissionPromptTracker,
  parseForwardedPermissionDecision,
  parsePermissionDecision,
  parsePermissionPrompt,
  PERMISSIONS_DECISION_EVENT,
  PERMISSIONS_FORWARDED_DECISION_EVENT,
  PERMISSIONS_UI_PROMPT_EVENT,
  type PermissionPromptTracker,
} from "./permissions.js";
import { createInteractionState } from "./state.js";

const PI_ASK_STARTED_EVENT = "@eko24ive/pi-ask:started";
const PI_ASK_COMPLETED_EVENT = "@eko24ive/pi-ask:completed";
const DEFAULT_ASK_LABEL = "Waiting for input";

export default function piTerminalNotifications(pi: ExtensionAPI): void {
  let agentRunActive = false;
  let config = createDefaultTerminalNotificationConfig();
  let terminalNotificationsEnabled = false;
  let permissionPrompts: PermissionPromptTracker | undefined;
  const state = createInteractionState(pi.events);

  const notify = (identifier: string, title: string, body: string): void => {
    if (!terminalNotificationsEnabled) {
      return;
    }

    emitTerminalNotification(
      resolveNotificationProtocol(config, process.env.TERM_PROGRAM),
      {
        body,
        identifier,
        title,
      },
    );
  };

  pi.on("session_start", (_event, ctx) => {
    const agentDir = agentDirectory();
    config = loadConfig(agentDir);
    permissionPrompts?.shutdown();
    permissionPrompts = createPermissionPromptTracker({
      onResolved: (requestId) => state.resolvePermission(requestId),
    });
    // Never write terminal control sequences in JSON, print, or RPC mode.
    terminalNotificationsEnabled = contextMode(ctx) === "tui";
  });

  pi.on("agent_start", () => {
    agentRunActive = true;
  });

  pi.on("agent_settled", () => {
    if (!agentRunActive) {
      return;
    }

    agentRunActive = false;
    notify("pi", "Pi", "Pi has completed its work.");
  });

  pi.events.on(PI_ASK_STARTED_EVENT, (event: unknown) => {
    const flowId = stringField(event, "flowId");
    if (!flowId) {
      return;
    }

    const label = stringField(event, "title") ?? DEFAULT_ASK_LABEL;
    if (!state.startAsk(flowId, label)) {
      return;
    }

    notify("pi-ask", "Pi ask", `Pi ask is waiting for your response: ${label}`);
  });

  pi.events.on(PI_ASK_COMPLETED_EVENT, (event: unknown) => {
    const flowId = stringField(event, "flowId");
    if (flowId) {
      state.completeAsk(flowId);
    }
  });

  pi.events.on(PERMISSIONS_UI_PROMPT_EVENT, (event: unknown) => {
    const prompt = parsePermissionPrompt(event);
    if (!prompt) {
      return;
    }

    const label = permissionLabel(prompt);
    if (!state.startPermission(prompt.requestId, label)) {
      return;
    }

    permissionPrompts?.track(prompt);
    notify("pi-permission", label, permissionMessage(prompt));
  });

  pi.events.on(PERMISSIONS_DECISION_EVENT, (event: unknown) => {
    const decision = parsePermissionDecision(event);
    if (decision) {
      permissionPrompts?.resolveDecision(decision);
    }
  });

  pi.events.on(PERMISSIONS_FORWARDED_DECISION_EVENT, (event: unknown) => {
    const decision = parseForwardedPermissionDecision(event);
    if (decision) {
      permissionPrompts?.resolveForwardedDecision(decision);
    }
  });

  pi.on("session_shutdown", () => {
    agentRunActive = false;
    terminalNotificationsEnabled = false;
    permissionPrompts?.shutdown();
    permissionPrompts = undefined;
    state.shutdown();
  });
}

function agentDirectory(): string | undefined {
  try {
    return getAgentDir();
  } catch {
    return undefined;
  }
}

function loadConfig(agentDir: string | undefined): TerminalNotificationConfig {
  if (!agentDir) {
    return createDefaultTerminalNotificationConfig();
  }

  return loadTerminalNotificationConfig(agentDir);
}

function permissionLabel(
  prompt: ReturnType<typeof parsePermissionPrompt>,
): string {
  if (prompt?.forwarding?.requesterAgentName) {
    return `Permission required by ${prompt.forwarding.requesterAgentName}`;
  }

  return "Permission required";
}

function permissionMessage(
  prompt: NonNullable<ReturnType<typeof parsePermissionPrompt>>,
): string {
  const requester = prompt.forwarding?.requesterAgentName
    ? `Subagent ${prompt.forwarding.requesterAgentName}`
    : "Pi";
  if (prompt.message) {
    return `${requester} is waiting for permission approval: ${prompt.message}`;
  }

  if (prompt.surface && prompt.value) {
    return `${requester} is waiting for permission approval: ${prompt.surface} ${prompt.value}`;
  }

  return `${requester} is waiting for permission approval.`;
}

function contextMode(context: unknown): string | undefined {
  const mode = asRecord(context)?.mode;
  return typeof mode === "string" ? mode : undefined;
}

function stringField(event: unknown, field: string): string | undefined {
  const value = asRecord(event)?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
