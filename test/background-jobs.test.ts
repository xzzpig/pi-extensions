/**
 * Background jobs: the pi-processes provider's reading of its protocol, and
 * the store's rules for combining a start snapshot, live answers, events and
 * persisted notification messages.
 *
 * The payloads below are shaped after @aliou/pi-processes 0.13
 * (`shared/protocol/*`, `ProcessInfo`, `StartDetails`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANIMATE_MS,
  connectJobs,
  jobForTool,
  jobNoteCount,
  noteJobMessage,
  piProcessesProvider,
  resetJobs,
  setJobOptions,
  spinnerFrame,
  type EventBusLike,
} from "../src/tools/background-jobs.ts";
import { describeJob } from "../src/tools/tool-lines.ts";

/** A minimal stand-in for pi's extension event bus. */
function bus(): EventBusLike & { listeners: Map<string, Array<(data: unknown) => void>> } {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    listeners,
    emit(channel, data) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler));
    },
  };
}

/** pi-processes answering `processes:request:get` from a table. */
function processesBus(known: Record<string, object | null>) {
  const b = bus();
  b.on("processes:request:get", (payload) => {
    const { id, reply } = payload as { id: string; reply(info: unknown): void };
    reply(known[id] ?? null);
  });
  return b;
}

const info = (id: string, extra: object = {}) => ({
  id,
  name: id,
  pid: 1,
  command: "x",
  cwd: "/tmp",
  startTime: 1_000,
  endTime: null,
  status: "running",
  exitCode: null,
  success: null,
  endReason: null,
  signal: null,
  errorMessage: null,
  ...extra,
});

const startCall = (id: string, extra: object = {}) => ({
  toolName: "process",
  args: { action: "start", name: id, command: "x" },
  isPartial: false,
  result: { isError: false, details: { action: "start", process: info(id, extra), notify: {} } },
});

const notification = (processId: string, kind: string, extra: object = {}) => ({
  customType: "ad-process:notification",
  details: { kind, processId, processName: processId, command: "x", timestamp: 21_000, summary: "", attention: "turn", ...extra },
});

test("only a successful `process start` result starts a job", () => {
  assert.equal(piProcessesProvider.fromToolResult(startCall("p1"))?.id, "p1");
  assert.equal(piProcessesProvider.fromToolResult({ ...startCall("p1"), args: { action: "list" } }), undefined);
  assert.equal(piProcessesProvider.fromToolResult({ ...startCall("p1"), toolName: "bash" }), undefined);
  assert.equal(piProcessesProvider.fromToolResult({ ...startCall("p1"), isPartial: true }), undefined);
  assert.equal(piProcessesProvider.fromToolResult({ ...startCall("p1"), result: { isError: true, details: {} } }), undefined);
});

test("ProcessInfo endings map to done / failed / killed", () => {
  const b = processesBus({
    ok: info("ok", { status: "exited", success: true, exitCode: 0, endTime: 21_000, endReason: "exit" }),
    bad: info("bad", { status: "exited", success: false, exitCode: 2, endTime: 4_000, endReason: "exit" }),
    term: info("term", { status: "killed", signal: { name: "SIGTERM" }, endTime: 4_000, endReason: "signal" }),
    stopping: info("stopping", { status: "terminating" }),
  });
  assert.deepEqual(
    ["ok", "bad", "term", "stopping"].map((id) => piProcessesProvider.lookup(b, id)?.status),
    ["done", "failed", "killed", "running"],
  );
  assert.equal(piProcessesProvider.lookup(b, "unknown"), null, "manager doesn't know it");
  assert.equal(piProcessesProvider.lookup(bus(), "x"), undefined, "nobody answered: extension not loaded");
});

test("a job is seeded from its result and corrected by the live answer", () => {
  resetJobs();
  connectJobs(processesBus({ p1: info("p1", { status: "exited", success: true, exitCode: 0, endTime: 5_000 }) }));
  const job = jobForTool(startCall("p1"));
  assert.equal(job?.status, "done", "the result said running, the manager says it already exited");
  assert.equal(describeJob(job!), "exited 0 · 4s");
});

test("a job its extension doesn't know is gone — not running forever", () => {
  resetJobs();
  connectJobs(processesBus({}));
  const job = jobForTool(startCall("old"));
  assert.equal(job?.status, "gone");
  assert.equal(describeJob(job!), "not running");
  // A persisted notification from that earlier session still tells the truth.
  noteJobMessage(notification("old", "success", { exitCode: 0 }));
  assert.equal(describeJob(job!), "exited 0 · 20s");
});

test("live events update the job and ask for a repaint", () => {
  resetJobs();
  const b = processesBus({ p1: info("p1") });
  connectJobs(b);
  let renders = 0;
  const job = jobForTool({ ...startCall("p1"), ui: { requestRender: () => renders++ } });
  assert.equal(job?.status, "running");

  b.emit("processes:notification", notification("p1", "log_match", { logMatch: { pattern: "READY" } }).details);
  assert.equal(job?.note, "READY matched");
  b.emit("processes:ended", info("p1", { status: "exited", success: true, exitCode: 0, endTime: 21_000 }));
  assert.equal(job?.status, "done");
  assert.equal(describeJob(job!), "exited 0 · 20s · READY matched");
  assert.ok(renders >= 2);

  // An ended job never goes back to running, and its ending isn't rewritten.
  b.emit("processes:ended", info("p1", { status: "killed", signal: { name: "SIGKILL" } }));
  assert.equal(job?.status, "done");
});

test("notification messages: hidden only when their job has a row", () => {
  resetJobs();
  connectJobs(processesBus({ p1: info("p1") }));
  assert.equal(noteJobMessage(notification("p1", "log_match", { logMatch: { pattern: "READY" } })), false, "no row yet");
  jobForTool(startCall("p1"));
  assert.equal(noteJobMessage(notification("p1", "killed", { signal: { name: "SIGTERM" } })), true);
  assert.equal(noteJobMessage({ customType: "something-else", details: {} }), false);

  setJobOptions({ enabled: true, hideNotifications: false });
  assert.equal(noteJobMessage(notification("p1", "killed")), false, "hideJobNotifications: false");
  setJobOptions({ enabled: false, hideNotifications: true });
  assert.equal(noteJobMessage(notification("p1", "killed")), false, "backgroundJobs: false");
  assert.equal(jobForTool(startCall("p1")), undefined);
});

test("a matched log line is kept for the rows under its job", () => {
  resetJobs();
  connectJobs(processesBus({ p1: info("p1") }));
  const job = jobForTool({ ...startCall("p1"), toolCallId: "call-1" })!;
  const match = (line: string) => notification("p1", "log_match", { logMatch: { pattern: "tick", stream: "stdout", line } });
  noteJobMessage(match("tick 5"));
  assert.equal(job.note, "tick matched", "the row keeps the pattern");
  assert.deepEqual(job.notifications, [{ text: "matched stdout: tick 5", at: 21_000 }]);
  // The same report also arrives as a live event, and every render asks again:
  // one row per report, not one per frame.
  noteJobMessage(match("tick 5"));
  connectJobs(processesBus({ p1: info("p1") }));
  noteJobMessage(match("tick 5"));
  assert.equal(job.notifications?.length, 1);
  // A pattern with no line is already on the row: nothing to add below it.
  noteJobMessage(notification("p1", "log_match", { logMatch: { pattern: "READY" } }));
  assert.equal(job.notifications?.length, 1);
  assert.equal(jobNoteCount("call-1"), 1);
});

test("a matched line cannot carry terminal controls into a row", () => {
  resetJobs();
  connectJobs(processesBus({ p1: info("p1") }));
  const job = jobForTool(startCall("p1"))!;
  noteJobMessage(notification("p1", "log_match", { logMatch: { pattern: "x", stream: "stderr", line: "\u001b[2J\u001b]0;title\u0007  tick\n5  " } }));
  assert.equal(job.notifications?.[0]?.text, "matched stderr: tick 5");
});

test("a job's notifications stop at ten, the oldest going first", () => {
  resetJobs();
  connectJobs(processesBus({ p1: info("p1") }));
  const job = jobForTool(startCall("p1"))!;
  for (let tick = 0; tick < 12; tick++) {
    noteJobMessage(notification("p1", "log_match", { logMatch: { pattern: "tick", line: `tick ${tick}` } }));
  }
  assert.equal(job.notifications?.length, 10);
  assert.equal(job.notifications?.[0]?.text, "matched stdout: tick 2");
});

test("describe: what a row says for each ending", () => {
  const base = { id: "x", name: "x", startTime: 0 };
  assert.equal(describeJob({ ...base, status: "running" }, 12_400), "running 12s");
  assert.equal(describeJob({ ...base, status: "running", note: "READY matched" }, 185_000), "running 3m05s · READY matched");
  assert.equal(describeJob({ ...base, status: "running" }, 3_725_000), "running 1h02m");
  assert.equal(describeJob({ ...base, status: "failed", exitCode: 1, endTime: 3_000 }), "exit 1 · 3s");
  assert.equal(describeJob({ ...base, status: "killed", signal: "SIGTERM", endTime: 3_000 }), "killed SIGTERM · 3s");
});

test("the spinner turns for the first minutes, then stands still", () => {
  const job = { id: "x", name: "x", status: "running" as const, startTime: 0 };
  const frames = new Set([0, 1000, 2000, 3000].map((now) => spinnerFrame(job, now)));
  assert.equal(frames.size, 4, "one frame per second");
  assert.equal(spinnerFrame(job, ANIMATE_MS + 1), "●");
});
