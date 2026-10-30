import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { GroupCollapseRuntime } from "../src/runtime.ts";
import { readExpandTarget } from "../src/expand-target.ts";
import extension from "../index.ts";

const WIDTH = 120;
type Host = {
  chatContainer: Container;
  ui: { requestRender(): void };
  outputPad: number;
  lastStatusMessage?: string;
  showExtensionNotify(
    message: string,
    level: "info" | "warning" | "error",
  ): void;
  showStatus(message: string): void;
};

function assistant(
  content: object[],
  stopReason = "stop",
): AssistantMessageComponent {
  return new AssistantMessageComponent(
    {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: 1,
    } as never,
    false,
    getMarkdownTheme(),
  );
}

function tool(id: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "bash",
    id,
    { command: `echo ${id}` },
    {},
    undefined,
    { requestRender() {} } as never,
    "/tmp",
  );
  component.updateResult(
    { content: [{ type: "text", text: `result ${id}` }], isError: false },
    false,
  );
  return component;
}

const plain = (line: string): string => stripTerminalSequences(line).trimEnd();
const rowOf = (lines: readonly string[], text: string): number =>
  lines.findIndex((line) => plain(line).includes(text));
const blankBetween = (
  lines: readonly string[],
  left: number,
  right: number,
): number =>
  lines.slice(left + 1, right).filter((line) => plain(line).trim() === "")
    .length;

let root: string;
let previousAgentDir: string | undefined;
let runtime: GroupCollapseRuntime;
let host: Host;

beforeEach(() => {
  initTheme();
  root = mkdtempSync(join(tmpdir(), "pigc-layout-test-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(
    join(root, "group-collapse.json"),
    JSON.stringify({
      rules: [{ kind: "notification", textPrefix: "NOTICE:", action: "group" }],
    }),
  );
  runtime = new GroupCollapseRuntime({ notify: () => {} });
  runtime.onSessionStart({ mode: "tui", cwd: root, getBranch: () => [] });
  // The host is constructed after patch installation, so its methods use
  // the same prototype dispatch as InteractiveMode in the real TUI.
  host = Object.create(InteractiveMode.prototype) as Host;
  host.chatContainer = new Container();
  host.ui = { requestRender() {} };
  host.outputPad = 1;
  runtime.handlePiEvent({ type: "agent_start" });
});

afterEach(() => {
  runtime.onSessionShutdown();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function addTool(id: string): ToolExecutionComponent {
  const component = tool(id);
  host.chatContainer.addChild(component);
  runtime.syncReceiver(host);
  runtime.handlePiEvent({
    type: "tool_execution_end",
    toolCallId: id,
    isError: false,
  });
  return component;
}

function settle(): void {
  runtime.handlePiEvent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  runtime.handlePiEvent({ type: "agent_before_settle", outcome: "completed" });
  runtime.handlePiEvent({ type: "agent_settled", aborted: false });
}

function lines(): string[] {
  return host.chatContainer.render(WIDTH);
}

function assertOneBoundary(rows: string[], from: string, to: string): void {
  const left = rowOf(rows, from);
  const right = rowOf(rows, to);
  expect(left).toBeGreaterThanOrEqual(0);
  expect(right).toBeGreaterThan(left);
  expect(blankBetween(rows, left, right)).toBe(1);
}

describe("group layout with real host components", () => {
  test("33 hidden assistant thinking rows do not leave 33 blank rows after a 38-tool group", () => {
    for (let i = 0; i < 38; i++) {
      const id = `tool-${i}`;
      if (i < 33) {
        host.chatContainer.addChild(
          assistant([
            { type: "thinking", thinking: `THOUGHT-${i}` },
            {
              type: "toolCall",
              id,
              name: "bash",
              arguments: { command: `echo ${id}` },
            },
          ]),
        );
      }
      addTool(id);
    }
    host.chatContainer.addChild(
      assistant([{ type: "text", text: "AFTER-GROUP" }]),
    );
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    const summary = rowOf(rows, "38 次工具调用 · 33 段思考");
    const after = rowOf(rows, "AFTER-GROUP");
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(summary);
    expect(blankBetween(rows, summary, after)).toBe(1);
  });

  test("ten proven info, warning and error notification spacers fold with their messages", () => {
    const levels = ["info", "warning", "error"] as const;
    for (let i = 0; i < 10; i++) {
      addTool(`notify-tool-${i}`);
      host.showExtensionNotify(`NOTICE: ${i}`, levels[i % levels.length]);
      runtime.syncReceiver(host);
      // ThemedText caches each status before the next status changes.
      host.chatContainer.render(WIDTH);
    }
    host.chatContainer.addChild(
      assistant([{ type: "text", text: "AFTER-NOTICES" }]),
    );
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    const summary = rowOf(rows, "10 次工具调用 · 10 条消息");
    const after = rowOf(rows, "AFTER-NOTICES");
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(blankBetween(rows, summary, after)).toBe(1);
    expect(rows.map(plain).join("\n")).not.toContain("NOTICE:");
  });

  test("a reused notification tail keeps one spacer and a keep update reveals it", () => {
    addTool("reuse-tool");
    host.showExtensionNotify("NOTICE: first", "info");
    const before = [...host.chatContainer.children];
    const notification = before.at(-1);
    if (!notification) throw new Error("host did not append a notification");
    const originalBuilder = Reflect.get(notification, "build");
    host.showExtensionNotify("NOTICE: second", "info");
    expect(host.chatContainer.children).toEqual(before);
    expect(Reflect.get(notification, "build")).toBe(originalBuilder);
    expect(host.lastStatusMessage).toBe("NOTICE: second");
    runtime.syncReceiver(host);
    settle();
    expect(lines().map(plain).join("\n")).toContain("1 次工具调用 · 1 条消息");
    const spacer = before[before.length - 2];
    expect(spacer.render(WIDTH)).toEqual([]);
    expect(Reflect.get(notification, "build")).toBe(originalBuilder);
    expect(host.lastStatusMessage).toBe("NOTICE: second");

    host.showExtensionNotify("KEEP: updated", "info");
    runtime.syncReceiver(host);
    expect(lines().map(plain).join("\n")).toContain("KEEP: updated");
    expect(spacer.render(WIDTH)).toHaveLength(1);
  });

  test("a core overwrite reveals its notification and restores its original spacer", () => {
    addTool("core-tool");
    host.showExtensionNotify("NOTICE: original", "info");
    runtime.syncReceiver(host);
    settle();
    const spacer = host.chatContainer.children.at(-2);
    expect(spacer?.render(WIDTH)).toEqual([]);
    host.showStatus("CORE: important");
    runtime.syncReceiver(host);
    expect(lines().map(plain).join("\n")).toContain("CORE: important");
    expect(spacer?.render(WIDTH)).toHaveLength(1);
  });

  test("unrelated spacers stay visible and known notification pairs survive index shifts", () => {
    addTool("shift-tool");
    host.showExtensionNotify("NOTICE: paired", "warning");
    runtime.syncReceiver(host);
    settle();
    const spacer = host.chatContainer.children.at(-2);
    const unrelated = new Spacer(2);
    // Simulate a host inserting a non-member padding component before the
    // proven pair: the next sync refreshes its index in one child walk.
    host.chatContainer.children.unshift(unrelated);
    runtime.syncReceiver(host);
    expect(unrelated.render(WIDTH)).toHaveLength(2);
    expect(spacer?.render(WIDTH)).toEqual([]);
    // The too-narrow group-wide fallback must restore the member spacer.
    expect(spacer?.render(5)).toHaveLength(1);
  });

  test("a mixed assistant message separates its group from text without changing the text", () => {
    const component = assistant([
      { type: "text", text: "BEFORE-THOUGHT" },
      { type: "thinking", thinking: "HIDDEN-THOUGHT" },
      { type: "text", text: "AFTER-THOUGHT" },
    ]);
    host.chatContainer.addChild(component);
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    assertOneBoundary(rows, "BEFORE-THOUGHT", "1 段思考");
    assertOneBoundary(rows, "1 段思考", "AFTER-THOUGHT");
    expect(rows.map(plain).join("\n")).not.toContain("HIDDEN-THOUGHT");
  });

  test("a hidden thinking run does not remove its native truncation diagnostic", () => {
    const component = assistant(
      [{ type: "thinking", thinking: "HIDDEN-TRUNCATED-THOUGHT" }],
      "length",
    );
    host.chatContainer.addChild(component);
    runtime.syncReceiver(host);
    // A later normal assistant result can settle the turn while the earlier
    // truncated component's own diagnostic remains part of the transcript.
    host.chatContainer.addChild(
      assistant([{ type: "text", text: "RECOVERED-TEXT" }]),
    );
    runtime.syncReceiver(host);
    settle();
    const output = lines().map(plain).join("\n");
    expect(output).toContain("1 段思考");
    expect(output).toContain("Response was truncated");
    expect(output).toContain("RECOVERED-TEXT");
    expect(output).not.toContain("HIDDEN-TRUNCATED-THOUGHT");
  });

  test("existing external spacer is not doubled and is restored with the members", () => {
    host.chatContainer.addChild(new Text("BEFORE-TOOL", 0, 0));
    host.chatContainer.addChild(new Spacer(1));
    const component = addTool("single");
    host.chatContainer.addChild(new Spacer(1));
    host.chatContainer.addChild(new Text("AFTER-TOOL", 0, 0));
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    assertOneBoundary(rows, "BEFORE-TOOL", "1 次工具调用");
    assertOneBoundary(rows, "1 次工具调用", "AFTER-TOOL");
    expect(runtime.expandAll()).toBe(1);
    expect(plain(component.render(WIDTH).join("\n"))).toContain("echo single");
  });

  test("tight external content receives exactly one group boundary", () => {
    host.chatContainer.addChild(new Text("BEFORE-TIGHT", 0, 0));
    addTool("tight");
    host.chatContainer.addChild(new Text("AFTER-TIGHT", 0, 0));
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    assertOneBoundary(rows, "BEFORE-TIGHT", "1 次工具调用");
    assertOneBoundary(rows, "1 次工具调用", "AFTER-TIGHT");
  });

  test("repeated expand and collapse keeps one boundary without accumulating rows", () => {
    host.chatContainer.addChild(new Text("BEFORE-LOOP", 0, 0));
    const component = addTool("loop");
    host.chatContainer.addChild(new Text("AFTER-LOOP", 0, 0));
    runtime.syncReceiver(host);
    settle();
    for (let pass = 0; pass < 5; pass++) {
      const folded = lines();
      assertOneBoundary(folded, "BEFORE-LOOP", "1 次工具调用");
      assertOneBoundary(folded, "1 次工具调用", "AFTER-LOOP");
      const foldedHeader = rowOf(component.render(WIDTH), "1 次工具调用");
      const target = readExpandTarget(component)?.resolveLocalTarget(
        foldedHeader,
        WIDTH,
      );
      expect(target).toBeDefined();
      target?.component.setExpanded(true);
      const opened = lines();
      assertOneBoundary(opened, "BEFORE-LOOP", "1 次工具调用");
      assertOneBoundary(opened, "收起分组", "AFTER-LOOP");
      const footerRow = rowOf(component.render(WIDTH), "收起分组");
      readExpandTarget(component)
        ?.resolveLocalTarget(footerRow, WIDTH)
        ?.component.setExpanded(false);
    }
  });

  test("a footer toggle between header clicks does not trigger double-click suppression", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const first = addTool("quick-first");
      const last = addTool("quick-last");
      settle();
      const click = (
        component: ToolExecutionComponent,
        y: number,
        screenY: number,
      ) => {
        const event = (type: "press" | "release") =>
          ({
            type,
            x: 2,
            y,
            screenX: 2,
            screenY,
            width: WIDTH,
            height: 50,
            button: "left",
            shift: false,
            alt: false,
            ctrl: false,
          }) as never;
        component.handleMouse(event("press"));
        component.handleMouse(event("release"));
      };
      first.render(WIDTH);
      click(first, 0, 1);
      expect(plain(first.render(WIDTH).join("\n"))).toContain("▾ 分组");
      clock.mockReturnValue(10_100);
      const footerRow = rowOf(last.render(WIDTH), "收起分组");
      expect(footerRow).toBeGreaterThanOrEqual(0);
      click(last, footerRow, 20);
      expect(plain(first.render(WIDTH).join("\n"))).toContain("▸ 分组");
      clock.mockReturnValue(10_200);
      click(first, 0, 1);
      expect(plain(first.render(WIDTH).join("\n"))).toContain("▾ 分组");
    } finally {
      clock.mockRestore();
    }
  });

  test("a last thinking member's visible text supplies the group's boundary", () => {
    addTool("before-last-thinking");
    host.chatContainer.addChild(
      assistant([
        { type: "thinking", thinking: "LAST-THOUGHT" },
        { type: "text", text: "LAST-ASSISTANT-TEXT" },
      ]),
    );
    host.chatContainer.addChild(new Text("FOLLOWING-CONTENT", 0, 0));
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    assertOneBoundary(rows, "1 次工具调用 · 1 段思考", "LAST-ASSISTANT-TEXT");
    expect(rows.map(plain).join("\n")).toContain("FOLLOWING-CONTENT");
  });

  test("a thinking carrier shares an existing external spacer instead of doubling it", () => {
    host.chatContainer.addChild(new Text("BEFORE-CARRIER", 0, 0));
    host.chatContainer.addChild(new Spacer(1));
    host.chatContainer.addChild(
      assistant([{ type: "thinking", thinking: "CARRIER-THOUGHT" }]),
    );
    host.chatContainer.addChild(new Text("AFTER-CARRIER", 0, 0));
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    assertOneBoundary(rows, "BEFORE-CARRIER", "1 段思考");
    assertOneBoundary(rows, "1 段思考", "AFTER-CARRIER");
  });

  test("a thinking-only group at transcript edges has no extra blank boundaries", () => {
    host.chatContainer.addChild(
      assistant([{ type: "thinking", thinking: "EDGE-THOUGHT" }]),
    );
    runtime.syncReceiver(host);
    settle();
    const rows = lines();
    expect(rows).toHaveLength(1);
    expect(plain(rows[0])).toContain("1 段思考");
    // The removed leading host Spacer carried Pi's zone-start marker;
    // it must survive on the remaining assistant output.
    expect(rows[0]).toContain("\x1b]133;A\x07");
    expect(rows[0]).toContain("\x1b]133;B\x07");
    expect(rows[0]).toContain("\x1b]133;C\x07");
  });

  test("adjacent groups share exactly one gap without leading or trailing blank rows", () => {
    const first = addTool("adjacent-first");
    settle();
    runtime.handlePiEvent({ type: "agent_start" });
    const second = addTool("adjacent-second");
    settle();
    const rows = lines();
    const headings = rows.flatMap((line, index) =>
      plain(line).includes("1 次工具调用") ? [index] : [],
    );
    expect(headings).toHaveLength(2);
    expect(headings[0]).toBe(0);
    expect(headings[1]).toBe(rows.length - 1);
    expect(blankBetween(rows, headings[0], headings[1])).toBe(1);
    for (let i = 0; i < 5; i++) expect(lines()).toEqual(rows);
    expect(readExpandTarget(first)?.resolveLocalTarget(0, WIDTH)).toBeDefined();
    expect(
      readExpandTarget(second)?.resolveLocalTarget(0, WIDTH),
    ).toBeUndefined();
    expect(
      readExpandTarget(second)?.resolveLocalTarget(1, WIDTH),
    ).toBeDefined();
  });

  test("neighbor probes do not overwrite a previously rendered header's hit geometry", () => {
    host.chatContainer.addChild(new Text("BEFORE-ADJACENT", 0, 0));
    const first = addTool("geometry-first");
    settle();
    runtime.handlePiEvent({ type: "agent_start" });
    addTool("geometry-second");
    settle();
    const rows = lines();
    expect(plain(rows[0])).toBe("BEFORE-ADJACENT");
    expect(plain(rows[1])).toBe("");
    expect(plain(rows[2])).toContain("1 次工具调用");
    // The first component's local row 0 is a boundary, not its header.
    // Resolving after the whole container render must not reuse a later
    // neighbor probe's temporary, unpadded geometry.
    const resolver = readExpandTarget(first);
    expect(resolver?.resolveLocalTarget(0, WIDTH)).toBeUndefined();
    expect(resolver?.resolveLocalTarget(1, WIDTH)).toBeDefined();
  });

  test("a single tool footer retains the member's own expansion state and output", () => {
    const component = addTool("individual");
    component.setExpanded(true);
    const original = component.render(WIDTH);
    settle();
    const target = readExpandTarget(component)?.resolveLocalTarget(0, WIDTH);
    expect(target).toBeDefined();
    target?.component.setExpanded(true);
    const expanded = component.render(WIDTH);
    expect(expanded.slice(1, -1)).toEqual(original);
    expect(plain(expanded.at(-1) ?? "")).toContain("收起分组");
    const footer = readExpandTarget(component)?.resolveLocalTarget(
      expanded.length - 1,
      WIDTH,
    );
    expect(footer?.component).toBe(target?.component);
    footer?.component.setExpanded(false);
    expect(component.render(WIDTH).map(plain).join("\n")).not.toContain(
      "收起分组",
    );
    target?.component.setExpanded(true);
    expect(component.render(WIDTH).slice(1, -1)).toEqual(original);
  });

  test("a custom-message last member owns the same group footer", () => {
    runtime.debugApplyPolicyRules([
      { kind: "customMessage", customType: "test-audit", action: "group" },
    ]);
    const first = addTool("before-audit");
    const custom = new CustomMessageComponent({
      role: "custom",
      customType: "test-audit",
      content: "AUDIT-CONTENT",
      display: true,
      timestamp: 1,
    });
    host.chatContainer.addChild(custom);
    runtime.syncReceiver(host);
    settle();
    const header = readExpandTarget(first)?.resolveLocalTarget(0, WIDTH);
    header?.component.setExpanded(true);
    const rows = custom.render(WIDTH);
    const footerRow = rowOf(rows, "收起分组");
    expect(footerRow).toBeGreaterThanOrEqual(0);
    expect(rows.map(plain).join("\n")).toContain("AUDIT-CONTENT");
    expect(
      readExpandTarget(custom)?.resolveLocalTarget(footerRow, WIDTH)?.component,
    ).toBe(header?.component);
  });

  test.each(["session_tree", "session_compact"])(
    "%s releases old notification spacing and footer geometry",
    (eventName) => {
      const handlers = new Map<
        string,
        (event: unknown, ctx: unknown) => void
      >();
      const slot = Symbol.for("pi-group-collapse.runtime.v1");
      Object.defineProperty(globalThis, slot, {
        value: runtime,
        configurable: true,
      });
      try {
        // The extension callback, not a direct runtime call, must perform
        // the branch rebuild for both supported lifecycle events.
        extension({
          on: (name: string, handler: (event: unknown, ctx: unknown) => void) =>
            handlers.set(name, handler),
          registerCommand: () => {},
        } as never);
        const first = addTool("old-view-tool");
        host.showExtensionNotify("NOTICE: old branch notification", "info");
        runtime.syncReceiver(host);
        const oldNotification = host.chatContainer.children.at(-1);
        const oldSpacer = host.chatContainer.children.at(-2);
        expect(oldSpacer).toBeInstanceOf(Spacer);
        settle();
        expect((oldSpacer as Spacer).render(WIDTH)).toEqual([]);
        expect(runtime.expandAll()).toBe(1);
        lines();
        const oldRows = (oldNotification as Text).render(WIDTH);
        const footer = rowOf(oldRows, "收起分组");
        expect(footer).toBeGreaterThanOrEqual(0);
        expect(
          readExpandTarget(oldNotification)?.resolveLocalTarget(footer, WIDTH),
        ).toBeDefined();

        // The host already replaced its view when the lifecycle callback
        // adopts the branch projection. Its old children must not retain
        // spacer ownership or claim a stale footer in the replacement view.
        host.chatContainer.clear();
        const newSpacer = new Spacer(1);
        host.chatContainer.addChild(newSpacer);
        host.chatContainer.addChild(new Text("NEW-BRANCH-CONTENT", 0, 0));
        const ctx = {
          sessionManager: { buildContextEntries: () => [] },
          ui: { notify() {} },
        };
        const handler = handlers.get(eventName);
        expect(handler).toBeDefined();
        handler?.({ willRetry: false }, ctx);
        expect((oldSpacer as Spacer).render(WIDTH)).toHaveLength(1);
        expect(newSpacer.render(WIDTH)).toHaveLength(1);
        expect(
          readExpandTarget(oldNotification)?.resolveLocalTarget(footer, WIDTH),
        ).toBeUndefined();
        expect(plain(first.render(WIDTH).join("\n"))).not.toContain("收起分组");
        expect(plain(lines().join("\n"))).toContain("NEW-BRANCH-CONTENT");
      } finally {
        Reflect.deleteProperty(globalThis, slot);
      }
    },
  );

  test("a detached or displaced footer carrier is never claimed", () => {
    const first = addTool("attached-first");
    const last = addTool("detached-last");
    settle();
    const header = readExpandTarget(first)?.resolveLocalTarget(0, WIDTH);
    header?.component.setExpanded(true);
    const rows = last.render(WIDTH);
    const footerRow = rowOf(rows, "收起分组");
    expect(footerRow).toBeGreaterThanOrEqual(0);
    host.chatContainer.children.pop();
    // Even before another scan, stale rendered geometry cannot claim a row.
    expect(
      readExpandTarget(last)?.resolveLocalTarget(footerRow, WIDTH),
    ).toBeUndefined();
    expect(last.render(WIDTH).map(plain).join("\n")).not.toContain("收起分组");
  });

  test("shutdown releases group controls and restores the member's original rendering", () => {
    const component = addTool("shutdown-tool");
    const original = component.render(WIDTH);
    settle();
    expect(runtime.expandAll()).toBe(1);
    expect(component.render(WIDTH).map(plain).join("\n")).toContain("收起分组");
    runtime.onSessionShutdown();
    expect(component.render(WIDTH)).toEqual(original);
    expect(
      readExpandTarget(component)?.resolveLocalTarget(0, WIDTH),
    ).toBeUndefined();
  });

  test("a zero-line last member can still carry its group's footer", () => {
    const first = addTool("nonempty");
    const last = addTool("zero-output");
    // Pi's hidden component state yields no original rows, without changing
    // its status as the logical last member of the settled group.
    Reflect.set(last, "hideComponent", true);
    settle();
    const header = readExpandTarget(first)?.resolveLocalTarget(0, WIDTH);
    header?.component.setExpanded(true);
    const rows = last.render(WIDTH);
    expect(rows).toHaveLength(1);
    expect(plain(rows[0])).toContain("收起分组");
    const footer = readExpandTarget(last)?.resolveLocalTarget(0, WIDTH);
    expect(footer?.component).toBe(header?.component);
    expect(footer?.expanded).toBe(false);
  });

  test("separate thinking groups inside one assistant resolve each footer to its own header", () => {
    const component = assistant([
      { type: "thinking", thinking: "FIRST-THOUGHT" },
      { type: "text", text: "BETWEEN-GROUPS" },
      { type: "thinking", thinking: "SECOND-THOUGHT" },
    ]);
    host.chatContainer.addChild(component);
    runtime.syncReceiver(host);
    settle();
    expect(runtime.expandAll()).toBe(2);
    const rows = component.render(WIDTH);
    const footers = rows.flatMap((line, index) =>
      plain(line).includes("收起分组") ? [index] : [],
    );
    const headers = rows.flatMap((line, index) =>
      plain(line).includes("▾") && plain(line).includes("1 段思考")
        ? [index]
        : [],
    );
    expect(headers).toHaveLength(2);
    expect(footers).toHaveLength(2);
    expect(headers[0]).toBeLessThan(footers[0]);
    expect(footers[0]).toBeLessThan(rowOf(rows, "BETWEEN-GROUPS"));
    expect(rowOf(rows, "BETWEEN-GROUPS")).toBeLessThan(headers[1]);
    expect(headers[1]).toBeLessThan(footers[1]);
    const resolver = readExpandTarget(component);
    const first = resolver?.resolveLocalTarget(headers[0], WIDTH);
    const second = resolver?.resolveLocalTarget(headers[1], WIDTH);
    expect(first?.component).toBe(
      resolver?.resolveLocalTarget(footers[0], WIDTH)?.component,
    );
    expect(second?.component).toBe(
      resolver?.resolveLocalTarget(footers[1], WIDTH)?.component,
    );
    expect(first?.component).not.toBe(second?.component);

    const event = (
      type: "press" | "move" | "release" | "click",
      y: number,
      extra: object = {},
    ) =>
      ({
        type,
        x: 1,
        y,
        width: WIDTH,
        height: 40,
        screenX: 1,
        screenY: y,
        button: "left",
        shift: false,
        alt: false,
        ctrl: false,
        ...extra,
      }) as never;
    // A drag that leaves and returns to the control must never toggle it.
    expect(component.handleMouse(event("press", footers[1]))).toBeUndefined();
    component.handleMouse(event("move", footers[1] - 1));
    component.handleMouse(event("release", footers[1]));
    expect(second?.component.expanded).toBe(true);
    component.handleMouse(event("click", footers[1], { clickCount: 2 }));
    expect(second?.component.expanded).toBe(true);
    component.handleMouse(event("press", footers[1]));
    component.handleMouse(
      event("release", footers[1], { screenY: footers[1] + 1 }),
    );
    expect(second?.component.expanded).toBe(true);
    component.handleMouse(event("press", footers[1]));
    expect(component.handleMouse(event("release", footers[1]))).toEqual({
      handled: true,
      render: true,
    });
    expect(first?.component.expanded).toBe(true);
    expect(second?.component.expanded).toBe(false);
    const after = component.render(WIDTH).map(plain).join("\n");
    expect(after).toContain("FIRST-THOUGHT");
    expect(after).not.toContain("SECOND-THOUGHT");
    expect(after).toContain("BETWEEN-GROUPS");
  });

  test("the last tool's bottom control resolves to the same group as the header", () => {
    const first = addTool("first");
    const last = addTool("last");
    settle();
    const header = readExpandTarget(first)?.resolveLocalTarget(0, WIDTH);
    expect(header).toBeDefined();
    header?.component.setExpanded(true);
    host.chatContainer.render(WIDTH);
    const lastRows = last.render(WIDTH);
    const footerRow = rowOf(lastRows, "收起分组");
    expect(footerRow).toBeGreaterThanOrEqual(0);
    const footer = readExpandTarget(last)?.resolveLocalTarget(footerRow, WIDTH);
    expect(footer?.component).toBe(header?.component);
    expect(footer?.expanded).toBe(false);
  });
});
