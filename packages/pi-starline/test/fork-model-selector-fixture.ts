import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, expect, vi } from "vitest";
import {
	selectorGeometry,
	selectorState,
} from "../extensions/starline/fork-model-selector-geometry";

// An external Pi entry allows the same contract to run against the actual host,
// without changing this workspace's lockfile or dependency installation.
export const host: typeof import("@earendil-works/pi-coding-agent") = await import(
	process.env.STARLINE_PI_ENTRY || "@earendil-works/pi-coding-agent"
);
// Match the real interactive host: bare pi-tui defaults have no app.models.save binding.
// This private-path import is test-only; production keeps using public Pi APIs.
const entry =
	process.env.STARLINE_PI_ENTRY || import.meta.resolve("@earendil-works/pi-coding-agent");
const entryUrl = entry.startsWith("file:") ? new URL(entry) : pathToFileURL(entry);
const tui = await import(createRequire(entryUrl).resolve("@earendil-works/pi-tui"));
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entryUrl).href);
const disposers: Array<() => void> = [];
beforeAll(() => {
	host.initTheme("dark");
	tui.setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

export async function makeSelector(
	count = 24,
	scoped = false,
	Selector = host.ModelSelectorComponent,
) {
	const models = Array.from({ length: count }, (_, i) => ({
		provider: "fixture",
		id: `model-${String(i).padStart(2, "0")}`,
		name: `模型名称 ${i} with a long descriptive name`,
	}));
	const runtime = {
		getAvailableSnapshot: () => models,
		getModel: (_provider: string, id: string) => models.find((model) => model.id === id),
		getError: () => undefined,
		refresh: async () => ({ errors: new Map(), aborted: false }),
	};
	const selected = vi.fn();
	const saved = vi.fn();
	const terminal = { rows: 65, columns: 80 };
	const selector = new Selector(
		{ requestRender: vi.fn(), terminal } as never,
		undefined,
		runtime as never,
		scoped ? (models.slice(0, 14).map((model) => ({ model })) as never) : [],
		selected,
		vi.fn(),
		undefined,
		saved,
	);
	disposers.push(() => selector.dispose());
	await new Promise<void>((resolve) => setImmediate(resolve));
	const state = selectorState(selector);
	expect(state).toBeDefined();
	if (!state) throw new Error("Real Pi selector no longer satisfies the adapter contract");
	return { selector, state, models, selected, saved, terminal };
}

export function requiredGeometry(value: unknown, width: number) {
	const geometry = selectorGeometry(value, width);
	if (!geometry) throw new Error("Expected verified native selector geometry");
	return geometry;
}
