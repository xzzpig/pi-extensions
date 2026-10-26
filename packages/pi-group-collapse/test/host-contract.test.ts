/**
 * Host integration contract tests (change task 1.2).
 *
 * These tests prove — against the real Pi components this package will
 * adapt — that the assumptions the whole design rests on hold on the current
 * host (pi-coding-agent 1.1.x):
 *
 * 1. main-session ownership of tools and custom messages is decidable from
 *    the transcript container's component subtree plus the identity fields
 *    the components carry at runtime;
 * 2. components with the same tool id living outside that subtree (a
 *    pi-btw/fleet-style extension panel) are provably *not* owned;
 * 3. a mixed thinking/text assistant message partitions into contiguous raw
 *    row intervals, one per native child (thinking run vs final text);
 * 4. visible non-members sit between member intervals, and a row maps to
 *    exactly one component — the primitive summary-click coordinates need;
 * 5. the real host notification entry dispatches by level, reuses the tail
 *    status line, and its shared state field can repaint an older line —
 *    the hazards the notification adapter must handle.
 *
 * If any of these break after a host upgrade, the adapter path is blocked:
 * fix the integration or report, never hide the gap.
 */

import { beforeAll, describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  MouseRegion,
  Spacer,
  Text,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";

const WIDTH = 80;

/** Pi's TS-private-but-runtime-public identity fields on tool components. */
type ToolIdentity = { toolName: string; toolCallId: string };

/** The slice of a renderable component these tests need. */
type Renderable = { render(width: number): string[]; invalidate?(): void };

const asRenderable = (value: unknown): Renderable => value as Renderable;

const identityOf = (component: unknown): ToolIdentity =>
  component as ToolIdentity;

/** OSC 133 shell-integration zones prepend/append outside the SGR stream. */
const stripOsc = (line: string): string =>
  line.replace(/\x1b\]133;[ABC]\x07/g, "");

const linesOf = (component: unknown, width = WIDTH): string[] =>
  asRenderable(component).render(width).map(stripOsc);

const plain = (component: unknown, width = WIDTH): string =>
  linesOf(component, width).map(stripTerminalSequences).join("\n");

/** Top-down subtree membership: Pi containers keep no parent pointers. */
function contains(root: unknown, target: unknown): boolean {
  if (root === target) return true;
  const children = (root as { children?: readonly unknown[] }).children;
  if (!Array.isArray(children)) return false;
  return children.some((child) => contains(child, target));
}

/** One interval per direct child, from Container.render's concatenation. */
function childIntervals(
  container: unknown,
  width = WIDTH,
): { component: unknown; start: number; end: number }[] {
  const intervals: { component: unknown; start: number; end: number }[] = [];
  let cursor = 0;
  for (const child of (container as Container).children) {
    const height = asRenderable(child).render(width).length;
    intervals.push({ component: child, start: cursor, end: cursor + height });
    cursor += height;
  }
  return intervals;
}

function componentAtRow(
  container: unknown,
  row: number,
  width = WIDTH,
): { component: unknown; start: number; end: number } | undefined {
  return childIntervals(container, width).find(
    (interval) => row >= interval.start && row < interval.end,
  );
}

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

function toolComponent(
  toolName: string,
  toolCallId: string,
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    toolName,
    toolCallId,
    { command: `echo ${toolCallId}` },
    {},
    undefined,
    stubUi() as never,
    "/tmp",
  );
  component.updateResult(
    {
      content: [{ type: "text", text: `done ${toolCallId}` }],
      isError: false,
    },
    false,
  );
  return component;
}

beforeAll(() => {
  initTheme();
});

describe("main-session ownership mapping", () => {
  test("tools and custom messages carry readable identity in the chat subtree", () => {
    const chat = new Container();
    const bash = toolComponent("bash", "call-1");
    const read = toolComponent("read", "call-2");
    const custom = new CustomMessageComponent({
      role: "custom",
      customType: "pi-goal-audit-event",
      content: "audit note",
      display: true,
      timestamp: Date.now(),
    });
    chat.addChild(bash);
    chat.addChild(read);
    chat.addChild(custom);

    expect(identityOf(bash)).toMatchObject({
      toolName: "bash",
      toolCallId: "call-1",
    });
    expect(identityOf(read)).toMatchObject({
      toolName: "read",
      toolCallId: "call-2",
    });
    expect(
      (custom as unknown as { message: { customType: string } }).message
        .customType,
    ).toBe("pi-goal-audit-event");

    // The host nests the chat container inside the scrolling document; the
    // ownership predicate must survive that extra level.
    const document = new Container();
    document.addChild(chat);
    for (const member of [bash, read, custom]) {
      expect(contains(document, member)).toBe(true);
      expect(contains(chat, member)).toBe(true);
    }
  });

  test("same-tool-id components outside the transcript subtree are not owned", () => {
    const chat = new Container();
    const owned = toolComponent("bash", "call-1");
    chat.addChild(owned);

    // A pi-btw/fleet-style panel renders its own ToolExecutionComponent with
    // the very same toolCallId inside its own component tree.
    const panelRoot = new Container();
    const panelChild = new Container();
    const foreign = toolComponent("bash", "call-1");
    panelChild.addChild(foreign);
    panelRoot.addChild(panelChild);

    expect(identityOf(foreign).toolCallId).toBe("call-1");
    expect(contains(chat, foreign)).toBe(false);
    expect(contains(panelRoot, owned)).toBe(false);
  });
});

describe("mixed thinking/text raw-line partitioning", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "alpha thinking" },
      { type: "thinking", thinking: "beta thinking" },
      { type: "text", text: "final answer" },
    ],
  };

  /** TS-private on the component, public at runtime. */
  function contentContainerOf(component: AssistantMessageComponent): Container {
    return (component as unknown as { contentContainer: Container })
      .contentContainer;
  }

  function mixedComponent(): AssistantMessageComponent {
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
    );
    component.updateContent(message as never, false);
    return component;
  }

  test("consecutive thinking blocks form one native child, text another", () => {
    const component = mixedComponent();
    const children = contentContainerOf(component).children;
    // [leading Spacer, MouseRegion(thinking run), separator Spacer, Markdown]
    expect(children.map((child) => child.constructor.name)).toEqual([
      "Spacer",
      "MouseRegion",
      "Spacer",
      "Markdown",
    ]);
    expect(plain(children[1])).toContain("alpha thinking");
    expect(plain(children[1])).toContain("beta thinking");
    expect(plain(children[3])).toContain("final answer");
  });

  test("thinking and text own disjoint contiguous row intervals", () => {
    const component = mixedComponent();
    const container = contentContainerOf(component);
    const own = linesOf(component);
    const intervals = childIntervals(container);

    // The container's own render is exactly the concatenation of its
    // children's renders — so the intervals partition the component's rows.
    const concatenated = intervals
      .flatMap((interval) => linesOf(interval.component))
      .join("\n");
    expect(own.join("\n")).toBe(concatenated);

    const thinking = intervals[1];
    const separator = intervals[2];
    const text = intervals[3];
    expect(thinking.component).toBeInstanceOf(MouseRegion);
    expect(text.component).toBeInstanceOf(Markdown);
    expect(thinking.end).toBe(separator.start);
    expect(separator.end).toBe(text.start);

    // Every thinking-run row belongs to that run: its content rows carry the
    // thinking text, and the run has no foreign content.
    const thinkingPlain = plain(thinking.component);
    expect(thinkingPlain).toContain("alpha thinking");
    expect(thinkingPlain).toContain("beta thinking");
    expect(thinkingPlain).not.toContain("final answer");
    expect(stripTerminalSequences(own[text.start])).toContain("final answer");
  });
});

describe("visible non-member boundaries and row ownership", () => {
  function transcriptWithBoundary(): {
    chat: Container;
    toolA: ToolExecutionComponent;
    user: UserMessageComponent;
    toolB: ToolExecutionComponent;
  } {
    const chat = new Container();
    const toolA = toolComponent("bash", "call-1");
    const user = new UserMessageComponent("user boundary", getMarkdownTheme());
    const toolB = toolComponent("bash", "call-2");
    chat.addChild(toolA);
    chat.addChild(user);
    chat.addChild(toolB);
    return { chat, toolA, user, toolB };
  }

  test("each row maps to exactly one direct child", () => {
    const { chat, toolA, user, toolB } = transcriptWithBoundary();
    const intervals = childIntervals(chat);
    expect(intervals.length).toBe(3);
    // Disjoint and contiguous.
    expect(intervals[0].end).toBe(intervals[1].start);
    expect(intervals[1].end).toBe(intervals[2].start);
    // The user message interval is the visible boundary between the groups.
    expect(intervals[1].component).toBe(user);
    expect(plain(user)).toContain("user boundary");

    const total = linesOf(chat).length;
    expect(intervals[2].end).toBe(total);

    // Row attribution: click coordinates resolve to the owning component.
    expect(componentAtRow(chat, intervals[0].start)?.component).toBe(toolA);
    expect(componentAtRow(chat, intervals[1].start)?.component).toBe(user);
    expect(componentAtRow(chat, intervals[1].end - 1)?.component).toBe(user);
    expect(componentAtRow(chat, intervals[2].start)?.component).toBe(toolB);
    expect(componentAtRow(chat, total)).toBeUndefined();
  });

  test("a summary line shifts member rows predictably", () => {
    const { chat, toolA, user } = transcriptWithBoundary();
    const before = childIntervals(chat);

    // A collapsed group renders one summary row ahead of its members; the
    // summary itself is a plain component at the group's position.
    const summary = new Text("▸ 2 tools", 1, 0);
    const projected = new Container();
    projected.addChild(summary);
    projected.addChild(toolA);
    projected.addChild(user);

    const after = childIntervals(projected);
    const summaryHeight = asRenderable(summary).render(WIDTH).length;
    expect(after[0].component).toBe(summary);
    expect(after[0].end).toBe(summaryHeight);
    // Original member coordinates shift by exactly the inserted height.
    expect(after[1].start).toBe(before[0].start + summaryHeight);
    expect(after[2].start).toBe(before[1].start + summaryHeight);
    // Clicking the summary row must not attribute to the first tool.
    expect(componentAtRow(projected, 0)?.component).toBe(summary);
    expect(componentAtRow(projected, 0)?.component).not.toBe(toolA);
  });
});

describe("host notification entry", () => {
  type DispatchReceiver = {
    showError: (message: string) => void;
    showWarning: (message: string) => void;
    showStatus: (message: string) => void;
  };

  /** The host types these prototype methods private; they are runtime-public. */
  const interactivePrototype = InteractiveMode.prototype as unknown as {
    showExtensionNotify: (
      this: DispatchReceiver,
      message: string,
      type?: "info" | "warning" | "error",
    ) => void;
    showStatus: (this: StatusReceiver, message: string) => void;
    showError: (this: StatusReceiver, message: string) => void;
    showWarning: (this: StatusReceiver, message: string) => void;
  };

  test("showExtensionNotify exists on the prototype and dispatches by level", () => {
    const calls: [string, string][] = [];
    const receiver: DispatchReceiver = {
      showError: (message) => void calls.push(["error", message]),
      showWarning: (message) => void calls.push(["warning", message]),
      showStatus: (message) => void calls.push(["status", message]),
    };
    const entry = interactivePrototype.showExtensionNotify;

    expect(typeof entry).toBe("function");
    entry.call(receiver, "plain");
    entry.call(receiver, "informed", "info");
    entry.call(receiver, "warned", "warning");
    entry.call(receiver, "errored", "error");
    expect(calls).toEqual([
      ["status", "plain"],
      ["status", "informed"],
      ["warning", "warned"],
      ["error", "errored"],
    ]);
  });

  test("the prototype entry can be observed without changing its behavior", () => {
    const target = InteractiveMode.prototype as unknown as {
      showExtensionNotify: (
        this: DispatchReceiver,
        message: string,
        type?: "info" | "warning" | "error",
      ) => void;
    };
    const original = target.showExtensionNotify;
    const observed: [string, string | undefined][] = [];
    const receiver: DispatchReceiver = {
      showError: () => {},
      showWarning: () => {},
      showStatus: () => {},
    };
    try {
      target.showExtensionNotify = function (message, type) {
        observed.push([message, type]);
        return original.call(this, message, type);
      };
      target.showExtensionNotify.call(receiver, "observed", "info");
    } finally {
      target.showExtensionNotify = original;
    }
    expect(observed).toEqual([["observed", "info"]]);
    expect(target.showExtensionNotify).toBe(original);
  });

  type StatusReceiver = {
    chatContainer: Container;
    ui: { requestRender(): void };
    outputPad: number;
    lastStatusMessage?: string;
    lastStatusText?: Text;
    lastStatusSpacer?: Spacer;
  };

  function statusReceiver(): StatusReceiver {
    return {
      chatContainer: new Container(),
      ui: stubUi(),
      outputPad: 1,
      lastStatusMessage: undefined,
      lastStatusText: undefined,
      lastStatusSpacer: undefined,
    };
  }

  const realShowStatus = interactivePrototype.showStatus;

  const realShowError = interactivePrototype.showError;

  const realShowWarning = interactivePrototype.showWarning;

  test("consecutive status notifications reuse the tail line in place", () => {
    const receiver = statusReceiver();
    realShowStatus.call(receiver, "first status");
    expect(receiver.chatContainer.children.length).toBe(2);
    const tail = receiver.chatContainer.children[1] as Text;
    // Warm the cache while "first status" is the current shared field.
    expect(plain(tail)).toContain("first status");

    realShowStatus.call(receiver, "second status");
    // Reuse, not append: the same pair of components renders the new text.
    expect(receiver.chatContainer.children.length).toBe(2);
    expect(receiver.chatContainer.children[1]).toBe(tail);
    expect(plain(tail)).toContain("second status");
    expect(plain(tail)).not.toContain("first status");
  });

  test("an intervening component breaks tail reuse; the old line repaints the shared field once invalidated", () => {
    const receiver = statusReceiver();
    realShowStatus.call(receiver, "first status");
    const firstTail = receiver.chatContainer.children[1] as Text;
    // Rendered while current, exactly as the host's requestRender would.
    expect(plain(firstTail)).toContain("first status");

    // Something else lands after the status line (a tool, a message...).
    receiver.chatContainer.addChild(toolComponent("bash", "call-9"));

    realShowStatus.call(receiver, "third status");
    // A new pair was appended; the old pair was left in place.
    expect(receiver.chatContainer.children.length).toBe(5);
    const newTail = receiver.chatContainer.children[4] as Text;
    expect(newTail).not.toBe(firstTail);
    expect(plain(newTail)).toContain("third status");

    // The old tail's render cache still shows the text it was built with…
    expect(plain(firstTail)).toContain("first status");
    // …but its builder reads the receiver's shared field: once invalidated
    // (theme change, width change) it repaints whatever that field holds now.
    receiver.lastStatusMessage = "repainted";
    expect(plain(firstTail)).toContain("first status");
    firstTail.invalidate?.();
    expect(plain(firstTail)).toContain("repainted");
  });

  test("error and warning notifications append distinct lines every time", () => {
    const receiver = statusReceiver();
    realShowError.call(receiver, "boom");
    realShowWarning.call(receiver, "careful");
    realShowError.call(receiver, "bam");
    expect(receiver.chatContainer.children.length).toBe(6);
    expect(plain(receiver.chatContainer.children[1])).toContain("Error: boom");
    expect(plain(receiver.chatContainer.children[3])).toContain(
      "Warning: careful",
    );
    expect(plain(receiver.chatContainer.children[5])).toContain("Error: bam");
  });
});
