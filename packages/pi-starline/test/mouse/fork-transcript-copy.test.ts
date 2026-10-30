import { describe, expect, it } from "vitest";
import { cleanForkTranscriptRows } from "../../extensions/starline/mouse/fork-transcript-copy";

describe("fork transcript cleaning", () => {
	it("strips the configured ASCII rail and maps partial-selection columns", () => {
		const lines = ["────────", "| first", "| second", "────────"];
		expect(cleanForkTranscriptRows(lines, 0, 3, "|")).toEqual({
			rows: [null, { text: "first", leftTrim: 2 }, { text: "second", leftTrim: 2 }, null],
			changed: true,
		});
		expect(cleanForkTranscriptRows(lines, 2, 2, "|")).toEqual({
			rows: [{ text: "second", leftTrim: 2 }],
			changed: true,
		});
	});

	it("also preserves upstream pi-tidy frame cleaning with a custom rail", () => {
		const lines = ["────────", "| first", "────────", "╭──────╮", "│ tidy │", "╰──────╯"];
		expect(cleanForkTranscriptRows(lines, 0, 5, "|")).toEqual({
			rows: [
				null,
				{ text: "first", leftTrim: 2 },
				null,
				null,
				{ text: " tidy ", leftTrim: 1 },
				null,
			],
			changed: true,
		});
	});

	it("does not discard a real user icon as if it were pi-tidy chrome", () => {
		const lines = ["────────", "│ \uf007 content", "────────"];
		expect(cleanForkTranscriptRows(lines, 0, 2, "│", true)).toEqual({
			rows: [null, { text: "\uf007 content", leftTrim: 2 }, null],
			changed: true,
		});
	});

	it("uses upstream pi-tidy icon cleaning when Starline is not drawing messages", () => {
		const lines = ["────────", "│ \uf007 content", "────────"];
		expect(cleanForkTranscriptRows(lines, 0, 2, "│", false)).toEqual({
			rows: [null, { text: "content", leftTrim: 4 }, null],
			changed: true,
		});
	});

	it("retains the former empty-rail rule-pair behavior", () => {
		expect(cleanForkTranscriptRows(["────", "plain", "────"], 0, 2, "")).toEqual({
			rows: [null, { text: "plain", leftTrim: 0 }, null],
			changed: true,
		});
	});

	it("leaves unrelated content alone when the configured rail does not match", () => {
		expect(cleanForkTranscriptRows(["────", "plain", "────"], 0, 2, "|")).toEqual({
			rows: [
				{ text: "────", leftTrim: 0 },
				{ text: "plain", leftTrim: 0 },
				{ text: "────", leftTrim: 0 },
			],
			changed: false,
		});
	});
});
