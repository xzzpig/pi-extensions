import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import extension, { getGroupCollapseRuntime } from "../index.ts";
import { createNotificationObserver } from "../src/notification-adapter.ts";
import { GroupCollapseRuntime } from "../src/runtime.ts";

const prototype = InteractiveMode.prototype as object;
const methods = [
  "showExtensionNotify",
  "showStatus",
  "showWarning",
  "showError",
] as const;
const runtimeKey = Symbol.for("pi-group-collapse.runtime.v1");
let root: string;
let priorAgentDir: string | undefined;
let runtime: GroupCollapseRuntime | undefined;
const cleanups: (() => void)[] = [];

function removeMethod(method: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  if (!descriptor) throw new Error(`Host method absent before test: ${method}`);
  Object.defineProperty(prototype, method, { ...descriptor, value: undefined });
  cleanups.push(() => Object.defineProperty(prototype, method, descriptor));
}

beforeEach(() => {
  initTheme();
  root = mkdtempSync(join(tmpdir(), "group-collapse-capability-"));
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  Reflect.deleteProperty(globalThis, runtimeKey);
});

afterEach(() => {
  runtime?.onSessionShutdown();
  runtime = undefined;
  while (cleanups.length) cleanups.pop()!();
  Reflect.deleteProperty(globalThis, runtimeKey);
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("notification capability degradation", () => {
  test.each(methods)("%s missing removes every partial observer", (method) => {
    const originals = new Map(
      methods.map((name) => [name, Reflect.get(prototype, name)]),
    );
    removeMethod(method);
    const observed: unknown[] = [];
    const observer = createNotificationObserver({
      onNotification: (item) => observed.push(item),
      onInvalidated: (item) => observed.push(item),
    });
    const install = observer.install();
    cleanups.push(install.cleanup);
    expect(install.available).toBe(false);
    for (const name of methods) {
      expect(Reflect.get(prototype, name)).toBe(
        name === method ? undefined : originals.get(name),
      );
    }
    expect(observed).toEqual([]);
  });

  test("degradation is reported once per session, not once per process", () => {
    removeMethod("showExtensionNotify");
    const notices: string[] = [];
    runtime = new GroupCollapseRuntime({
      notify: (message) => notices.push(message),
    });
    const input = { cwd: root, mode: "tui", getBranch: () => [] };
    runtime.onSessionStart(input);
    runtime.onSessionStart(input);
    runtime.handlePiEvent({ type: "agent_start" });
    expect(notices).toEqual([
      "group-collapse: notification source unavailable; notifications will remain visible",
    ]);
    runtime.onSessionShutdown();
    runtime.onSessionStart(input);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe(notices[0]);
  });

  test("an unobserved notification remains visible after a normal settle", () => {
    // Losing one exit must disable the entire observer, even though the
    // still-working entry and info exit could otherwise claim this line.
    removeMethod("showWarning");
    writeFileSync(
      join(root, "group-collapse.json"),
      JSON.stringify({
        rules: [
          { kind: "notification", textPrefix: "VISIBLE", action: "group" },
        ],
      }),
    );
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    runtime.onSessionStart({ cwd: root, mode: "tui", getBranch: () => [] });
    const receiver = {
      chatContainer: new Container(),
      ui: { requestRender() {} },
      outputPad: 1,
      showStatus: Reflect.get(prototype, "showStatus"),
      showError: Reflect.get(prototype, "showError"),
      showWarning: Reflect.get(prototype, "showWarning"),
    };
    Reflect.get(prototype, "showExtensionNotify").call(
      receiver,
      "VISIBLE notification",
      "info",
    );
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({ type: "agent_start" });
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    expect(
      stripTerminalSequences(receiver.chatContainer.render(80).join("\n")),
    ).toContain("VISIBLE notification");
    expect(runtime.debugSegmentCount()).toBe(0);
  });

  test("non-TUI modes do not install or report host display capabilities", () => {
    removeMethod("showExtensionNotify");
    const notices: string[] = [];
    runtime = new GroupCollapseRuntime({
      notify: (message) => notices.push(message),
    });
    runtime.onSessionStart({ cwd: root, mode: "rpc", getBranch: () => [] });
    expect(notices).toEqual([]);
    expect(runtime.isDisplayInstalled()).toBe(false);
  });

  test("a recreated factory rebinds the singleton to its current notification queue", () => {
    removeMethod("showExtensionNotify");
    const firstQueue: string[] = [];
    const secondQueue: string[] = [];
    runtime = getGroupCollapseRuntime((message) => firstQueue.push(message));
    runtime.onSessionStart({ cwd: root, mode: "tui", getBranch: () => [] });
    runtime.onSessionShutdown();
    const replacement = getGroupCollapseRuntime((message) =>
      secondQueue.push(message),
    );
    expect(replacement).toBe(runtime);
    replacement.onSessionStart({ cwd: root, mode: "tui", getBranch: () => [] });
    expect(firstQueue).toHaveLength(1);
    expect(secondQueue).toHaveLength(1);
    expect(secondQueue[0]).toBe(firstQueue[0]);
  });

  test("the real extension queue delivers the same degradation in a later session", () => {
    removeMethod("showExtensionNotify");
    type Context = {
      cwd: string;
      mode: string;
      sessionManager: { buildContextEntries(): never[]; getBranch(): never[] };
      ui: { notify(message: string, level?: string): void };
    };
    const handlers = new Map<string, (event: object, ctx: Context) => void>();
    extension({
      on: (name: string, handler: (event: object, ctx: Context) => void) =>
        handlers.set(name, handler),
      registerCommand() {},
    } as never);
    const notices: string[] = [];
    const context: Context = {
      cwd: root,
      mode: "tui",
      sessionManager: { buildContextEntries: () => [], getBranch: () => [] },
      ui: { notify: (message) => notices.push(message) },
    };
    cleanups.push(() => handlers.get("session_shutdown")!({}, context));
    handlers.get("session_start")!({}, context);
    handlers.get("tool_execution_update")!(
      { type: "tool_execution_update" },
      context,
    );
    expect(notices).toHaveLength(1);
    handlers.get("session_shutdown")!({}, context);
    handlers.get("session_start")!({}, context);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toBe(notices[1]);
  });
});
