import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConfig } from "../extensions/starline/config";
import { renderStatusBar, type StatusBarMemo } from "../extensions/starline/fork-status-bar";
import { clearStatusPanelModel } from "../extensions/starline/fork-status-view";
import type { ThemeLike } from "../extensions/starline/style";

const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const plain = (text: string) => stripVTControlCharacters(text);

afterEach(() => {
	clearStatusPanelModel();
});

function bar(options: {
	statuses: ReadonlyMap<string, string>;
	width: number;
	memo: StatusBarMemo;
	iconMode?: "auto" | "ascii" | "nerd";
	caps?: "round" | "right" | "none";
	separator?: "chevron" | "arrow" | "none";
}) {
	const config = mergeConfig({
		footerStyle: "pill",
		icons: { mode: options.iconMode ?? "nerd" },
		pill: {
			segments: ["extensionStatus"],
			...(options.caps ? { caps: options.caps } : {}),
			...(options.separator ? { separator: options.separator } : {}),
		},
	});
	return renderStatusBar({
		config,
		theme,
		colorSource: "terminal",
		statuses: options.statuses,
		width: options.width,
		iconMode: options.iconMode ?? "nerd",
		renderBuiltin: (segment: string) => segment,
		builtinSpec: () => "bright-black",
		statusSpec: () => "bright-black",
		memo: options.memo,
		legacyInputs: () => [],
	});
}

const oneStatus = new Map([["x", "abcd"]]);

describe("the cached layout follows the renderer it was solved for", () => {
	it("re-solves when the icon mode changes under a shared memo", () => {
		const memo: StatusBarMemo = {};
		const ascii = bar({ statuses: oneStatus, width: 6, memo, iconMode: "ascii" });
		const nerd = bar({ statuses: oneStatus, width: 6, memo, iconMode: "nerd" });
		const fresh = bar({ statuses: oneStatus, width: 6, memo: {}, iconMode: "nerd" });

		// The cached ASCII decision must not be redrawn with Nerd caps: the row is
		// whatever a fresh solve produces, not the previous geometry cut at the end.
		expect(plain(nerd.line)).toBe(plain(fresh.line));
		expect(plain(nerd.line)).not.toBe(plain(ascii.line));
		for (const rendered of [ascii, nerd, fresh]) {
			expect(visibleWidth(rendered.line)).toBeLessThanOrEqual(6);
		}
		// A row that only fits by summarising must not be described as fully shown:
		// the model the caller gets describes the row just drawn, not the cached one.
		const item = nerd.model.items.find((candidate) => candidate.key === "extensionStatus:x");
		const drawn = plain(nerd.line);
		expect(item?.state).toBe(drawn.includes("+1") ? "hidden" : "full");
	});

	it("re-solves when the caps change under a shared memo", () => {
		const memo: StatusBarMemo = {};
		const round = bar({ statuses: oneStatus, width: 6, memo, caps: "round" });
		const none = bar({ statuses: oneStatus, width: 6, memo, caps: "none" });
		const fresh = bar({ statuses: oneStatus, width: 6, memo: {}, caps: "none" });
		expect(plain(none.line)).toBe(plain(fresh.line));
		expect(visibleWidth(none.line)).toBeLessThanOrEqual(6);
		expect(visibleWidth(round.line)).toBeLessThanOrEqual(6);
	});

	it("re-solves when the separator changes under a shared memo", () => {
		const statuses = new Map([
			["a", "alpha"],
			["b", "beta"],
		]);
		const memo: StatusBarMemo = {};
		const chevron = bar({ statuses, width: 40, memo, separator: "chevron" });
		const none = bar({ statuses, width: 40, memo, separator: "none" });
		const fresh = bar({ statuses, width: 40, memo: {}, separator: "none" });
		expect(plain(none.line)).toBe(plain(fresh.line));
		expect(plain(chevron.line)).not.toBe(plain(none.line));
	});

	it("keeps a cache hit byte-identical to a fresh solve", () => {
		const memo: StatusBarMemo = {};
		const statuses = new Map([
			["a", "alpha"],
			["b", "a much longer second status that will not fit"],
		]);
		const first = bar({ statuses, width: 40, memo });
		const second = bar({ statuses, width: 40, memo });
		const fresh = bar({ statuses, width: 40, memo: {} });
		expect(plain(second.line)).toBe(plain(first.line));
		expect(plain(second.line)).toBe(plain(fresh.line));
	});

	it("caches the decision as keys, not as last frame's entries", () => {
		const memo: StatusBarMemo = {};
		const rendered = bar({ statuses: oneStatus, width: 40, memo });
		expect(memo.layout?.visible).toEqual(["extensionStatus:x"]);
		expect(memo.layout?.visible.every((key) => typeof key === "string")).toBe(true);
		expect(memo.layout?.hidden).toEqual([]);
		// The row the caller sees still carries the live entry objects.
		expect(rendered.hit.entryByKey.get("x")?.fullText).toBe("abcd");
	});
});
