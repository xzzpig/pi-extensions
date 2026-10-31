/**
 * Fork-only legibility helpers for pill text.
 *
 * A pill's text colour is normally picked from the background's RGB, but the
 * terminal owns the RGB of its own 16 colours: `38;5;3` is whatever the theme
 * paints for palette slot 3 (herdr: `#61AFEE`), not the standard table's olive.
 * Guessing from the standard table turned "light blue" into "dark yellow" and
 * picked white text for a light pill.
 *
 * For those backgrounds the fork paints the text with reverse video instead:
 * the palette colour becomes the background and the terminal's own default
 * background becomes the text. A palette is designed to keep its colours
 * readable against that default background, so the pair stays legible without
 * the program knowing either RGB.
 *
 * See FORK-CHANGELOG.md; `test/fork-pill-contrast.test.ts` covers it.
 */

import { toForegroundSgr } from "./style";

const DEFAULT_BG = "\x1b[49m";
const REVERSE = "\x1b[7m";

/**
 * True when the background is one of the terminal's own 16 colours, whose RGB
 * only the terminal knows. The 256-colour cube (`48;5;16`+) and truecolor are
 * fixed by the standard, so those stay knowable.
 */
export function isTerminalOwnedBackground(background: string): boolean {
	if (/^\x1b\[(4[0-7]|10[0-7])m$/.test(background)) return true;
	const indexed = /^\x1b\[48;5;(\d{1,3})m$/.exec(background);
	return indexed ? Number(indexed[1]) < 16 : false;
}

/**
 * True when the spec names a foreground colour itself (`fg:…`). Such a pill
 * keeps the colour the user asked for: reverse video would replace it.
 */
export function hasExplicitForeground(spec: string): boolean {
	return /(^|\s)fg:/i.test(spec.trim());
}

/**
 * The SGR that paints text on a terminal-owned background, or undefined when
 * the background is knowable (the caller picks a contrast colour instead) or
 * cannot be turned into a foreground colour.
 */
export function reverseVideoSgr(background: string): string | undefined {
	if (!isTerminalOwnedBackground(background)) return undefined;
	const foreground = toForegroundSgr(background);
	return foreground ? `${DEFAULT_BG}${foreground}${REVERSE}` : undefined;
}
