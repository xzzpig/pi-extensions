import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { type CleanedRows, cleanTranscriptRows } from "./transcript-copy";

/** Preserve Starline's configurable message rail alongside upstream's pi-tidy cleaning. */
export function cleanForkTranscriptRows(
	lines: readonly string[],
	startRow: number,
	endRow: number,
	railGlyph: string,
	starlineOwnsMessages = true,
): CleanedRows {
	const upstream = cleanTranscriptRows(lines, startRow, endRow);
	// When tidy owns messages, its icon is decoration rather than user text.
	if (railGlyph === "│" && !starlineOwnsMessages) return upstream;

	const prefix = railGlyph ? `${railGlyph} ` : "";
	const dropped = new Set<number>();
	const railContent = new Set<number>();
	let lastRule: { row: number; width: number } | undefined;
	for (let row = 0; row < lines.length; row++) {
		const text = stripTerminalSequences(lines[row] ?? "");
		if (/^─+$/.test(text)) {
			const width = visibleWidth(text);
			if (lastRule && lastRule.width === width && row - lastRule.row >= 2) {
				dropped.add(lastRule.row);
				dropped.add(row);
				for (let inner = lastRule.row + 1; inner < row; inner++) railContent.add(inner);
			}
			lastRule = { row, width };
		} else if (prefix && !text.startsWith(prefix)) {
			lastRule = undefined;
		}
	}

	let changed = upstream.changed;
	const rows = upstream.rows.map((cleaned, index) => {
		const row = startRow + index;
		if (dropped.has(row)) {
			changed = true;
			return null;
		}
		if (cleaned === null || !prefix || !railContent.has(row)) return cleaned;
		const original = stripTerminalSequences(lines[row] ?? "");
		if (!original.startsWith(prefix)) return cleaned;
		// For Starline's own rail the icon may be user text, so preserve it even
		// when upstream would identify it as a pi-tidy decoration.
		if (!starlineOwnsMessages && (cleaned.text !== original || cleaned.leftTrim !== 0)) {
			return cleaned;
		}
		changed = true;
		return { text: original.slice(prefix.length), leftTrim: visibleWidth(prefix) };
	});
	return { rows, changed };
}
