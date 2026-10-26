import { describe, expect, test } from "vitest";
import extension from "../index.ts";

/** Minimal ExtensionAPI double: record subscriptions and commands. */
function fakePi(): {
  handlers: Map<string, unknown>;
  commands: Map<string, unknown>;
  pi: never;
} {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const pi = {
    on(event: string, handler: unknown) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
  };
  return { handlers, commands, pi: pi as never };
}

const fakeCtx = (overrides: Record<string, unknown> = {}) =>
  ({
    mode: "tui",
    cwd: "/tmp/project",
    sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
    ui: { notify: () => {} },
    ...overrides,
  }) as never;

describe("pi-group-collapse entry", () => {
  test("subscribes to lifecycle events and registers the command", () => {
    const { handlers, commands, pi } = fakePi();
    expect(() => extension(pi)).not.toThrow();
    for (const name of [
      "session_start",
      "session_shutdown",
      "agent_start",
      "agent_end",
      "agent_before_settle",
      "agent_settled",
      "tool_execution_update",
      "tool_execution_end",
    ]) {
      expect(handlers.has(name)).toBe(true);
    }
    expect(commands.has("group-collapse")).toBe(true);
  });

  test("session_start in TUI installs the display pipeline", () => {
    const { handlers, pi } = fakePi();
    extension(pi);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const start = handlers.get("session_start") as any;
    expect(() =>
      start({ type: "session_start", reason: "startup" }, fakeCtx()),
    ).not.toThrow();
  });

  test("the command guards non-TUI and unknown arguments", async () => {
    const { commands, pi } = fakePi();
    extension(pi);
    const { handler: command } = commands.get("group-collapse") as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    const notices: string[] = [];
    const ctx = fakeCtx({
      ui: { notify: (m: string) => notices.push(m) },
    }) as never;
    // No display installed in this bare harness (no session_start ran):
    // every action answers with the mode notice instead of acting.
    await command("frobnicate", ctx);
    expect(notices.length).toBe(1);
    await command(
      "expand",
      fakeCtx({ mode: "rpc", ui: { notify: (m: string) => notices.push(m) } }),
    );
    expect(notices.length).toBe(2);
  });
});
