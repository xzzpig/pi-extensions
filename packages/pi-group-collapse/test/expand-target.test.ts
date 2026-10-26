/**
 * Explicit expand-target protocol tests (change task 4.1).
 *
 * Pins: the versioned protocol publishes on component instances under the
 * shared symbol; only the summary/title local row of a carrier resolves;
 * repeated resolutions return the same independent group object (press and
 * release stay on one identity); toggling the group never calls the first
 * tool's own `setExpanded`; and the consumer-side reader rejects invalid
 * shapes safely.
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import {
  EXPAND_TARGET_KEY,
  isValidExpandTarget,
  readExpandTarget,
  retractExpandTarget,
} from "../src/expand-target.ts";

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

describe("explicit expand-target protocol", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };
  let first: ToolExecutionComponent;
  let second: ToolExecutionComponent;

  beforeEach(() => {
    initTheme();
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    runtime.handlePiEvent({ type: "agent_start" });
    first = toolComponent("t1");
    second = toolComponent("t2");
    receiver.chatContainer.addChild(first);
    receiver.chatContainer.addChild(second);
    runtime.syncReceiver(receiver);
    for (const id of ["t1", "t2"]) {
      runtime.handlePiEvent({
        type: "tool_execution_end",
        toolCallId: id,
        isError: false,
      });
    }
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });
  });

  test("the protocol publishes under the shared versioned symbol", () => {
    const protocol = readExpandTarget(first);
    expect(protocol).toBeDefined();
    expect(protocol?.version).toBe(1);
    expect(typeof protocol?.resolveLocalTarget).toBe("function");
    expect(EXPAND_TARGET_KEY).toBe(
      Symbol.for("@xzzpig/transcript-expand-target.v1"),
    );
  });

  test("only the carrier's summary row resolves", () => {
    const protocol = readExpandTarget(first);
    // The folded carrier renders exactly one summary line.
    expect(first.render(WIDTH).length).toBe(1);
    const hit = protocol?.resolveLocalTarget(0, WIDTH);
    expect(isValidExpandTarget(hit)).toBe(true);
    // Any other local row misses.
    expect(protocol?.resolveLocalTarget(1, WIDTH)).toBeUndefined();
    expect(protocol?.resolveLocalTarget(-1, WIDTH)).toBeUndefined();
    // Non-carrier members never resolve, at any row.
    const memberProtocol = readExpandTarget(second);
    expect(memberProtocol?.resolveLocalTarget(0, WIDTH)).toBeUndefined();
  });

  test("press and release keep one target identity and direction", () => {
    const protocol = readExpandTarget(first);
    const press = protocol?.resolveLocalTarget(0, WIDTH);
    const release = protocol?.resolveLocalTarget(0, WIDTH);
    expect(press?.component).toBe(release?.component);
    expect(press?.expanded).toBe(true); // folded group opens on click

    // After toggling, the same carrier resolves the same object with the
    // flipped direction — identity survives the state change.
    press?.component.setExpanded(true);
    const after = protocol?.resolveLocalTarget(0, WIDTH);
    expect(after?.component).toBe(press?.component);
    expect(after?.expanded).toBe(false);
  });

  test("toggling the group never calls the first tool's setExpanded", () => {
    const calls: boolean[] = [];
    const original = first.setExpanded.bind(first);
    first.setExpanded = (expanded: boolean) => {
      calls.push(expanded);
      original(expanded);
    };
    const target = readExpandTarget(first)?.resolveLocalTarget(0, WIDTH);
    expect(target).toBeDefined();
    target!.component.setExpanded(true);
    target!.component.setExpanded(false);
    target!.component.setExpanded(true);
    expect(calls).toEqual([]);

    // The member's own field is untouched by the group shell.
    expect((first as unknown as { expanded?: boolean }).expanded).toBe(
      (second as unknown as { expanded?: boolean }).expanded,
    );
  });

  test("group expansion restores content and keeps resolving the title row", () => {
    const protocol = readExpandTarget(first);
    protocol?.resolveLocalTarget(0, WIDTH)?.component.setExpanded(true);
    const lines = first.render(WIDTH);
    expect(lines.length).toBeGreaterThan(1);
    expect(stripTerminalSequences(lines.join("\n"))).toContain("echo t1");
    // The title row still resolves, now with the collapse direction.
    const title = protocol?.resolveLocalTarget(0, WIDTH);
    expect(title?.expanded).toBe(false);
    // Content rows below the title do not resolve.
    expect(protocol?.resolveLocalTarget(1, WIDTH)).toBeUndefined();
  });

  test("a summary that cannot fit does not resolve", () => {
    const narrow = readExpandTarget(first)?.resolveLocalTarget(0, 5);
    expect(narrow).toBeUndefined();
  });

  test("the consumer reader rejects invalid providers safely", () => {
    const garbage = { render: () => [] };
    expect(readExpandTarget(garbage)).toBeUndefined();
    (garbage as Record<PropertyKey, unknown>)[EXPAND_TARGET_KEY] = {
      version: 2,
      resolveLocalTarget: () => undefined,
    };
    expect(readExpandTarget(garbage)).toBeUndefined();
    (garbage as Record<PropertyKey, unknown>)[EXPAND_TARGET_KEY] = {
      version: 1,
      resolveLocalTarget: "not a function",
    };
    expect(readExpandTarget(garbage)).toBeUndefined();
    // A resolver that throws degrades to no target for the consumer.
    (garbage as Record<PropertyKey, unknown>)[EXPAND_TARGET_KEY] = {
      version: 1,
      resolveLocalTarget: () => {
        throw new Error("boom");
      },
    };
    const protocol = readExpandTarget(garbage);
    expect(() => protocol?.resolveLocalTarget(0, WIDTH)).toThrow();
    expect(isValidExpandTarget({ component: {}, expanded: true })).toBe(false);
    expect(
      isValidExpandTarget({
        component: { expanded: true, setExpanded: () => {} },
        expanded: true,
      }),
    ).toBe(true);
  });

  test("retracting removes the protocol from the instance", () => {
    retractExpandTarget(first);
    expect(readExpandTarget(first)).toBeUndefined();
  });
});
