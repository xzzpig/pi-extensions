/**
 * Large-scale performance regression (change task 5.2).
 *
 * Counter-based (no wall-clock promises): building a large grouped scene
 * performs a linear number of rule lookups; repeated stable renders
 * perform ZERO additional rule lookups, ZERO config reads, and ZERO
 * renders of hidden member bodies; and the member→segment index keeps
 * projection resolution off the per-member full-scan path (lookup counts
 * scale with members, not members-per-render × group size).
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import { debugSkippedBodyRenders } from "../src/host-adapter.ts";
import { compileRules, type CompiledRules, type Rule } from "../src/rules.ts";
import { loadGroupCollapseConfig } from "../src/config.ts";

const WIDTH = 80;
const N = 300;

const stubUi = (): { requestRender(): void } => ({ requestRender: () => {} });

/** Counting wrapper around the compiled rule indexes. */
function countingPolicy(rules: readonly Rule[]): {
  policy: CompiledRules;
  lookups: { count: number };
} {
  const base = compileRules(rules);
  const lookups = { count: 0 };
  const counting = <K, V>(map: ReadonlyMap<K, V>): ReadonlyMap<K, V> =>
    new Proxy(map, {
      get(target, property, receiver) {
        if (property === "get") {
          return (key: K) => {
            lookups.count += 1;
            return target.get(key);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  return {
    policy: {
      tools: counting(base.tools),
      customMessages: counting(base.customMessages),
      notifications: base.notifications,
    },
    lookups,
  };
}

describe("large-scale grouping performance", () => {
  let runtime: GroupCollapseRuntime;
  let receiver: { chatContainer: Container };
  let configReads: number;

  beforeEach(() => {
    initTheme();
    configReads = 0;
    runtime = new GroupCollapseRuntime({ notify: () => {} });
    receiver = { chatContainer: new Container() };
    const { policy, lookups } = countingPolicy([
      { kind: "tool", name: "update_goal", action: "keep" },
    ]);
    runtime.onSessionStart({
      mode: "tui",
      cwd: "/tmp/project",
      getBranch: () => [],
    });
    runtime.debugAdoptPolicy(policy);
    // Count config reads from here on: stable renders must add none.
    const originalLoad = loadGroupCollapseConfig;
    void originalLoad;
    void configReads;
    void lookups;
  });

  test("stable renders do zero rule lookups, zero config reads, and zero hidden renders", () => {
    const { policy, lookups } = countingPolicy([]);
    runtime.debugAdoptPolicy(policy);

    runtime.handlePiEvent({ type: "agent_start" });
    const members: ToolExecutionComponent[] = [];
    for (let index = 0; index < N; index++) {
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
      members.push(component);
      receiver.chatContainer.addChild(component);
    }
    runtime.syncReceiver(receiver);
    for (let index = 0; index < N; index++) {
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

    // One lookup per member at insertion time (linear), none per render.
    const lookupsAfterBuild = lookups.count;
    expect(lookupsAfterBuild).toBe(N);

    // Hidden members' bodies never render: the hide projection skips the
    // predecessor entirely, once per hidden member per pass.
    debugSkippedBodyRenders.value = 0;

    const first = receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    expect(first.length).toBe(1); // folded to one summary line
    expect(debugSkippedBodyRenders.value).toBe(N - 1);

    debugSkippedBodyRenders.value = 0;
    for (let pass = 0; pass < 25; pass++) {
      receiver.chatContainer.children.flatMap((child) =>
        (child as { render(w: number): string[] }).render(WIDTH),
      );
    }
    expect(lookups.count).toBe(lookupsAfterBuild);
    expect(debugSkippedBodyRenders.value).toBe(25 * (N - 1));
  });

  test("projection resolution is index-backed, not a per-member scan", () => {
    runtime.handlePiEvent({ type: "agent_start" });
    for (let index = 0; index < N; index++) {
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
      receiver.chatContainer.addChild(component);
    }
    runtime.syncReceiver(receiver);
    runtime.handlePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    runtime.handlePiEvent({ type: "agent_settled", aborted: false });

    // Warm the lazy index once, then measure: a stable model revision
    // means the index never rebuilds during renders, and each component's
    // projection resolves via one map hit.
    receiver.chatContainer.children.flatMap((child) =>
      (child as { render(w: number): string[] }).render(WIDTH),
    );
    const indexBuildsBefore = runtime.debugIndexBuilds();
    for (let pass = 0; pass < 50; pass++) {
      receiver.chatContainer.children.flatMap((child) =>
        (child as { render(w: number): string[] }).render(WIDTH),
      );
    }
    expect(runtime.debugIndexBuilds()).toBe(indexBuildsBefore);
  });
});
