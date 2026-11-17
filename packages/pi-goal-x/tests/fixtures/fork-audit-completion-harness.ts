import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { installSupervisorResponderAck } from "./goal-audit-supervisor-owner.ts";

class FakeEvents {
  private readonly handlers = new Map<
    string,
    Array<(value: unknown) => void>
  >();

  on(event: string, handler: (value: unknown) => void): () => void {
    const entries = this.handlers.get(event) ?? [];
    entries.push(handler);
    this.handlers.set(event, entries);
    return () =>
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((entry) => entry !== handler),
      );
  }

  emit(event: string, value: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
  }
}

export function createHarness(cwd: string) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, ToolDefinition>();
  const events = new FakeEvents();
  // The responder must be registered BEFORE the delegation request; this
  // fixture answers registration with an inert handle (no model work) so the
  // existing lifecycle assertions keep running unchanged.
  installSupervisorResponderAck(events);
  const messages: unknown[] = [];
  let activeTools = ["read", "bash", "edit", "write"];
  const goal = createGoal({
    objective: "Ship a complete delegated audit integration.",
    autoContinue: true,
    sisyphus: false,
  });
  writeActiveGoalFile({ cwd }, goal);
  mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".pi", "agents", "goal-auditor.md"),
    `---
name: goal-auditor
description: Test completion auditor
tools: read, grep, find, ls, bash, report_auditor_progress
extensions:
inheritProjectContext: false
inheritSkills: false
systemPromptMode: replace
---

Test auditor.
`,
    "utf8",
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-goal-focus",
      data: goalFocusDetails(goal.id, "created"),
    },
  ];
  const pi = {
    registerTool: (definition: ToolDefinition) => {
      tools.set(definition.name, definition);
    },
    registerCommand: () => {},
    on: (event: string, handler: Function) => {
      handlers.set(event, handler);
    },
    appendEntry: () => {},
    registerMessageRenderer: () => {},
    sendMessage: (message: unknown) => {
      messages.push(message);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    events,
    hasUI: false,
  };
  // SAFETY: this isolated harness supplies only the host fields exercised by Goal-X.
  const ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => entries,
      getCwd: () => cwd,
      getSessionId: () => "delegated-completion-session",
      getRoot: () => cwd,
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      onTerminalInput: () => () => {},
      select: async () => undefined,
      confirm: async () => false,
      custom: async () => undefined,
    },
    getSystemPrompt: () => "base",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    // SAFETY: this fixture intentionally supplies only the host fields used by these Goal-X tests.
  } as unknown as ExtensionContext;
  goalExtension(pi as any);
  return {
    handlers,
    tools,
    events,
    ctx,
    goal,
    messages,
    core: (pi as any)._goalCore,
  };
}

export async function start(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  await harness.handlers.get("session_start")?.(
    { reason: "start" },
    harness.ctx,
  );
  await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "base", prompt: "test", systemPromptOptions: {} },
    harness.ctx,
  );
}
