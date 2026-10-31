/**
 * Fork-only regression coverage for pill text contrast.
 *
 * The fork replaces the basic ANSI text codes (`30`/`97`) with the 256-colour
 * cube's fixed black and white (`16`/`231`). The basic codes belong to the
 * terminal theme: herdr renders ANSI black as `#616161`, which dropped the
 * automatic "dark" text on the muted pill background to 1.76:1.
 *
 * Kept out of `pill.test.ts` so an upstream sync never has to merge these
 * scenarios; see FORK-CHANGELOG.md.
 */

import { describe, expect, it } from "vitest";

import {
	hasExplicitForeground,
	isTerminalOwnedBackground,
	reverseVideoSgr,
} from "../extensions/starline/fork-pill-legibility";
import {
	backgroundSgrToRgb,
	contrastTextSgr,
	type PillInput,
	renderPillBar,
} from "../extensions/starline/pill";
import { renderPillBubble } from "../extensions/starline/pill-bubble";
import { DEFAULT_PILL_CONFIG } from "../extensions/starline/pill-config";
import type { ThemeLike } from "../extensions/starline/style";

const TEXT_DARK = "\x1b[38;5;16m";
const TEXT_LIGHT = "\x1b[38;5;231m";

/** The pill backgrounds the footer actually draws on a dark Pi theme. */
const MUTED_BG = "\x1b[48;2;130;137;151m"; // #828997 — muted promoted to a background
const BLUE_BG = "\x1b[48;2;97;175;238m"; // #61AFEE — the model pill
const GREEN_BG = "\x1b[48;2;152;195;121m"; // #98C379 — the cost pill
const DARK_BG = "\x1b[48;2;30;30;46m"; // #1E1E2E — a dark pill background
const MAUVE_BG = "\x1b[48;2;203;166;247m"; // #CBA6F7 — two pills sharing one colour

/** What herdr's palette paints for ANSI black (`30`), the code the fork removed. */
const TERMINAL_ANSI_BLACK: Rgb = [97, 97, 97];

const CUBE_BLACK: Rgb = [0, 0, 0];
const CUBE_WHITE: Rgb = [255, 255, 255];

type Rgb = [number, number, number];

const theme: ThemeLike = {
	fg(color: string, text: string): string {
		const colors: Record<string, string> = {
			syntaxKeyword: "\x1b[38;2;203;166;247m",
			success: "\x1b[38;2;166;227;161m",
			borderMuted: "\x1b[38;2;69;71;90m",
			text: "\x1b[38;2;205;214;244m",
			// The user's theme declares several tokens as palette slots, whose RGB
			// only the terminal knows.
			thinkingHigh: "\x1b[38;5;3m",
			syntaxFunction: "\x1b[38;5;3m",
		};
		const ansi = colors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

function channelLuminance(value: number): number {
	const channel = value / 255;
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: Rgb): number {
	return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
	const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (high + 0.05) / (low + 0.05);
}

function backgroundRgb(background: string): Rgb {
	const rgb = backgroundSgrToRgb(background);
	if (!rgb) throw new Error(`background ${JSON.stringify(background)} has no RGB`);
	return rgb;
}

/** The RGB the terminal will actually paint for a chosen text colour. */
function textRgb(sgr: string): Rgb {
	if (sgr === TEXT_DARK) return CUBE_BLACK;
	if (sgr === TEXT_LIGHT) return CUBE_WHITE;
	throw new Error(`unexpected text colour ${JSON.stringify(sgr)}`);
}

function bar(inputs: PillInput[]): string {
	return renderPillBar(inputs, theme, "theme", { ...DEFAULT_PILL_CONFIG }, 200);
}

describe("pill text contrast in a terminal that owns the basic palette", () => {
	it("documents why the basic ANSI black was unusable on this theme", () => {
		expect(contrastRatio(TERMINAL_ANSI_BLACK, backgroundRgb(MUTED_BG))).toBeLessThan(4.5);
		expect(contrastRatio(TERMINAL_ANSI_BLACK, backgroundRgb(BLUE_BG))).toBeLessThan(4.5);
	});

	it("picks the cube black for every mid-tone background the footer draws", () => {
		for (const background of [MUTED_BG, BLUE_BG, GREEN_BG]) {
			const picked = contrastTextSgr(background);
			expect(picked).toBe(TEXT_DARK);
			expect(contrastRatio(backgroundRgb(background), textRgb(picked))).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("picks the cube white on dark backgrounds", () => {
		const picked = contrastTextSgr(DARK_BG);
		expect(picked).toBe(TEXT_LIGHT);
		expect(contrastRatio(backgroundRgb(DARK_BG), textRgb(picked))).toBeGreaterThanOrEqual(4.5);
	});

	it("keeps the existing dark fallback when the background cannot be resolved", () => {
		expect(contrastTextSgr("\x1b[49m")).toBe(TEXT_DARK);
		expect(contrastTextSgr("not-a-sgr")).toBe(TEXT_DARK);
	});

	it("still chooses by background luminance for 256-index and named backgrounds", () => {
		expect(contrastTextSgr("\x1b[48;5;231m")).toBe(TEXT_DARK);
		expect(contrastTextSgr("\x1b[48;5;16m")).toBe(TEXT_LIGHT);
		expect(contrastTextSgr("\x1b[47m")).toBe(TEXT_DARK);
		expect(contrastTextSgr("\x1b[42m")).toBe(TEXT_LIGHT);
	});

	it("never emits the basic ANSI text codes the terminal theme owns", () => {
		for (const background of [MUTED_BG, BLUE_BG, GREEN_BG, DARK_BG, MAUVE_BG, "\x1b[49m"]) {
			expect(contrastTextSgr(background)).not.toBe("\x1b[30m");
			expect(contrastTextSgr(background)).not.toBe("\x1b[97m");
		}
	});

	it("draws a same-background divider in the fixed contrast colour", () => {
		const same: PillInput[] = [
			{ key: "a", text: "aaa", spec: "syntaxKeyword" },
			{ key: "b", text: "bbb", spec: "syntaxKeyword" },
		];
		const out = bar(same);
		expect(out).toContain(`${MAUVE_BG}${TEXT_DARK}`);
		expect(out).not.toContain("\x1b[30m");
	});

	it("gives the bubble's selected row the same contrast colour", () => {
		const lines = renderPillBubble({
			content: { title: "queued", body: [{ text: "first", onSelect: () => {} }] },
			width: 40,
			background: MUTED_BG,
			selected: 0,
		});
		const selected = lines.find((line) => line.includes("first"));
		expect(selected).toContain(TEXT_DARK);
		expect(lines.join("\n")).not.toContain("\x1b[30m");
	});
});

describe("backgrounds the terminal owns are painted in reverse", () => {
	const PALETTE_SLOT = "\x1b[48;5;3m";
	const REVERSE_PREFIX = "\x1b[49m\x1b[38;5;3m\x1b[7m";

	it("knows which backgrounds the terminal owns", () => {
		for (const owned of ["\x1b[43m", "\x1b[103m", "\x1b[48;5;0m", "\x1b[48;5;15m"]) {
			expect(isTerminalOwnedBackground(owned)).toBe(true);
		}
		for (const knowable of [
			"\x1b[48;5;16m",
			"\x1b[48;5;231m",
			"\x1b[48;2;97;175;238m",
			"\x1b[49m",
			"not-a-sgr",
		]) {
			expect(isTerminalOwnedBackground(knowable)).toBe(false);
		}
	});

	it("turns an owned background into the reverse-video prefix", () => {
		expect(reverseVideoSgr(PALETTE_SLOT)).toBe(REVERSE_PREFIX);
		expect(reverseVideoSgr(BLUE_BG)).toBeUndefined();
		expect(reverseVideoSgr("\x1b[49m")).toBeUndefined();
	});

	it("paints a palette-slot pill in reverse instead of guessing its RGB", () => {
		const out = bar([{ key: "model", text: "model", spec: "syntaxFunction" }]);
		expect(out).toContain(REVERSE_PREFIX);
		// The guess this replaces: white text on the standard table's olive.
		expect(out).not.toContain("\x1b[48;5;3m\x1b[38;5;231m");
	});

	it("leaves an explicit fg: alone", () => {
		const out = bar([{ key: "model", text: "model", spec: "bg:blue fg:bright-white" }]);
		expect(out).not.toContain("\x1b[7m");
	});

	it("does not reverse a pill that names its own foreground without a background", () => {
		// `fg:` alone still promotes to a palette background, but the user chose the
		// text colour, so reverse video must not replace it.
		const out = bar([{ key: "model", text: "TEST", spec: "fg:blue" }]);
		expect(out).not.toContain("\x1b[7m");
		expect(out).toContain("\x1b[34m");
	});

	it("recognizes an explicit foreground token in a spec", () => {
		expect(hasExplicitForeground("fg:blue")).toBe(true);
		expect(hasExplicitForeground("bold fg:#ff0000")).toBe(true);
		expect(hasExplicitForeground("bg:blue fg:bright-white")).toBe(true);
		expect(hasExplicitForeground("bold blue")).toBe(false);
		expect(hasExplicitForeground("bg:blue")).toBe(false);
		expect(hasExplicitForeground("")).toBe(false);
	});

	it("draws the same-background divider in reverse too", () => {
		const out = bar([
			{ key: "a", text: "aaa", spec: "syntaxFunction" },
			{ key: "b", text: "bbb", spec: "syntaxFunction" },
		]);
		// Two bodies and the thin divider between them.
		expect(out.match(/\x1b\[7m/g)?.length).toBe(3);
	});

	it("paints the bubble's selected row in reverse for an owned background", () => {
		const lines = renderPillBubble({
			content: { title: "levels", body: [{ text: "high", onSelect: () => {} }] },
			width: 40,
			background: PALETTE_SLOT,
			selected: 0,
		});
		const selected = lines.find((line) => line.includes("high"));
		expect(selected).toContain(REVERSE_PREFIX);
	});
});
