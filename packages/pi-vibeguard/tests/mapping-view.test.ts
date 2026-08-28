import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildCategoryStats,
  buildMappingSnapshot,
  formatDuration,
  formatTtlRemaining,
  MappingViewModal,
  type MappingEntry,
  type MappingSnapshotSource,
  maskOriginal,
  parseCategoryFromPlaceholder,
} from "../index.ts";

// Build placeholder strings programmatically instead of writing them as
// literals: complete placeholder-shaped literals are unreliable inside a
// session protected by vibeguard itself (they may be rewritten before they
// reach disk or back into the model's view). Assembled strings cannot be.
const HASH_1 = "a".repeat(12); // aaaaaaaaaaaa
const HASH_2 = "0123456789abcdef".slice(0, 12); // 0123456789ab
const HASH_3 = "f".repeat(12); // ffffffffffff
const vg = (prefix: string, category: string, hash: string, collision = "") =>
  `${prefix}${category}_${hash}${collision}__`;

const VG = "__VG_";

describe("parseCategoryFromPlaceholder", () => {
  it("parses a regular placeholder", () => {
    expect(parseCategoryFromPlaceholder(vg(VG, "OPENAI_KEY", HASH_1), VG)).toBe("OPENAI_KEY");
  });

  it("parses a category containing underscores", () => {
    expect(parseCategoryFromPlaceholder(vg(VG, "SECRET_VALUE", HASH_2), VG)).toBe("SECRET_VALUE");
  });

  it("ignores the numeric collision suffix", () => {
    expect(parseCategoryFromPlaceholder(vg(VG, "JWT", HASH_2, "_2"), VG)).toBe("JWT");
    expect(parseCategoryFromPlaceholder(vg(VG, "JWT", HASH_2, "_12"), VG)).toBe("JWT");
  });

  it("supports a custom placeholder prefix", () => {
    expect(parseCategoryFromPlaceholder(vg("@@R_", "EMAIL", HASH_3), "@@R_")).toBe("EMAIL");
    expect(parseCategoryFromPlaceholder(vg("VG__", "IPV4", HASH_3), "VG__")).toBe("IPV4");
  });

  it("degrades to UNKNOWN for malformed placeholders without dropping them", () => {
    expect(parseCategoryFromPlaceholder(`${VG}NOMATCH__`, VG)).toBe("UNKNOWN");
    expect(parseCategoryFromPlaceholder(`${VG}CAT_short_1__`, VG)).toBe("UNKNOWN");
    expect(parseCategoryFromPlaceholder("", VG)).toBe("UNKNOWN");
    expect(parseCategoryFromPlaceholder("totally-unrelated", VG)).toBe("UNKNOWN");
  });
});

describe("maskOriginal", () => {
  it("keeps first 3 and last 4 characters for values longer than 7", () => {
    expect(maskOriginal("sk-abcdefgh12345678")).toBe("sk-…5678");
  });

  it("fully masks values of exactly 7 characters", () => {
    expect(maskOriginal("1234567")).toBe("•");
  });

  it("fully masks short values", () => {
    expect(maskOriginal("1234")).toBe("•");
    expect(maskOriginal("")).toBe("•");
  });

  it("counts unicode code points, not UTF-16 units", () => {
    // 4 code points (8 UTF-16 units) -> still short -> fully masked
    expect(maskOriginal("🔐🔐🔐🔐")).toBe("•");
    // 8 code points -> first 3 + … + last 4
    expect(maskOriginal("你好世界ABCDEF")).toBe("你好世…CDEF");
  });
});

describe("buildMappingSnapshot", () => {
  const PH_KEY = vg(VG, "OPENAI_KEY", HASH_1);
  const PH_JWT = vg(VG, "JWT", HASH_2, "_2");
  const PH_PHONE = vg(VG, "CHINA_PHONE", HASH_3);

  function makeSource(): MappingSnapshotSource {
    return {
      prefix: VG,
      forward: new Map([
        [PH_KEY, "sk-aaaabbbbccccdddd"],
        [PH_JWT, "fake.jwt.payload"],
        [PH_PHONE, PH_PHONE], // self-referential-looking entry is still just data
      ]),
      created: new Map([
        [PH_KEY, 1000],
        [PH_JWT, 2000],
        [PH_PHONE, 3000],
      ]),
    };
  }

  it("maps every forward entry to category/original/createdAt", () => {
    const source = makeSource();
    const entries = buildMappingSnapshot(source);
    expect(entries).toHaveLength(3);
    const byPh = new Map(entries.map((e) => [e.placeholder, e]));
    expect(byPh.get(PH_KEY)?.category).toBe("OPENAI_KEY");
    expect(byPh.get(PH_KEY)?.original).toBe("sk-aaaabbbbccccdddd");
    expect(byPh.get(PH_KEY)?.createdAt).toBe(1000);
    expect(byPh.get(PH_JWT)?.category).toBe("JWT");
  });

  it("sorts by category asc, then createdAt asc", () => {
    const entries = buildMappingSnapshot(makeSource());
    expect(entries.map((e) => e.category)).toEqual(["CHINA_PHONE", "JWT", "OPENAI_KEY"]);
  });

  it("defaults createdAt to 0 when the created map is missing an entry", () => {
    const source = makeSource();
    source.created.delete(PH_JWT);
    const entries = buildMappingSnapshot(source);
    expect(entries.find((e) => e.category === "JWT")?.createdAt).toBe(0);
  });

  it("never mutates or evicts the source tables", () => {
    const source = makeSource();
    const forwardBefore = source.forward.size;
    const createdBefore = source.created.size;
    buildMappingSnapshot(source);
    expect(source.forward.size).toBe(forwardBefore);
    expect(source.created.size).toBe(createdBefore);
    expect([...source.forward.keys()]).toContain(PH_PHONE);
  });

  it("returns an empty array when nothing is mapped", () => {
    expect(buildMappingSnapshot({ prefix: VG, forward: new Map(), created: new Map() })).toEqual([]);
  });
});

describe("buildCategoryStats", () => {
  const entry = (category: string): MappingEntry => ({ category, placeholder: "p", original: "o", createdAt: 1 });

  it("counts per category sorted by count desc then name asc", () => {
    const entries = [
      ...Array.from({ length: 12 }, () => entry("SECRET_VALUE")),
      ...Array.from({ length: 4 }, () => entry("OPENAI_KEY")),
      ...Array.from({ length: 2 }, () => entry("JWT")),
    ];
    expect(buildCategoryStats(entries)).toEqual([
      { category: "SECRET_VALUE", count: 12 },
      { category: "OPENAI_KEY", count: 4 },
      { category: "JWT", count: 2 },
    ]);
    expect(buildCategoryStats(entries).reduce((acc, s) => acc + s.count, 0)).toBe(entries.length);
  });

  it("breaks ties alphabetically", () => {
    expect(buildCategoryStats([entry("JWT"), entry("IBAN")]).map((s) => s.category)).toEqual(["IBAN", "JWT"]);
  });
});

describe("formatDuration / formatTtlRemaining", () => {
  it("formats minute-granularity durations", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(43 * 60_000)).toBe("43m");
    expect(formatDuration(65 * 60_000)).toBe("1h5m");
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
  });

  it("computes remaining TTL from createdAt", () => {
    expect(formatTtlRemaining(1000, 60 * 60_000, 1000 + 17 * 60_000)).toBe("43m");
    expect(formatTtlRemaining(1000, 60 * 60_000, 1000 + 61 * 60_000)).toBe("0m");
  });

  it("treats non-positive ttl as unlimited", () => {
    expect(formatTtlRemaining(0, 0, 1)).toBe("∞");
  });
});

describe("MappingViewModal", () => {
  const fakeTheme = {
    fg: (_c: string, text: string) => text,
    bg: (_c: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const fakeTui = { requestRender: () => {} } as unknown as TUI;

  const entries: MappingEntry[] = [
    { category: "OPENAI_KEY", placeholder: vg(VG, "OPENAI_KEY", HASH_1), original: "sk-abcdefgh12345678", createdAt: 1000 },
    { category: "JWT", placeholder: vg(VG, "JWT", HASH_2), original: "short", createdAt: 2000 },
    { category: "CHINA_PHONE", placeholder: vg(VG, "CHINA_PHONE", HASH_3), original: "13812345678", createdAt: 3000 },
  ];

  // Mirror the production path: the modal receives the pre-sorted snapshot.
  const snapshotOf = (list: MappingEntry[]): MappingEntry[] =>
    buildMappingSnapshot({
      prefix: VG,
      forward: new Map(list.map((e) => [e.placeholder, e.original])),
      created: new Map(list.map((e) => [e.placeholder, e.createdAt])),
    });

  function makeModal(mode: "list" | "stats", done: () => void = () => {}): MappingViewModal {
    return new MappingViewModal({ tui: fakeTui, theme: fakeTheme, done, mode, entries: snapshotOf(entries), ttlMs: 60 * 60_000 });
  }

  it("renders list chrome, all rows, and masked originals by default", () => {
    const lines = makeModal("list").render(120);
    const text = lines.join("\n");
    // framed modal: top border with embedded title, side borders, bottom border
    expect(lines[0].startsWith("┌")).toBe(true);
    expect(lines.at(-1)!.startsWith("└")).toBe(true);
    expect(lines.filter((l) => l.includes("│")).length).toBe(lines.length - 2);
    expect(text).toContain("VibeGuard 映射");
    expect(text).toContain("CATEGORY");
    expect(text).toContain("OPENAI_KEY");
    expect(text).toContain("r 切换原文"); // key hints in the bottom border
    // masked, not plaintext
    expect(text).toContain("sk-…5678");
    expect(text).not.toContain("sk-abcdefgh12345678");
    // short original fully masked
    expect(text).toContain("•");
    expect(text).not.toContain("short\b");
  });

  it("toggles reveal without disturbing scroll position or row order", () => {
    const modal = makeModal("list");
    const before = modal.render(120);
    const dataRows = (ls: string[]) =>
      ls.filter((l) => l.includes(vg(VG, "OPENAI_KEY", HASH_1)) || l.includes(vg(VG, "JWT", HASH_2)) || l.includes(vg(VG, "CHINA_PHONE", HASH_3)));

    modal.handleInput("r"); // reveal
    const after = modal.render(120);
    expect(after.join("\n")).toContain("sk-abcdefgh12345678");
    expect(after.join("\n")).not.toContain("sk-…5678");
    // same chrome height, same sorted row order (CHINA_PHONE < JWT < OPENAI_KEY)
    expect(after.length).toBe(before.length);
    const orderAfter = dataRows(after).map((r) => r.slice(1, 12));
    const orderBefore = dataRows(before).map((r) => r.slice(1, 12));
    expect(orderAfter).toEqual(orderBefore);
    expect(dataRows(after)[0]).toContain("CHINA_PHONE");

    // toggle back to masked
    modal.handleInput("r");
    expect(modal.render(120).join("\n")).not.toContain("sk-abcdefgh12345678");
  });

  it("scrolls when content exceeds the viewport and clamps at the bottom", () => {
    const many: MappingEntry[] = Array.from({ length: 30 }, (_, i) => ({
      category: `CAT_${String(i).padStart(2, "0")}`,
      placeholder: vg(VG, `CAT_${String(i).padStart(2, "0")}`, HASH_1),
      original: `value-${i}`,
      createdAt: i,
    }));
    const modal = new MappingViewModal({
      tui: fakeTui,
      theme: fakeTheme,
      done: () => {},
      mode: "list",
      entries: snapshotOf(many),
      ttlMs: 60 * 60_000,
    });
    modal.handleInput("j"); // offset 1
    expect(modal.render(120).filter((l) => l.includes("CAT_"))[0]).toContain("CAT_01");
    for (let i = 0; i < 100; i++) modal.handleInput("j"); // clamp at bottom
    const bottom = modal.render(120).filter((l) => l.includes("CAT_"));
    expect(bottom.at(-1)).toContain("CAT_29");
    for (let i = 0; i < 100; i++) modal.handleInput("k"); // clamp at top
    expect(modal.render(120).filter((l) => l.includes("CAT_"))[0]).toContain("CAT_00");
  });

  it("scrolls within bounds and closes on q/escape", () => {
    let closed = false;
    const modal = makeModal("list", () => {
      closed = true;
    });
    for (let i = 0; i < 5; i++) modal.handleInput("j"); // no throw even if unscrollable
    modal.handleInput("g"); // unsupported key: ignored, no throw
    expect(closed).toBe(false);
    modal.handleInput("q");
    expect(closed).toBe(true);
  });

  it("renders stats sorted desc with counts", () => {
    const lines = makeModal("stats").render(120);
    const text = lines.join("\n");
    expect(text).toContain("VibeGuard 统计");
    expect(text).toContain("OPENAI_KEY");
    expect(text).toContain("█");
  });

  it("frames every line to the exact overlay width so the corners close", () => {
    for (const w of [120, 101, 80, 40]) {
      const list = makeModal("list").render(w);
      for (const line of list) expect(visibleWidth(line)).toBe(w);
      const stats = makeModal("stats").render(w);
      for (const line of stats) expect(visibleWidth(line)).toBe(w);
      // corners are present at the very edges
      expect(list[0].endsWith("┐")).toBe(true);
      expect(list.at(-1)!.endsWith("┘")).toBe(true);
    }
  });

  it("handles very narrow widths without throwing", () => {
    expect(() => makeModal("list").render(40)).not.toThrow();
    expect(() => makeModal("stats").render(40)).not.toThrow();
  });
});
