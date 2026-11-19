import { describe, expect, it } from "vitest";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import {
  measureDiffColumns,
  pairDiffEntries,
  renderAnchoredDiffEntries,
  renderDiffEntries,
  renderPairedDiffRows,
  sanitizeDiffText,
  type DiffTextEntry,
  type DiffTextLine,
  type DiffTextMeta,
} from "../src/diff.ts";

const line = (
  lineKind: DiffTextLine["lineKind"],
  content: string,
  hunkIndex = 1,
): DiffTextLine => ({
  kind: "line",
  lineKind,
  content,
  hunkIndex,
});
const meta = (content: string, hunkIndex = 1): DiffTextMeta => ({
  kind: "meta",
  content,
  hunkIndex,
});
const plain = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("共享差异排版", () => {
  it("长前缀按近线性时间扫描并保持所有文本", () => {
    const elapsed = (size: number, suffix: string) => {
      const text = "<".repeat(size) + suffix;
      const start = performance.now();
      const rows = renderDiffEntries([meta(text)], {
        width: 119,
        mode: "unified",
      });
      const ms = performance.now() - start;
      expect(rows.length).toBeGreaterThan(1);
      return ms;
    };
    elapsed(1000, "");
    for (const suffix of ["", "U+"]) {
      const small = Math.min(
        ...Array.from({ length: 3 }, () => elapsed(4000, suffix)),
      );
      const large = Math.min(
        ...Array.from({ length: 3 }, () => elapsed(32000, suffix)),
      );
      expect(large).toBeLessThan(small * 25 + 120);
    }
  });
  it("不可换行空格在通用文本差异中不会消失或混入补白", () => {
    for (const width of [1, 119, 120]) {
      const rows = renderAnchoredDiffEntries(
        [line("remove", "A"), line("add", "A\u00a0")],
        { width, mode: "unified" },
      );
      const text = rows
        .filter((row) => row.entryIndexes.includes(1))
        .map((row) => row.text.trim())
        .join("");
      expect(text.replaceAll(" ", "")).toContain("<U+00A0>");
    }
  });
  it("多个源空格与字面空格标记始终可区分", () => {
    for (const width of [1, 2, 119, 120]) {
      const rows = renderAnchoredDiffEntries(
        [line("remove", "  "), line("add", "␠")],
        { width, mode: "unified" },
      );
      const get = (i: number) =>
        rows
          .filter((row) => row.entryIndexes.includes(i))
          .map((row) => row.text.trim())
          .join("");
      expect(get(0)).toContain("␠␠");
      expect(get(1)).toContain("<U+2420>");
      expect(get(0)).not.toEqual(get(1));
    }
  });
  it("字面前缀与相邻的降级字素编码不会伪装成相同内容", () => {
    const rows = renderAnchoredDiffEntries(
      [line("remove", "<甲"), line("add", "<U+7532>")],
      { width: 1, mode: "unified" },
    );
    const get = (i: number) =>
      rows
        .filter((row) => row.entryIndexes.includes(i))
        .map((row) => row.text)
        .join("")
        .slice(1);
    expect(get(0)).toBe("<<<U+7532>");
    expect(get(1)).toBe("<<U+7532>");
  });
  it("Unicode 降级标记与同形合法字面文本可逆区分", () => {
    const rows = renderAnchoredDiffEntries(
      [line("remove", "甲"), line("add", "<U+7532>")],
      { width: 1, mode: "unified" },
    );
    const get = (i: number) =>
      rows
        .filter((row) => row.entryIndexes.includes(i))
        .map((row) => row.text)
        .join("");
    expect(get(0)).toBe("-<U+7532>");
    expect(get(1)).toBe("+<<U+7532>");
    const parts = rows.filter((row) => row.entryIndexes.includes(0)).slice(1);
    expect(parts.map((row) => row.sourcePositions[0]?.fragment)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });
  it("无法容纳的字素用可辨认可还原的 Unicode 码点逐列显示并保留来源锚点", () => {
    for (const [width, oldText, newText] of [
      [1, "甲", "乙"],
      [3, "स्त्र्य", "क्ष्ण्य"],
    ] as const) {
      const rows = renderAnchoredDiffEntries(
        [line("remove", oldText), line("add", newText)],
        { width, mode: "unified" },
      );
      const extract = (entryIndex: number) =>
        rows
          .filter((row) => row.entryIndexes.includes(entryIndex))
          .map((row) => row.text.trim())
          .join("");
      const expected = (value: string) =>
        "<" +
        Array.from(
          value,
          (c) =>
            `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
        )
          .join(" ")
          .replaceAll(" ", "") +
        ">";
      expect(rows.every((row) => visibleWidth(row.text) <= width)).toBe(true);
      expect(extract(0).replaceAll(" ", "")).toContain(expected(oldText));
      expect(extract(1).replaceAll(" ", "")).toContain(expected(newText));
      expect(extract(0)).not.toEqual(extract(1));
      expect(
        rows
          .filter((row) => row.entryIndexes.includes(1))
          .every((row) => row.sourcePositions[0]?.offset === 0),
      ).toBe(true);
    }
  });
  it("按实际字素宽度保留可容纳的内容与源锚点", () => {
    for (const width of [3, 4, 5]) {
      const rows = renderAnchoredDiffEntries([line("add", "Aस्त्रB")], {
        width,
        mode: "unified",
      });
      expect(rows.some((row) => row.text.includes("स्त्र"))).toBe(true);
      expect(rows.every((row) => visibleWidth(row.text) <= width)).toBe(true);
      const offset = rows.find((row) => row.text.includes("स्त्र"))
        ?.sourcePositions[0]?.offset;
      expect(offset).toBe(width === 4 ? 0 : 1);
    }
  });
  it("无硬换行的长逻辑行按源位置而非视觉续行序号锚定", () => {
    const value = Array.from(
      { length: 600 },
      (_, i) => `NEW${String(i).padStart(3, "0")}中文`,
    ).join(" ");
    const entries = [line("remove", "OLD-SHORT"), line("add", value)];
    const split = renderAnchoredDiffEntries(entries, { width: 127 });
    const target = split.find((row) => row.text.includes("NEW249"));
    expect(target).toBeDefined();
    const offset = target!.sourcePositions.find(
      (pos) => pos.entryIndex === 1,
    )!.offset;
    const unified = renderAnchoredDiffEntries(entries, { width: 119 }).filter(
      (row) => row.entryIndexes.includes(1),
    );
    const candidates = unified.filter(
      (row) => row.sourcePositions[0]!.offset <= offset,
    );
    const candidate = candidates.at(-1)!;
    const next = unified[unified.indexOf(candidate) + 1];
    expect(candidate.sourcePositions[0]!.offset).toBeLessThanOrEqual(offset);
    expect(next?.sourcePositions[0]!.offset ?? Infinity).toBeGreaterThan(
      offset,
    );
    expect(candidate.text).toContain(value.slice(offset, offset + 8));
  });
  it("单侧续行仅锚定实际存在的来源，避免重排跳到短旧值", () => {
    const entries = [
      line("remove", "OLD-SHORT"),
      line(
        "add",
        Array.from(
          { length: 90 },
          (_, i) => `NEW${String(i).padStart(3, "0")}`,
        ).join("\n"),
      ),
    ];
    const split = renderAnchoredDiffEntries(entries, { width: 120 });
    const row = split.find((item) => item.text.includes("NEW052"));
    expect(row?.entryIndexes).toEqual([1]);
    const unified = renderAnchoredDiffEntries(entries, { width: 119 });
    expect(
      unified.filter((item) => item.entryIndexes.includes(1))[row!.part]?.text,
    ).toContain("NEW052");
  });
  it("超大跨列说明在上下与并排两种模式均不发生参数溢出", () => {
    const entries = [
      meta(Array.from({ length: 130_000 }, (_, i) => `note-${i}`).join("\n")),
    ];
    const unified = renderDiffEntries(entries, { width: 119 });
    const split = renderDiffEntries(entries, { width: 120 });
    expect(unified).toHaveLength(130_000);
    expect(split).toHaveLength(130_001);
    expect(split.at(-1)).toContain("note-129999");
  }, 60_000);
  it("不允许标题中的换行注入额外物理行", () => {
    for (const width of [120, 160]) {
      const rows = renderDiffEntries(
        [line("remove", "旧"), line("add", "新")],
        {
          width,
          oldLabel: "old\n[Confirm selection]",
          newLabel: "new\r\nnext",
        },
      );
      expect(rows.every((row) => !/[\r\n]/.test(row))).toBe(true);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    }
  });
  it("在上下与并排布局中保留左右来源和续行锚点", () => {
    const entries: DiffTextEntry[] = [
      meta("目标"),
      line("remove", "旧".repeat(90)),
      line("add", "新".repeat(90)),
    ];
    const stacked = renderAnchoredDiffEntries(entries, { width: 119 });
    const split = renderAnchoredDiffEntries(entries, { width: 120 });
    expect(
      stacked.some(
        (row) => row.entryIndexes.includes(1) && !row.entryIndexes.includes(2),
      ),
    ).toBe(true);
    const paired = split.filter(
      (row) => row.entryIndexes.includes(1) && row.entryIndexes.includes(2),
    );
    expect(paired.length).toBeGreaterThan(1);
    expect(paired.map((row) => row.part)).toEqual(
      paired.map((_row, index) => index),
    );
    expect(split.map((row) => row.text)).toEqual(
      renderDiffEntries(entries, { width: 120 }),
    );
  });

  it("只读取冻结的输入，不更改调用方的差异或视图状态", () => {
    const entries = Object.freeze([
      Object.freeze(line("remove", "旧")),
      Object.freeze(line("add", "新")),
    ]);
    const before = JSON.stringify(entries);
    const options = Object.freeze({ width: 120, mode: "auto" as const });
    const first = renderDiffEntries(entries, options);
    expect(renderDiffEntries(entries, options)).toEqual(first);
    expect(JSON.stringify(entries)).toBe(before);
  });

  it("成对连续删除与新增，保留各侧顺序、元信息和上下文引用", () => {
    const context = line("context", "保留");
    const entries: DiffTextEntry[] = [
      meta("分组"),
      context,
      line("remove", "旧一"),
      line("remove", "旧二"),
      line("add", "新一"),
      line("add", "新二"),
      line("add", "新三"),
      meta("省略"),
    ];
    const rows = pairDiffEntries<DiffTextLine, DiffTextMeta>(entries);
    expect(rows).toHaveLength(6);
    expect(rows[0]!.meta).toBe(entries[0]);
    expect(rows[1]!.left).toBe(context);
    expect(rows[1]!.right).toBe(context);
    expect(rows[2]!.left?.content).toBe("旧一");
    expect(rows[2]!.right?.content).toBe("新一");
    expect(rows[3]!.left?.content).toBe("旧二");
    expect(rows[3]!.right?.content).toBe("新二");
    expect(rows[4]!.left).toBeUndefined();
    expect(rows[4]!.right?.content).toBe("新三");
    expect(rows[5]!.meta).toBe(entries[7]);
  });

  it("共享成对行合成保留自定义样式和元信息，并填充较短的另一侧", () => {
    const rows = pairDiffEntries<DiffTextLine, DiffTextMeta>([
      line("remove", "old"),
      line("add", "new"),
      meta("说明"),
    ]);
    const result = renderPairedDiffRows(rows, {
      leftWidth: 4,
      rightWidth: 4,
      separator: " | ",
      renderCell: (entry, side) =>
        entry ? (side === "left" ? ["A   ", "B   "] : ["C   "]) : ["    "],
      renderBlank: () => "    ",
      renderMeta: (entry) => [
        { text: entry.content, hunkIndex: entry.hunkIndex },
      ],
    });
    expect(result).toEqual([
      { text: "A    | C   ", hunkIndex: 1 },
      { text: "B    |     ", hunkIndex: 1 },
      { text: "说明", hunkIndex: 1 },
    ]);
  });

  it("自动布局在实际宽度 120 切换，显式 split 仍受安全最小宽度约束", () => {
    const entries: DiffTextEntry[] = [line("remove", "旧"), line("add", "新")];
    expect(
      renderDiffEntries(entries, { width: 119, mode: "auto" }).some((s) =>
        s.includes(" │ "),
      ),
    ).toBe(false);
    expect(
      renderDiffEntries(entries, { width: 120, mode: "auto" })[0],
    ).toContain(" │ ");
    expect(
      renderDiffEntries(entries, { width: 50, mode: "split" }).some((s) =>
        s.includes(" │ "),
      ),
    ).toBe(false);
    expect(
      renderDiffEntries(entries, { width: 51, mode: "split" })[0],
    ).toContain(" │ ");
    expect(measureDiffColumns(51, " │ ")).toEqual({
      leftWidth: 24,
      rightWidth: 24,
    });
    expect(measureDiffColumns(50, " │ ")).toBeUndefined();
  });

  it("变化、元信息和空行在上下及并排中保留且不只依赖颜色", () => {
    const entries: DiffTextEntry[] = [
      meta("目标:"),
      line("context", "标题"),
      line("context", ""),
      line("remove", "旧值"),
      line("add", "新值"),
      meta("… 保留说明"),
    ];
    const unified = renderDiffEntries(entries, {
      width: 80,
      mode: "unified",
    }).join("\n");
    const split = renderDiffEntries(entries, {
      width: 120,
      mode: "split",
    }).join("\n");
    for (const output of [unified, split]) {
      expect(output).toContain("目标:");
      expect(output).toContain("标题");
      expect(output).toContain("- 旧值");
      expect(output).toContain("+ 新值");
      expect(output).toContain("… 保留说明");
    }
    expect(split).toContain("旧值");
    expect(split).toContain("新值");
  });

  it("长中文、emoji 与组合字符逐列换行并保持完整", () => {
    const old = "旧😀e\u0301".repeat(35);
    const fresh = "新😺a\u0301".repeat(21);
    const width = 120;
    const result = renderDiffEntries(
      [line("remove", old), line("add", fresh)],
      { width, mode: "split" },
    );
    const columns = measureDiffColumns(width, " │ ")!;
    const data = result.slice(1);
    const read = (side: "left" | "right") =>
      data
        .map((s) => {
          const start = side === "left" ? 0 : columns.leftWidth + 3;
          const value = sliceByColumn(
            s,
            start,
            side === "left" ? columns.leftWidth : columns.rightWidth,
          );
          return value.slice(2).trimEnd();
        })
        .join("");
    expect(read("left")).toBe(old);
    expect(read("right")).toBe(fresh);
    for (const size of [8, 17, 50, 51, 119, 120, 121, 200]) {
      for (const s of renderDiffEntries(
        [line("remove", old), line("add", fresh)],
        { width: size, mode: "auto" },
      )) {
        expect(visibleWidth(s)).toBeLessThanOrEqual(size);
      }
    }
  });

  it("大输入完整输出而非仅显示首屏", () => {
    const large = "长".repeat(20000) + "终点";
    const rows = renderDiffEntries([line("add", large)], {
      width: 120,
      mode: "split",
    });
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.at(-1)).toContain("终点");
    expect(rows.every((row) => visibleWidth(row) <= 120)).toBe(true);
  });

  it("换行保留前导、内部及尾随空格，极窄屏不让前缀吞掉双宽字符", () => {
    const rows = renderDiffEntries([line("remove", " a  b ")], {
      width: 6,
      mode: "unified",
    });
    expect(rows).toEqual(["-  a␠␠", "  b␠  "]);
    expect(
      renderDiffEntries([line("add", "中 文")], { width: 2, mode: "unified" }),
    ).toEqual(["+ ", "中", "␠ ", "文"]);
    expect(
      renderDiffEntries([line("remove", "中")], { width: 1, mode: "unified" }),
    ).toEqual(["-", "<", "U", "+", "4", "E", "2", "D", ">"]);
  });

  it("不执行输入中的 OSC、CSI、APC 或其他控制字符，主题样式可独立重置", () => {
    const bad =
      "甲\u001b]52;c;SGVsbG8=\u0007乙\u001b[2J丙\u001b_Gabcd\u001b\\丁\u0001终";
    expect(sanitizeDiffText(bad)).toBe("甲乙丙丁终");
    expect(sanitizeDiffText("A\u001b]52;c;unfinished")).toBe("A");
    const theme = {
      fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[0m`,
    };
    for (const width of [12, 80, 120]) {
      const rows = renderDiffEntries(
        [line("remove", bad), line("add", "正常")],
        { width, theme },
      );
      expect(plain(rows.join(""))).toContain("甲乙丙丁终");
      expect(rows.join("")).not.toMatch(/\u001b\](?:52|8);|\u001b\[2J|\u001b_/);
      rows.forEach((s) => expect(visibleWidth(s)).toBeLessThanOrEqual(width));
    }
  });
});
