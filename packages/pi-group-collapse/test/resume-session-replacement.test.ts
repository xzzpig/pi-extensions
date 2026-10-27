/**
 * In-session session replacement (`/resume`, `/fork`) first-frame regression.
 *
 * Pi replaces a session in this order (real host code, 1.1.0):
 *
 * 1. `AgentSessionRuntime.teardownCurrent(reason)` awaits `session_shutdown`,
 *    so every display patch of the old session is already uninstalled;
 * 2. `finishSessionReplacement → rebindSession → rebindCurrentSession({
 *    renderBeforeBind: true })` calls `renderCurrentSessionState()`, which
 *    clears the chat container and renders the *new* branch — **before** the
 *    new `session_start` exists;
 * 3. only then `bindCurrentSessionExtensions → session.bindExtensions`
 *    emits `session_start`, which rebuilds the history model for the new
 *    branch and reinstalls the display patches.
 *
 * The session-scoped `renderInitialMessages` seam is therefore absent during
 * step 2 (it is installed in step 3), and `syncReceiver` refuses to run while
 * no session is active. Without a handoff the replacement frame stays raw:
 * the model is folded for the new branch while the screen shows it unfolded,
 * until an unrelated event or another render happens.
 *
 * These tests drive the real `InteractiveMode.prototype.renderCurrentSessionState`
 * and `renderInitialMessages` in exactly that order, with two *different*
 * branches, and prove the replacement frame binds to the new branch (and
 * never to the replaced one's components).
 */

import { describe, expect, test } from "vitest";
import {
  InteractiveMode,
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime, debugRebuildPending } from "../src/runtime.ts";

const WIDTH = 80;

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function toolComponent(id: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "bash",
    id,
    { command: `echo ${id}` },
    {},
    undefined,
    stubUi() as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `done ${id}` }], isError: false },
    false,
  );
  return component;
}

const plain = (lines: readonly string[]): string =>
  stripTerminalSequences(lines.join("\n"));

const renderedText = (receiver: { chatContainer: Container }): string =>
  plain(
    receiver.chatContainer.children.flatMap((child) =>
      (child as { render(width: number): string[] }).render(WIDTH),
    ),
  );

type Branch = readonly never[];

/** The tool-call ids a branch's assistant messages carry, in order. */
function toolIds(branch: Branch): string[] {
  // SAFETY: the adapter and the folding model read the same known fields.
  const entries = branch as unknown as {
    type: string;
    message?: { role?: string; content?: { type: string; id?: string }[] };
  }[];
  return entries.flatMap((entry) =>
    entry.type === "message" && entry.message?.role === "assistant"
      ? (entry.message.content ?? [])
          .filter((part) => part.type === "toolCall")
          .map((part) => part.id as string)
      : [],
  );
}

/** One settled turn with the given tool calls: folds to a single summary. */
function settledTurn(ids: readonly string[]): Branch {
  return [
    { type: "message", id: "u", message: { role: "user", content: [] } },
    {
      type: "message",
      id: "a",
      message: {
        role: "assistant",
        content: ids.map((id) => ({ type: "toolCall", id, name: "bash" })),
        stopReason: "stop",
      },
    },
    ...ids.map((id) => ({
      type: "message",
      id: `r-${id}`,
      message: { role: "toolResult", toolCallId: id, content: [] },
    })),
  ] as unknown as Branch;
}

type ReplacementReceiver = {
  chatContainer: Container;
  renderInitialMessages(): void;
  renderCurrentSessionState(): void;
};

/**
 * The live `InteractiveMode` instance across a replacement: pi keeps the
 * same mode object and only repoints its session, so the receiver's
 * `sessionManager` projects whichever branch is current. The host fields
 * `renderCurrentSessionState` and `renderInitialMessages` read are stubbed
 * to the minimum, and `renderSessionEntries` adds the restored components
 * the way the host does.
 */
function replacementReceiver(initial: Branch): {
  receiver: ReplacementReceiver;
  pointAt(branch: Branch): void;
  renderedIds(): string[];
  renderRequests: number[];
} {
  const state = { branch: initial };
  const renderRequests: number[] = [];
  const receiver = Object.assign(
    Object.create(InteractiveMode.prototype) as object,
    {
      chatContainer: new Container(),
      loadedResourcesContainer: new Container(),
      pendingMessagesContainer: new Container(),
      pendingTools: new Map(),
      compactionQueuedMessages: [],
      streamingComponent: undefined,
      streamingMessage: undefined,
      ui: { requestRender: () => void renderRequests.push(1) },
      outputPad: 0,
      renderSessionEntries: () => {
        for (const id of toolIds(state.branch)) {
          receiver.chatContainer.addChild(toolComponent(id));
        }
      },
      renderProjectTrustWarningIfNeeded: () => {},
    },
  ) as unknown as ReplacementReceiver;
  // `sessionManager` is a prototype getter on InteractiveMode; the test
  // receiver owns the branch projection instead of a real session.
  Object.defineProperty(receiver, "sessionManager", {
    configurable: true,
    value: {
      buildContextEntries: () => state.branch,
      getEntries: () => state.branch,
    },
  });
  return {
    receiver,
    pointAt: (branch) => {
      state.branch = branch;
    },
    renderedIds: () => toolIds(state.branch),
    renderRequests,
  };
}

describe("in-session /resume replacement binding", () => {
  test("the frame rendered before session_start binds to the new branch", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const oldBranch = settledTurn(["old-tool"]);
    const newBranch = settledTurn(["new-a", "new-b"]);
    const { receiver, pointAt, renderRequests } =
      replacementReceiver(oldBranch);

    // 1. The old session is live: session_start rebuilt its model and the
    //    host rendered the old branch (bound by the startup seam).
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => oldBranch,
    });
    receiver.renderInitialMessages();
    expect(renderedText(receiver)).toContain("1 次工具调用");
    const oldChildren = [...receiver.chatContainer.children];
    expect(oldChildren.length).toBeGreaterThan(0);
    const renderRequestsAfterOldFrame = renderRequests.length;

    // 2. `/resume`: the host awaits `session_shutdown` first, so every
    //    display patch of the old session is gone when the replacement
    //    transcript is rendered.
    runtime.onSessionShutdown();

    // 3. The host repoints the mode at the new session and renders the
    //    replacement transcript *before* binding the new extensions.
    pointAt(newBranch);
    receiver.renderCurrentSessionState();

    // The replacement frame is unbound and shows the *new* branch raw: the
    // new components exist, nothing folded them yet.
    expect(renderedText(receiver)).toContain("echo new-a");
    expect(renderedText(receiver)).toContain("done new-b");
    expect(renderedText(receiver)).not.toContain("2 次工具调用");
    // The replaced branch's components left the view with the clear().
    for (const child of oldChildren) {
      expect(receiver.chatContainer.children).not.toContain(child);
    }

    // 4. `session_start` for the new session: the model replays the new
    //    branch, and the recorded replacement frame binds in that same
    //    pass so the first frame shows the fold.
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => newBranch,
    });

    const resumed = renderedText(receiver);
    expect(resumed).toContain("2 次工具调用");
    expect(resumed).not.toContain("echo new-a");
    expect(resumed).not.toContain("done new-b");
    // The new branch, not the replaced one: one folded turn replayed from
    // the new projection, and no old component survived in the view.
    expect(runtime.debugFoldedIds()).toEqual([1]);
    for (const child of oldChildren) {
      expect(receiver.chatContainer.children).not.toContain(child);
    }
    // Exactly one repaint for the rebound replacement frame.
    expect(renderRequests.length).toBe(renderRequestsAfterOldFrame + 1);
    // The handoff was consumed, not kept alive.
    expect(debugRebuildPending()).toBeUndefined();

    runtime.onSessionShutdown();
    // The handoff is session-scoped state: it does not outlive the pause.
    expect(receiver.chatContainer.children.length).toBeGreaterThan(0);
  });

  test("a replacement render without a following session_start keeps the raw frame", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const oldBranch = settledTurn(["old-tool"]);
    const newBranch = settledTurn(["new-a", "new-b"]);
    const { receiver, pointAt, renderRequests } =
      replacementReceiver(oldBranch);

    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => oldBranch,
    });
    receiver.renderInitialMessages();
    const bound = renderRequests.length;
    runtime.onSessionShutdown();

    pointAt(newBranch);
    receiver.renderCurrentSessionState();

    // Nothing binds while no session is active, and the inactive hook only
    // records the receiver for the next session start.
    expect(renderedText(receiver)).toContain("echo new-a");
    expect(renderRequests.length).toBe(bound);
    expect(debugRebuildPending()).toBe(receiver);
  });

  test("an empty replacement (/new) binds nothing and repaints nothing", () => {
    initTheme();
    const runtime = new GroupCollapseRuntime({ notify: () => {} });
    const oldBranch = settledTurn(["old-tool"]);
    const emptyBranch = [] as Branch;
    const { receiver, pointAt, renderRequests } =
      replacementReceiver(oldBranch);

    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => oldBranch,
    });
    receiver.renderInitialMessages();
    const bound = renderRequests.length;
    runtime.onSessionShutdown();

    pointAt(emptyBranch);
    receiver.renderCurrentSessionState();
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/no-config-resume",
      getBranch: () => emptyBranch,
    });

    // /new: the replacement frame is empty, so the handoff binds no
    // components and requests no frame of its own.
    expect(receiver.chatContainer.children.length).toBe(0);
    expect(renderRequests.length).toBe(bound);
    expect(runtime.debugFoldedIds()).toEqual([]);
    expect(debugRebuildPending()).toBeUndefined();
    runtime.onSessionShutdown();
  });
});
