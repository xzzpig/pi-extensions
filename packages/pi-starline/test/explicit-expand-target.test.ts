/**
 * Fork-only tests for the explicit expand-target consumer
 * (change task 4.2).
 *
 * Pins the defensive contract: without a provider the seam returns
 * undefined and `expandTargetAt` keeps its existing behavior; a provider
 * with the wrong version, an invalid shape, or a throwing resolver degrades
 * safely; and a valid provider's target wins over the carrier's own
 * `setExpanded` resolution — clicking a summary toggles the group object,
 * not the tool that carries it.
 *
 * No hand-written BoxLike: every scene is a real ScrollView over a real
 * Container graph, laid out by pi-tui, with every row found in the output
 * (the discipline of `test/mouse/tool-box.test.ts`).
 */

import {
	Container,
	ScrollView,
	stripTerminalSequences,
	Text,
	VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { describe, expect, test } from "vitest";
import {
	EXPAND_TARGET_KEY,
	explicitExpandTargetAt,
} from "../extensions/starline/mouse/explicit-expand-target.ts";
import type { BoxLike } from "../extensions/starline/mouse/hit-test.ts";
import { expandTargetAt } from "../extensions/starline/mouse/tool-box.ts";

const WIDTH = 60;
const KEY = "ctrl+o";

/** An expandable carrier: has its own setExpanded, like a tool component. */
class CarrierComponent {
	expanded = false;
	setExpandedCalls: boolean[] = [];

	constructor(private readonly summary: string) {}

	setExpanded(expanded: boolean): void {
		this.setExpandedCalls.push(expanded);
		this.expanded = expanded;
	}

	render(): string[] {
		return [this.summary, "carrier row two"];
	}
}

function makeScene(carrier: CarrierComponent) {
	const document = new Container();
	const chat = new Container();
	document.addChild(chat);
	chat.addChild(new Text("first message", 0, 0));
	chat.addChild(carrier as never);
	const scroll = new ScrollView(document);
	const layout = () => {
		const root = new VStack([
			{ component: scroll, grow: 1 },
			{ component: new Text("dock", 0, 0) },
		]);
		const frame = renderLayoutFrame(root, WIDTH, 24, () => {});
		const scrollBox = frame.root.children[0] as BoxLike & {
			scrollContentLines?: readonly string[];
		};
		const contentBox = (scrollBox.children ?? [])[0];
		if (!contentBox) throw new Error("no content box");
		const lines = (scrollBox.scrollContentLines ?? []) as readonly string[];
		return { root: frame.root as BoxLike, lines, originY: contentBox.rect.y };
	};
	return { layout };
}

function sceneYOf(lines: readonly string[], needle: string, originY: number): number {
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes(needle));
	if (row < 0) throw new Error(`no row contains ${needle}`);
	return originY + row;
}

function publish(component: object, resolver: (row: number) => unknown): void {
	(component as Record<PropertyKey, unknown>)[EXPAND_TARGET_KEY] = {
		version: 1,
		resolveLocalTarget: resolver,
	};
}

describe("explicitExpandTargetAt", () => {
	test("no provider returns undefined", () => {
		expect(explicitExpandTargetAt(new Text("plain", 1, 0), 0, WIDTH)).toBeUndefined();
		expect(explicitExpandTargetAt(null, 0, WIDTH)).toBeUndefined();
		expect(explicitExpandTargetAt(undefined, 0, WIDTH)).toBeUndefined();
	});

	test("a wrong version is not this protocol", () => {
		const component = new Text("x", 1, 0) as unknown as Record<PropertyKey, unknown>;
		component[EXPAND_TARGET_KEY] = {
			version: 2,
			resolveLocalTarget: () => undefined,
		};
		expect(explicitExpandTargetAt(component, 0, WIDTH)).toBeUndefined();
	});

	test("a non-callable resolver is rejected", () => {
		const component = new Text("x", 1, 0) as unknown as Record<PropertyKey, unknown>;
		component[EXPAND_TARGET_KEY] = { version: 1, resolveLocalTarget: "no" };
		expect(explicitExpandTargetAt(component, 0, WIDTH)).toBeUndefined();
	});

	test("a throwing resolver degrades to undefined", () => {
		const component = new Text("x", 1, 0) as unknown as Record<PropertyKey, unknown>;
		publish(component, () => {
			throw new Error("boom");
		});
		expect(explicitExpandTargetAt(component, 0, WIDTH)).toBeUndefined();
	});

	test("an invalid resolved shape is rejected", () => {
		const cases: unknown[] = [
			undefined,
			null,
			{ expanded: "yes" },
			{ expanded: true },
			{ expanded: true, component: {} },
			{ expanded: true, component: { setExpanded: "no" } },
		];
		for (const resolved of cases) {
			const component = new Text("x", 1, 0) as unknown as Record<PropertyKey, unknown>;
			publish(component, () => resolved);
			expect(explicitExpandTargetAt(component, 0, WIDTH)).toBeUndefined();
		}
	});

	test("a valid provider resolves with its direction", () => {
		const group = {
			expanded: false,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
		};
		const component = new Text("summary", 1, 0) as unknown as Record<PropertyKey, unknown>;
		publish(component, (row) =>
			row === 0 ? { component: group, expanded: !group.expanded } : undefined,
		);
		const hit = explicitExpandTargetAt(component, 0, WIDTH);
		expect(hit?.component).toBe(group);
		expect(hit?.expanded).toBe(true);
		expect(explicitExpandTargetAt(component, 1, WIDTH)).toBeUndefined();
	});
});

describe("expandTargetAt with the seam", () => {
	test("without a provider the carrier resolves exactly as before", () => {
		const carrier = new CarrierComponent("carrier summary");
		const { layout } = makeScene(carrier);
		const { root, lines, originY } = layout();
		const y = sceneYOf(lines, "carrier summary", originY);
		const target = expandTargetAt({ root, keyText: KEY }, 1, y);
		// The carrier itself, direction from its own state field.
		expect(target?.component).toBe(carrier);
		expect(target?.expanded).toBe(true);
	});

	test("a provider wins on its row; other rows fall back to the carrier", () => {
		const carrier = new CarrierComponent("carrier summary");
		const group = {
			expanded: true,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
		};
		publish(carrier, (row) =>
			row === 0 ? { component: group, expanded: !group.expanded } : undefined,
		);
		const { layout } = makeScene(carrier);
		const { root, lines, originY } = layout();

		const summaryY = sceneYOf(lines, "carrier summary", originY);
		const hit = expandTargetAt({ root, keyText: KEY }, 1, summaryY);
		expect(hit?.component).toBe(group);
		expect(hit?.expanded).toBe(false);

		// The second row misses the provider and resolves the carrier itself.
		const secondY = sceneYOf(lines, "carrier row two", originY);
		const fallback = expandTargetAt({ root, keyText: KEY }, 1, secondY);
		expect(fallback?.component).toBe(carrier);
	});

	test("a broken provider leaves the existing behavior intact", () => {
		const carrier = new CarrierComponent("carrier summary");
		publish(carrier, () => {
			throw new Error("boom");
		});
		const { layout } = makeScene(carrier);
		const { root, lines, originY } = layout();
		const y = sceneYOf(lines, "carrier summary", originY);
		const target = expandTargetAt({ root, keyText: KEY }, 1, y);
		expect(target?.component).toBe(carrier);
		expect(target?.expanded).toBe(true);
	});

	test("toggling through the hit target never touches the carrier", () => {
		const carrier = new CarrierComponent("carrier summary");
		const group = {
			expanded: false,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
		};
		publish(carrier, (row) =>
			row === 0 ? { component: group, expanded: !group.expanded } : undefined,
		);
		const { layout } = makeScene(carrier);
		const { root, lines, originY } = layout();
		const y = sceneYOf(lines, "carrier summary", originY);
		const hit = expandTargetAt({ root, keyText: KEY }, 1, y);
		hit?.component.setExpanded(hit.expanded);
		expect(group.expanded).toBe(true);
		expect(carrier.setExpandedCalls).toEqual([]);
		expect(carrier.expanded).toBe(false);
	});
});
