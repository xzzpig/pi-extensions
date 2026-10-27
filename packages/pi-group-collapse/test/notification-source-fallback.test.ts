/**
 * Notification source/capability fallbacks (no pin, no host-state freeze).
 *
 * Re-classifying a moved notification line is only safe while the observer
 * can prove *what the line will render next*. Two fallbacks keep that
 * honest:
 *
 * - a consumer that does not handle content versions gets the pre-existing
 *   conservative behavior: a tail move is reported as an invalidation, so
 *   the line is revealed instead of being kept on a guess;
 * - a host whose status component exposes no readable builder cannot prove
 *   either outcome, so the moved line is revealed and its run splits.
 *
 * Both assert the same end state the terminal shows: nothing is hidden
 * unless its classification was proven.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  InteractiveMode,
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createNotificationObserver } from "../src/notification-adapter.ts";
import { GroupCollapseRuntime } from "../src/runtime.ts";

const WIDTH = 120;
const OM_A = "Observational memory: observer running on ~1,111-token chunk";
const OM_B = "Observational memory: observer running on ~2,222-token chunk";

const prototype = InteractiveMode.prototype as unknown as {
  showExtensionNotify: (
    this: unknown,
    message: string,
    type?: "info" | "warning" | "error",
  ) => void;
  showStatus: (this: unknown, message: string) => void;
  showWarning: (this: unknown, message: string) => void;
  showError: (this: unknown, message: string) => void;
};

const originalMethods = {
  showExtensionNotify: prototype.showExtensionNotify,
  showStatus: prototype.showStatus,
};

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function realStatusReceiver(): {
  chatContainer: Container;
  ui: { requestRender(): void };
  outputPad: number;
} {
  return {
    chatContainer: new Container(),
    ui: stubUi(),
    outputPad: 1,
  };
}

function interveningChild(): unknown {
  return { render: () => ["intervening"], invalidate: () => {} };
}

describe("consumer without content-version handling", () => {
  test("a proven tail move falls back to an invalidation", () => {
    const invalidations: unknown[] = [];
    const observer = createNotificationObserver({
      onNotification: () => {},
      onInvalidated: (invalidation) => invalidations.push(invalidation),
    });
    const install = observer.install();
    try {
      const receiver = Object.create(InteractiveMode.prototype) as ReturnType<
        typeof realStatusReceiver
      >;
      Object.assign(receiver, realStatusReceiver());
      prototype.showExtensionNotify.call(receiver, OM_A, "info");
      receiver.chatContainer.addChild(interveningChild() as never);
      prototype.showExtensionNotify.call(receiver, OM_B, "info");

      // Without a re-classification handler the observer must not assume
      // the line is still group content: it reports the reveal instead.
      expect(invalidations).toHaveLength(1);
      expect((invalidations[0] as { reason: string }).reason).toBe(
        "tail-moved",
      );
    } finally {
      install.cleanup();
    }
  });
});

let root: string;
let priorAgentDir: string | undefined;
let runtime: GroupCollapseRuntime | undefined;

beforeEach(() => {
  initTheme();
  root = mkdtempSync(join(tmpdir(), "group-collapse-source-fallback-"));
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
  runtime?.onSessionShutdown();
  runtime = undefined;
  expect(prototype.showStatus).toBe(originalMethods.showStatus);
  expect(prototype.showExtensionNotify).toBe(
    originalMethods.showExtensionNotify,
  );
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("runtime with an unreadable status builder", () => {
  test("an unprovable moved line is revealed and splits the run", () => {
    writeFileSync(
      join(root, "group-collapse.json"),
      JSON.stringify({
        rules: [
          {
            kind: "notification",
            textPrefix: "Observational memory:",
            level: "info",
            action: "group",
          },
        ],
      }),
    );
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    runtime.onSessionStart({ cwd: root, mode: "tui", getBranch: () => [] });
    const receiver = Object.create(InteractiveMode.prototype) as ReturnType<
      typeof realStatusReceiver
    > & { lastStatusText?: unknown };
    Object.assign(receiver, realStatusReceiver());

    const addTool = (callId: string): void => {
      const component = new ToolExecutionComponent(
        "bash",
        callId,
        { command: `echo ${callId}` },
        {},
        undefined,
        stubUi() as never,
        "/tmp",
      );
      component.updateResult(
        {
          content: [{ type: "text", text: `result ${callId}` }],
          isError: false,
        },
        false,
      );
      receiver.chatContainer.addChild(component as never);
      runtime!.syncReceiver(receiver);
      runtime!.handlePiEvent({
        type: "tool_execution_end",
        toolCallId: callId,
        isError: false,
      });
    };
    const notify = (text: string): void => {
      prototype.showExtensionNotify.call(receiver, text, "info");
      runtime!.syncReceiver(receiver);
    };

    runtime.handlePiEvent({ type: "agent_start" });
    addTool("tool-1");
    addTool("tool-2");
    notify(OM_A);

    // A host that does not expose a readable builder on its status line
    // cannot prove the line keeps its own text, so the next status must
    // reveal it instead of keeping it hidden on a guess.
    const movedLine = receiver.lastStatusText as { build?: unknown };
    movedLine.build = () => "a host status the observer cannot attribute";
    addTool("tool-3");
    notify(OM_B);

    expect(
      runtime
        .currentSegmentsForTest()
        .map((segment) =>
          segment.members.map((member) =>
            member.kind === "tool" ? `tool:${member.key}` : member.kind,
          ),
        ),
    ).toEqual([
      ["tool:tool-1", "tool:tool-2"],
      ["tool:tool-3", "notification"],
    ]);

    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
    const transcript = stripTerminalSequences(
      receiver.chatContainer.render(WIDTH).join("\n"),
    );
    // The moved line is painted (not hidden) with whatever the host now
    // renders on it, and the two segments keep their own folds.
    expect(transcript).toContain("a host status the observer cannot attribute");
    expect(transcript).toContain("▸ 分组 2 次工具调用");
    expect(transcript).toContain("▸ 分组 1 次工具调用 · 1 条消息");
  });
});
