import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectJobs, jobsForTool, noteJobMessage, registerNestedJobs, resetJobs, setJobOptions,
} from "../src/tools/background-jobs.ts";

function host() {
  const handlers = new Map<string, Array<(event: any) => any>>();
  const pi = { on(name: string, handler: (event: any) => any) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  } } as unknown as ExtensionAPI;
  registerNestedJobs(pi);
  return (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = handler(event) ?? result;
    return result;
  };
}

const info = (id: string, name = "worker") => ({ id, name, status: "running", startTime: 1000 });
const result = (id: string, parentToolCallId = "outer", extra: object = {}) => ({
  toolCallId: `${parentToolCallId}/${id}`, parentToolCallId, toolName: "process",
  input: { action: "start" }, isError: false, content: [], details: { process: info(id) }, ...extra,
});
const outer = (details: unknown = {}, isError = false) => ({
  toolCallId: "outer", toolName: "codemode", input: {}, content: [], details, isError,
});
const tool = (details: unknown = {}, extra: object = {}) => ({
  toolCallId: "outer", toolName: "codemode", isPartial: false, result: { details }, ...extra,
});
const notice = (id: string, kind = "success") => ({
  customType: "ad-process:notification", details: { processId: id, kind, timestamp: 2000 },
});

test("nested results track multiple same-name jobs without parsing script output", () => {
  resetJobs();
  const emit = host();
  emit("tool_result", result("p2"));
  emit("tool_result", result("p1"));
  assert.equal(noteJobMessage(notice("p1")), false, "no row has taken ownership yet");
  assert.deepEqual(jobsForTool(tool()).map((j) => j.id), ["p2", "p1"]);
  assert.equal(noteJobMessage(notice("p1")), true);
  assert.equal(noteJobMessage(notice("unrelated")), false);
});

test("outer details preserve a script's results and jobs even if the script fails", () => {
  resetJobs();
  const emit = host();
  emit("tool_result", result("p1"));
  const original = { calls: [{ name: "process", status: "ok" }] };
  const patched = emit("tool_result", outer(original, true));
  assert.deepEqual(original, { calls: [{ name: "process", status: "ok" }] }, "do not mutate another tool's details");
  assert.deepEqual(patched.details.calls, original.calls);
  assert.equal(patched.content, undefined, "model-facing output stays untouched");
  assert.equal(patched.isError, undefined, "the outer failure must not be cleared");
  resetJobs();
  assert.equal(jobsForTool(tool(patched.details, { result: { details: patched.details, isError: true } }))[0]?.id, "p1");
});

test("nested wrappers resolve to their transcript-visible ancestor, not another wrapper", () => {
  resetJobs();
  const emit = host();
  emit("tool_execution_start", { toolCallId: "outer/1", parentToolCallId: "outer" });
  emit("tool_result", result("p1", "outer/1"));
  assert.equal(jobsForTool(tool())[0]?.id, "p1");
  assert.equal(jobsForTool(tool({}, { toolCallId: "other" })).length, 0);
});

test("failed starts and non-start actions never acquire notification ownership", () => {
  resetJobs();
  const emit = host();
  emit("tool_result", result("bad", "outer", { isError: true }));
  emit("tool_result", result("output", "outer", { input: { action: "output" } }));
  assert.deepEqual(jobsForTool(tool()), []);
  assert.equal(noteJobMessage(notice("bad", "failure")), false);
});

test("a notification arriving before the start result is not lost", () => {
  resetJobs();
  const emit = host();
  assert.equal(noteJobMessage(notice("quick")), false);
  emit("tool_result", result("quick"));
  assert.equal(jobsForTool(tool())[0]?.status, "done");
  assert.equal(noteJobMessage(notice("quick")), true);
});

test("jobs remain visible while the outer call is still running", () => {
  resetJobs();
  const emit = host();
  emit("tool_result", result("p1"));
  assert.equal(jobsForTool(tool({}, { isPartial: true }))[0]?.status, "running");
});

test("session lifecycle clears associations; persisted details rebuild only the active branch", () => {
  for (const event of ["session_start", "session_tree", "session_shutdown"]) {
    resetJobs();
    const emit = host();
    emit("tool_result", result("p1"));
    const saved = emit("tool_result", outer()).details;
    jobsForTool(tool());
    emit(event);
    assert.equal(noteJobMessage(notice("p1")), false, event);
    assert.deepEqual(jobsForTool(tool()), [], event);
    assert.equal(jobsForTool(tool(saved))[0]?.id, "p1", event);
  }
});

test("notification settings and backgroundJobs still apply to nested calls", () => {
  resetJobs();
  const emit = host();
  emit("tool_result", result("p1"));
  jobsForTool(tool());
  setJobOptions({ enabled: true, hideNotifications: false });
  assert.equal(noteJobMessage(notice("p1")), false);
  setJobOptions({ enabled: false, hideNotifications: true });
  assert.deepEqual(jobsForTool(tool()), []);
  assert.equal(noteJobMessage(notice("p1")), false);
  assert.equal(emit("tool_result", result("p2")), undefined);
});

test("unknown outer details are never replaced just to persist a UI association", () => {
  for (const details of [null, "opaque", [1, 2]]) {
    resetJobs();
    const emit = host();
    emit("tool_result", result("p1"));
    assert.equal(emit("tool_result", outer(details)), undefined);
    assert.equal(jobsForTool(tool())[0]?.id, "p1", "live association still works");
  }
});

test("malformed persisted associations fall back without acquiring unrelated notices", () => {
  resetJobs();
  assert.deepEqual(jobsForTool(tool({ tidyBackgroundJobs: [null, {}, { id: "p1", name: "x", status: "unknown" }] })), []);
  assert.equal(noteJobMessage(notice("p1")), false);
});

test("a reconnected manager corrects a persisted start; unknown jobs do not spin forever", () => {
  resetJobs();
  const emit = host();
  emit("tool_result", result("p1"));
  const saved = emit("tool_result", outer()).details;
  resetJobs();
  connectJobs({ on: () => () => {}, emit(_channel, raw) { (raw as any).reply(null); } });
  assert.equal(jobsForTool(tool(saved))[0]?.status, "gone");
  noteJobMessage(notice("p1", "killed"));
  assert.equal(jobsForTool(tool(saved))[0]?.status, "killed");
});
