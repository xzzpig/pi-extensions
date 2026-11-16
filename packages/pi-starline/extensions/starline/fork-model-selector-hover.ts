import type { ModelRow, SelectorGeometry } from "./fork-model-selector-geometry";

/** Decorate real rendered model rows only; never rebuild the native list or its selection. */
export function decorateModelHover(
	lines: string[],
	geometry: SelectorGeometry,
	row: ModelRow,
	background: string,
): string[] {
	if (geometry.height !== lines.length || !geometry.rows.includes(row)) return lines;
	return lines.map((line, index) => {
		if (index < row.start || index >= row.end) return line;
		// Native Text includes nested foreground/reset sequences. Reassert only
		// our background after SGR, preserving every original sequence and glyph.
		const styled = line.replace(/\x1b\[[0-9:;]*m/g, (sequence) => sequence + background);
		return `${background}${styled}\x1b[49m`;
	});
}
