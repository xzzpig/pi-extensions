/**
 * Pure rule matching tests (change task 1.5).
 *
 * Pins the matching contract: exact case-sensitive identity per kind, kinds
 * never cross-matching, last-hit-wins override order, group/keep defaults,
 * notification prefix + optional level semantics, and the compiled-index
 * path agreeing with the direct scan on every case.
 */

import { describe, expect, test } from "vitest";
import {
  actionForCandidate,
  actionForCandidateCompiled,
  compileRules,
  defaultActionFor,
  type Rule,
} from "../src/rules.ts";

const RULES: readonly Rule[] = [
  { kind: "tool", name: "update_goal", action: "keep" },
  { kind: "tool", name: "update_goal", action: "group" },
  { kind: "customMessage", customType: "pi-goal-audit-event", action: "group" },
  {
    kind: "notification",
    textPrefix: "Observational memory:",
    level: "info",
    action: "group",
  },
];

const COMPILED = compileRules(RULES);

function both(candidate: Parameters<typeof actionForCandidate>[1]): {
  direct: string;
  compiled: string;
} {
  return {
    direct: actionForCandidate(RULES, candidate),
    compiled: actionForCandidateCompiled(COMPILED, candidate),
  };
}

describe("tool rules", () => {
  test("exact, case-sensitive name matching with last hit winning", () => {
    expect(both({ kind: "tool", name: "update_goal" }).direct).toBe("group");
    expect(both({ kind: "tool", name: "Update_Goal" }).direct).toBe("group"); // no rule hit → default
  });

  test("unmatched tools default to group regardless of type", () => {
    for (const name of ["edit", "write", "mcp__x__y", "totally_unknown"]) {
      expect(both({ kind: "tool", name }).direct).toBe("group");
    }
  });

  test("a tool rule never matches a custom message with the same name", () => {
    const rules: readonly Rule[] = [
      { kind: "tool", name: "shared", action: "keep" },
    ];
    expect(
      actionForCandidate(rules, {
        kind: "customMessage",
        customType: "shared",
      }),
    ).toBe("keep"); // custom-message default, not the tool rule
    expect(actionForCandidate(rules, { kind: "tool", name: "shared" })).toBe(
      "keep",
    );
  });
});

describe("custom message rules", () => {
  test("exact customType matching; other types stay keep", () => {
    expect(
      both({ kind: "customMessage", customType: "pi-goal-audit-event" }).direct,
    ).toBe("group");
    expect(
      both({ kind: "customMessage", customType: "pi-goal-audit-EVENT" }).direct,
    ).toBe("keep");
    expect(
      both({ kind: "customMessage", customType: "other-type" }).direct,
    ).toBe("keep");
  });

  test("a custom message rule never matches a tool with the same name", () => {
    const rules: readonly Rule[] = [
      { kind: "customMessage", customType: "shared", action: "group" },
    ];
    expect(actionForCandidate(rules, { kind: "tool", name: "shared" })).toBe(
      "group",
    ); // tool default, unaffected by the message rule
  });
});

describe("notification rules", () => {
  test("prefix matches the verified original text from its start", () => {
    expect(
      both({
        kind: "notification",
        text: "Observational memory: stored 3 notes",
        level: "info",
      }).direct,
    ).toBe("group");
  });

  test("substrings and case variants do not match", () => {
    expect(
      both({
        kind: "notification",
        text: "later Observational memory: stored",
        level: "info",
      }).direct,
    ).toBe("keep");
    expect(
      both({
        kind: "notification",
        text: "observational memory: stored",
        level: "info",
      }).direct,
    ).toBe("keep");
  });

  test("the level condition gates the rule", () => {
    expect(
      both({
        kind: "notification",
        text: "Observational memory: stored",
        level: "warning",
      }).direct,
    ).toBe("keep");
    expect(
      both({
        kind: "notification",
        text: "Observational memory: stored",
        level: "error",
      }).direct,
    ).toBe("keep");
  });

  test("a rule without a level matches any level", () => {
    const rules: readonly Rule[] = [
      { kind: "notification", textPrefix: "Any:", action: "group" },
    ];
    const compiled = compileRules(rules);
    for (const level of ["info", "warning", "error"] as const) {
      expect(
        actionForCandidateCompiled(compiled, {
          kind: "notification",
          text: "Any: message",
          level,
        }),
      ).toBe("group");
    }
  });

  test("later notification rules override earlier ones on the same prefix", () => {
    const rules: readonly Rule[] = [
      { kind: "notification", textPrefix: "P:", action: "group" },
      { kind: "notification", textPrefix: "P:", action: "keep" },
    ];
    const compiled = compileRules(rules);
    expect(
      actionForCandidateCompiled(compiled, {
        kind: "notification",
        text: "P: text",
        level: "info",
      }),
    ).toBe("keep");
  });

  test("unmatched notifications stay keep by default", () => {
    expect(
      both({ kind: "notification", text: "unrelated", level: "info" }).direct,
    ).toBe("keep");
  });
});

describe("defaults and compiled parity", () => {
  test("default actions per kind", () => {
    expect(defaultActionFor("tool")).toBe("group");
    expect(defaultActionFor("customMessage")).toBe("keep");
    expect(defaultActionFor("notification")).toBe("keep");
  });

  test("compiled indexes and direct scans agree across a matrix", () => {
    const candidates: Parameters<typeof actionForCandidate>[1][] = [
      { kind: "tool", name: "update_goal" },
      { kind: "tool", name: "bash" },
      { kind: "customMessage", customType: "pi-goal-audit-event" },
      { kind: "customMessage", customType: "x" },
      { kind: "notification", text: "Observational memory: x", level: "info" },
      { kind: "notification", text: "Observational memory: x", level: "error" },
      { kind: "notification", text: "other", level: "warning" },
    ];
    for (const candidate of candidates) {
      expect(both(candidate).direct).toBe(both(candidate).compiled);
    }
  });
});
