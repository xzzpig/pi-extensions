/**
 * pi-notify extension composition root.
 *
 * Adapts Pi lifecycle and known plugin events into closed semantic events,
 * routes them to OSC/ntfy channel instances, and maintains the public
 * `herdr:blocked` contract independently of notification routing. Every
 * failure path is observational: notifications never block Pi, answers,
 * permissions, or other channels.
 *
 * Dialog waits: Pi core (>= 0.84.4) emits `ui_prompt_start`/`ui_prompt_end`
 * around the outermost blocking `ctx.ui` dialog. That generic adapter is the
 * single notification and Herdr source for dialog waits; labeled plugin
 * events (pi-ask flows, permission-system prompts) only provide
 * classification context and never notify or block on their own.
 */
import { createRequire } from "node:module";
import { basename } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  PI_NOTIFY_PUBLISH_EVENT,
  PI_NOTIFY_UI_SPAN_SILENT_EVENT,
  type NotificationEventId,
} from "../api.js";
import { createAgentRunTracker } from "./agent-events.js";
import { createOscSender } from "./channels/osc.js";
import { createNtfySender, ntfyHttpWarning } from "./channels/ntfy.js";
import {
  loadPiNotifyConfig,
  makeDefaultConfig,
  type ChannelInstance,
  type PiNotifyConfig,
} from "./config.js";
import {
  createNotificationEvent,
  parsePublishPayload,
  stringField,
  type InternalNotificationEvent,
} from "./events.js";
import { createHealthTracker } from "./health.js";
import { type RoutableChannel, createRouter } from "./router.js";
import { createInteractionState } from "./state.js";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_FOREGROUND_COMPLETE_EVENT,
  parseSubagentCompletion,
} from "./subagent-events.js";
import {
  UI_PROMPT_END_EVENT,
  UI_PROMPT_SOURCE,
  UI_PROMPT_START_EVENT,
  createUiPromptContexts,
  createUiPromptSpanTracker,
  parseUiPromptEvent,
  parseUiSpanSilentPayload,
} from "./ui-prompts.js";
import {
  createPermissionPromptTracker,
  parseForwardedPermissionDecision,
  parsePermissionDecision,
  parsePermissionPrompt,
  PERMISSIONS_DECISION_EVENT,
  PERMISSIONS_FORWARDED_DECISION_EVENT,
  PERMISSIONS_UI_PROMPT_EVENT,
} from "./permissions.js";

const PI_ASK_STARTED_EVENT = "@eko24ive/pi-ask:started";
const PI_ASK_COMPLETED_EVENT = "@eko24ive/pi-ask:completed";

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = (require("../package.json") as { version: string })
  .version;
export const DEFAULT_ICON_URL = `https://cdn.jsdelivr.net/npm/@xzzpig/pi-notify@${PACKAGE_VERSION}/assets/pi.png`;

export default function piNotify(pi: ExtensionAPI): void {
  const agentTracker = createAgentRunTracker();
  const uiContexts = createUiPromptContexts();
  const spans = createUiPromptSpanTracker();
  const state = createInteractionState(pi.events);
  const health = createHealthTracker({
    onFailure: (channelId, detail) =>
      notify(
        `notification channel "${channelId}" failed: ${detail}`,
        "warning",
      ),
    onRecovery: (channelId) =>
      notify(`notification channel "${channelId}" recovered`, "info"),
  });
  const router = createRouter({
    mode: () => currentMode,
    health,
  });

  let currentMode = "";
  let latestContext:
    | { ui?: { notify(message: string, type?: string): void } }
    | undefined;
  let config: PiNotifyConfig = makeDefaultConfig();
  let projectName = "";
  let herdrEnabled = false;
  let permissionPrompts:
    | ReturnType<typeof createPermissionPromptTracker>
    | undefined;
  let openSpanId: string | undefined;
  const seenWarnings = new Set<string>();

  const notify = (message: string, kind: "warning" | "info"): void => {
    if (seenWarnings.has(message)) {
      return;
    }
    seenWarnings.add(message);
    console.warn(`[pi-notify] ${message}`);
    if ((currentMode === "tui" || currentMode === "rpc") && latestContext?.ui) {
      latestContext.ui.notify(message, kind);
    }
  };

  const route = (
    id: NotificationEventId,
    source: string,
    label?: string,
  ): void => {
    if (!started) {
      return;
    }
    const event: InternalNotificationEvent = createNotificationEvent({
      id,
      source,
      label,
      projectName,
      sessionName: safeSessionName(pi),
    });
    router.route(event);
  };

  let started = false;

  pi.on("session_start", (_event, ctx) => {
    started = true;
    currentMode = String(ctx.mode ?? "");
    latestContext = ctx;
    projectName = basename(ctx.cwd ?? "");

    uiContexts.reset();
    openSpanId = undefined;
    agentTracker.shutdown();
    state.shutdown();

    const agentDir = agentDirectory();
    const loaded = loadPiNotifyConfig({
      agentDir,
      cwd: ctx.cwd,
      configDirName: CONFIG_DIR_NAME,
      trusted: ctx.isProjectTrusted(),
    });
    config = loaded.config;
    herdrEnabled = config.herdr.enabled;
    seenWarnings.clear();
    for (const warning of loaded.warnings) {
      notify(warning, "warning");
    }

    permissionPrompts?.shutdown();
    permissionPrompts = createPermissionPromptTracker({
      onResolved: (requestId) => {
        uiContexts.resolvePermission(requestId);
      },
    });

    router.setEnabled(config.enabled);
    router.setChannels(buildChannels(config));
    health.reset();
  });

  pi.on("session_shutdown", () => {
    started = false;
    currentMode = "";
    latestContext = undefined;
    projectName = "";
    uiContexts.reset();
    openSpanId = undefined;
    agentTracker.shutdown();
    state.shutdown();
    permissionPrompts?.shutdown();
    permissionPrompts = undefined;
    health.reset();
  });

  pi.on("agent_start", () => {
    agentTracker.onAgentStart();
  });

  pi.on("agent_end", (event) => {
    agentTracker.onAgentEnd(event);
  });

  pi.on("agent_settled", () => {
    const result = agentTracker.onSettled();
    if (!result || result === "silent") {
      return;
    }
    route(result === "error" ? "agent-error" : "agent-completed", "pi");
  });

  pi.on("session_compact", () => {
    route("context-compacted", "pi");
  });

  // Generic UI-wait adapter: the only dialog-wait notification and Herdr
  // source. Pi core coalesces nested dialogs into one outermost span, so at
  // most one span is open at a time; a defensive duplicate start is ignored.
  pi.on(UI_PROMPT_START_EVENT, (event) => {
    const prompt = parseUiPromptEvent(event);
    if (!prompt || openSpanId !== undefined) {
      return;
    }
    // Consume a pending silent marker before the agent gate: an idle span
    // still consumes the one-shot marker, so it can never leak into a later
    // agent-active span.
    const silent = uiContexts.consumeSilent();
    if (!agentTracker.isActive()) {
      // User-initiated dialogs (commands, settings) never notify or block.
      return;
    }

    const spanId = spans.nextSpanId();
    openSpanId = spanId;
    if (silent) {
      // Silent span: tracked for `ui_prompt_end` pairing, but produces no
      // notification and no Herdr wait entry.
      return;
    }

    const classification = uiContexts.classify(prompt.title);
    if (herdrEnabled) {
      state.startUiPrompt(spanId, classification.label);
    }
    route(classification.eventId, UI_PROMPT_SOURCE);
  });

  pi.on(UI_PROMPT_END_EVENT, (event) => {
    if (!parseUiPromptEvent(event)) {
      return;
    }
    const spanId = openSpanId;
    openSpanId = undefined;
    if (spanId === undefined) {
      return;
    }
    state.completeUiPrompt(spanId);
  });

  // Silent-span markers: a plugin that opens a dialog which is NOT an
  // agent-waiting prompt (monitoring panels, admin dialogs) claims the next
  // span before opening it. Observational: invalid payloads are ignored.
  pi.events.on(PI_NOTIFY_UI_SPAN_SILENT_EVENT, (event: unknown) => {
    if (!parseUiSpanSilentPayload(event)) {
      return;
    }
    uiContexts.markSilent();
  });

  // pi-ask flows: classification context only. The ask dialog itself opens
  // the core span that actually notifies and blocks Herdr.
  pi.events.on(PI_ASK_STARTED_EVENT, (event: unknown) => {
    const flowId = stringField(event, "flowId");
    if (!flowId) {
      return;
    }

    uiContexts.registerAskFlow(flowId, stringField(event, "title"));
  });

  pi.events.on(PI_ASK_COMPLETED_EVENT, (event: unknown) => {
    const flowId = stringField(event, "flowId");
    if (!flowId) {
      return;
    }
    uiContexts.completeAskFlow(flowId);
  });

  // permission-system prompts: classification context only; decision events
  // resolve the tracker, which clears the pending context.
  pi.events.on(PERMISSIONS_UI_PROMPT_EVENT, (event: unknown) => {
    const prompt = parsePermissionPrompt(event);
    if (!prompt) {
      return;
    }

    uiContexts.trackPermission(
      prompt.requestId,
      prompt.forwarding?.requesterAgentName,
    );
    permissionPrompts?.track(prompt);
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

  for (const eventName of [
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    SUBAGENT_FOREGROUND_COMPLETE_EVENT,
  ] as const) {
    pi.events.on(eventName, (event: unknown) => {
      const completion = parseSubagentCompletion(event);
      if (completion.kind === "silent") {
        return;
      }
      route(completion.kind, "pi-subagents", completion.label);
    });
  }

  pi.events.on(PI_NOTIFY_PUBLISH_EVENT, (payload: unknown) => {
    const parsed = parsePublishPayload(payload);
    if (!parsed) {
      notify("ignored invalid pi-notify:publish payload", "warning");
      return;
    }
    route(parsed.eventId, parsed.source, parsed.label);
  });

  function buildChannels(channelConfig: PiNotifyConfig): RoutableChannel[] {
    return channelConfig.channels.map((instance) =>
      buildRoutableChannel(instance),
    );
  }

  function buildRoutableChannel(instance: ChannelInstance): RoutableChannel {
    const base = {
      id: instance.id,
      type: instance.type,
      enabled: instance.enabled,
      subscribed: instance.events,
    };
    if (instance.type === "osc" && instance.osc) {
      const sender = createOscSender({
        fallback: instance.osc.fallback,
        termPrograms: instance.osc.termPrograms,
        termProgram: process.env.TERM_PROGRAM,
        kittyWindowId: process.env.KITTY_WINDOW_ID,
      });
      return { ...base, send: (event) => sender.send(event) };
    }
    if (instance.type === "ntfy" && instance.ntfy) {
      const warning = ntfyHttpWarning(instance.ntfy);
      if (warning) {
        notify(warning, "warning");
      }
      const sender = createNtfySender({
        config: instance.ntfy,
        defaultIconUrl: DEFAULT_ICON_URL,
      });
      return { ...base, send: (event) => sender.send(event) };
    }
    // Unreachable after config validation; keep the channel inert.
    return { ...base, send: () => undefined };
  }
}

function agentDirectory(): string | undefined {
  try {
    return getAgentDir();
  } catch {
    return undefined;
  }
}

function safeSessionName(pi: ExtensionAPI): string | undefined {
  try {
    return pi.getSessionName() ?? undefined;
  } catch {
    return undefined;
  }
}
