/**
 * Fork-only new-generation regressions for the minimized main-model view.
 *
 * The fork behavior under test (new-content telemetry suppression, generation-time
 * history field selection, and preserved current execution constraints) is fork
 * logic, so its dedicated cases live here rather than in the upstream
 * goal-core-tools.test.ts suite. The harness below mirrors that suite's stubs on
 * purpose; it is fork-owned and may diverge.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { appendGoalEvent, goalLedgerPath } from "../extensions/goal-ledger.ts";
import {
  GOAL_CONTEXT_EVENT_ENTRY,
  renderGoalResult,
} from "../extensions/goal-format.ts";
import { LIVE_CONTEXT_TYPE } from "../extensions/goal-live-retention.ts";
import { newGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import { goalContextMessagePrompt } from "../extensions/prompts/goal-prompts.ts";
import { createMockTheme } from "./tui-test-utils.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface HarnessOptions {
  cwd: string;
  sessionEntries: unknown[];
  hasUI?: boolean;
  runCompletionAuditor?: (...args: any[]) => Promise<any>;
  settings?: Record<string, unknown>;
  uiCustom?: (...args: any[]) => Promise<any>;
  onSendMessage?: (message: any, opts?: any) => void;
}

function createHarness(options: HarnessOptions) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const tools = new Map<string, ToolDefinition>();
  let activeTools = ["read", "bash", "edit", "write"];
  const pi = {
    registerTool: (def: ToolDefinition) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, def: any) => {
      commands.set(name, def);
    },
    on: (event: string, handler: Function) => {
      handlers.set(event, handler);
    },
    appendEntry: () => {},
    registerMessageRenderer: () => {},
    sendMessage: (message: any, opts?: any) => {
      options.onSendMessage?.(message, opts);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    hasUI: options.hasUI ?? false,
  };
  const ctx = {
    cwd: options.cwd,
    hasUI: options.hasUI ?? false,
    sessionManager: {
      getBranch: () => options.sessionEntries,
      getCwd: () => options.cwd,
      getSessionId: () => "core-tools-session",
      getRoot: () => options.cwd,
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      onTerminalInput: () => () => {},
      select: async () => undefined,
      confirm: async () => false,
      custom: options.uiCustom ?? (async () => undefined),
    },
    getSystemPrompt: () => "base prompt",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
  } as unknown as ExtensionContext;
  goalExtension(pi as any, {
    runCompletionAuditor: options.runCompletionAuditor,
  });
  return {
    handlers,
    commands,
    tools,
    ctx,
    get activeTools() {
      return [...activeTools];
    },
    get core() {
      return (pi as unknown as { _goalCore: any })._goalCore;
    },
  };
}

function makeFixture(
  opts: {
    objective?: string;
    tokenBudget?: number;
    pauseReason?: string;
    status?: string;
  } = {},
) {
  const cwd = mkdtempSync(path.join(tmpdir(), "goal-core-"));
  mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
  const goal = createGoal(
    {
      objective: opts.objective ?? "=== Goal ===\nObjective: Core tools test",
      autoContinue: true,
      sisyphus: false,
    },
    Date.UTC(2026, 7, 4, 9, 0, 0),
  );
  if (opts.tokenBudget) goal.tokenBudget = opts.tokenBudget;
  if (opts.pauseReason) {
    goal.status = "paused" as const;
    goal.autoContinue = false;
    goal.stopReason = "agent";
    goal.pauseReason = opts.pauseReason;
  }
  if (opts.status === "complete") goal.status = "complete" as const;
  const written = writeActiveGoalFile({ cwd }, goal);
  const sessionEntries = [
    {
      type: "custom",
      customType: "pi-goal-focus",
      data: goalFocusDetails(goal.id, "created"),
    },
  ];
  const cleanup = () => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort; failure must not fail the test */
    }
  };
  return { cwd, goal: written, sessionEntries, cleanup };
}

function ledgerEvents(cwd: string): Array<Record<string, unknown>> {
  const filePath = goalLedgerPath({ cwd });
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function start(h: ReturnType<typeof createHarness>): Promise<void> {
  await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
  await h.handlers.get("before_agent_start")?.(
    { systemPrompt: "base", prompt: "test", systemPromptOptions: {} },
    h.ctx,
  );
}

test("get_goal history projects events before pagination and rejects stale cursors", async () => {
  const f = makeFixture();
  try {
    const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
    await start(h);
    const goalId = h.core.state.goal.id;
    appendGoalEvent(h.ctx, {
      type: "audit_usage",
      goalId,
      tokens: 500,
      inputTokens: 200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.1234,
      turns: 2,
      at: "2026-10-07T00:00:00.000Z",
    });
    appendGoalEvent(h.ctx, {
      type: "goal_budget_changed",
      goalId,
      oldBudget: 100,
      newBudget: null,
      tokensUsed: 40,
      at: "2026-10-07T00:00:01.000Z",
    });
    appendGoalEvent(h.ctx, {
      type: "goal_budget_warning",
      goalId,
      budget: 100,
      tokensUsed: 90,
      pct: 90,
      at: "2026-10-07T00:00:02.000Z",
    });
    for (let index = 0; index < 7; index++) {
      appendGoalEvent(h.ctx, {
        type: "task_complete",
        goalId,
        taskId: `task-${index}`,
        evidence: `Evidence ${index}: ${"preserve source text ".repeat(48)}`,
        at: `2026-10-07T00:00:${String(index + 3).padStart(2, "0")}.000Z`,
      });
    }
    const originalEvents = ledgerEvents(f.cwd);
    const get = h.tools.get("get_goal")!;
    const pages: Array<{ content: string; nextCursor?: string }> = [];
    let cursor: string | undefined;
    let pageNumber = 0;
    do {
      const result = await (get.execute as any)(
        `history-${pageNumber}`,
        { section: "history", ...(cursor ? { cursor } : {}) },
        undefined,
        undefined,
        h.ctx,
      );
      const text = result.content?.[0]?.text ?? "";
      assert.match(text, /history for/);
      assert.doesNotMatch(text, /audit_usage|tokensUsed|costUsd|"pct"/);
      const page = result.details?.page;
      assert.ok(page, "history result includes structured page details");
      pages.push(page);
      cursor = page.nextCursor;
      pageNumber++;
    } while (cursor);
    assert.ok(pages.length > 1, "large projected history is paginated");
    const firstPage = pages[0]!;
    assert.ok(
      firstPage.nextCursor,
      "first projected page returns a continuation cursor",
    );
    const joined = pages.map((page) => page.content).join("");
    for (let index = 0; index < 7; index++) {
      assert.equal(
        joined.split(`"taskId":"task-${index}"`).length - 1,
        1,
        `task-${index} appears exactly once across pages`,
      );
    }
    assert.match(
      joined,
      /"oldBudget":100,"newBudget":null/,
      "real budget-change values remain",
    );
    assert.match(
      joined,
      /"budget":100/,
      "budget threshold remains without its consumption fields",
    );
    assert.match(joined, /Evidence 6: preserve source text/);
    assert.deepEqual(
      ledgerEvents(f.cwd),
      originalEvents,
      "new query field selection leaves the on-disk ledger unchanged",
    );

    appendGoalEvent(h.ctx, {
      type: "task_complete",
      goalId,
      taskId: "later",
      evidence: "new revision",
      at: "2026-10-07T00:01:00.000Z",
    });
    const stale = await (get.execute as any)(
      "history-stale",
      { section: "history", cursor: firstPage.nextCursor },
      undefined,
      undefined,
      h.ctx,
    );
    assert.match(stale.content?.[0]?.text ?? "", /Invalid or stale cursor/);
  } finally {
    f.cleanup();
  }
});

test("active context handler omits context telemetry and keeps real constraints", async () => {
  const f = makeFixture({ tokenBudget: 100 });
  writeFileSync(
    path.join(f.cwd, ".pi", "pi-goal-x-settings.json"),
    JSON.stringify({ maxAutonomousRuns: 5 }),
  );
  try {
    const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
    await start(h);
    h.core.state.goal!.usage.activeSeconds = 61;
    h.core.state.goal!.usage.tokensUsed = 25;
    h.core.persist(h.ctx);
    let contextUsageReads = 0;
    (h.ctx as any).getContextUsage = () => {
      contextUsageReads++;
      return { tokens: 99_000, contextWindow: 100_000 };
    };
    const userMessage = {
      role: "user",
      content: "Context snapshot: user-authored phrase stays.",
      timestamp: 1,
    };
    const oldCounter = {
      role: "custom",
      customType: LIVE_CONTEXT_TYPE,
      content:
        "Goal snapshot: 1m1s · 25 tokens\nContext snapshot: 99/100 tokens (99%).",
      display: false,
      timestamp: 0,
    };
    const result = await h.handlers.get("context")?.(
      { messages: [userMessage, oldCounter] },
      h.ctx,
    );
    const messages = (result as any)?.messages ?? [userMessage, oldCounter];
    const live = messages.filter(
      (message: any) =>
        message.role === "custom" &&
        message.customType === LIVE_CONTEXT_TYPE &&
        message !== oldCounter,
    );
    assert.equal(
      contextUsageReads,
      0,
      "the context hook does not read host context occupancy",
    );
    assert.ok(
      messages.includes(userMessage),
      "user-authored context wording is preserved",
    );
    assert.ok(
      messages.includes(oldCounter),
      "already persisted telemetry is intentionally not cleaned",
    );
    assert.equal(
      live.length,
      2,
      "budget and finite-run counters remain as separate request tails",
    );
    assert.match(live[0].content, /Lifetime token budget cap: 100 tokens/);
    assert.match(live[0].content, /Maximum autonomous runs: 5/);
    assert.match(live[1].content, /25\/100 used, 75 remaining/);
    assert.match(live[1].content, /Autonomous runs: 0\/5/);
    assert.doesNotMatch(
      live.map((message: any) => message.content).join("\n"),
      /Goal snapshot:|Context snapshot:|unavailable|99\/100/,
    );
  } finally {
    f.cleanup();
  }
});

test("context handler preserves old persisted context while generating current run constraints", async () => {
  const f = makeFixture();
  writeFileSync(
    path.join(f.cwd, ".pi", "pi-goal-x-settings.json"),
    JSON.stringify({ maxAutonomousRuns: 0, showAutonomousRuns: false }),
  );
  try {
    const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
    await start(h);
    const currentGoal = h.core.state.goal!;
    const oldScheduler = newGoalScheduler("old-run-session");
    oldScheduler.used = 2;
    oldScheduler.phase = "waiting";
    oldScheduler.decision = { kind: "wait" };
    oldScheduler.wait = {
      id: "old-wait",
      token: "old-wait-token",
      reason: "waiting for historical artifact",
      deadline: Date.UTC(2026, 9, 8, 12),
      intervalMs: 60_000,
      remainingChecks: 2,
      nextCheckAt: Date.UTC(2026, 9, 8, 11, 30),
    };
    const persisted = {
      role: "custom",
      customType: GOAL_CONTEXT_EVENT_ENTRY,
      content: goalContextMessagePrompt(
        { ...currentGoal, scheduler: oldScheduler },
        { maxAutonomousRuns: 5 },
      ),
      details: {
        version: 1,
        kind: "context",
        goalId: currentGoal.id,
        revision: 1,
      },
      display: false,
      timestamp: 1,
    };
    assert.match(persisted.content, /Scheduling: Autonomous runs: 2\/5\./);
    const original = structuredClone(persisted);
    const result = await h.handlers.get("context")?.(
      { messages: [persisted] },
      h.ctx,
    );
    const messages = (result as any)?.messages ?? [persisted];
    const context = messages.find(
      (message: any) =>
        message.role === "custom" &&
        message.customType === GOAL_CONTEXT_EVENT_ENTRY,
    );
    assert.ok(
      context,
      "the known persisted Goal-X context remains in the request",
    );
    assert.equal(
      context,
      persisted,
      "the old message stays byte-identical and by reference",
    );
    assert.match(context.content, /Scheduling: Autonomous runs: 2\/5/);
    assert.match(context.content, /Waiting: waiting for historical artifact/);
    assert.match(context.content, /Next check:.*checks remaining/);
    const live = messages.filter(
      (message: any) =>
        message.role === "custom" && message.customType === LIVE_CONTEXT_TYPE,
    );
    assert.ok(
      live.some((message: any) =>
        /Automatic continuation is disabled by the configured zero run limit/.test(
          message.content,
        ),
      ),
    );
    assert.doesNotMatch(
      live.map((message: any) => message.content).join("\n"),
      /Autonomous runs: 2\/5/,
    );
    assert.deepEqual(
      persisted,
      original,
      "the append-only session source is not rewritten",
    );
  } finally {
    f.cleanup();
  }
});

// ── update_goal(complete) without paperwork ──────────────────────────────────

test("real create and completion tool cards keep authoritative usage while model content stays minimized", async () => {
  const theme = createMockTheme() as unknown as Theme;

  const created = makeFixture();
  try {
    const h = createHarness({
      cwd: created.cwd,
      sessionEntries: created.sessionEntries,
    });
    await start(h);
    const create = h.tools.get("create_goal")!;
    const result = await (create.execute as any)(
      "create-card",
      { objective: "=== Goal ===\nObjective: Card usage", token_budget: 100 },
      undefined,
      undefined,
      h.ctx,
    );
    const ui = renderGoalResult(result as any, undefined, theme)
      .render(200)
      .join("\n");
    assert.match(
      ui,
      /Time spent:/,
      "create card restores cumulative time from details",
    );
    assert.match(
      ui,
      /Tokens used:/,
      "create card restores cumulative tokens from details",
    );
    assert.doesNotMatch(
      result.content[0]!.text,
      /Time spent:|Tokens used:/,
      "create model content stays minimized",
    );
  } finally {
    created.cleanup();
  }

  const completing = makeFixture({ tokenBudget: 100 });
  try {
    const h = createHarness({
      cwd: completing.cwd,
      sessionEntries: completing.sessionEntries,
      runCompletionAuditor: async () => ({
        approved: true,
        disapproved: false,
        output: "All good",
        model: "mock",
      }),
    });
    await start(h);
    h.core.state.goal!.usage.activeSeconds = 61;
    h.core.state.goal!.usage.tokensUsed = 321;
    h.core.persist(h.ctx);
    const update = h.tools.get("update_goal")!;
    const result = await (update.execute as any)(
      "complete-card",
      { status: "complete" },
      undefined,
      undefined,
      h.ctx,
    );
    const ui = renderGoalResult(result as any, undefined, theme)
      .render(200)
      .join("\n");
    assert.match(ui, /Time spent: 1m01s/);
    assert.match(ui, /Tokens used: 321 tokens/);
    assert.doesNotMatch(
      result.content[0]!.text,
      /Time spent:|Tokens used: 321 tokens/,
      "completion model content stays minimized",
    );
  } finally {
    completing.cleanup();
  }
});
