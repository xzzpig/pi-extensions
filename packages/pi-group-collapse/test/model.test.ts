/**
 * Contiguous-segment division tests (change task 2.1).
 *
 * Drives the pure grouping model with visual-item streams and pins every
 * division rule: tools merge across steps, visible non-members split,
 * selected special messages join instead of splitting, mixed assistant
 * messages contribute only their thinking, hidden items neither count nor
 * split, whitespace is inert, single-member and single-kind segments form,
 * and no built-in tool list treats edit/write/MCP/unknown differently.
 */

import { describe, expect, test } from "vitest";
import {
  GroupingModel,
  summarizeSegment,
  type Segment,
  type VisualItem,
} from "../src/model.ts";
import { compileRules, type Rule } from "../src/rules.ts";

const policyOf = (rules: readonly Rule[] = []) => compileRules(rules);

const summarize = (segments: readonly Segment[]) =>
  segments.map((segment) => summarizeSegment(segment));

describe("segment division", () => {
  test("tools merge across steps with no visible boundary between", () => {
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      { type: "thinkingRun", messageKey: "m1", runIndex: 0, nonEmpty: true },
      { type: "toolCall", toolCallId: "t1", toolName: "bash" },
      { type: "toolResult", toolCallId: "t1", isError: false },
      { type: "toolCall", toolCallId: "t2", toolName: "mcp__srv__op" },
      { type: "toolResult", toolCallId: "t2", isError: false },
      { type: "toolCall", toolCallId: "t3", toolName: "read" },
      { type: "toolResult", toolCallId: "t3", isError: false },
      { type: "assistantText", messageKey: "m2", nonEmpty: true },
      { type: "turnEnd" },
    ]);
    const segments = model.currentSegments();
    expect(segments.length).toBe(1);
    expect(summarize(segments)).toEqual([
      { tools: 3, thinking: 1, messages: 0, failed: 0, warnings: 0, errors: 0 },
    ]);
    // One tool call + result pair is exactly one member.
    expect(segments[0].members.map((m) => m.key)).toEqual([
      "m1#t0",
      "t1",
      "t2",
      "t3",
    ]);
  });

  test("assistant text, user messages, and kept items split", () => {
    const rules: readonly Rule[] = [
      { kind: "tool", name: "update_goal", action: "keep" },
    ];
    const model = new GroupingModel(policyOf(rules));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a1", toolName: "bash" },
      { type: "toolResult", toolCallId: "a1", isError: false },
      { type: "toolCall", toolCallId: "a2", toolName: "update_goal" },
      { type: "toolResult", toolCallId: "a2", isError: false },
      { type: "toolCall", toolCallId: "a3", toolName: "read" },
      { type: "toolResult", toolCallId: "a3", isError: false },
      { type: "assistantText", messageKey: "m1", nonEmpty: true },
      { type: "toolCall", toolCallId: "b1", toolName: "bash" },
      { type: "toolResult", toolCallId: "b1", isError: false },
      { type: "turnEnd" },
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "c1", toolName: "bash" },
      { type: "toolResult", toolCallId: "c1", isError: false },
      { type: "turnEnd" },
    ]);
    const segments = model.currentSegments();
    // a1 | kept update_goal splits | a3 | text splits | b1 | turn splits | c1
    expect(segments.map((s) => s.members.map((m) => m.key))).toEqual([
      ["a1"],
      ["a3"],
      ["b1"],
      ["c1"],
    ]);
  });

  test("unselected custom messages split; selected ones join", () => {
    const rules: readonly Rule[] = [
      {
        kind: "customMessage",
        customType: "pi-goal-audit-event",
        action: "group",
      },
    ];
    const model = new GroupingModel(policyOf(rules));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      {
        type: "customMessage",
        key: "cm1",
        customType: "pi-goal-audit-event",
        display: true,
      },
      { type: "toolCall", toolCallId: "b", toolName: "read" },
      { type: "toolResult", toolCallId: "b", isError: false },
      {
        type: "customMessage",
        key: "cm2",
        customType: "some-other-type",
        display: true,
      },
      { type: "toolCall", toolCallId: "c", toolName: "bash" },
      { type: "toolResult", toolCallId: "c", isError: false },
      { type: "turnEnd" },
    ]);
    const segments = model.currentSegments();
    expect(segments.map((s) => s.members.map((m) => m.key))).toEqual([
      ["a", "cm1", "b"],
      ["c"],
    ]);
    expect(summarize(segments)).toEqual([
      { tools: 2, thinking: 0, messages: 1, failed: 0, warnings: 0, errors: 0 },
      { tools: 1, thinking: 0, messages: 0, failed: 0, warnings: 0, errors: 0 },
    ]);
  });

  test("native diagnostics always split", () => {
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      { type: "nativeDiagnostic" },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
      { type: "turnEnd" },
    ]);
    expect(model.currentSegments().length).toBe(2);
  });

  test("mixed assistant message: thinking joins, final text splits", () => {
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      { type: "thinkingRun", messageKey: "m2", runIndex: 0, nonEmpty: true },
      { type: "assistantText", messageKey: "m2", nonEmpty: true },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
      { type: "turnEnd" },
    ]);
    const segments = model.currentSegments();
    expect(segments.map((s) => s.members.map((m) => m.key))).toEqual([
      ["a", "m2#t0"],
      ["b"],
    ]);
  });

  test("hidden and whitespace items neither count nor split", () => {
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      {
        type: "customMessage",
        key: "hidden1",
        customType: "pi-goal-audit-event",
        display: false,
      },
      { type: "assistantText", messageKey: "m", nonEmpty: false },
      { type: "thinkingRun", messageKey: "m", runIndex: 0, nonEmpty: false },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
      { type: "turnEnd" },
    ]);
    const segments = model.currentSegments();
    expect(segments.length).toBe(1);
    expect(segments[0].members.map((m) => m.key)).toEqual(["a", "b"]);
  });

  test("single-member, pure-message, and pure-thinking segments form", () => {
    const rules: readonly Rule[] = [
      {
        kind: "customMessage",
        customType: "pi-goal-audit-event",
        action: "group",
      },
    ];
    const model = new GroupingModel(policyOf(rules));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "solo", toolName: "edit" },
      { type: "toolResult", toolCallId: "solo", isError: false },
      { type: "assistantText", messageKey: "m", nonEmpty: true },
      {
        type: "customMessage",
        key: "cm1",
        customType: "pi-goal-audit-event",
        display: true,
      },
      {
        type: "customMessage",
        key: "cm2",
        customType: "pi-goal-audit-event",
        display: true,
      },
      { type: "assistantText", messageKey: "m2", nonEmpty: true },
      { type: "thinkingRun", messageKey: "m3", runIndex: 0, nonEmpty: true },
      { type: "turnEnd" },
    ]);
    expect(summarize(model.currentSegments())).toEqual([
      { tools: 1, thinking: 0, messages: 0, failed: 0, warnings: 0, errors: 0 },
      { tools: 0, thinking: 0, messages: 2, failed: 0, warnings: 0, errors: 0 },
      { tools: 0, thinking: 1, messages: 0, failed: 0, warnings: 0, errors: 0 },
    ]);
  });

  test("edit/write/MCP/unknown tools join by default with no list bias", () => {
    const names = ["edit", "write", "mcp__custom__tool", "never_seen_before"];
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      ...names.flatMap<VisualItem>((name, index) => [
        { type: "toolCall", toolCallId: `t${index}`, toolName: name },
        { type: "toolResult", toolCallId: `t${index}`, isError: false },
      ]),
      { type: "turnEnd" },
    ]);
    expect(summarize(model.currentSegments())).toEqual([
      { tools: 4, thinking: 0, messages: 0, failed: 0, warnings: 0, errors: 0 },
    ]);
  });

  test("failed tool results are counted per segment", () => {
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: true },
      { type: "turnEnd" },
    ]);
    expect(summarize(model.currentSegments())).toEqual([
      { tools: 2, thinking: 0, messages: 0, failed: 1, warnings: 0, errors: 0 },
    ]);
  });

  test("turn boundaries always split segments", () => {
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      { type: "turnEnd" },
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
      { type: "turnEnd" },
    ]);
    const segments = model.currentSegments();
    expect(segments.length).toBe(2);
    expect(segments[0].turn).not.toBe(segments[1].turn);
    expect(model.isTurnActive()).toBe(false);
  });

  test("notifications join only when the rule table selects them", () => {
    const rules: readonly Rule[] = [
      {
        kind: "notification",
        textPrefix: "Observational memory:",
        level: "info",
        action: "group",
      },
    ];
    const model = new GroupingModel(policyOf(rules));
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      {
        type: "notification",
        key: "n1",
        level: "info",
        text: "Observational memory: stored",
      },
      {
        type: "notification",
        key: "n2",
        level: "warning",
        text: "Observational memory: warn",
      },
      { type: "toolCall", toolCallId: "b", toolName: "bash" },
      { type: "toolResult", toolCallId: "b", isError: false },
      { type: "turnEnd" },
    ]);
    const segments = model.currentSegments();
    expect(segments.map((s) => s.members.map((m) => m.key))).toEqual([
      ["a", "n1"],
      ["b"],
    ]);
    expect(segments[0].members[1]).toMatchObject({ level: "info" });
  });

  test("duplicate items are idempotent by key", () => {
    const model = new GroupingModel(policyOf());
    model.applyAll([
      { type: "turnBegin" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolCall", toolCallId: "a", toolName: "bash" },
      { type: "toolResult", toolCallId: "a", isError: false },
      { type: "toolResult", toolCallId: "a", isError: false },
      { type: "thinkingRun", messageKey: "m", runIndex: 0, nonEmpty: true },
      { type: "thinkingRun", messageKey: "m", runIndex: 0, nonEmpty: true },
      { type: "turnEnd" },
    ]);
    expect(summarize(model.currentSegments())).toEqual([
      { tools: 1, thinking: 1, messages: 0, failed: 0, warnings: 0, errors: 0 },
    ]);
  });

  test("args streaming bumps the member version without new members", () => {
    const model = new GroupingModel(policyOf());
    model.apply({ type: "turnBegin" });
    model.apply({ type: "toolCall", toolCallId: "a", toolName: "bash" });
    const before = model.member("a")?.version ?? 0;
    model.apply({ type: "toolArgs", toolCallId: "a" });
    model.apply({ type: "toolArgs", toolCallId: "a" });
    expect(model.member("a")?.version).toBe(before + 2);
    expect(summarize(model.currentSegments())).toEqual([
      { tools: 1, thinking: 0, messages: 0, failed: 0, warnings: 0, errors: 0 },
    ]);
  });
});
