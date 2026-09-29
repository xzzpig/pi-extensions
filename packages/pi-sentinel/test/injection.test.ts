import { describe, expect, test } from "vitest";
import type { AuditVerdict } from "../extensions/audit-loop.ts";
import type { SourcedRule } from "../extensions/config.ts";
import {
  FINDING_CUSTOM_TYPE,
  FindingInjector,
  findingKey,
  normalizeMessage,
  renderFindingContent,
  type FindingMessage,
} from "../extensions/injection.ts";

interface Sent {
  message: FindingMessage;
  deliverAs: string | undefined;
}

function rule(overrides: Partial<SourcedRule> = {}): SourcedRule {
  return {
    name: "bash-safety",
    trigger: { type: "tool_call", tools: ["bash"] },
    mode: "background",
    prompt: "check",
    source: "global",
    ...overrides,
  };
}

function harness(idle = true) {
  const sent: Sent[] = [];
  let currentIdle = idle;
  const deduped: string[] = [];
  const injector = new FindingInjector(
    {
      sendMessage: (message, options) => {
        sent.push({ message, deliverAs: options?.deliverAs });
      },
      isIdle: () => currentIdle,
    },
    { onDeduped: (r) => deduped.push(r.name) },
  );
  return {
    sent,
    deduped,
    injector,
    setIdle: (value: boolean) => {
      currentIdle = value;
    },
  };
}

const fail: AuditVerdict = { verdict: "fail", message: "rm -rf 太危险" };
const warn: AuditVerdict = { verdict: "warn", message: "路径可疑" };

describe("finding injection", () => {
  test("pass verdicts are silent", () => {
    const h = harness();
    expect(
      h.injector.inject(rule(), { verdict: "pass", message: "ok" }, 600_000),
    ).toBe("silent");
    expect(h.sent).toHaveLength(0);
  });

  test("fail findings are injected with the sentinel custom type and details", () => {
    const h = harness(true);
    expect(h.injector.inject(rule(), fail, 600_000)).toBe("injected");

    expect(h.sent).toHaveLength(1);
    const { message, deliverAs } = h.sent[0];
    expect(message.customType).toBe(FINDING_CUSTOM_TYPE);
    expect(message.content).toBe(
      '[pi-sentinel][fail] 规则 "bash-safety"：rm -rf 太危险',
    );
    expect(message.display).toBe(true);
    expect(message.details).toMatchObject({
      rule: "bash-safety",
      verdict: "fail",
      message: "rm -rf 太危险",
      kind: "audit",
    });
    expect(deliverAs).toBeUndefined();
  });

  test("the delivery path follows the main loop state", () => {
    const streaming = harness(false);
    streaming.injector.inject(rule(), warn, 600_000);
    expect(streaming.sent[0].deliverAs).toBe("steer");

    const idle = harness(true);
    idle.injector.inject(rule(), warn, 600_000);
    expect(idle.sent[0].deliverAs).toBeUndefined();
  });

  test("an equivalent finding inside the cooldown window is deduped", () => {
    let now = 0;
    const sent: Sent[] = [];
    const deduped: string[] = [];
    const injector = new FindingInjector(
      {
        sendMessage: (message, options) =>
          sent.push({ message, deliverAs: options?.deliverAs }),
        isIdle: () => true,
      },
      { now: () => now, onDeduped: (r) => deduped.push(r.name) },
    );

    expect(injector.inject(rule(), fail, 600_000)).toBe("injected");
    // Same content modulo case/whitespace is the same finding.
    expect(
      injector.inject(
        rule(),
        { verdict: "fail", message: "RM -RF   太危险" },
        600_000,
      ),
    ).toBe("deduped");
    expect(sent).toHaveLength(1);
    expect(deduped).toEqual(["bash-safety"]);

    // A different message is a different finding.
    expect(injector.inject(rule(), warn, 600_000)).toBe("injected");
    expect(sent).toHaveLength(2);

    now = 600_000;
    expect(injector.inject(rule(), fail, 600_000)).toBe("injected");
    expect(sent).toHaveLength(3);
  });

  test("dedupe can be disabled per rule and cleared per session", () => {
    const h = harness();
    expect(h.injector.inject(rule({ dedupe: false }), fail, 600_000)).toBe(
      "injected",
    );
    expect(h.injector.inject(rule({ dedupe: false }), fail, 600_000)).toBe(
      "injected",
    );
    expect(h.sent).toHaveLength(2);

    expect(h.injector.inject(rule(), fail, 600_000)).toBe("injected");
    expect(h.injector.size()).toBe(1);
    h.injector.clear();
    expect(h.injector.size()).toBe(0);
    expect(h.injector.inject(rule(), fail, 600_000)).toBe("injected");
  });

  test("normalize/key/render helpers are stable", () => {
    expect(normalizeMessage("  A\n\n b  ")).toBe("a b");
    expect(findingKey("r", "fail", "A  b")).toBe(
      findingKey("r", "fail", "a b"),
    );
    expect(renderFindingContent("r", warn)).toBe(
      '[pi-sentinel][warn] 规则 "r"：路径可疑',
    );
  });
});
