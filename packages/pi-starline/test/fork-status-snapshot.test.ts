import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { mergeConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import {
	collectStatusSnapshot,
	type SnapshotOptions,
	snapshotSignature,
} from "../extensions/starline/fork-status-snapshot";

type Options = {
	statuses?: [string, string][];
	pill?: Record<string, unknown>;
	extensionStatuses?: Record<string, unknown>;
	config?: Record<string, unknown>;
	renderBuiltin?: (segment: string) => string;
	ellipsis?: string;
};

function buildConfig(options: Options): PolishedTuiConfig {
	return mergeConfig({
		...(options.config ?? {}),
		pill: {
			segments: ["cwd", "extensionStatus", "model"],
			...options.pill,
		},
		...(options.extensionStatuses
			? {
					extensionStatuses: {
						defaultPlacement: "right",
						...options.extensionStatuses,
					},
				}
			: {}),
	});
}

function snapshot(options: Options = {}) {
	const config = buildConfig(options);
	const statuses = new Map<string, string>(options.statuses ?? []);
	const params: SnapshotOptions = {
		statuses,
		config,
		renderBuiltin: options.renderBuiltin ?? ((segment) => `\u001b[36m${segment}\u001b[39m`),
		builtinSpec: (segment) => (segment === "cwd" ? "bold cyan" : "bold blue"),
		statusSpec: () => "bright-black",
		...(options.ellipsis ? { ellipsis: options.ellipsis } : {}),
	};
	return { config, statuses, result: collectStatusSnapshot(params) };
}

describe("status snapshot placement", () => {
	it("keeps the published text while the bar shows the value format", () => {
		const { result } = snapshot({
			statuses: [["mcp", "MCP: 8 servers connected"]],
			extensionStatuses: { formats: { mcp: "value" } },
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:mcp");
		expect(entry?.fullText).toBe("MCP: 8 servers connected");
		expect(entry?.displayText).toBe("8");
		expect(entry?.input.text).toBe("8");
		expect(entry?.actionKey).toBe("mcp");
	});

	it("separates off and unplaced statuses into the panel's other group", () => {
		const { result } = snapshot({
			statuses: [
				["off-one", "hidden by placement"],
				["unlisted", "never in the layout"],
				["shown", "on the bar"],
			],
			extensionStatuses: { placements: { "off-one": "off" } },
			pill: { segments: ["cwd", "extensionStatus:shown", "model"] },
		});
		expect(result.entries.map((entry) => entry.key)).toEqual([
			"cwd",
			"extensionStatus:shown",
			"model",
		]);
		expect(result.others.map((entry) => entry.key)).toEqual([
			"extensionStatus:off-one",
			"extensionStatus:unlisted",
		]);
		// The off status is still readable, and it is not counted as displayed.
		expect(result.others[0]?.fullText).toBe("hidden by placement");
	});

	it("de-duplicates a status named explicitly and by the wildcard", () => {
		const { result } = snapshot({
			statuses: [["mcp", "MCP 1/2"]],
			pill: { segments: ["extensionStatus:mcp", "model", "extensionStatus"] },
		});
		expect(result.entries.map((entry) => entry.key)).toEqual(["extensionStatus:mcp", "model"]);
	});

	it("expands the wildcard in place and keeps left/middle/right order", () => {
		const { result } = snapshot({
			statuses: [
				["zzz", "left z"],
				["aaa", "left a"],
				["middle-one", "middle"],
				["right-one", "right"],
			],
			extensionStatuses: {
				placements: { zzz: "left", aaa: "left", "middle-one": "middle" },
			},
		});
		expect(result.entries.map((entry) => entry.key)).toEqual([
			"cwd",
			"extensionStatus:aaa",
			"extensionStatus:zzz",
			"extensionStatus:middle-one",
			"extensionStatus:right-one",
			"model",
		]);
	});

	it("drops empty and control-only text, and skips a builtin with no content", () => {
		const { result } = snapshot({
			statuses: [
				["blank", "   "],
				["control", "\u001b[2J\u001b[?25l"],
				["real", "kept"],
			],
			renderBuiltin: (segment) => (segment === "model" ? "  " : segment),
		});
		expect(result.entries.map((entry) => entry.key)).toEqual(["cwd", "extensionStatus:real"]);
	});
});

describe("status snapshot width limit", () => {
	it("truncates CJK content to the column cap and keeps the full text", () => {
		const published = "这是一条很长很长很长很长的第三方状态文本，用来测试溢出治理";
		const { result } = snapshot({
			statuses: [["goal", published]],
			extensionStatuses: { icons: { goal: "\uf0eb" } },
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:goal");
		expect(entry?.truncated).toBe(true);
		expect(visibleWidth(entry?.input.text ?? "")).toBeLessThanOrEqual(28);
		expect(stripVTControlCharacters(entry?.input.text ?? "").endsWith("…")).toBe(true);
		expect(entry?.fullText).toBe(published);
	});

	it("counts the icon inside the cap", () => {
		const { result } = snapshot({
			statuses: [["mcp", "012345678901234567890123456789"]],
			extensionStatuses: { icons: { mcp: "\uf1e6" } },
			pill: { overflow: { extensionMaxContentWidth: 6 } },
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:mcp");
		expect(visibleWidth(entry?.input.text ?? "")).toBeLessThanOrEqual(6);
		expect(entry?.input.text.startsWith("\uf1e6 ")).toBe(true);
	});

	it("uses the ascii ellipsis and stays inside tiny caps", () => {
		const { result } = snapshot({
			statuses: [["mcp", "abcdefghij"]],
			pill: { overflow: { extensionMaxContentWidth: 2 } },
			ellipsis: "...",
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:mcp");
		expect(visibleWidth(entry?.input.text ?? "")).toBeLessThanOrEqual(2);
	});

	it("counts emoji and combining text by display columns", () => {
		const { result } = snapshot({
			statuses: [["emoji", "\u{1F3AF}\u{1F3AF}\u{1F3AF}\u{1F3AF}\u{1F3AF}"]],
			pill: { overflow: { extensionMaxContentWidth: 5 } },
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:emoji");
		const text = stripVTControlCharacters(entry?.input.text ?? "");
		expect(visibleWidth(text)).toBeLessThanOrEqual(5);
		expect(text).not.toContain("\uFFFD");
	});

	it("truncates styled original text without breaking its escapes", () => {
		const { result } = snapshot({
			statuses: [["styled", "\u001b[31mabcdefghijklmnopqrstuvwxyz\u001b[39m"]],
			extensionStatuses: { colorModes: { styled: "original" } },
			pill: { overflow: { extensionMaxContentWidth: 8 } },
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:styled");
		const plain = stripVTControlCharacters(entry?.input.text ?? "");
		expect(visibleWidth(plain)).toBeLessThanOrEqual(8);
		expect(plain.startsWith("abcdef")).toBe(true);
		// Whatever is left must still be a balanced, renderable sequence.
		expect(entry?.input.text.includes("\u001b[31m")).toBe(true);
	});

	it("leaves a short entry whole and marks it not truncated", () => {
		const { result } = snapshot({ statuses: [["mcp", "MCP 1/2"]] });
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:mcp");
		expect(entry?.truncated).toBe(false);
		expect(entry?.input.text).toBe("MCP 1/2");
	});

	it("applies per-key widths and keeps the cwd default for other keys", () => {
		const { result } = snapshot({
			pill: { overflow: { maxWidths: { cwd: 2 } } },
			renderBuiltin: (segment) => (segment === "cwd" ? "very-long-directory-name" : segment),
		});
		const cwd = result.entries.find((entry) => entry.key === "cwd");
		expect(visibleWidth(cwd?.input.text ?? "")).toBeLessThanOrEqual(2);
		expect(cwd?.truncated).toBe(true);
		// A key without an override still uses the category default, not the cwd 2.
		const other = collectStatusSnapshot({
			statuses: new Map([["x", "0123456789012345678901234567890123456789"]]),
			config: buildConfig({ pill: { overflow: { maxWidths: { cwd: 2 } } } }),
			renderBuiltin: (segment) => segment,
			builtinSpec: () => "",
			statusSpec: () => "",
		}).entries.find((entry) => entry.key === "extensionStatus:x");
		expect(visibleWidth(other?.input.text ?? "")).toBeLessThanOrEqual(28);
		expect(visibleWidth(other?.input.text ?? "")).toBeGreaterThan(2);
	});
});

describe("status snapshot safety and ownership", () => {
	it("strips terminal controls from the readable text", () => {
		const { result } = snapshot({
			statuses: [["evil", "\u001b[2Jab\u001b[1;1H\u0007"]],
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:evil");
		expect(entry?.fullText).toBe("ab");
		expect(entry?.fullText.includes("\u001b")).toBe(false);
	});

	it("keeps an original-mode status styled on the bar but plain in the panel", () => {
		const { result } = snapshot({
			statuses: [["themed", "\u001b[31mred\u001b[39m text"]],
			extensionStatuses: { colorModes: { themed: "original" } },
		});
		const entry = result.entries.find((candidate) => candidate.key === "extensionStatus:themed");
		expect(entry?.colorMode).toBe("original");
		expect(entry?.input.keepStyling).toBe(true);
		expect(entry?.fullText).toBe("red text");
		expect(stripVTControlCharacters(entry?.input.text ?? "")).toBe("red text");
	});

	it("never writes back to the published statuses", () => {
		const statuses = new Map([["mcp", "MCP: 8 servers connected"]]);
		collectStatusSnapshot({
			statuses,
			config: buildConfig({ extensionStatuses: { formats: { mcp: "value" } } }),
			renderBuiltin: (segment) => segment,
			builtinSpec: () => "",
			statusSpec: () => "",
		});
		expect([...statuses]).toEqual([["mcp", "MCP: 8 servers connected"]]);
	});

	it("does not invent builtin segments that the layout leaves out", () => {
		const { result } = snapshot({
			pill: { segments: ["cwd"] },
		});
		expect(result.entries.map((entry) => entry.key)).toEqual(["cwd"]);
	});
});

describe("status snapshot signature", () => {
	it("changes when text, truncation or the other group changes", () => {
		const base = snapshot({ statuses: [["mcp", "MCP 1/2"]] }).result;
		const longer = snapshot({ statuses: [["mcp", "MCP 1/2 and a longer tail"]] }).result;
		const off = snapshot({
			statuses: [["mcp", "MCP 1/2"]],
			extensionStatuses: { placements: { mcp: "off" } },
		}).result;
		expect(snapshotSignature(longer)).not.toBe(snapshotSignature(base));
		expect(snapshotSignature(off)).not.toBe(snapshotSignature(base));
	});

	it("is stable for identical input", () => {
		const a = snapshot({ statuses: [["mcp", "MCP 1/2"]] }).result;
		const b = snapshot({ statuses: [["mcp", "MCP 1/2"]] }).result;
		expect(snapshotSignature(a)).toBe(snapshotSignature(b));
	});
});
