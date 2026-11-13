import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnStore, TURN_ENTRY, messageKey, unionMs, type TurnMessage } from "../src/turns/turn-state.ts";

const user = (timestamp: number): TurnMessage => ({ role: "user", timestamp, content: "check this" });
const reply = (timestamp: number, text = "Done", durationMs: number | undefined = 100): TurnMessage => ({
  role: "assistant", timestamp, provider: "openai", model: "test", durationMs, stopReason: "stop",
  content: [{ type: "text", text }],
});
const calling = (timestamp: number): TurnMessage => ({ ...reply(timestamp, "Checking"), stopReason: "toolUse", content: [
  { type: "text", text: "Checking" },
  { type: "toolCall", id: "a", name: "codemode", arguments: { code: "tools.read({path:'x'})" } },
  { type: "toolCall", id: "b", name: "mcp__docs__search", arguments: { query: "x" } },
] });

test("interval union counts parallel and nested execution only once", () => {
  assert.equal(unionMs([[100, 400], [150, 350], [500, 600], [100, 400]]), 400);
  assert.equal(unionMs([]), 0);
  const store = new TurnStore();
  store.begin(0); store.note(user(0)); store.note(calling(10));
  store.toolStart("a", undefined, 100); store.toolStart("b", undefined, 150);
  store.toolStart("a/1", "a", 200); store.toolEnd("a/1", "a", 250);
  store.requestStart(200); // a nested model request still belongs to the parent tool
  assert.equal(store.pendingLlmAt, undefined);
  assert.equal(store.toolTime(store.current!, 300), 200);
  store.toolEnd("b", undefined, 350); store.toolEnd("a", undefined, 400);
  const turn = store.current!;
  store.note({ role: "toolResult", toolCallId: "a", toolName: "codemode", timestamp: 450, isError: false,
    nestedCalls: { calls: [{ status: "error" }] }, details: { calls: [{ status: "error" }] } });
  assert.equal(turn.tools.get("a")?.nestedFailed, 1, "native and codemode records must not double count a nested failure");
  store.note(reply(500)); store.settle(false, 1000);
  assert.equal(store.toolTime(turn), 300);
  assert.equal(turn.tools.size, 2);
  assert.equal(turn.endedAt! - turn.startedAt!, 1000);
});

test("LLM timing includes request wait and deduplicates streaming updates", () => {
  const store = new TurnStore();
  store.begin(0); store.pendingLlmAt = 100;
  assert.equal(store.llmTime(store.current!, 200), 100);
  const first = reply(100, "First", 1000);
  store.note(first); store.note(first);
  store.note(reply(2000, "Last", 500));
  assert.equal(store.llmTime(store.current!, 3000), 1500);
  const turn = store.current!;
  store.settle(false, 4000);
  assert.equal(store.llmTime(turn), 1500);
  const missing = reply(4100); delete missing.durationMs;
  store.begin(4000); store.note(missing, true);
  assert.equal(store.pendingLlmAt, undefined, "an ended response cannot keep charging retry wait to the LLM");
  store.requestStart(5000);
  assert.equal(store.llmTime(store.current!, 6000), undefined, "missing request timing stays unknown during continuation too");
});

test("steering and automatic continuation remain one run until settled", () => {
  const store = new TurnStore();
  store.begin(100); store.note(user(100)); store.note(calling(200));
  const turn = store.current!;
  store.note(user(500)); store.begin(600); store.note(reply(700));
  store.settle(false, 1000);
  assert.equal(store.byMessage.get(messageKey(user(100))!), store.byMessage.get(messageKey(user(500))!));
  assert.equal(turn.startedAt, 100);
  assert.equal(turn.final, messageKey(reply(700)));
  store.begin(2000); store.note(user(2000));
  assert.notEqual(store.current, turn);
});

test("interrupted tool-only endings never promote a planning message to final reply", () => {
  const store = new TurnStore();
  store.begin(0); store.note(user(0)); store.note(calling(100));
  const turn = store.current!;
  store.settle(true, 500);
  assert.equal(turn.outcome, "interrupted");
  assert.equal(turn.final, undefined);
  for (const [reason, expected] of [["error", "error"], ["length", "incomplete"], ["aborted", "interrupted"]]) {
    store.begin(1000); store.note({ ...reply(1100), stopReason: reason });
    const current = store.current!; store.settle(false, 2000);
    assert.equal(current.outcome, expected);
  }
  store.begin(3000); store.note(reply(3100)); store.settlementOutcome = "error";
  const failed = store.current!; store.settle(false, 4000);
  assert.equal(failed.outcome, "error", "final settlement errors override a prior normal assistant stop");
});

test("saved non-context metadata restores steering membership and tool timing", () => {
  const store = new TurnStore();
  const messages = [user(100), calling(200), user(500), reply(700)];
  store.begin(100);
  for (const message of messages) store.note(message);
  store.toolStart("a", undefined, 300); store.toolEnd("a", undefined, 450);
  const saved = store.settle(false, 1000)!;
  const restored = new TurnStore();
  restored.restore([...messages.map((message) => ({ type: "message", message })), { type: "custom", customType: TURN_ENTRY, data: saved }]);
  const turn = restored.byMessage.get(messageKey(messages[0])!)!;
  assert.equal(restored.byMessage.get(messageKey(messages[2])!), turn);
  assert.equal(restored.byTool.get("a"), turn);
  assert.equal(turn.firstAssistant, messageKey(messages[1]));
  assert.equal(turn.toolMs, 150);
  assert.equal(turn.endedAt, 1000);
  assert.equal(turn.open, undefined, "expansion is not persisted");
});

test("legacy sessions keep missing timing unknown rather than inferring it", () => {
  const store = new TurnStore();
  const final = reply(700);
  delete final.durationMs;
  store.restore([user(100), calling(200), final].map((message) => ({ type: "message", message })));
  const turn = store.byMessage.get(messageKey(final)!)!;
  assert.equal(turn.startedAt, undefined);
  assert.equal(store.toolTime(turn), undefined);
  assert.equal(store.llmTime(turn), undefined);
  assert.equal(turn.final, messageKey(final));
});
