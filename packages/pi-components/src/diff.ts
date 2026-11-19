import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Input identities are retained so callers can attach domain-specific styling. */
export interface DiffLineLike {
  kind: "line";
  lineKind: "add" | "remove" | "context";
  hunkIndex: number;
}

export interface DiffMetaLike {
  kind: "meta" | "hunk" | "file";
  hunkIndex: number;
}

export interface DiffPair<L, M> {
  left?: L;
  right?: L;
  meta?: M;
  hunkIndex: number | null;
}

export interface DiffRenderedRow {
  text: string;
  hunkIndex: number | null;
}

/** Pair consecutive removal/addition blocks without changing either side's order. */
export function pairDiffEntries<L extends DiffLineLike, M extends DiffMetaLike>(
  entries: readonly (L | M)[],
): DiffPair<L, M>[] {
  const rows: DiffPair<L, M>[] = [];
  for (let index = 0; index < entries.length; ) {
    const entry = entries[index];
    if (!entry) break;
    if (entry.kind !== "line") {
      rows.push({ meta: entry as M, hunkIndex: entry.hunkIndex || null });
      index++;
      continue;
    }
    if (entry.lineKind === "remove") {
      const removed: L[] = [];
      const added: L[] = [];
      for (; index < entries.length; ) {
        const item = entries[index];
        if (!item || item.kind !== "line" || item.lineKind !== "remove") break;
        removed.push(item as L);
        index++;
      }
      for (; index < entries.length; ) {
        const item = entries[index];
        if (!item || item.kind !== "line" || item.lineKind !== "add") break;
        added.push(item as L);
        index++;
      }
      for (let i = 0; i < Math.max(removed.length, added.length); i++) {
        const left = removed[i];
        const right = added[i];
        rows.push({
          left,
          right,
          hunkIndex: left?.hunkIndex ?? right?.hunkIndex ?? null,
        });
      }
      continue;
    }
    const line = entry as L;
    rows.push(
      entry.lineKind === "add"
        ? { right: line, hunkIndex: entry.hunkIndex || null }
        : { left: line, right: line, hunkIndex: entry.hunkIndex || null },
    );
    index++;
  }
  return rows;
}

export interface DiffColumns {
  leftWidth: number;
  rightWidth: number;
}

/** The separator may already be styled; visibleWidth ignores its ANSI SGR. */
export function measureDiffColumns(
  width: number,
  separator: string,
  minimumColumnWidth = 24,
): DiffColumns | undefined {
  const available = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const minimum = Math.max(1, Math.floor(minimumColumnWidth));
  const separatorWidth = visibleWidth(separator);
  if (available < minimum * 2 + separatorWidth) return undefined;
  const leftWidth = Math.floor((available - separatorWidth) / 2);
  return { leftWidth, rightWidth: available - separatorWidth - leftWidth };
}

export interface DiffPairLayout<L, M> extends DiffColumns {
  separator: string;
  /** Callbacks return already bounded and styled visual cells. */
  renderCell(
    line: L | undefined,
    side: "left" | "right",
    width: number,
  ): string[];
  renderBlank(side: "left" | "right", width: number): string;
  renderMeta(meta: M): DiffRenderedRow[];
}

/** Shared split-row compositor; caller owns gutters, theme, and metadata styling. */
export function renderPairedDiffRows<L, M>(
  rows: readonly DiffPair<L, M>[],
  layout: DiffPairLayout<L, M>,
): DiffRenderedRow[] {
  const output: DiffRenderedRow[] = [];
  for (const row of rows) {
    if (row.meta !== undefined) {
      for (const item of layout.renderMeta(row.meta)) output.push(item);
      continue;
    }
    const left = layout.renderCell(row.left, "left", layout.leftWidth);
    const right = layout.renderCell(row.right, "right", layout.rightWidth);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const leftCell =
        left[index] ?? layout.renderBlank("left", layout.leftWidth);
      const rightCell =
        right[index] ?? layout.renderBlank("right", layout.rightWidth);
      output.push({
        text: `${leftCell}${layout.separator}${rightCell}`,
        hunkIndex: row.hunkIndex,
      });
    }
  }
  return output;
}

export interface DiffTextLine extends DiffLineLike {
  content: string;
}
export interface DiffTextMeta extends DiffMetaLike {
  content: string;
}
export type DiffTextEntry = DiffTextLine | DiffTextMeta;
export interface DiffTextTheme {
  fg(color: string, text: string): string;
}
export interface DiffTextOptions {
  width: number;
  mode?: "auto" | "split" | "unified";
  splitMinWidth?: number;
  theme?: DiffTextTheme;
  oldLabel?: string;
  newLabel?: string;
}

/** Treat data as text, not terminal instructions. Styles supplied by a theme are applied later. */
export function sanitizeDiffText(value: string): string {
  return value
    .replace(
      /\u001b[\]P_^X](?:[^\u001b\u0007]|\u001b(?!\\))*(?:\u0007|\u001b\\|$)/g,
      "",
    )
    .replace(
      /[\u0090\u009d\u009e\u009f][^\u009c\u0007]*(?:\u009c|\u0007|$)/g,
      "",
    )
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function fitCell(text: string, width: number): string {
  const fitted =
    visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A physical row's original spaces must not be mistaken for cell padding. */
function markBoundarySpaces(value: string): string {
  return value.replace(/ +$/g, (spaces) => "␠".repeat(spaces.length));
}

/** Detect each run once; repeated rescanning of a long "<<<<..." suffix is quadratic. */
function dangerousPrefixPositions(line: string, width: number): Set<number> {
  const result = new Set<number>();
  let run = -1;
  for (const part of graphemes.segment(line)) {
    if (part.segment === "<") {
      if (run < 0) run = part.index;
      continue;
    }
    if (run >= 0) {
      const next = part.segment;
      const dangerous =
        line.startsWith("U+", part.index) ||
        next === "␠" ||
        (/\p{White_Space}/u.test(next) && next !== " ") ||
        visibleWidth(next) > width;
      if (dangerous) for (let i = run; i < part.index; i++) result.add(i);
      run = -1;
    }
  }
  return result;
}

/** Wrap plain text with source offsets; oversized graphemes use explicit,
 * reversible Unicode notation rather than an indistinguishable ellipsis. */
function wrapDataWithOffsets(
  text: string,
  width: number,
): { text: string; offset: number; fragment?: number }[] {
  if (width <= 0) return [{ text: "", offset: 0 }];
  const result: { text: string; offset: number; fragment?: number }[] = [];
  let base = 0;
  for (const line of sanitizeDiffText(text).split("\n")) {
    const ascii = /^[\x20-\x7e]*$/.test(line);
    // ASCII can only require escaping when a literal U+ marker exists; this
    // check avoids a grapheme pass on the common long-text fast path.
    const dangerousPrefixes =
      ascii && !line.includes("U+")
        ? new Set<number>()
        : dangerousPrefixPositions(line, width);
    if (ascii && dangerousPrefixes.size === 0) {
      if (!line) result.push({ text: "", offset: base });
      else
        for (let i = 0; i < line.length; i += width)
          result.push({
            text: markBoundarySpaces(line.slice(i, i + width)),
            offset: base + i,
          });
      base += line.length + 1;
      continue;
    }
    let chunk = "",
      columns = 0,
      offset = 0;
    const flush = () => {
      if (chunk)
        result.push({ text: markBoundarySpaces(chunk), offset: base + offset });
      chunk = "";
      columns = 0;
    };
    for (const part of graphemes.segment(line)) {
      const size = visibleWidth(part.segment);
      if (columns + size > width && chunk) flush();
      const literalPrefix =
        part.segment === "<" && dangerousPrefixes.has(part.index);
      const literalSpaceMarker = part.segment === "␠";
      const nonAsciiSpace =
        part.segment !== " " && /\p{White_Space}/u.test(part.segment);
      if (
        size > width ||
        literalPrefix ||
        literalSpaceMarker ||
        nonAsciiSpace
      ) {
        if (chunk) flush();
        const escaped = literalPrefix
          ? "<<"
          : literalSpaceMarker
            ? "<U+2420>"
            : "<" +
              Array.from(
                part.segment,
                (c) =>
                  `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
              ).join(" ") +
              ">";
        for (let i = 0; i < escaped.length; i += width)
          result.push({
            text: escaped.slice(i, i + width),
            offset: base + part.index,
            fragment: i,
          });
      } else {
        if (!chunk) offset = part.index;
        chunk += part.segment;
        columns += size;
      }
    }
    flush();
    if (!line) result.push({ text: "", offset: base });
    base += line.length + 1;
  }
  return result;
}
function wrapData(text: string, width: number): string[] {
  return wrapDataWithOffsets(text, width).map((row) => row.text);
}
function wrapOffsets(
  text: string,
  width: number,
): { offset: number; fragment?: number }[] {
  return wrapDataWithOffsets(text, width).map(({ offset, fragment }) => ({
    offset,
    fragment,
  }));
}

function separateMarker(line: DiffTextLine, width: number): boolean {
  if (width < 4) return true;
  if (/^[\x20-\x7e]*$/.test(line.content)) return false;
  for (const { segment } of graphemes.segment(sanitizeDiffText(line.content))) {
    const columns = visibleWidth(segment);
    if (columns > width - 2 && columns <= width) return true;
  }
  return false;
}

function cellOffsets(
  line: DiffTextLine,
  width: number,
): { offset: number; fragment?: number }[] {
  const separate = separateMarker(line, width);
  const marker =
    separate && line.lineKind !== "context"
      ? [{ offset: 0, fragment: -1 }]
      : [];
  return [
    ...marker,
    ...wrapOffsets(line.content, separate ? width : width - 2),
  ];
}

function color(
  theme: DiffTextTheme | undefined,
  name: string,
  text: string,
): string {
  return theme ? theme.fg(name, text) : text;
}

function renderTextCell(
  line: DiffTextLine | undefined,
  width: number,
  theme?: DiffTextTheme,
): string[] {
  if (!line) return [" ".repeat(width)];
  let sign = "  ";
  let style = "muted";
  if (line.lineKind === "remove") {
    sign = "- ";
    style = "error";
  } else if (line.lineKind === "add") {
    sign = "+ ";
    style = "success";
  }
  // Below four columns, put the marker on its own row so a two-cell
  // grapheme can still be displayed rather than eaten by the prefix.
  if (separateMarker(line, width)) {
    const marker = sign.trim()
      ? [fitCell(color(theme, style, sign.trim()), width)]
      : [];
    return [
      ...marker,
      ...wrapData(line.content, width).map((chunk) =>
        fitCell(color(theme, style, chunk), width),
      ),
    ];
  }
  const bodyWidth = width - 2;
  return wrapData(line.content, bodyWidth).map((chunk, index) =>
    fitCell(color(theme, style, (index === 0 ? sign : "  ") + chunk), width),
  );
}

export interface AnchoredDiffRow {
  text: string;
  /** Source entry indexes represented by this row, including both sides of a pair. */
  entryIndexes: readonly number[];
  /** Wrapped visual row within the source entry or pair. */
  part: number;
  /** Start positions in sanitized source text for each visible entry. */
  sourcePositions: readonly {
    entryIndex: number;
    offset: number;
    fragment?: number;
  }[];
}

/** Render text plus source anchors for a viewport that survives resize/reflow. */
export function renderAnchoredDiffEntries(
  entries: readonly DiffTextEntry[],
  options: DiffTextOptions,
): AnchoredDiffRow[] {
  const width = safeWidth(options.width);
  if (width === 0) return [];
  const separator = color(options.theme, "dim", " │ ");
  const columns = measureDiffColumns(width, separator);
  const split =
    options.mode === "split"
      ? columns !== undefined
      : options.mode !== "unified" &&
        width >= (options.splitMinWidth ?? 120) &&
        columns !== undefined;
  if (!split || !columns) {
    return entries.flatMap((entry, entryIndex) => {
      const lines =
        entry.kind === "line"
          ? renderTextCell(entry, width, options.theme)
          : wrapData(entry.content, width).map((line) =>
              fitCell(color(options.theme, "dim", line), width),
            );
      const offsets =
        entry.kind === "line"
          ? cellOffsets(entry, width)
          : wrapOffsets(entry.content, width);
      return lines.map((text, part) => ({
        text,
        entryIndexes: [entryIndex],
        part,
        sourcePositions: [{ entryIndex, ...(offsets[part] ?? { offset: 0 }) }],
      }));
    });
  }
  type IndexedLine = DiffTextLine & { entryIndex: number };
  type IndexedMeta = DiffTextMeta & { entryIndex: number };
  const indexed = entries.map((entry, entryIndex) => ({
    ...entry,
    entryIndex,
  }));
  const rows = pairDiffEntries<IndexedLine, IndexedMeta>(indexed);
  const header =
    fitCell(
      color(
        options.theme,
        "muted",
        sanitizeDiffText(options.oldLabel ?? "旧值").replace(/\n/g, " "),
      ),
      columns.leftWidth,
    ) +
    separator +
    fitCell(
      color(
        options.theme,
        "muted",
        sanitizeDiffText(options.newLabel ?? "新值").replace(/\n/g, " "),
      ),
      columns.rightWidth,
    );
  const output: AnchoredDiffRow[] = [
    { text: header, entryIndexes: [], part: 0, sourcePositions: [] },
  ];
  for (const row of rows) {
    const left = row.left
      ? renderTextCell(row.left, columns.leftWidth, options.theme)
      : [];
    const right = row.right
      ? renderTextCell(row.right, columns.rightWidth, options.theme)
      : [];
    const leftOffsets = row.left
      ? cellOffsets(row.left, columns.leftWidth)
      : [];
    const rightOffsets = row.right
      ? cellOffsets(row.right, columns.rightWidth)
      : [];
    const metaOffsets = row.meta ? wrapOffsets(row.meta.content, width) : [];
    const rendered = renderPairedDiffRows([row], {
      ...columns,
      separator,
      renderCell: (_line, side) => (side === "left" ? left : right),
      renderBlank: (_side, cellWidth) => " ".repeat(cellWidth),
      renderMeta: (meta) =>
        wrapData(meta.content, width).map((text) => ({
          text: fitCell(color(options.theme, "dim", text), width),
          hunkIndex: meta.hunkIndex || null,
        })),
    });
    for (const [part, item] of rendered.entries()) {
      // A blank continuation does not represent that side: anchoring to it
      // would jump to an unrelated short value after split/unified reflow.
      const entryIndexes = [
        row.meta?.entryIndex,
        part < left.length ? row.left?.entryIndex : undefined,
        part < right.length ? row.right?.entryIndex : undefined,
      ]
        .filter((index): index is number => index !== undefined)
        .filter(
          (index, position, indexes) => indexes.indexOf(index) === position,
        );
      const sourcePositions = entryIndexes.map((entryIndex) => ({
        entryIndex,
        ...(entryIndex === row.meta?.entryIndex
          ? (metaOffsets[part] ?? { offset: 0 })
          : entryIndex === row.left?.entryIndex
            ? (leftOffsets[part] ?? { offset: 0 })
            : (rightOffsets[part] ?? { offset: 0 })),
      }));
      output.push({ text: item.text, entryIndexes, part, sourcePositions });
    }
  }
  return output;
}

/** Render sanitized semantic text entries in a standalone split/unified presentation. */
export function renderDiffEntries(
  entries: readonly DiffTextEntry[],
  options: DiffTextOptions,
): string[] {
  return renderAnchoredDiffEntries(entries, options).map((row) => row.text);
}
