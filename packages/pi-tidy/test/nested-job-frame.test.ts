/** Real Pi components + Tidy's entry point: nested starts must own visible rows. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, CustomMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import tidy from "../src/index.ts";
import { connectJobs, resetJobs, type EventBusLike } from "../src/tools/background-jobs.ts";
import { resetGroups } from "../src/tools/tool-groups.ts";
import { enableHoverForTests, resetHover } from "../src/hover.ts";
import { harness, loadTidy } from "./renderer-harness.ts";

initTheme("dark");
const W = 90;
const ui = { requestRender() {} };
const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "").trimEnd();

function setup(config: Record<string, unknown> = {}) {
  resetJobs();
  resetGroups();
  resetHover();
  enableHoverForTests();
  const h = harness();
  loadTidy(tidy, h.pi, { icons: false, frameMessages: false, collapseTurns: "off", frameFinalReply: false, ...config });
  function emit(name: string, event: any = {}) {
    const context = { sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
    for (const handler of h.handlers.get(name) ?? []) {
      const patch = handler(event, context);
      if (patch) Object.assign(event, patch);
    }
    return event;
  }
  emit("session_start");
  const listeners = new Map<string, Array<(data: any) => void>>();
  const known = new Map<string, any>();
  const logs = new Map<string, Array<{ type: "stdout" | "stderr"; text: string }>>();
  let logReads = 0;
  const events: EventBusLike = {
    on(name, handler) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((h) => h !== handler));
    },
    emit(name, data: any) {
      if (name === "processes:request:get") data.reply(known.get(data.id) ?? null);
      if (name === "processes:request:combined_output") {
        logReads++;
        data.reply(known.has(data.id) ? (logs.get(data.id) ?? []).slice(-data.tailLines) : null);
      }
      for (const handler of listeners.get(name) ?? []) handler(data);
    },
  };
  connectJobs(events);
  const chat = new Container();
  const c = new ToolExecutionComponent("codemode", "outer", { code: "await tools.process(start);" }, {}, undefined, ui as any, process.cwd());
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  chat.addChild(new AssistantMessageComponent({
    role: "assistant", content: [{ type: "text", text: "Starting." }, { type: "toolCall", id: "outer", name: "codemode", arguments: {} }],
    stopReason: "toolUse",
  } as any));
  chat.addChild(c);
  const frame = (width = W) => {
    let lines: string[] = [];
    for (let i = 0; i < 5; i++) lines = chat.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width && !/[\r\n]/.test(line)), "one physical row per element, within terminal width");
    return lines.map(strip).filter((line) => line.trim());
  };
  function mouse(needle: string, type = "click", occurrence = 0) {
    const lines = chat.render(W).map(strip);
    const y = lines.map((line, i) => line.includes(needle) ? i : -1).filter((i) => i >= 0)[occurrence];
    assert.ok(y !== undefined, `missing ${needle}:\n${lines.join("\n")}`);
    return chat.handleMouse({ type, button: type === "click" ? "left" : "none", x: 4, y, screenX: 4, screenY: y, width: W, height: lines.length } as any);
  }
  const click = (needle: string, occurrence = 0) => mouse(needle, "click", occurrence);
  function start(id: string, name = id, age = 12_000) {
    const process = { id, name, command: `run-${id}`, cwd: "/tmp", status: "running", startTime: Date.now() - age };
    known.set(id, process);
    emit("tool_execution_start", { toolCallId: `outer/${id}`, parentToolCallId: "outer", toolName: "process" });
    emit("tool_result", { toolCallId: `outer/${id}`, parentToolCallId: "outer", toolName: "process", input: { action: "start" },
      details: { action: "start", process }, content: [], isError: false });
  }
  function finish(isError = false) {
    const event = emit("tool_result", { toolCallId: "outer", toolName: "codemode", input: {}, details: { calls: [] },
      content: [{ type: "text", text: isError ? "Script failed after starting jobs" : "Script completed" }], isError });
    c.updateResult({ ...event, durationMs: 10 } as any, false);
    return event.details;
  }
  function notice(id: string, kind: string, extra: object = {}) {
    const details = { processId: id, kind, timestamp: Date.now(), ...extra };
    events.emit("processes:notification", details);
    chat.addChild(new CustomMessageComponent({ role: "custom", customType: "ad-process:notification", content: `[process] "${id}" ${kind}`,
      display: true, details, timestamp: Date.now() } as any));
  }
  return { c, chat, events, emit, known, logs, frame, click, mouse, start, finish, notice, logReads: () => logReads };
}

test("one codemode call carries two independently updated process rows and hides duplicate notices", () => {
  const h = setup();
  h.start("p1", "same-name");
  h.start("p2", "same-name");
  h.finish();
  let lines = h.frame();
  assert.ok(lines.some((line) => line.includes("1 call") && line.includes("2 running")), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("process same-name")).length, 2);
  h.notice("p1", "success");
  lines = h.frame();
  assert.ok(!lines.some((line) => line.includes("[process]")), "notification is redundant with the row");
  assert.equal(lines.filter((line) => line.includes("process same-name")).length, 1, "only the running job stays under a folded group");
  assert.ok(lines.some((line) => line.includes("1 running")));
  h.notice("p2", "failure", { exitCode: 3 });
  lines = h.frame();
  assert.ok(lines.some((line) => line.includes("1 failed")));
  assert.ok(!lines.some((line) => line.includes("process same-name")), "completed jobs fold away");
  h.click("1 call");
  lines = h.frame();
  assert.equal(lines.filter((line) => line.includes("process same-name")).length, 2);
  assert.ok(lines.some((line) => line.includes("exited 0")));
  assert.ok(lines.some((line) => line.includes("exit 3")));
  assert.ok(lines.some((line) => line.includes("codemode")), "the wrapper's own row remains");
});

test("a nested job opens its own details without expanding the script or its siblings", () => {
  const h = setup();
  h.start("p1");
  h.start("p2");
  h.logs.set("p1", [{ type: "stdout", text: "first job output" }]);
  h.logs.set("p2", [{ type: "stderr", text: "second job output" }]);
  h.finish(true);
  h.frame();
  assert.ok(h.click("process p1"));
  let lines = h.frame();
  assert.equal((h.c as any).expanded, false, "the script stays collapsed");
  assert.ok(lines.some((line) => line.includes("first job output")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("run-p1")));
  assert.ok(!lines.some((line) => line.includes("second job output") || line.includes("Script failed after starting jobs")));
  assert.ok(h.click("process p2"));
  lines = h.frame();
  assert.ok(lines.some((line) => line.includes("second job output")));
  assert.ok(h.click("process p1"));
  lines = h.frame();
  assert.ok(!lines.some((line) => line.includes("first job output")));
  assert.ok(lines.some((line) => line.includes("second job output")), "sibling stays expanded");
  h.click("1 call");
  h.click("▾ 1 call");
  assert.ok(!h.frame().some((line) => line.includes("second job output")), "closing the group also closes child details");
});

test("hover highlights just the pointed-at job, then clears on its detail body", () => {
  const h = setup();
  h.start("p1");
  h.start("p2");
  h.finish();
  h.frame();
  const raw = () => h.chat.render(W);
  const before = raw();
  const p1 = before.findIndex((line) => strip(line).includes("process p1"));
  const p2 = before.findIndex((line) => strip(line).includes("process p2"));
  assert.equal(h.mouse("process p1", "move"), undefined, "hover does not consume selection packets");
  const hovered = raw();
  assert.notEqual(hovered[p1], before[p1]);
  assert.equal(hovered[p2], before[p2]);
  h.click("process p1");
  h.mouse("process p1", "move");
  const highlighted = raw().find((line) => strip(line).includes("process p1"));
  h.mouse("run-p1", "move");
  assert.notEqual(raw().find((line) => strip(line).includes("process p1")), highlighted);
});

test("collapsing the script does not collapse its job; global collapse closes child details", () => {
  const h = setup();
  h.start("p1");
  h.logs.set("p1", [{ type: "stdout", text: "child stays open" }]);
  h.finish();
  h.frame();
  h.click("1 call");
  h.click("codemode ✓");
  h.click("process p1");
  assert.ok(h.frame().some((line) => line.includes("Script completed")));
  h.click("Script completed");
  assert.equal((h.c as any).expanded, false);
  assert.ok(h.frame().some((line) => line.includes("child stays open")));
  h.c.setExpanded(false); // pi's ctrl+o collapse-all, outside a pointer dispatch.
  assert.ok(!h.frame().some((line) => line.includes("child stays open")));
});

test("logs are cached while unchanged, refreshed on output, and are not read after collapse", () => {
  const h = setup();
  h.start("p1");
  h.finish();
  h.frame();
  assert.equal(h.logReads(), 0);
  h.click("process p1");
  h.frame();
  assert.equal(h.logReads(), 1, "not once per render");
  h.logs.set("p1", [{ type: "stdout", text: "updated log" }]);
  h.events.emit("processes:output_changed", { id: "p1" });
  assert.ok(h.frame().some((line) => line.includes("updated log")));
  assert.equal(h.logReads(), 2);
  h.click("updated log");
  assert.equal((h.c as any).expanded, false, "clicking log text must not toggle the wrapper");
  h.click("process p1");
  h.events.emit("processes:output_changed", { id: "p1" });
  h.frame();
  assert.equal(h.logReads(), 2);
});

test("same-name jobs expand by id, logs are bounded, and terminal controls cannot escape the detail row", () => {
  const h = setup();
  h.start("p1", "same-name");
  h.start("p2", "same-name");
  h.logs.set("p1", [{ type: "stdout", text: "wrong job log" }]);
  h.logs.set("p2", Array.from({ length: 50 }, (_, i) => ({ type: "stderr" as const, text: `log-${i}: \x1b[2J\x1b]0;injected\x07\x1b[31m中文\ttext\x1b[0m` })));
  h.finish();
  h.frame();
  h.click("process same-name", 1);
  const lines = h.frame();
  assert.ok(!lines.some((line) => line.includes("wrong job log") || line.includes("log-0:")));
  assert.equal(lines.filter((line) => line.includes("log-")).length, 20);
  for (const line of h.chat.render(W)) assert.ok(!line.includes("\x1b[2J") && !line.includes("injected"));
  for (const width of [20, 40, 90]) h.frame(width);
});

test("open details remain reachable when a job ends; a cleared manager shows an honest fallback", () => {
  const h = setup();
  h.start("p1");
  h.finish();
  h.frame();
  h.click("process p1");
  h.frame();
  h.logs.set("p1", [{ type: "stdout", text: "final output" }]);
  h.notice("p1", "success");
  assert.ok(h.frame().some((line) => line.includes("final output")));
  h.known.clear();
  h.events.emit("processes:changed", { reason: "cleared" });
  assert.ok(h.frame().some((line) => line.includes("Logs unavailable")));
  h.click("process p1");
  assert.ok(!h.frame().some((line) => line.includes("Logs unavailable")));
});

test("a log match lives on the job row, and narrow terminals remain width-correct", () => {
  const h = setup();
  h.start("ticker");
  h.finish();
  h.notice("ticker", "log_match", { logMatch: { pattern: "READY" } });
  assert.ok(h.frame().some((line) => line.includes("READY matched")));
  assert.ok(!h.frame().some((line) => line.includes("[process]")));
  for (const width of [20, 40, 90]) h.frame(width);
});

test("the matched line itself waits on a row under its job, inside the group", () => {
  const h = setup();
  h.start("ticker");
  h.finish();
  h.notice("ticker", "log_match", { logMatch: { pattern: "tick", stream: "stdout", line: "tick 5" } });
  let lines = h.frame();
  assert.ok(!lines.some((line) => line.includes("[process]")), "no block of its own");
  assert.ok(!lines.some((line) => line.includes("tick 5")), "a folded group keeps one row for a running job");
  h.click("1 call");
  lines = h.frame();
  assert.ok(lines.some((line) => line.includes("matched stdout: tick 5")), lines.join("\n"));
  for (const width of [20, 40, 90]) h.frame(width);
});

test("turn folding does not bring a notice back, and an unowned one still shows", () => {
  const h = setup({ collapseTurns: "afterRun" });
  h.start("ticker");
  h.finish();
  h.notice("ticker", "log_match", { logMatch: { pattern: "tick", line: "tick 5" } });
  assert.ok(!h.frame().some((line) => line.includes("[process]")), "its row carries the pattern");
  h.notice("stranger", "success");
  assert.ok(h.frame().some((line) => line.includes('"stranger"')), "nothing owns it, so it keeps its block");
});

test("hideJobNotifications: false keeps the block instead of also growing rows", () => {
  const h = setup({ hideJobNotifications: false });
  h.start("ticker");
  h.finish();
  h.notice("ticker", "log_match", { logMatch: { pattern: "tick", line: "tick 5" } });
  assert.ok(h.frame().some((line) => line.includes('[process] "ticker"')));
  h.click("1 call");
  assert.ok(!h.frame().some((line) => line.includes("matched stdout: tick 5")), "the block is the record");
});

test("multiline task names and log patterns cannot inject physical terminal rows", () => {
  const h = setup();
  h.start("ticker", "line one\nline two");
  h.finish();
  h.notice("ticker", "log_match", { logMatch: { pattern: "READY\nDONE" } });
  assert.ok(h.frame().some((line) => line.includes("line one line two") && line.includes("READY DONE matched")));
});

test("a running script can already display a job before its final result exists", () => {
  const h = setup();
  h.frame();
  h.start("ticker");
  assert.ok(h.frame().some((line) => line.includes("process ticker")));
  h.notice("ticker", "success");
  assert.ok(!h.frame().some((line) => line.includes("[process]")));
});

test("restored metadata and persisted notifications reconstruct jobs after a manager restart", () => {
  const h = setup();
  h.start("p1");
  h.start("p2");
  const saved = h.finish();
  h.frame();
  h.emit("session_start");
  h.known.clear();
  h.c.updateResult({ content: [{ type: "text", text: "Script completed" }], details: JSON.parse(JSON.stringify(saved)), isError: false } as any, false);
  h.notice("p1", "killed", { signal: { name: "SIGTERM" } });
  h.frame();
  h.click("1 call");
  const lines = h.frame();
  assert.ok(lines.some((line) => line.includes("process p1") && line.includes("killed SIGTERM")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("process p2") && line.includes("not running")));
  assert.ok(!lines.some((line) => line.includes("[process]")));
});

test("early notifications are folded after the row claims a quickly completed job", () => {
  const h = setup();
  h.notice("quick", "success");
  assert.ok(h.frame().some((line) => line.includes('[process] "quick"')));
  h.start("quick");
  h.finish();
  assert.ok(!h.frame().some((line) => line.includes("[process]")));
  h.click("1 call");
  assert.ok(h.frame().some((line) => line.includes("process quick") && line.includes("exited 0")));
});

test("fresh nested jobs do not flash rows, then each gets counted and drawn", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  const h = setup();
  h.start("p1", "p1", 0);
  h.start("p2", "p2", 0);
  h.finish();
  let lines = h.frame();
  assert.ok(!lines.some((line) => line.includes("process p")));
  assert.ok(!lines.some((line) => line.includes("running")));
  t.mock.timers.tick(1200);
  lines = h.frame();
  assert.ok(lines.some((line) => line.includes("2 running")), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("process p")).length, 2);
});

test("each failed child is counted without inventing more outer tool calls", () => {
  const h = setup();
  h.start("p1");
  h.start("p2");
  h.finish();
  h.notice("p1", "failure", { exitCode: 1 });
  h.notice("p2", "failure", { exitCode: 2 });
  const lines = h.frame();
  assert.ok(lines.some((line) => line.includes("1 call") && line.includes("2 failed")), lines.join("\n"));
});

test("tasks without a visible owner keep their notifications, including pinned and ungrouped scripts", () => {
  for (const config of [{}, { alwaysShowTools: ["codemode"] }, { groupTools: false }, { backgroundJobs: false }, { hideJobNotifications: false }]) {
    const h = setup(config);
    h.start("ticker");
    h.finish();
    h.frame();
    h.c.setExpanded(false); // Global collapse must not give pinned rows notification ownership.
    h.notice("stranger", "failure");
    assert.ok(h.frame().some((line) => line.includes('"stranger"')), JSON.stringify(config));
    if (Object.keys(config).length) {
      h.notice("ticker", "success");
      assert.ok(h.frame().some((line) => line.includes('"ticker"')), JSON.stringify(config));
    }
  }
});
