import { agentLoop } from "@earendil-works/pi-agent-core";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  sessionEntryToContextMessages,
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionBeforeSwitchEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
  type ToolResultEventResult,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import {
  type AuditDeps,
  type AuditLoopFn,
  type AuditModelRegistry,
  type AuditRequest,
  guardedStreamFn,
  startAudit,
} from "./audit-loop.js";
import { VerdictCache, hashRuleDefinition } from "./cache.js";
import {
  buildListEntries,
  formatListOption,
  formatListText,
  formatTestResult,
  type RuleListEntry,
  type TestRunSummary,
} from "./commands.js";
import {
  ConfigureDialog,
  type ApplyChangeResult,
  type ConfigChange,
} from "./configure-dialog.js";
import {
  loadConfig,
  loadConfigFromPaths,
  mergeRules,
  resolveConfigFilePaths,
  validateRule,
  writeFileConfig,
  DEFAULT_FLEET_KEYBINDINGS,
  type ConfigScope,
  type LoadedSentinelConfig,
  type SentinelDefaults,
  type SourcedRule,
} from "./config.js";
import {
  buildAgentEndEventData,
  buildContextTokensEventData,
  buildEventEventData,
  buildScopeText,
  buildToolCallEventData,
  buildToolResultEventData,
  buildTurnEndEventData,
  DEFAULT_SERIALIZE_OPTIONS,
  type SerializeOptions,
  type SentinelEventData,
} from "./event-data.js";
import {
  EventSubscriptionRegistry,
  type CoreSubscriber,
} from "./event-subscriptions.js";
import {
  FINDING_CUSTOM_TYPE,
  FindingInjector,
  findingRenderer,
} from "./injection.js";
import {
  buildFleetRows,
  openFleetInspector,
  updateSentinelStatus,
  type FleetRow,
} from "./fleet-view.js";
import { SentinelRegistry } from "./registry.js";
import {
  RuleRunner,
  Semaphore,
  type RunnerContext,
  type RunnerResult,
} from "./runner.js";
import { renderTemplate } from "./template.js";
import {
  SESSION_CONFIG_CUSTOM_TYPE,
  SessionConfigStore,
  type SessionConfigOp,
} from "./session-store.js";

/**
 * pi-sentinel composition root: loads config, builds one runner per rule, wires
 * the six triggers, and owns the lifecycle/reset rules.
 */

/** Pending blocking-warn lines attached to a tool call's result. */
interface PendingWarning {
  ruleName: string;
  message: string;
}

export interface SentinelRuntimeOverrides {
  /** Injectable side loop (tests); defaults to the real `agentLoop`. */
  agentLoop?: AuditLoopFn;
  now?: () => number;
  /** Injectable file-config loader (tests); defaults to `loadConfig`. */
  configLoader?: (ctx: ExtensionContext) => LoadedSentinelConfig;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstConcreteTool(rule: SourcedRule): string | undefined {
  return rule.trigger.tools?.find((pattern) => !pattern.includes("*"));
}

/** Parse simulated dry-run content into a tool input object. */
function parseSimulatedInput(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isPlainRecord(parsed)) return { ...parsed };
  } catch {
    // Not JSON: fall through to a text wrapper.
  }
  return { text: content };
}

/** Match a reported tool name against a rule's minimatch pattern array. */
export function matchesToolPatterns(
  toolName: string,
  patterns?: string[],
): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => minimatch(toolName, pattern));
}

export function serializeOptionsFor(rule: SourcedRule): SerializeOptions {
  return {
    includeThinking:
      rule.includeThinking ?? DEFAULT_SERIALIZE_OPTIONS.includeThinking,
    includeToolInputs:
      rule.includeToolInputs ?? DEFAULT_SERIALIZE_OPTIONS.includeToolInputs,
    includeToolOutputs:
      rule.includeToolOutputs ?? DEFAULT_SERIALIZE_OPTIONS.includeToolOutputs,
  };
}

/** Resolve the active branch's LLM-visible messages. */
export function contextMessages(ctx: ExtensionContext): AgentMessage[] {
  const entries = ctx.sessionManager.buildContextEntries();
  return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}

export class SentinelRuntime {
  private resolved: LoadedSentinelConfig | null = null;
  private fileConfig: LoadedSentinelConfig | null = null;
  private runners = new Map<string, RuleRunner>();
  private readonly cache = new VerdictCache();
  private semaphore = new Semaphore(3);
  private readonly registry = new SentinelRegistry();
  private readonly sessionStore = new SessionConfigStore();
  private readonly ruleHashes = new Map<string, string>();
  private configureDialog: ConfigureDialog | null = null;
  private fleetClose: (() => void) | null = null;
  private injector: FindingInjector | null = null;
  private ctx: ExtensionContext | null = null;
  private warnings: string[] = [];
  /** context_tokens incremental markers: last processed session entry id. */
  private readonly markers = new Map<string, string | null>();
  /** context_tokens multiple watermarks: last observed level. */
  private readonly watermarks = new Map<string, number>();
  private readonly pendingWarnings = new Map<string, PendingWarning[]>();
  /** `event`-trigger subscriptions; built in register(), null before that. */
  private eventSubscriptions: EventSubscriptionRegistry | null = null;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly overrides: SentinelRuntimeOverrides = {},
  ) {}

  getRegistry(): SentinelRegistry {
    return this.registry;
  }

  /** Read-only access to the event subscription registry (tests). */
  getEventSubscriptionRegistry(): EventSubscriptionRegistry | null {
    return this.eventSubscriptions;
  }

  getResolvedConfig(): LoadedSentinelConfig | null {
    return this.resolved;
  }

  getRunners(): Map<string, RuleRunner> {
    return this.runners;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  /** Register every event handler, command, and renderer. */
  register(): void {
    this.eventSubscriptions = new EventSubscriptionRegistry(
      // Host `pi.on` exposes per-event overloads but routes by string name at
      // runtime: the single controlled cast for event-trigger subscriptions.
      this.pi.on as unknown as CoreSubscriber,
      (channel, handler) => this.pi.events.on(channel, handler),
      (name, payload, ...ctxArgs) => {
        // Spread-forward to preserve the registry's dispatch arity: core
        // events always carry the host ctx as a third argument, bus events
        // never do.
        void this.handleEventTrigger(name, payload, ...ctxArgs);
      },
    );
    this.pi.on("session_start", (event, ctx) =>
      this.handleSessionStart(event, ctx),
    );
    this.pi.on("session_before_switch", (event) =>
      this.handleSessionBeforeSwitch(event),
    );
    this.pi.on("session_before_fork", () => this.handleRuntimeReset("fork"));
    this.pi.on("session_tree", (event, ctx) =>
      this.handleSessionTree(event, ctx),
    );
    this.pi.on("session_shutdown", (event) =>
      this.handleSessionShutdown(event),
    );
    this.pi.on("tool_call", (event, ctx) => this.handleToolCall(event, ctx));
    this.pi.on("tool_result", (event, ctx) =>
      this.handleToolResult(event, ctx),
    );
    this.pi.on("turn_end", (event, ctx) => this.handleTurnEnd(event, ctx));
    this.pi.on("agent_end", (event, ctx) => this.handleAgentEnd(event, ctx));
    this.pi.registerMessageRenderer(FINDING_CUSTOM_TYPE, findingRenderer);
    this.pi.registerCommand("sentinel:list", {
      description: "列出 pi-sentinel 规则；交互模式下可启用/禁用/移除",
      handler: async (_args, ctx) => this.handleListCommand(ctx),
    });
    this.pi.registerCommand("sentinel:configure", {
      description: "启动后台自然语言配置对话（仅交互模式）",
      handler: async (args, ctx) => this.handleConfigureCommand(args, ctx),
    });
    this.pi.registerCommand("sentinel:fleet", {
      description: "交互式实时检查器（仅交互模式）",
      handler: async (_args, ctx) => this.openFleet(ctx),
    });
    this.pi.registerCommand("sentinel:test", {
      description: "试运行一条规则（零分流副作用）",
      handler: async (args, ctx) => this.handleTestCommand(args, ctx),
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async handleSessionStart(
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.ctx = ctx;
    this.resetRuntimeState();
    // Session-level config is replayed from the active branch before files load.
    this.sessionStore.replay(ctx.sessionManager.getBranch());
    this.load(ctx);
    this.initializeMarkers(ctx);
    for (const warning of this.warnings)
      ctx.ui.notify(`pi-sentinel: ${warning}`, "warning");
    void event;
  }

  handleSessionBeforeSwitch(event: SessionBeforeSwitchEvent): void {
    this.handleRuntimeReset(`session_before_switch:${event.reason}`);
  }

  handleSessionTree(_event: SessionTreeEvent, ctx: ExtensionContext): void {
    // Tree navigation is not a session switch: only replay the session op-log
    // along the new active branch and re-anchor the increment markers. Running
    // audits, caches/cooldowns and a running configuration dialog are kept.
    this.sessionStore.replay(ctx.sessionManager.getBranch());
    this.rebuild(ctx);
    this.initializeMarkers(ctx);
  }

  handleSessionShutdown(_event: SessionShutdownEvent): void {
    // Session shutdown is the only reset path that tears down event
    // subscriptions: session switches and tree navigation share
    // resetRuntimeState, which must keep the config-level wiring alive.
    this.eventSubscriptions?.clear();
    this.handleRuntimeReset("session_shutdown");
  }

  /** Abort in-flight audits and clear session runtime state (keeps config). */
  handleRuntimeReset(reason: string): void {
    void reason;
    this.resetRuntimeState();
  }

  private resetRuntimeState(): void {
    for (const runner of this.runners.values()) {
      runner.abortAll();
      // Negative cooldowns are session runtime state: never carry them over.
      runner.resetCooldown();
    }
    this.configureDialog?.abort();
    this.registry.clearDialogs();
    this.cache.clear();
    this.injector?.clear();
    this.markers.clear();
    this.watermarks.clear();
    this.pendingWarnings.clear();
  }

  /** Load (or reload) file config and rebuild runners. */
  load(ctx: ExtensionContext): void {
    const loaded = (this.overrides.configLoader ?? loadConfig)(ctx);
    this.warnings = loaded.warnings;
    this.applyConfig(loaded, ctx);
  }

  /** Set the file scope, then layer session rules on top. */
  applyConfig(loaded: LoadedSentinelConfig, ctx: ExtensionContext): void {
    this.fileConfig = loaded;
    this.rebuild(ctx);
  }

  /**
   * Recompute the effective rule set (file + session) and reconcile runners:
   * unchanged rules keep their state, changed rules hot-reload, removed rules
   * are disposed (their running audits still dispatch under the old identity).
   */
  private rebuild(ctx: ExtensionContext): void {
    const file = this.fileConfig;
    if (!file) return;
    this.ctx = ctx;

    const effective: LoadedSentinelConfig = {
      ...file,
      rules: mergeRules(file.rules, this.sessionStore.sessionRules()),
    };
    this.resolved = effective;
    // One shared semaphore for every rule; hot reload only changes its limit so
    // in-flight slot accounting and the global cap are never split in two.
    this.semaphore.setLimit(effective.defaults.maxConcurrent ?? 3);

    const audit = this.buildAuditDeps(ctx, effective.defaults);
    const runnerContext: RunnerContext = {
      audit,
      cache: this.cache,
      semaphore: this.semaphore,
      history: this.registry,
      now: this.overrides.now,
      onFinding: (rule, verdict, durationMs) => {
        this.injector?.inject(
          rule,
          verdict,
          effective.defaults.dedupeCooldownMs ?? 600_000,
          durationMs,
        );
      },
      onAuditFailure: (rule, reason) => {
        ctx.ui.notify(
          `sentinel 审计失败（规则 "${rule.name}"）：${reason}`,
          "warning",
        );
      },
      onStateChange: () => this.refreshStatusBar(),
    };

    const nextRunners = new Map<string, RuleRunner>();
    const changedNames = new Set<string>();
    const removedNames = new Set<string>();
    for (const rule of effective.rules) {
      const hash = hashRuleDefinition(rule);
      const existing = this.runners.get(rule.name);
      if (existing && this.ruleHashes.get(rule.name) === hash) {
        existing.updateContext(runnerContext);
        nextRunners.set(rule.name, existing);
      } else if (existing) {
        existing.setRule(rule);
        existing.updateContext(runnerContext);
        changedNames.add(rule.name);
        nextRunners.set(rule.name, existing);
      } else {
        nextRunners.set(rule.name, new RuleRunner(rule, runnerContext));
        changedNames.add(rule.name);
      }
      this.ruleHashes.set(rule.name, hash);
    }
    for (const [name, runner] of this.runners) {
      if (!nextRunners.has(name)) {
        runner.dispose();
        this.ruleHashes.delete(name);
        removedNames.add(name);
      }
    }
    this.runners = nextRunners;
    this.registry.setRunners(this.runners);

    // Persistent injector: dedupe cooldowns are session runtime state and must
    // survive unrelated config changes. Only replaced/removed rules expire.
    if (!this.injector) {
      this.injector = new FindingInjector(
        {
          sendMessage: (message, options) =>
            this.pi.sendMessage(message, options),
          isIdle: () => this.ctx?.isIdle() ?? true,
        },
        {
          now: this.overrides.now,
          onDeduped: (rule, verdict) => {
            this.registry.record({
              at: this.now(),
              ruleName: rule.name,
              kind: "audit",
              status: "verdict",
              verdict,
              deduped: true,
            });
          },
        },
      );
    }
    for (const name of [...changedNames, ...removedNames]) {
      this.injector.invalidateRule(name);
    }

    const lastEntryId =
      ctx.sessionManager.buildContextEntries().at(-1)?.id ?? null;
    for (const name of changedNames) {
      const rule = effective.rules.find((candidate) => candidate.name === name);
      if (rule?.trigger.type === "context_tokens") {
        const threshold = rule.trigger.threshold;
        this.markers.set(name, lastEntryId);
        this.watermarks.set(
          name,
          threshold === undefined ? 0 : this.levelFor(ctx, threshold),
        );
      }
    }
    for (const name of removedNames) {
      this.markers.delete(name);
      this.watermarks.delete(name);
    }
    this.refreshStatusBar();

    // Event-trigger subscriptions are config-level wiring: keep them aligned
    // with the effective rule set's event names (an empty set unsubscribes
    // everything). Null before register().
    const eventNames = new Set<string>();
    for (const rule of effective.rules) {
      if (rule.trigger.type === "event" && rule.trigger.event)
        eventNames.add(rule.trigger.event);
    }
    this.eventSubscriptions?.reconcile(eventNames);
  }

  private buildAuditDeps(
    ctx: ExtensionContext,
    defaults: SentinelDefaults,
  ): AuditDeps {
    const registry: AuditModelRegistry = ctx.modelRegistry;
    // Guarded: a synchronous throw from streamSimple becomes a terminal error
    // stream instead of hanging the audit until timeoutMs.
    const streamFn: StreamFn = guardedStreamFn((model, context, options) =>
      ctx.modelRegistry.streamSimple(model, context, options),
    );
    return {
      agentLoop: this.overrides.agentLoop ?? agentLoop,
      streamFn,
      registry,
      sessionModel: ctx.model,
      defaults,
      cwd: ctx.cwd,
      now: this.overrides.now,
    };
  }

  private now(): number {
    return this.overrides.now ? this.overrides.now() : Date.now();
  }

  private initializeMarkers(ctx: ExtensionContext): void {
    if (!this.resolved) return;
    const lastId = ctx.sessionManager.buildContextEntries().at(-1)?.id ?? null;
    for (const rule of this.resolved.rules) {
      if (rule.trigger.type !== "context_tokens") continue;
      const threshold = rule.trigger.threshold;
      this.markers.set(rule.name, lastId);
      // Anchor the watermark at the level already reached: a rule loaded or
      // re-anchored mid-session must not fire a catch-up audit at the next
      // boundary; it fires on the next multiple it actually crosses.
      this.watermarks.set(
        rule.name,
        threshold === undefined ? 0 : this.levelFor(ctx, threshold),
      );
    }
  }

  /** floor(tokens / threshold), or 0 when usage is unavailable. */
  private levelFor(ctx: ExtensionContext, threshold: number): number {
    const tokens = ctx.getContextUsage()?.tokens ?? null;
    if (tokens === null || threshold <= 0) return 0;
    return Math.floor(tokens / threshold);
  }

  // ---------------------------------------------------------------------------
  // Trigger wiring
  // ---------------------------------------------------------------------------

  private rulesFor(
    triggerType: SourcedRule["trigger"]["type"],
    toolName?: string,
  ): SourcedRule[] {
    if (!this.resolved) return [];
    return this.resolved.rules.filter((rule) => {
      if (rule.trigger.type !== triggerType) return false;
      if (rule.enabled === false || this.sessionStore.isDisabled(rule.name))
        return false;
      if (toolName === undefined) return true;
      return matchesToolPatterns(toolName, rule.trigger.tools);
    });
  }

  /** Build an audit request with the trigger's event data and scope. */
  buildRequest(
    rule: SourcedRule,
    ctx: ExtensionContext,
    args: {
      eventData: SentinelEventData;
      defaultMessages?: readonly AgentMessage[];
      allMessages?: readonly AgentMessage[];
    },
  ): AuditRequest {
    const serialize = serializeOptionsFor(rule);
    const maxWindowTokens = this.resolved?.defaults.maxWindowTokens ?? 20_000;
    const scopeText = buildScopeText({
      triggerType: rule.trigger.type,
      eventData: args.eventData,
      defaultMessages: args.defaultMessages,
      allMessages: args.allMessages ?? contextMessages(ctx),
      window: rule.window,
      maxWindowTokens,
      serialize,
    });
    return {
      ruleName: rule.name,
      rule,
      prompt: rule.prompt,
      renderedPrompt: renderTemplate(rule.prompt, args.eventData),
      scopeText,
      eventData: args.eventData,
    };
  }

  private fireBackground(rule: SourcedRule, request: AuditRequest): void {
    const runner = this.runners.get(rule.name);
    if (!runner) return;
    void runner.run(request).catch(() => {});
  }

  async handleToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | void> {
    const toolName = event.toolName;
    const rules = this.rulesFor("tool_call", toolName);
    if (rules.length === 0) return;

    const fields = {
      toolName,
      toolCallId: event.toolCallId,
      input: { ...event.input },
    };
    const allMessages = contextMessages(ctx);

    const blockingRules = rules.filter((rule) => rule.mode === "blocking");
    for (const rule of rules) {
      if (rule.mode !== "background") continue;
      const eventData = buildToolCallEventData(
        fields,
        serializeOptionsFor(rule),
      );
      this.fireBackground(
        rule,
        this.buildRequest(rule, ctx, { eventData, allMessages }),
      );
    }
    if (blockingRules.length === 0) return;

    const results = await Promise.all(
      blockingRules.map((rule) => {
        const eventData = buildToolCallEventData(
          fields,
          serializeOptionsFor(rule),
        );
        const request = this.buildRequest(rule, ctx, {
          eventData,
          allMessages,
        });
        const runner = this.runners.get(rule.name);
        return runner
          ? runner.run(request)
          : Promise.resolve<RunnerResult>({
              ruleName: rule.name,
              cached: false,
              skipped: { reason: "no runner" },
            });
      }),
    );

    const blocks: Array<{ ruleName: string; line: string }> = [];
    const warnings: PendingWarning[] = [];

    for (const [index, result] of results.entries()) {
      const rule = blockingRules[index];
      if (result.failure) {
        if (result.failure.policy === "closed") {
          const line = result.failure.reason.includes("负冷却")
            ? `[pi-sentinel] 规则 "${rule.name}" 拦截本次调用：审计持续失败（负冷却中）`
            : `[pi-sentinel] 规则 "${rule.name}" 审计失败（fail-closed）：${result.failure.reason}`;
          blocks.push({ ruleName: rule.name, line });
        }
        // Fail-open: the failure itself is reported once by the runner's
        // onAuditFailure hook (which names the rule); do not notify again here.
        continue;
      }
      if (result.verdict?.verdict === "fail") {
        blocks.push({
          ruleName: rule.name,
          line: `[pi-sentinel] 规则 "${rule.name}" 拦截本次调用：${result.verdict.message}`,
        });
      } else if (result.verdict?.verdict === "warn") {
        warnings.push({ ruleName: rule.name, message: result.verdict.message });
      }
    }

    if (blocks.length > 0) {
      // fail wins: never attach a warn line for a blocked call.
      this.pendingWarnings.delete(fields.toolCallId);
      blocks.sort((a, b) => a.ruleName.localeCompare(b.ruleName));
      return {
        block: true,
        reason: blocks.map((entry) => entry.line).join("\n"),
      };
    }

    if (warnings.length > 0) {
      this.pendingWarnings.set(fields.toolCallId, warnings);
    }
    return;
  }

  async handleToolResult(
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<ToolResultEventResult | void> {
    const allMessages = contextMessages(ctx);
    for (const rule of this.rulesFor("tool_result", event.toolName)) {
      const eventData = buildToolResultEventData(
        {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          input: { ...event.input },
          content: event.content,
          isError: event.isError,
        },
        serializeOptionsFor(rule),
      );
      this.fireBackground(
        rule,
        this.buildRequest(rule, ctx, { eventData, allMessages }),
      );
    }

    const warnings = this.pendingWarnings.get(event.toolCallId);
    if (!warnings || warnings.length === 0) return;
    this.pendingWarnings.delete(event.toolCallId);

    const sorted = [...warnings].sort((a, b) =>
      a.ruleName.localeCompare(b.ruleName),
    );
    const prefix: TextContent = {
      type: "text",
      text: `${sorted
        .map(
          (warning) =>
            `[pi-sentinel][warn] ${warning.ruleName}: ${warning.message}`,
        )
        .join("\n")}\n`,
    };
    // `content` replaces the whole array, so the original entries must be kept.
    return { content: [prefix, ...event.content] };
  }

  async handleTurnEnd(
    event: TurnEndEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.pendingWarnings.clear();
    const allMessages = contextMessages(ctx);
    const defaultMessages: AgentMessage[] = [
      event.message,
      ...event.toolResults,
    ];

    for (const rule of this.rulesFor("turn_end")) {
      const eventData = buildTurnEndEventData(
        {
          turnIndex: event.turnIndex,
          assistant: event.message,
          toolResults: event.toolResults,
        },
        serializeOptionsFor(rule),
      );
      this.fireBackground(
        rule,
        this.buildRequest(rule, ctx, {
          eventData,
          defaultMessages,
          allMessages,
        }),
      );
    }

    this.checkContextTokens(ctx, allMessages);
  }

  async handleAgentEnd(
    event: AgentEndEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    const allMessages = contextMessages(ctx);
    const eventData = buildAgentEndEventData(event.messages.length);
    for (const rule of this.rulesFor("agent_end")) {
      this.fireBackground(
        rule,
        this.buildRequest(rule, ctx, {
          eventData,
          defaultMessages: event.messages,
          allMessages,
        }),
      );
    }

    this.checkContextTokens(ctx, allMessages);
  }

  /**
   * `context_tokens`: fire once per crossed multiple of the threshold. The
   * watermark follows the current level on every check (so compaction-induced
   * drops simply re-arm it), and each rule keeps its own incremental marker.
   */
  checkContextTokens(ctx: ExtensionContext, allMessages: AgentMessage[]): void {
    if (!this.resolved) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.tokens === undefined) return;
    const tokens = usage.tokens;

    const entries = ctx.sessionManager.buildContextEntries();
    const lastEntryId = entries.at(-1)?.id ?? null;

    for (const rule of this.resolved.rules) {
      if (rule.trigger.type !== "context_tokens") continue;
      const threshold = rule.trigger.threshold;
      if (!threshold) continue;
      const level = Math.floor(tokens / threshold);

      if (rule.enabled === false || this.sessionStore.isDisabled(rule.name)) {
        // Disabled rules keep advancing so re-enabling does not swallow a backlog.
        this.watermarks.set(rule.name, level);
        this.markers.set(rule.name, lastEntryId);
        continue;
      }

      const lastFired = this.watermarks.get(rule.name) ?? 0;
      if (level > lastFired) {
        const markerId = this.markers.get(rule.name) ?? null;
        const incremental = this.incrementalMessages(
          entries,
          markerId,
          allMessages,
        );
        const eventData = buildContextTokensEventData(
          { tokens, threshold, level, messages: incremental },
          serializeOptionsFor(rule),
        );
        this.fireBackground(
          rule,
          this.buildRequest(rule, ctx, {
            eventData,
            defaultMessages: incremental,
            allMessages,
          }),
        );
        this.markers.set(rule.name, lastEntryId);
      }
      this.watermarks.set(rule.name, level);
    }
  }

  private incrementalMessages(
    entries: ReturnType<
      ExtensionContext["sessionManager"]["buildContextEntries"]
    >,
    markerId: string | null,
    allMessages: AgentMessage[],
  ): AgentMessage[] {
    let startIndex = markerId
      ? entries.findIndex((entry) => entry.id === markerId)
      : -1;
    if (startIndex < 0) {
      // Marker invalidated by compaction: restart after the last compaction entry.
      let compactionIndex = -1;
      for (let index = 0; index < entries.length; index += 1) {
        if (entries[index].type === "compaction") compactionIndex = index;
      }
      startIndex = compactionIndex;
    }
    if (startIndex < 0) return [...allMessages];
    const slice = entries.slice(startIndex + 1);
    return slice.flatMap((entry) => sessionEntryToContextMessages(entry));
  }

  /**
   * `event` trigger dispatch, invoked by the subscription registry. The
   * registry guarantees core events always dispatch a third argument (the
   * host ctx, possibly undefined) while bus events never do; the dispatch
   * wiring spreads its arguments through, so `ctxArgs.length === 1`
   * reliably separates a host-provided ctx from the bus path, which falls
   * back to the runtime ctx refreshed by rebuild().
   */
  async handleEventTrigger(
    name: string,
    payload: unknown,
    ...ctxArgs: unknown[]
  ): Promise<void> {
    let ctx: ExtensionContext | null | undefined = null;
    try {
      ctx = ctxArgs.length > 0 ? (ctxArgs[0] as ExtensionContext) : this.ctx;
      if (!ctx) return;
      // Payload projection is rule-independent: build once for every match.
      const eventData = buildEventEventData({ name, payload });
      for (const rule of this.rulesFor("event")) {
        if (rule.trigger.event !== name) continue;
        try {
          this.fireBackground(
            rule,
            this.buildRequest(rule, ctx, { eventData }),
          );
        } catch (error) {
          // One malformed rule (e.g. an uncompilable template) must not starve
          // its siblings: every matching rule SHALL run for a given event.
          const reason = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `sentinel 事件分发失败（规则 "${rule.name}"，事件 "${name}"）：${reason}`,
            "warning",
          );
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      (ctx ?? this.ctx)?.ui.notify(
        `sentinel 事件分发失败（事件 "${name}"）：${reason}`,
        "warning",
      );
    }
  }
  // ---------------------------------------------------------------------------
  // Commands and session-level management
  // ---------------------------------------------------------------------------

  /** Build the `/sentinel:list` view from the effective rules and live state. */
  listEntries(): RuleListEntry[] {
    const statuses = new Map(
      [...this.runners.entries()].map(
        ([name, runner]) => [name, runner.status()] as const,
      ),
    );
    return buildListEntries(
      this.resolved?.rules ?? [],
      statuses,
      this.registry.getHistory(),
      this.resolved?.defaults ?? {},
      (name) => this.sessionStore.isDisabled(name),
    );
  }

  async handleListCommand(ctx: ExtensionCommandContext): Promise<void> {
    const entries = this.listEntries();
    if (!ctx.hasUI || entries.length === 0) {
      ctx.ui.notify(formatListText(entries), "info");
      return;
    }

    const options = entries.map(formatListOption);
    const selected = await ctx.ui.select(
      "pi-sentinel 哨兵（选择后管理）",
      options,
    );
    if (!selected) return;
    const index = options.indexOf(selected);
    const entry = index >= 0 ? entries[index] : undefined;
    if (!entry) return;

    const action = await ctx.ui.select(`规则 "${entry.name}"`, [
      "启用",
      "禁用",
      "移除",
      "取消",
    ]);
    if (!action || action === "取消") return;

    if (action === "禁用" || action === "启用") {
      this.setRuleEnabled(entry.name, action === "启用", ctx);
      ctx.ui.notify(`pi-sentinel: 已${action}规则 "${entry.name}"`, "info");
      return;
    }

    const result = this.removeSessionRule(entry.name, ctx);
    if (result.ok) {
      ctx.ui.notify(`pi-sentinel: 已移除会话级规则 "${entry.name}"`, "info");
    } else {
      ctx.ui.notify(`pi-sentinel: ${result.error}`, "warning");
    }
  }

  /** Disable/enable any rule by name (masking is source-independent). */
  setRuleEnabled(name: string, enabled: boolean, ctx: ExtensionContext): void {
    const op: SessionConfigOp = { op: enabled ? "enable" : "disable", name };
    this.pi.appendEntry(SESSION_CONFIG_CUSTOM_TYPE, op);
    this.sessionStore.apply(op);
    this.runners.get(name)?.invalidate();
    this.rebuild(ctx);
  }

  /** Remove a session-added rule; inherited rules must be disabled instead. */
  removeSessionRule(
    name: string,
    ctx: ExtensionContext,
  ): { ok: boolean; error?: string } {
    if (!this.sessionStore.hasSessionRule(name)) {
      return {
        ok: false,
        error: `规则 "${name}" 不是会话级新增规则，无法移除；请改用禁用`,
      };
    }
    const op: SessionConfigOp = { op: "remove", name };
    this.pi.appendEntry(SESSION_CONFIG_CUSTOM_TYPE, op);
    this.sessionStore.apply(op);
    this.runners.get(name)?.invalidate();
    this.rebuild(ctx);
    return { ok: true };
  }

  /** Add a session-level rule (used by the configuration dialog). */
  addSessionRule(rule: SourcedRule, ctx: ExtensionContext): void {
    // Persist only the bare rule fields; `source` is scope metadata, not config.
    const { source: _source, ...bare } = rule;
    const op: SessionConfigOp = { op: "add-rule", rule: bare };
    this.pi.appendEntry(SESSION_CONFIG_CUSTOM_TYPE, op);
    this.sessionStore.apply(op);
    this.runners.get(rule.name)?.invalidate();
    this.rebuild(ctx);
  }

  /** Session rule names currently layered on top of the file scopes. */
  sessionRuleNames(): string[] {
    return this.sessionStore.sessionRules().map((rule) => rule.name);
  }

  /** Replay session config from a branch (used by tests and tree navigation). */
  replaySessionConfig(
    branch: Parameters<SessionConfigStore["replay"]>[0],
  ): void {
    this.sessionStore.replay(branch);
  }

  // ---------------------------------------------------------------------------
  // Configuration dialog
  // ---------------------------------------------------------------------------

  async handleConfigureCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "pi-sentinel: /sentinel:configure 仅在交互（TUI）模式下可用；其他模式请直接编辑 sentinel.json",
        "warning",
      );
      return;
    }

    if (this.configureDialog?.isRunning) {
      const replace = await ctx.ui.confirm(
        "pi-sentinel",
        "已有配置对话在运行。取消当前对话并开始新的？",
      );
      if (!replace) {
        ctx.ui.notify("pi-sentinel: 保持现有配置对话", "info");
        return;
      }
      this.configureDialog.abort();
    }

    this.startConfigure(ctx, args);
    ctx.ui.notify(
      "pi-sentinel: 配置对话已在后台开始（用 /sentinel:fleet 查看进展）",
      "info",
    );
  }

  /** Launch the background dialog; the command returns immediately. */
  startConfigure(ctx: ExtensionContext, description: string): ConfigureDialog {
    const defaults = this.resolved?.defaults ?? {};
    const dialog = new ConfigureDialog({
      agentLoop: this.overrides.agentLoop ?? agentLoop,
      streamFn: (model, context, options) =>
        ctx.modelRegistry.streamSimple(model, context, options),
      registry: ctx.modelRegistry,
      sessionModel: ctx.model,
      defaults,
      host: {
        applyChange: (change, scope) => this.applyChange(change, scope, ctx),
        closeFleet: async () => {
          this.fleetClose?.();
          this.fleetClose = null;
        },
        getRules: () => this.resolved?.rules ?? [],
        getFileRules: () => this.fileConfig?.rules ?? [],
      },
      sentinelRegistry: this.registry,
      now: this.overrides.now,
    });
    this.configureDialog = dialog;
    dialog.start(ctx, description);
    return dialog;
  }

  /** Current configure dialog (observability / tests). */
  getConfigureDialog(): ConfigureDialog | null {
    return this.configureDialog;
  }

  /**
   * Validate and apply a configuration-dialog change to one scope.
   *
   * add/update use the shared rule validator; remove reports a missing rule for
   * file scopes and only removes session-added rules for the session scope.
   * global/project writes are read-merge-write and hot-reload immediately.
   */
  applyChange(
    change: ConfigChange,
    scope: ConfigScope,
    ctx: ExtensionContext,
  ): ApplyChangeResult {
    const paths = resolveConfigFilePaths(ctx);

    if (change.type === "remove") {
      if (scope === "session") {
        if (!this.sessionStore.hasSessionRule(change.name)) {
          return { ok: false, error: `会话级不存在规则 "${change.name}"` };
        }
        const result = this.removeSessionRule(change.name, ctx);
        return result.ok
          ? { ok: true, summary: `已移除会话级规则 "${change.name}"` }
          : { ok: false, error: result.error };
      }

      const path = scope === "global" ? paths.globalPath : paths.projectPath;
      if (!path) return { ok: false, error: "项目未受信任，无法写入项目配置" };
      const fileRules = loadConfigFromPaths({
        globalPath: path,
        projectPath: null,
      }).rules;
      if (!fileRules.some((rule) => rule.name === change.name)) {
        return {
          ok: false,
          error: `规则 "${change.name}" 在 ${scope} 配置中不存在`,
        };
      }
      writeFileConfig(path, { removeNames: [change.name] });
      this.load(ctx);
      return {
        ok: true,
        summary: `已从 ${scope} 配置删除规则 "${change.name}"`,
      };
    }

    const validation = validateRule(change.rule);
    if (!validation.ok) return { ok: false, error: validation.error };
    const rule = validation.rule;

    if (scope === "session") {
      this.addSessionRule({ ...rule, source: "session" }, ctx);
      return { ok: true, summary: `已写入会话级规则 "${rule.name}"` };
    }

    const path = scope === "global" ? paths.globalPath : paths.projectPath;
    if (!path) return { ok: false, error: "项目未受信任，无法写入项目配置" };
    writeFileConfig(path, { upsert: [rule] });
    this.load(ctx);
    return { ok: true, summary: `已写入 ${scope} 配置规则 "${rule.name}"` };
  }

  // ---------------------------------------------------------------------------
  // Fleet inspector, status bar, and dry-run
  // ---------------------------------------------------------------------------

  fleetRows(): FleetRow[] {
    return buildFleetRows({
      rules: this.resolved?.rules ?? [],
      statuses: [...this.runners.values()].map((runner) => runner.status()),
      dialogs: this.registry.dialogsView(),
      history: this.registry.getHistory(),
      isDisabled: (name) => this.sessionStore.isDisabled(name),
    });
  }

  refreshStatusBar(): void {
    if (!this.ctx) return;
    updateSentinelStatus(this.ctx.ui, this.fleetRows());
  }

  async openFleet(ctx: ExtensionContext): Promise<void> {
    await openFleetInspector(ctx, {
      registry: this.registry,
      buildRows: () => this.fleetRows(),
      keybindings: this.resolved?.fleetKeybindings ?? DEFAULT_FLEET_KEYBINDINGS,
      promptSteer: () => ctx.ui.input("steer 审计（追加消息）"),
      registerClose: (close) => {
        this.fleetClose = close;
      },
    });
  }

  /** `/sentinel:test <规则名> [模拟内容]` — a dry run with zero side effects. */
  async handleTestCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
      ctx.ui.notify("用法: /sentinel:test <规则名> [模拟内容]", "warning");
      return;
    }
    const space = trimmed.indexOf(" ");
    const ruleName = space < 0 ? trimmed : trimmed.slice(0, space);
    const content = space < 0 ? "" : trimmed.slice(space + 1).trim();

    const rule = this.resolved?.rules.find(
      (candidate) => candidate.name === ruleName,
    );
    if (!rule) {
      ctx.ui.notify(`pi-sentinel: 规则 "${ruleName}" 不存在`, "warning");
      return;
    }

    const summary = await this.runDryRun(rule, content, ctx);
    this.registry.record({
      at: this.now(),
      ruleName,
      kind: "test",
      status: summary.verdict ? "verdict" : "failed",
      verdict: summary.verdict,
      failureReason: summary.failureReason,
      durationMs: summary.durationMs,
    });
    ctx.ui.notify(formatTestResult(summary), "info");
  }

  /**
   * Run a rule against a simulated event through the full audit pipeline.
   * Bypasses the runner so no cache, cooldown, injection, or gating happens.
   */
  async runDryRun(
    rule: SourcedRule,
    content: string,
    ctx: ExtensionContext,
  ): Promise<TestRunSummary> {
    const serialize = serializeOptionsFor(rule);
    const defaults = this.resolved?.defaults ?? {};
    const simulated: AgentMessage = { role: "user", content, timestamp: 0 };
    const toolName = firstConcreteTool(rule) ?? "bash";
    let eventData: SentinelEventData;
    let defaultMessages: AgentMessage[] = [];

    switch (rule.trigger.type) {
      case "tool_call":
        eventData = buildToolCallEventData(
          { toolName, toolCallId: "test", input: parseSimulatedInput(content) },
          serialize,
        );
        break;
      case "tool_result":
        eventData = buildToolResultEventData(
          {
            toolName,
            toolCallId: "test",
            input: parseSimulatedInput(content),
            content: [{ type: "text", text: content }],
            isError: false,
          },
          serialize,
        );
        break;
      case "turn_end":
        eventData = buildTurnEndEventData(
          { turnIndex: 0, assistant: simulated, toolResults: [] },
          serialize,
        );
        defaultMessages = [simulated];
        break;
      case "agent_end":
        eventData = buildAgentEndEventData(content.length > 0 ? 1 : 0);
        defaultMessages = content.length > 0 ? [simulated] : [];
        break;
      case "context_tokens":
        eventData = buildContextTokensEventData(
          {
            tokens: 0,
            threshold: rule.trigger.threshold ?? 0,
            level: 0,
            messages: content.length > 0 ? [simulated] : [],
          },
          serialize,
        );
        defaultMessages = content.length > 0 ? [simulated] : [];
        break;
      case "event":
        // The event default scope is the payload JSON, so no default messages.
        eventData = buildEventEventData({
          name: rule.trigger.event ?? "",
          payload: parseSimulatedInput(content),
        });
        break;
    }

    const scopeText = buildScopeText({
      triggerType: rule.trigger.type,
      eventData,
      defaultMessages,
      allMessages: defaultMessages,
      window: rule.window,
      maxWindowTokens: defaults.maxWindowTokens ?? 20_000,
      serialize,
    });
    const request: AuditRequest = {
      ruleName: rule.name,
      rule,
      prompt: rule.prompt,
      scopeText,
      eventData,
    };

    const handle = startAudit(request, this.buildAuditDeps(ctx, defaults));
    const outcome = await handle.done;
    return {
      ruleName: rule.name,
      verdict: outcome.verdict,
      failureReason: outcome.failureReason,
      model: outcome.model,
      durationMs: outcome.durationMs,
      unresolvedPaths: outcome.unresolvedPaths,
    };
  }
}

export default function sentinel(pi: ExtensionAPI): void {
  const runtime = new SentinelRuntime(pi);
  runtime.register();
}
