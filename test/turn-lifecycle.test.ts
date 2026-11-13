import assert from "node:assert/strict";
import { test } from "node:test";
import tidy from "../src/index.ts";
import { harness, loadTidy } from "./renderer-harness.ts";
import { folded, messageKey, turnStore, TURN_ENTRY } from "../src/turns/turn-state.ts";

const user = { role: "user", timestamp: 1000, content: "Check this" };
const first = { role: "assistant", provider: "openai", model: "test", timestamp: 1100, durationMs: 10, stopReason: "toolUse", content: [
  { type: "thinking", thinking: "Inspect first" },
  { type: "toolCall", id: "a", name: "bash", arguments: { command: "pwd" } },
] };
const answer = { ...first, timestamp: 1500, stopReason: "stop", content: [{ type: "text", text: "Done" }] };

test("lifecycle settles once, persists outside model context, and restores the active branch", async () => {
  const h = harness();
  loadTidy(tidy, h.pi, { collapseTurns: "afterRun", frameFinalReply: true, groupTools: false });
  const messages = [user, first, answer].map((message) => ({ type: "message", message }));
  let branch: any[] = [];
  const ctx = { sessionManager: { getBranch: () => branch }, ui: { notify() {} } } as any;
  const fire = async (event: string, data = {}) => {
    for (const handler of h.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  await fire("session_start");
  await fire("before_agent_start"); await fire("agent_start");
  await fire("message_start", { message: user });
  await fire("message_end", { message: first });
  await fire("tool_execution_start", { toolCallId: "a" });
  await fire("tool_execution_end", { toolCallId: "a" });
  await fire("message_end", { message: answer });
  await fire("agent_end");
  assert.equal(h.entries.length, 0, "a low-level loop ending is not final settlement");
  assert.equal(turnStore.get().current?.outcome, "running");
  await fire("agent_settled", { aborted: false }); await fire("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].customType, TURN_ENTRY);
  assert.equal(h.entries[0].type, "custom", "not a context message");
  branch = [...messages, ...h.entries];
  await fire("session_tree");
  const turn = turnStore.get().byMessage.get(messageKey(answer)!)!;
  assert.equal(turn.outcome, "completed");
  assert.equal(turn.final, messageKey(answer));
  assert.equal(folded(turn), true);
  await h.commands.get("tidy").handler("turn last", ctx);
  assert.equal(folded(turn), false);
  await h.commands.get("tidy").handler("turn 1", ctx);
  assert.equal(folded(turn), true);
  branch = messages.slice(0, 1);
  await fire("session_tree");
  assert.equal(turnStore.get().byMessage.has(messageKey(answer)!), false, "abandoned branches cannot leak into current state");
});

test("disabled turn features register no timing or persistence listeners", () => {
  const h = harness(); loadTidy(tidy, h.pi, { collapseTurns: "off", frameFinalReply: false });
  assert.equal(h.handlers.has("before_provider_request"), false);
  assert.equal(h.handlers.has("message_end"), false);
  assert.equal(h.commands.has("tidy"), false);
});

test("with no settings at all, turn features are on", () => {
  const h = harness(); loadTidy(tidy, h.pi);
  assert.equal(h.handlers.has("message_end"), true);
  assert.equal(h.commands.has("tidy"), true);
});
