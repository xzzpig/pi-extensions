import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import { collectStatusSnapshot } from "../extensions/starline/fork-status-snapshot";
import {
	buildExtensionOnlyModel,
	buildLegacyStatusPanelModel,
	readStatusPanelModel,
} from "../extensions/starline/fork-status-view";

describe("extension-only fallback model", () => {
	it("reads the published text, not the value format the bar uses", () => {
		const config = mergeConfig({ extensionStatuses: { formats: { mcp: "value" } } });
		const model = buildExtensionOnlyModel(config, new Map([["mcp", "MCP: 8 servers connected"]]));
		const item = model.items.find((candidate) => candidate.key === "extensionStatus:mcp");
		expect(item?.text).toBe("MCP: 8 servers connected");
		expect(item?.state).toBe("hidden");
	});

	it("keeps the published text when the pill would show a bare number", () => {
		const config = mergeConfig({ extensionStatuses: { formats: { balance: "value" } } });
		const model = buildExtensionOnlyModel(
			config,
			new Map([["balance", "Tavily: 41.1% of monthly quota remaining"]]),
		);
		expect(model.items[0]?.text).toBe("Tavily: 41.1% of monthly quota remaining");
	});

	it("splits off and unlisted statuses into the other group and never invents rows", () => {
		const config = mergeConfig({
			extensionStatuses: { placements: { balance: "off" } },
		});
		const model = buildExtensionOnlyModel(
			config,
			new Map([
				["balance", "hidden by placement"],
				["mcp", "MCP 1/2"],
			]),
		);
		expect(model.items.map((item) => item.key)).toEqual(["extensionStatus:mcp"]);
		expect(model.others.map((item) => item.key)).toEqual(["extensionStatus:balance"]);
		expect(model.others[0]?.state).toBe("off");
		expect(model.hiddenCount).toBe(1);
	});

	it("drops empty and control-only text", () => {
		const model = buildExtensionOnlyModel(
			defaultConfig,
			new Map([
				["blank", "   "],
				["control", "\u001b[2J"],
				["real", "kept"],
			]),
		);
		expect(model.items.map((item) => item.key)).toEqual(["extensionStatus:real"]);
	});

	it("is what the panel reads when no footer has published a model", async () => {
		const { configureStatusView, clearStatusPanelModel } = await import(
			"../extensions/starline/fork-status-view"
		);
		clearStatusPanelModel();
		configureStatusView({
			getConfig: () => mergeConfig({ extensionStatuses: { formats: { mcp: "value" } } }),
			getStatuses: () => new Map([["mcp", "MCP: 8 servers connected"]]),
		});
		const item = readStatusPanelModel().items.find(
			(candidate) => candidate.key === "extensionStatus:mcp",
		);
		expect(item?.text).toBe("MCP: 8 servers connected");
		configureStatusView(undefined);
	});
});

describe("model signatures cover the body text", () => {
	it("changes the fallback signature when a body changes", () => {
		const config = mergeConfig({});
		const short = buildExtensionOnlyModel(config, new Map([["a", "AAA"]]));
		const long = buildExtensionOnlyModel(config, new Map([["a", "A".repeat(600)]]));
		expect(long.signature).not.toBe(short.signature);
	});

	it("changes the legacy signature when a body or its action changes", () => {
		const config = mergeConfig({ pill: { overflow: { enabled: false } } });
		const snapshotOf = (text: string) =>
			collectStatusSnapshot({
				statuses: new Map([["a", text]]),
				config,
				renderBuiltin: (segment) => segment,
				builtinSpec: () => "",
				statusSpec: () => "",
			});
		const short = buildLegacyStatusPanelModel(snapshotOf("AAA"), {
			visibleKeys: new Set(["a"]),
			hiddenCount: 0,
		});
		const long = buildLegacyStatusPanelModel(snapshotOf("A".repeat(600)), {
			visibleKeys: new Set(["a"]),
			hiddenCount: 0,
		});
		expect(long.signature).not.toBe(short.signature);
	});
});
