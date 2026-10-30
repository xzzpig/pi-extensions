/**
 * Pi 1.2+ delays drawing its software cursor: the editor emits APC markers
 * around the cursor cell and the TUI resolves them after our editor renders.
 * Restyle the marked cell before that resolution, keeping CURSOR_MARKER intact
 * for hardware cursor/IME positioning. Pi 1.1's SGR cursor stays upstream's
 * responsibility in editor-cursor.ts.
 */
const MARKED_CURSOR = /\x1b_pi:fc\x07([^\x1b]+)\x1b_pi:\/fc\x07/g;

export function applyMarkedCursorStyle(line: string, style: "underline" | "terminal"): string {
	return line.replace(MARKED_CURSOR, (_match, cell: string) =>
		style === "underline" ? `\x1b[4m${cell}\x1b[0m` : cell,
	);
}
