/**
 * GC probe (change task 5.3) — run in its own process with --expose-gc.
 *
 * Phase 1 builds a session, folds it, and shuts it down **without starting
 * a next session**: the runtime lives in a process-global slot, so the old
 * host view must be collectable on the strength of onSessionShutdown
 * alone (receiver, branch closure, and every semantic index released).
 * Phase 2 then replaces the session (shutdown + session_start, the
 * new/resume/fork/reload path) and verifies the strong tables are back at
 * the new view's scale. Collection is forced with a bounded retry loop.
 */

import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../../src/runtime.ts";

const WIDTH = 80;
const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function buildSession(runtime: GroupCollapseRuntime): {
  receiver: { chatContainer: Container };
  components: ToolExecutionComponent[];
} {
  const receiver = { chatContainer: new Container() };
  const components: ToolExecutionComponent[] = [];
  runtime.handlePiEvent({ type: "agent_start" });
  for (let index = 0; index < 20; index++) {
    const component = new ToolExecutionComponent(
      "bash",
      `t${index}`,
      { command: `echo ${index}` },
      {},
      undefined,
      stubUi() as never,
      "/tmp",
    );
    component.updateResult(
      { content: [{ type: "text", text: `done ${index}` }], isError: false },
      false,
    );
    components.push(component);
    receiver.chatContainer.addChild(component);
  }
  runtime.syncReceiver(receiver);
  for (let index = 0; index < 20; index++) {
    runtime.handlePiEvent({
      type: "tool_execution_end",
      toolCallId: `t${index}`,
      isError: false,
    });
  }
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
  return { receiver, components };
}

function collect(retries = 50): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  for (let attempt = 0; attempt < retries; attempt++) {
    gc?.();
  }
  return true;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function main(): Promise<void> {
  initTheme();
  const runtime = new GroupCollapseRuntime({ notify: () => {} });
  runtime.onSessionStart({
    mode: "tui",
    cwd: "/tmp/project",
    getBranch: () => [],
  });

  // Phase 1: shutdown alone — no next session may rescue the old host
  // view. The runtime lives in a process-global slot, so every strong
  // reference it holds must die with onSessionShutdown.
  const alone = buildSession(runtime);
  const containerRef = new WeakRef(alone.receiver.chatContainer);
  const shutdownRefs = alone.components.map(
    (component) => new WeakRef(component),
  );
  runtime.onSessionShutdown();
  // Drop every strong reference this probe holds to the host view, then
  // let the event loop unwind before forcing collection. No session_start
  // runs between the shutdown and this check — that is the window.
  (alone as { components?: unknown }).components = undefined;
  (alone as { receiver?: unknown }).receiver = undefined;
  await tick();
  collect();
  const survived = shutdownRefs.filter((ref) => ref.deref() !== undefined);
  if (survived.length > 0) {
    throw new Error(
      `${survived.length} components survived a shutdown with no next session`,
    );
  }
  if (containerRef.deref() !== undefined) {
    throw new Error("the host chat container survived shutdown");
  }
  if (
    (runtime as unknown as { activeReceiver?: unknown }).activeReceiver !==
    undefined
  ) {
    throw new Error("shutdown kept a strong receiver reference");
  }
  if (
    (runtime as unknown as { lastGetBranch?: unknown }).lastGetBranch !==
    undefined
  ) {
    throw new Error("shutdown kept the branch closure");
  }

  // Session 2: a fresh, smaller view (the reload/new/resume path).
  runtime.onSessionStart({
    mode: "tui",
    cwd: "/tmp/project",
    getBranch: () => [],
  });
  const second = buildSession(runtime);

  // Strong tables are back at the new view's scale: touching one summary
  // click materializes exactly the new view's group handle.
  const secondFolded = second.receiver.chatContainer.children.flatMap((child) =>
    (child as { render(w: number): string[] }).render(WIDTH),
  );
  if (secondFolded.length !== 1) throw new Error("session 2 did not fold");
  const firstChild = second.receiver.chatContainer.children[0] as unknown as {
    handleMouse(event: unknown): unknown;
  };
  const click = (type: string): unknown =>
    firstChild.handleMouse({
      type,
      x: 2,
      y: 0,
      button: "left",
      width: WIDTH,
      height: 24,
      screenX: 2,
      screenY: 0,
      shift: false,
      alt: false,
      ctrl: false,
    });
  click("press");
  click("release");
  const handles = runtime.debugGroupHandleCount();
  if (handles !== 1) {
    throw new Error(`expected exactly the new view's handle, got ${handles}`);
  }
  if (runtime.debugPendingCount() !== 0) throw new Error("stale pending ids");

  console.log("gc-probe-ok");
}

await main();
