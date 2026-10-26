/**
 * Call/result pairing, idempotency, and quiet-state tests (change task 2.2).
 *
 * Pins the model's activity semantics: parallel calls must all settle
 * before their segment is quiet, args streaming never settles a call,
 * duplicate call/result events neither double-count nor overwrite the
 * first outcome, a result arriving before its call is tracked as unpaired
 * evidence until the call shows up, and nested-call ids never enter the
 * model.
 */

import { describe, expect, test } from "vitest";
import { GroupingModel } from "../src/model.ts";
import { compileRules } from "../src/rules.ts";

const model = () => new GroupingModel(compileRules([]));

describe("call/result pairing", () => {
  test("parallel calls keep the segment busy until every result lands", () => {
    const m = model();
    m.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "p1", toolName: "bash" },
      { type: "toolCall", toolCallId: "p2", toolName: "read" },
      { type: "toolCall", toolCallId: "p3", toolName: "grep" },
      { type: "toolResult", toolCallId: "p1", isError: false },
      { type: "toolResult", toolCallId: "p2", isError: false },
    ]);
    const [segment] = m.currentSegments();
    expect(m.segmentIsQuiet(segment)).toBe(false);

    m.apply({ type: "toolResult", toolCallId: "p3", isError: false });
    expect(m.segmentIsQuiet(segment)).toBe(true);
  });

  test("args streaming keeps a call pending and bumps its version", () => {
    const m = model();
    m.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolArgs", toolCallId: "a" },
      { type: "toolArgs", toolCallId: "a" },
    ]);
    expect(m.member("a")?.status).toBe("pending");
    expect(m.member("a")?.version).toBe(3);
    expect(m.segmentIsQuiet(m.currentSegments()[0])).toBe(false);
  });

  test("duplicate result events keep the first outcome", () => {
    const m = model();
    m.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: true },
      { type: "toolResult", toolCallId: "a", isError: false },
    ]);
    expect(m.member("a")?.status).toBe("failed");
    expect(m.member("a")?.version).toBe(2);

    m.applyAll([
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
      { type: "toolResult", toolCallId: "b", isError: true },
    ]);
    expect(m.member("b")?.status).toBe("settled");
  });

  test("a result without its call is unpaired evidence, then pairs late", () => {
    const m = model();
    m.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      // A result for a call the model has not seen.
      { type: "toolResult", toolCallId: "late", isError: false },
    ]);
    expect(m.unpairedResultCount()).toBe(1);
    // The unseen call never blocked its own segment (it is not on screen
    // as ours), but the evidence blocks conservative turn decisions.

    // The call arrives afterwards (e.g. event ordering across replays).
    m.apply({ type: "toolCall", toolCallId: "late", toolName: "read" });
    expect(m.unpairedResultCount()).toBe(0);
    expect(m.member("late")?.status).toBe("settled");
  });

  test("nested call ids are refused by both directions", () => {
    const m = model();
    m.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "parent-1", toolName: "bash" },
      { type: "toolCall", toolCallId: "parent-1/1", toolName: "read" },
      { type: "toolResult", toolCallId: "parent-1/1", isError: false },
      { type: "toolResult", toolCallId: "parent-1", isError: false },
    ]);
    expect(m.member("parent-1/1")).toBeUndefined();
    expect(m.unpairedResultCount()).toBe(0);
    expect(m.member("parent-1")?.status).toBe("settled");
  });

  test("tool failure marks the member failed without blocking quiet", () => {
    const m = model();
    m.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: true },
    ]);
    expect(m.member("a")?.status).toBe("failed");
    expect(m.segmentIsQuiet(m.currentSegments()[0])).toBe(true);
  });
});
