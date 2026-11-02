import { describe, expect, it } from "vitest";
import { mergeConfig } from "../extensions/starline/config";
import {
	DEFAULT_OVERFLOW_PRIORITY,
	isOverflowPinned,
	normalizePillOverflow,
	overflowContentLimit,
	overflowPriority,
	overflowSignature,
} from "../extensions/starline/fork-overflow-config";

const norm = (value: unknown) => normalizePillOverflow(value);

describe("pill.overflow defaults", () => {
	it("ships the documented defaults", () => {
		const config = norm(undefined);
		expect(config.enabled).toBe(true);
		expect(config.maxContentWidth).toBe(32);
		expect(config.extensionMaxContentWidth).toBe(28);
		expect(config.pinned).toEqual([]);
	});

	it("keeps cwd and git at 24, queue at 100, model/context at 80", () => {
		const config = norm(undefined);
		expect(overflowContentLimit(config, "cwd", "builtin")).toBe(24);
		expect(overflowContentLimit(config, "git", "builtin")).toBe(24);
		expect(overflowContentLimit(config, "cost", "builtin")).toBe(32);
		expect(overflowContentLimit(config, "extensionStatus:mcp", "extension")).toBe(28);
		expect(overflowPriority(config, "queue")).toBe(100);
		expect(overflowPriority(config, "model")).toBe(80);
		expect(overflowPriority(config, "context")).toBe(80);
		expect(overflowPriority(config, "extensionStatus:mcp")).toBe(DEFAULT_OVERFLOW_PRIORITY);
	});

	it("is reachable through the normal pill config merge", () => {
		const merged = mergeConfig({
			pill: { overflow: { extensionMaxContentWidth: 12, enabled: false } },
		});
		expect(merged.pill.overflow.enabled).toBe(false);
		expect(merged.pill.overflow.extensionMaxContentWidth).toBe(12);
		// The rest of the pill block keeps its own defaults.
		expect(merged.pill.separator).toBe("powerline");
		expect(merged.pill.overflow.maxContentWidth).toBe(32);
	});
});

describe("pill.overflow resolution", () => {
	it("lets a per-key width win over the category default", () => {
		const config = norm({ maxWidths: { cost: 10, "extensionStatus:mcp": 6 } });
		expect(overflowContentLimit(config, "cost", "builtin")).toBe(10);
		expect(overflowContentLimit(config, "extensionStatus:mcp", "extension")).toBe(6);
		// Overriding one built-in default must not drop the other.
		expect(overflowContentLimit(config, "cwd", "builtin")).toBe(24);
		expect(overflowContentLimit(config, "git", "builtin")).toBe(24);
	});

	it("treats pinned keys as a set and keeps unknown keys", () => {
		const config = norm({
			pinned: ["model", "model", " extensionStatus:goal ", 7, null],
			priorities: { "extensionStatus:not-published-yet": 66 },
			maxWidths: { "extensionStatus:not-published-yet": 40 },
		});
		expect(config.pinned).toEqual(["model", "extensionStatus:goal"]);
		expect(isOverflowPinned(config, "model")).toBe(true);
		expect(isOverflowPinned(config, "context")).toBe(false);
		expect(overflowPriority(config, "extensionStatus:not-published-yet")).toBe(66);
		expect(overflowContentLimit(config, "extensionStatus:not-published-yet", "extension")).toBe(40);
	});
});

describe("pill.overflow tolerance", () => {
	it("falls back per field instead of discarding a partly bad block", () => {
		const config = norm({
			enabled: "yes",
			maxContentWidth: 0,
			extensionMaxContentWidth: 2.5,
			maxWidths: { cost: -4, cwd: "wide", model: 20 },
			priorities: { queue: 5000, model: 70, context: 1.5 },
			pinned: ["cost"],
		});
		expect(config.enabled).toBe(true);
		expect(config.maxContentWidth).toBe(32);
		expect(config.extensionMaxContentWidth).toBe(28);
		expect(config.maxWidths.cost).toBeUndefined();
		expect(config.maxWidths.cwd).toBe(24);
		expect(config.maxWidths.model).toBe(20);
		expect(config.priorities.queue).toBe(100);
		expect(config.priorities.model).toBe(70);
		expect(config.priorities.context).toBe(80);
		expect(config.pinned).toEqual(["cost"]);
	});

	it("accepts the extremes of the documented ranges", () => {
		const config = norm({
			maxContentWidth: 1,
			extensionMaxContentWidth: 4096,
			priorities: { a: -1000, b: 1000 },
		});
		expect(config.maxContentWidth).toBe(1);
		expect(config.extensionMaxContentWidth).toBe(4096);
		expect(config.priorities.a).toBe(-1000);
		expect(config.priorities.b).toBe(1000);
	});

	it("ignores a block that is not an object", () => {
		expect(norm("on").enabled).toBe(true);
		expect(norm([]).maxContentWidth).toBe(32);
	});
});

describe("pill.overflow signature", () => {
	it("is stable for equal settings regardless of key order", () => {
		const a = norm({ maxWidths: { cwd: 10, git: 12 }, priorities: { model: 70, queue: 90 } });
		const b = norm({ priorities: { queue: 90, model: 70 }, maxWidths: { git: 12, cwd: 10 } });
		expect(overflowSignature(a)).toBe(overflowSignature(b));
	});

	it("changes when a governed field changes", () => {
		const base = norm({});
		expect(overflowSignature(norm({ enabled: false }))).not.toBe(overflowSignature(base));
		expect(overflowSignature(norm({ maxContentWidth: 33 }))).not.toBe(overflowSignature(base));
		expect(overflowSignature(norm({ pinned: ["model"] }))).not.toBe(overflowSignature(base));
		expect(overflowSignature(norm({ maxWidths: { cost: 9 } }))).not.toBe(overflowSignature(base));
	});
});

describe("pill.overflow persistence", () => {
	it("round-trips through a settings save and keeps unknown keys", async () => {
		const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { loadConfig, savePillOverflowPatch } = await import("../extensions/starline/config");
		const dir = mkdtempSync(join(tmpdir(), "starline-overflow-"));
		const path = join(dir, "starline.json");
		writeFileSync(
			path,
			JSON.stringify({
				pill: {
					segments: ["cwd", "model"],
					overflow: {
						priorities: { "extensionStatus:not-yet-loaded": 71 },
						futureField: { keep: true },
					},
				},
			}),
		);

		const saved = savePillOverflowPatch(
			{ enabled: false, maxWidths: { model: 9 }, pinned: ["model"] },
			path,
		);
		expect(saved.pill.overflow.enabled).toBe(false);
		expect(saved.pill.overflow.maxWidths.model).toBe(9);
		expect(saved.pill.overflow.pinned).toEqual(["model"]);

		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			pill: { segments: string[]; overflow: Record<string, unknown> };
		};
		expect(raw.pill.overflow.futureField).toEqual({ keep: true });
		expect(raw.pill.overflow.priorities).toEqual({ "extensionStatus:not-yet-loaded": 71 });
		expect(raw.pill.segments).toEqual(["cwd", "model"]);

		// Reloading keeps the unknown entries addressable.
		const reloaded = loadConfig(path);
		expect(reloaded.pill.overflow.priorities["extensionStatus:not-yet-loaded"]).toBe(71);
		expect(reloaded.pill.overflow.enabled).toBe(false);
	});
});

describe("documented example", () => {
	it("loads the JSON printed in docs/status-overflow.md", () => {
		// Keep this literal identical to the fenced example in the fork doc.
		const documented = {
			pill: {
				overflow: {
					enabled: true,
					maxContentWidth: 32,
					extensionMaxContentWidth: 28,
					maxWidths: { cwd: 24, git: 24, "extensionStatus:mcp": 20 },
					priorities: { queue: 100, model: 80, context: 80 },
					pinned: ["model", "context"],
				},
			},
		};
		const config = mergeConfig(documented);
		expect(config.pill.overflow.enabled).toBe(true);
		expect(config.pill.overflow.maxWidths.cwd).toBe(24);
		expect(config.pill.overflow.maxWidths["extensionStatus:mcp"]).toBe(20);
		expect(config.pill.overflow.priorities.queue).toBe(100);
		expect(config.pill.overflow.pinned).toEqual(["model", "context"]);
	});
});
