import type {
  AuditDeps,
  AuditHandle,
  AuditOutcome,
  AuditVerdict,
  LiveAuditDetails,
} from "./audit-loop.js";
import { startAudit } from "./audit-loop.js";
import { cacheKey, type VerdictCache } from "./cache.js";
import type { FailurePolicy, OverlapStrategy, SourcedRule } from "./config.js";

/**
 * Per-rule audit scheduling.
 *
 * A `RuleRunner` owns the `idle | queued | running` state machine for one rule
 * and implements the four overlap strategies, the shared global concurrency
 * limit, the negative cooldown after audit failures, and verdict dispatch
 * (including cache hits, which go through the same dispatch path).
 */

export const NEGATIVE_COOLDOWN_MS = 30_000;

/** FIFO counting semaphore shared by every rule. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(private limit: number) {}

  /**
   * Hot reload: adopt a new global limit without discarding slot accounting.
   * Queued waiters are served as soon as capacity allows.
   */
  setLimit(next: number): void {
    this.limit = Math.max(1, next);
    while (this.waiters.length > 0 && this.active < this.limit) {
      const next_ = this.waiters.shift();
      if (!next_) break;
      this.active += 1;
      next_(this.makeRelease());
    }
  }

  get available(): number {
    return Math.max(0, this.limit - this.active);
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  /** Acquire a slot immediately, or null when saturated. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    return this.makeRelease();
  }

  /** Acquire a slot, queueing FIFO while saturated. */
  acquire(): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      this.waiters.push((release) => resolve(release));
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) {
        this.active += 1;
        next(this.makeRelease());
      }
    };
  }
}

export type RunnerState = "idle" | "queued" | "running";

export interface HistoryEntry {
  at: number;
  ruleName: string;
  kind: "audit" | "test";
  status: "verdict" | "failed" | "cancelled" | "skipped";
  verdict?: AuditVerdict;
  cached?: boolean;
  /** Finding suppressed by the injection dedupe cooldown. */
  deduped?: boolean;
  failureReason?: string;
  skippedReason?: string;
  durationMs?: number;
}

export interface HistorySink {
  record(entry: HistoryEntry): void;
}

export interface RunnerContext {
  audit: AuditDeps;
  cache: VerdictCache;
  semaphore: Semaphore;
  history: HistorySink;
  now?: () => number;
  negativeCooldownMs?: number;
  /** Background warn/fail findings (dedupe + injection live in injection.ts). */
  onFinding?: (
    rule: SourcedRule,
    verdict: AuditVerdict,
    durationMs?: number,
  ) => void | Promise<void>;
  /** Audit failure notification (UI notify / history). */
  onAuditFailure?: (rule: SourcedRule, reason: string) => void;
  /** Called when the rule's running/queued state changes (status bar refresh). */
  onStateChange?: () => void;
}

export interface RunnerResult {
  ruleName: string;
  /** Effective verdict from a real or cached audit. */
  verdict?: AuditVerdict;
  /** Audit failure (including negative cooldown) plus the rule's failure policy. */
  failure?: { reason: string; policy: FailurePolicy };
  /** Trigger was skipped (overlap/saturation/hot-reload drop/cooldown drop). */
  skipped?: { reason: string };
  cached: boolean;
}

export interface RunnerStatus {
  ruleName: string;
  state: RunnerState;
  activeCount: number;
  queuedCount: number;
  cooldownUntil: number;
  live: LiveAuditDetails[];
}

interface AuditTask {
  request: Parameters<typeof startAudit>[0];
  rule: SourcedRule;
  dropped: boolean;
  /** Resolves the task's pending wait so a drop is observed immediately. */
  onDrop?: () => void;
}

function overlapFor(rule: SourcedRule): OverlapStrategy {
  return rule.overlap ?? (rule.mode === "blocking" ? "parallel" : "ignore");
}

export class RuleRunner {
  private currentRule: SourcedRule;
  private activeCount = 0;
  private queuedCount = 0;
  private cooldownUntil = 0;
  private readonly handles = new Set<AuditHandle>();
  private serialChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    rule: SourcedRule,
    private context: RunnerContext,
  ) {
    this.currentRule = rule;
  }

  /**
   * Hot reload: adopt the freshly built context so a reused runner shares the
   * single global semaphore, the current audit deps (ctx-bound session model /
   * streamFn) and the current onFinding/onAuditFailure closures.
   */
  updateContext(context: RunnerContext): void {
    this.context = context;
  }

  /** Session switch: negative cooldowns are session runtime state. */
  resetCooldown(): void {
    this.cooldownUntil = 0;
  }

  get name(): string {
    return this.currentRule.name;
  }

  get rule(): SourcedRule {
    return this.currentRule;
  }

  private now(): number {
    return this.context.now ? this.context.now() : Date.now();
  }

  status(): RunnerStatus {
    const state: RunnerState =
      this.activeCount > 0
        ? "running"
        : this.queuedCount > 0
          ? "queued"
          : "idle";
    return {
      ruleName: this.currentRule.name,
      state,
      activeCount: this.activeCount,
      queuedCount: this.queuedCount,
      cooldownUntil: this.cooldownUntil,
      live: [...this.handles].map((handle) => handle.live),
    };
  }

  isCoolingDown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  /**
   * Hot reload: adopt a new definition. Running audits finish and dispatch by
   * their captured (old) definition; queued audits are dropped as skipped; the
   * rule's cache entries and cooldown are invalidated immediately.
   */
  setRule(rule: SourcedRule): void {
    this.dropQueued("dropped: rule replaced");
    this.currentRule = rule;
    this.cooldownUntil = 0;
    this.context.cache.invalidateRule(rule.name);
  }

  /** Remove the rule: queued audits are dropped, running audits continue. */
  dispose(): void {
    this.disposed = true;
    this.dropQueued("dropped: rule removed");
    this.context.cache.invalidateRule(this.currentRule.name);
  }

  /** Invalidate cached verdicts and the failure cooldown without a definition change. */
  invalidate(): void {
    this.cooldownUntil = 0;
    this.context.cache.invalidateRule(this.currentRule.name);
  }

  /** Session switch/shutdown: abort everything in flight. */
  abortAll(): void {
    this.dropQueued("dropped: runtime reset");
    for (const handle of this.handles) handle.abort();
  }

  /**
   * Deliver a steering message to this rule's running audits.
   * Returns "delivered" when at least one audit accepted it.
   */
  steer(message: string): "delivered" | "ended" {
    let delivered = false;
    for (const handle of this.handles) {
      if (handle.steer(message)) delivered = true;
    }
    return delivered ? "delivered" : "ended";
  }

  private dropQueued(reason: string): void {
    // Queued tasks observe `task.dropped` when their turn arrives; queuedCount
    // is intentionally left to the task's own finally block.
    for (const task of this.pendingTasks) {
      if (task.dropped) continue;
      task.dropped = true;
      task.onDrop?.();
      this.context.history.record({
        at: this.now(),
        ruleName: task.rule.name,
        kind: "audit",
        status: "skipped",
        skippedReason: reason,
      });
    }
  }

  private readonly pendingTasks = new Set<AuditTask>();

  /** Run (or skip) one trigger for this rule. */
  async run(request: AuditTask["request"]): Promise<RunnerResult> {
    const rule = this.currentRule;
    const task: AuditTask = { request, rule, dropped: false };
    this.pendingTasks.add(task);
    try {
      return await this.runTask(task);
    } finally {
      this.pendingTasks.delete(task);
    }
  }

  private async runTask(task: AuditTask): Promise<RunnerResult> {
    const rule = task.rule;

    if (this.disposed) {
      return this.skip(task, "rule removed");
    }

    if (this.isCoolingDown()) {
      const reason = "审计持续失败（负冷却中）";
      this.context.history.record({
        at: this.now(),
        ruleName: rule.name,
        kind: "audit",
        status: "skipped",
        skippedReason: reason,
      });
      if (rule.mode === "blocking") {
        return {
          ruleName: rule.name,
          failure: { reason, policy: rule.onFailure ?? "open" },
          cached: false,
        };
      }
      return { ruleName: rule.name, skipped: { reason }, cached: false };
    }

    const cached = this.cachedVerdict(task);
    if (cached) {
      this.context.history.record({
        at: this.now(),
        ruleName: rule.name,
        kind: "audit",
        status: "verdict",
        verdict: cached,
        cached: true,
      });
      await this.dispatch(task, cached);
      return { ruleName: rule.name, verdict: cached, cached: true };
    }

    const strategy = overlapFor(rule);
    const busy = this.activeCount > 0;

    if (
      strategy === "ignore" &&
      (busy || this.context.semaphore.available === 0)
    ) {
      return this.skip(
        task,
        busy
          ? "skipped: rule busy (ignore)"
          : "skipped: concurrency limit (ignore)",
      );
    }

    if (strategy === "replace" && busy && rule.mode === "background") {
      for (const handle of this.handles) handle.abort();
    }

    if (
      strategy === "serial" ||
      (strategy === "replace" && rule.mode === "blocking")
    ) {
      // Always route through the serial chain so an in-flight audit holds the
      // gate for later triggers (blocking `replace` waits instead of aborting).
      return await this.runSerial(task);
    }

    return await this.execute(task, strategy);
  }

  private cachedVerdict(task: AuditTask): AuditVerdict | undefined {
    const rule = task.rule;
    if (!this.cacheEnabled(rule)) return undefined;
    const key = cacheKey(
      rule.name,
      rule,
      task.request.renderedPrompt ?? task.request.prompt,
      task.request.scopeText,
    );
    return this.context.cache.get(key, this.cacheTtl(rule));
  }

  private cacheEnabled(rule: SourcedRule): boolean {
    return rule.cache ?? this.context.audit.defaults.cache ?? true;
  }

  private cacheTtl(rule: SourcedRule): number {
    return rule.cacheTtlMs ?? this.context.audit.defaults.cacheTtlMs ?? 600_000;
  }

  private async runSerial(task: AuditTask): Promise<RunnerResult> {
    const gate = this.serialChain;
    let open!: () => void;
    this.serialChain = new Promise<void>((resolve) => {
      open = resolve;
    });
    const dropSignal = new Promise<void>((resolve) => {
      task.onDrop = resolve;
    });
    this.queuedCount += 1;
    try {
      await Promise.race([gate, dropSignal]);
    } finally {
      this.queuedCount -= 1;
    }
    if (task.dropped || this.disposed) {
      open();
      return this.skip(task, "dropped before execution");
    }
    try {
      return await this.execute(task, "serial");
    } finally {
      open();
    }
  }

  private async execute(
    task: AuditTask,
    strategy: OverlapStrategy,
  ): Promise<RunnerResult> {
    if (strategy === "ignore") {
      const release = this.context.semaphore.tryAcquire();
      if (!release) return this.skip(task, "skipped: concurrency limit");
      return await this.finishExecute(task, release);
    }

    const dropSignal = new Promise<null>((resolve) => {
      task.onDrop = () => resolve(null);
    });
    const acquirePromise = this.context.semaphore.acquire();
    const release = await Promise.race([acquirePromise, dropSignal]);

    if (release === null) {
      // The slot may still arrive after the drop; release it when it does.
      void acquirePromise.then((lateRelease) => lateRelease());
      return this.skip(task, "dropped before execution");
    }

    return await this.finishExecute(task, release);
  }

  private async finishExecute(
    task: AuditTask,
    release: () => void,
  ): Promise<RunnerResult> {
    const rule = task.rule;

    if (task.dropped || this.disposed) {
      release();
      return this.skip(task, "dropped before execution");
    }

    const key = cacheKey(
      rule.name,
      rule,
      task.request.renderedPrompt ?? task.request.prompt,
      task.request.scopeText,
    );
    const handle = startAudit(task.request, this.context.audit);
    this.handles.add(handle);
    this.activeCount += 1;
    this.context.onStateChange?.();

    let outcome: AuditOutcome;
    try {
      outcome = await handle.done;
    } finally {
      this.activeCount -= 1;
      this.handles.delete(handle);
      release();
      this.context.onStateChange?.();
    }

    if (outcome.status === "verdict" && outcome.verdict) {
      if (this.cacheEnabled(rule))
        this.context.cache.put(key, rule.name, outcome);
      this.context.history.record({
        at: this.now(),
        ruleName: rule.name,
        kind: "audit",
        status: "verdict",
        verdict: outcome.verdict,
        cached: false,
        durationMs: outcome.durationMs,
      });
      await this.dispatch(task, outcome.verdict, outcome.durationMs);
      return { ruleName: rule.name, verdict: outcome.verdict, cached: false };
    }

    if (outcome.status === "cancelled") {
      this.context.history.record({
        at: this.now(),
        ruleName: rule.name,
        kind: "audit",
        status: "cancelled",
        durationMs: outcome.durationMs,
      });
      return { ruleName: rule.name, cached: false };
    }

    const reason = outcome.failureReason ?? "审计失败";
    this.cooldownUntil =
      this.now() + (this.context.negativeCooldownMs ?? NEGATIVE_COOLDOWN_MS);
    this.context.history.record({
      at: this.now(),
      ruleName: rule.name,
      kind: "audit",
      status: "failed",
      failureReason: reason,
      durationMs: outcome.durationMs,
    });
    this.context.onAuditFailure?.(rule, reason);
    return {
      ruleName: rule.name,
      failure: { reason, policy: rule.onFailure ?? "open" },
      cached: false,
    };
  }

  private async dispatch(
    task: AuditTask,
    verdict: AuditVerdict,
    durationMs?: number,
  ): Promise<void> {
    if (task.rule.mode !== "background") return;
    if (verdict.verdict === "pass") return;
    await this.context.onFinding?.(task.rule, verdict, durationMs);
  }

  private skip(task: AuditTask, reason: string): RunnerResult {
    this.context.history.record({
      at: this.now(),
      ruleName: task.rule.name,
      kind: "audit",
      status: "skipped",
      skippedReason: reason,
    });
    return { ruleName: task.rule.name, skipped: { reason }, cached: false };
  }
}

/** Build the rule runner set for a resolved config. */
export function createRunners(
  rules: SourcedRule[],
  context: RunnerContext,
): Map<string, RuleRunner> {
  const runners = new Map<string, RuleRunner>();
  for (const rule of rules)
    runners.set(rule.name, new RuleRunner(rule, context));
  return runners;
}
