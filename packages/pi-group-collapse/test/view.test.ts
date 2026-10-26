/**
 * Summary line tests (change task 3.2).
 *
 * Pins: per-kind counts with zero kinds omitted, failure/warning markers
 * shown ahead of counts, pure-tool / pure-thinking / pure-message groups,
 * CJK-aware width fitting, narrow terminals dropping secondary counts and
 * ultimately keeping the original display, and no member content leaking
 * into the line.
 */

import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { summaryCacheKey, summaryLine } from "../src/view.ts";
import type { SegmentSummary } from "../src/model.ts";

const summary = (partial: Partial<SegmentSummary>): SegmentSummary => ({
  tools: 0,
  thinking: 0,
  messages: 0,
  failed: 0,
  warnings: 0,
  errors: 0,
  ...partial,
});

const WIDE = 80;

describe("summaryLine", () => {
  test("lists non-zero kind counts separated by middots", () => {
    const line = summaryLine(summary({ tools: 4, thinking: 3, messages: 2 }), {
      width: WIDE,
    });
    expect(line).toBe("▸ 4 次工具调用 · 3 段思考 · 2 条消息");
  });

  test("zero kinds are omitted", () => {
    expect(summaryLine(summary({ tools: 1 }), { width: WIDE })).toBe(
      "▸ 1 次工具调用",
    );
    expect(summaryLine(summary({ thinking: 2 }), { width: WIDE })).toBe(
      "▸ 2 段思考",
    );
    expect(summaryLine(summary({ messages: 2 }), { width: WIDE })).toBe(
      "▸ 2 条消息",
    );
  });

  test("an empty summary has no line (it is not a group)", () => {
    expect(summaryLine(summary({}), { width: WIDE })).toBeUndefined();
  });

  test("failures and errors outrank warnings in the marker", () => {
    expect(summaryLine(summary({ tools: 2, failed: 1 }), { width: WIDE })).toBe(
      "▸ ✗ 2 次工具调用",
    );
    expect(summaryLine(summary({ tools: 2, errors: 1 }), { width: WIDE })).toBe(
      "▸ ✗ 2 次工具调用",
    );
    expect(
      summaryLine(summary({ messages: 1, warnings: 1 }), { width: WIDE }),
    ).toBe("▸ ⚠ 1 条消息");
  });

  test("the marker survives narrow terminals that drop counts", () => {
    // "▸ ✗ 2 次工具调用" measures 16 cells; that is the minimal line the
    // marker can appear in, and 16 columns still show it.
    const narrow = summaryLine(summary({ tools: 2, failed: 1 }), { width: 16 });
    expect(narrow).toBe("▸ ✗ 2 次工具调用");
    // Below the minimal width the group keeps its original display.
    expect(
      summaryLine(summary({ tools: 2, failed: 1 }), { width: 15 }),
    ).toBeUndefined();
  });

  test("narrow terminals drop secondary counts before primary ones", () => {
    const counts = summary({ tools: 123, thinking: 45, messages: 6 });
    // Wide enough for everything.
    const wide = summaryLine(counts, { width: WIDE });
    expect(wide).toContain("123");
    expect(wide).toContain("45");
    expect(wide).toContain("6");

    // "▸ 123 次工具调用 · 45 段思考" measures 28 cells and drops the
    // messages count at that width.
    const tight = summaryLine(counts, { width: 28 });
    expect(tight).toBe("▸ 123 次工具调用 · 45 段思考");

    // "▸ 123 次工具调用" alone fits exactly 16.
    const minimal = summaryLine(counts, { width: 16 });
    expect(minimal).toBe("▸ 123 次工具调用");
  });

  test("a terminal too narrow for the minimal summary keeps the original display", () => {
    expect(
      summaryLine(summary({ tools: 12345 }), { width: 5 }),
    ).toBeUndefined();
  });

  test("CJK counts double their cell width", () => {
    const line = summaryLine(summary({ tools: 1 }), { width: WIDE })!;
    // "▸ 1 次工具调用": the han characters occupy two cells each.
    expect(visibleWidth(line)).toBeGreaterThan(line.length / 2);
    // The line must actually fit its claimed width.
    expect(visibleWidth(line)).toBeLessThanOrEqual(WIDE);
    // And cutting the width below the measured width forces degradation.
    const measured = visibleWidth(line);
    expect(
      summaryLine(summary({ tools: 1 }), { width: measured - 1 }),
    ).not.toBe(line);
  });

  test("the line carries counts only — no member content by construction", () => {
    const line = summaryLine(
      summary({ tools: 3, thinking: 2, messages: 1, failed: 1 }),
      { width: WIDE },
    )!;
    for (const forbidden of [
      "bash",
      "command",
      "rm -rf",
      "Observational memory",
      "alpha thinking",
      "final answer",
      "/tmp",
    ]) {
      expect(line).not.toContain(forbidden);
    }
  });

  test("the cache key changes exactly when the counts change", () => {
    const base = summary({ tools: 1 });
    expect(summaryCacheKey(base)).toBe(summaryCacheKey({ ...base }));
    expect(summaryCacheKey(base)).not.toBe(
      summaryCacheKey(summary({ tools: 2 })),
    );
    expect(summaryCacheKey(base)).not.toBe(
      summaryCacheKey(summary({ tools: 1, warnings: 1 })),
    );
  });
});
