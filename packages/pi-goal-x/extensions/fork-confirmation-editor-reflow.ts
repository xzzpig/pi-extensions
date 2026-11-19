import {
  CURSOR_MARKER,
  renderFakeCursor,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Reflow a native editor's wider virtual rows without splitting a fitting
 * grapheme. Retain reverse coordinates for the native editor's mouse handler. */
export function reflowEditorRows(
  rows: string[],
  width: number,
): { lines: string[]; mapping: { row: number; col: number }[] } {
  const lines: string[] = [];
  const mapping: { row: number; col: number }[] = [];
  for (let row = 0; row < rows.length; row++) {
    const source = rows[row]!;
    const markerAt = source.indexOf(CURSOR_MARKER);
    const markerCol = markerAt < 0 ? -1 : visibleWidth(source.slice(0, markerAt));
    const clean = source.replace(CURSOR_MARKER, "");
    const plain = stripTerminalSequences(clean);
    const spans: { start: number; end: number; tooWide?: boolean }[] = [];
    let position = 0, start = 0, used = 0;
    for (const { segment } of graphemes.segment(plain)) {
      const size = visibleWidth(segment);
      if (used && used + size > width) {
        spans.push({ start, end: position });
        start = position; used = 0;
      }
      if (size > width) {
        spans.push({ start: position, end: position + size, tooWide: true });
        position += size; start = position;
      } else {
        used += size; position += size;
      }
    }
    if (used || spans.length === 0) spans.push({ start, end: position });
    for (const span of spans) {
      let part = span.tooWide ? "…" : sliceByColumn(plain, span.start, span.end - span.start, true);
      if (markerCol >= span.start && markerCol < span.end) {
        const local = span.tooWide ? 0 : markerCol - span.start;
        const left = sliceByColumn(part, 0, local, true);
        const right = sliceByColumn(part, local, width - local, true);
        const next = graphemes.segment(right)[Symbol.iterator]().next().value?.segment ?? " ";
        part = left + " ".repeat(Math.max(0, local - visibleWidth(left))) + CURSOR_MARKER + renderFakeCursor(next) + right.slice(next.length);
      }
      lines.push(part);
      mapping.push({ row, col: span.start });
    }
    if (markerCol >= position) {
      lines.push(CURSOR_MARKER + renderFakeCursor(" "));
      mapping.push({ row, col: markerCol });
    }
  }
  return { lines, mapping };
}
