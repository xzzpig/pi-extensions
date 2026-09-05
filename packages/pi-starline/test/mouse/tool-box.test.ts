/**
 * Click-to-expand, against Pi's real layout engine.
 *
 * There is no hand-written `BoxLike` in here on purpose. The original plan for
 * this feature had one, and it described a tree production never builds: a box
 * per tool box, nested under the transcript's. `renderLayoutFrame` gives the
 * whole transcript a single leaf box (pinned in
 * `test/contract/transcript-layout.test.ts`), so every scene below is a real
 * `ScrollView` over a real `Container` graph, laid out by pi-tui, with every
 * row number *found* in the output rather than counted by hand.
 */

import {
	Container,
	getKeybindings,
	KeybindingsManager,
	ScrollView,
	setKeybindings,
	stripTerminalSequences,
	Text,
	VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import type { BoxLike } from "../../extensions/starline/mouse/hit-test";
import {
	expandHintAction,
	expandKeyText,
	expandTargetAt,
} from "../../extensions/starline/mouse/tool-box";
import {
	AnchoredFramedToolComponent,
	EXPAND_KEY_TEXT,
	ExpandableText,
	expandHintLine,
	HintedToolComponent,
	MouseAwareComponent,
	StatelessExpandableComponent,
	UnderscoreStateComponent,
} from "./component-graph";
import { installMouseShim } from "./shim";

const WIDTH = 60;

/**
 * A transcript in a scroll view, laid out for real.
 *
 * The prose message is the case the hint rule has to survive: an ordinary
 * message that *says* `ctrl+o to expand`. It is a plain `Text`, so it exposes
 * no `setExpanded` — which is what makes it inert, and why the rule is asked
 * of the resolved component rather than of the screen.
 */
function makeScene(height = 24, toolOverride?: HintedToolComponent | AnchoredFramedToolComponent) {
	const document = new Container();
	const chat = new Container();
	document.addChild(chat);
	chat.addChild(new Text("first message", 0, 0));
	const tool =
		toolOverride ?? new HintedToolComponent("bash echo hi", ["out one", "out two", "out three"], 1);
	chat.addChild(tool);
	const prose = new Text(`press (${EXPAND_KEY_TEXT} to expand) for the rest`, 0, 0);
	chat.addChild(prose);
	const scroll = new ScrollView(document);

	const layout = () => {
		const root = new VStack([
			{ component: scroll, grow: 1 },
			{ component: new Text("dock", 0, 0) },
		]);
		const frame = renderLayoutFrame(root, WIDTH, height, () => {});
		const scrollBox = frame.root.children[0] as BoxLike & {
			scrollView?: unknown;
			scrollContentLines?: readonly string[];
		};
		const contentBox = (scrollBox.children ?? [])[0];
		if (!contentBox) throw new Error("the scroll view laid out no content box");
		return {
			root: frame.root as BoxLike,
			lines: (scrollBox.scrollContentLines ?? []) as readonly string[],
			originY: contentBox.rect.y,
		};
	};

	return { document, chat, tool, prose, scroll, layout };
}

/** The content row whose plain text contains `needle`, found not counted. */
function rowContaining(lines: readonly string[], needle: string): number {
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes(needle));
	if (row < 0) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	return row;
}

function lookupFor(scene: ReturnType<typeof makeScene>, keyText = EXPAND_KEY_TEXT) {
	const { root, lines, originY } = scene.layout();
	return {
		lookup: { root, keyText },
		/** Screen y of the content row containing `needle`. */
		screenY: (needle: string) => originY + rowContaining(lines, needle),
		lines,
		originY,
	};
}

describe("expandHintAction", () => {
	it("reads a collapsed hint as an invitation to expand", () => {
		expect(expandHintAction(expandHintLine(EXPAND_KEY_TEXT, false), EXPAND_KEY_TEXT)).toBe(
			"expand",
		);
	});

	it("reads an expanded hint as an invitation to collapse", () => {
		expect(expandHintAction(expandHintLine(EXPAND_KEY_TEXT, true), EXPAND_KEY_TEXT)).toBe(
			"collapse",
		);
	});

	it("ignores an ordinary line", () => {
		expect(expandHintAction("out one", EXPAND_KEY_TEXT)).toBeUndefined();
		expect(expandHintAction("... 3 more lines", EXPAND_KEY_TEXT)).toBeUndefined();
	});

	it("needs the parentheses Pi always renders around the hint", () => {
		expect(expandHintAction(`${EXPAND_KEY_TEXT} to expand`, EXPAND_KEY_TEXT)).toBeUndefined();
	});

	it("needs this session's own key, not the phrase alone", () => {
		expect(expandHintAction("(press enter to expand)", EXPAND_KEY_TEXT)).toBeUndefined();
	});

	it("declines everything when no key is bound, rather than matching the phrase", () => {
		// `keyText` is "" when `app.tools.expand` has no keys. Without this guard
		// the pattern would degrade to "(… to expand)" and match ordinary prose.
		expect(expandHintAction(expandHintLine("", false), "")).toBeUndefined();
	});

	it("survives the frame pi-toolbox draws around the row", () => {
		const framed = `│ ${expandHintLine(EXPAND_KEY_TEXT, false)}   │`;
		expect(expandHintAction(framed, EXPAND_KEY_TEXT)).toBe("expand");
	});

	it("matches the capitalized hint pi-mcp-adapter renders", () => {
		// tool-result-renderer.ts hardcodes `(Ctrl+O to expand)` instead of
		// asking Pi's `keyText`; a case-sensitive match made MCP boxes the one
		// box a click could not open.
		expect(expandHintAction("(Ctrl+O to expand)", EXPAND_KEY_TEXT)).toBe("expand");
		expect(expandHintAction("(Ctrl+O to collapse)", EXPAND_KEY_TEXT)).toBe("collapse");
	});
});

describe("expandKeyText", () => {
	const original = getKeybindings();
	afterEach(() => setKeybindings(original));

	it("reads the key actually bound to app.tools.expand", () => {
		setKeybindings(
			new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }) as never,
		);
		expect(expandKeyText()).toBe("ctrl+o");
	});

	it("honours a user rebinding", () => {
		setKeybindings(
			new KeybindingsManager(
				{ "app.tools.expand": { defaultKeys: "ctrl+o" } },
				{
					"app.tools.expand": "ctrl+t",
				},
			) as never,
		);
		expect(expandKeyText()).toBe("ctrl+t");
	});

	it("is empty when nothing is bound", () => {
		setKeybindings(new KeybindingsManager({}) as never);
		expect(expandKeyText()).toBe("");
	});
});

describe("expandTargetAt", () => {
	it("resolves the tool box from a press on its hint row", () => {
		const scene = makeScene();
		const { lookup, screenY } = lookupFor(scene);

		const target = expandTargetAt(lookup, 4, screenY("to expand)"));

		expect(target?.component).toBe(scene.tool);
		expect(target?.expanded).toBe(true);
	});

	it("resolves any row of the box, with the direction from its state field", () => {
		const scene = makeScene();
		const { lookup, screenY } = lookupFor(scene);

		// Collapsed: title and body rows carry no hint, so the state field
		// (expanded === false) is the direction — open it.
		const title = expandTargetAt(lookup, 4, screenY("bash echo hi"));
		expect(title?.component).toBe(scene.tool);
		expect(title?.expanded).toBe(true);
		const body = expandTargetAt(lookup, 4, screenY("out one"));
		expect(body?.component).toBe(scene.tool);
		expect(body?.expanded).toBe(true);

		// Expanded: the same body row now reads the field the other way — close
		// it. This is the click the old hint-only rule had no target for.
		scene.tool.setExpanded(true);
		const reopened = lookupFor(scene);
		const shut = expandTargetAt(reopened.lookup, 4, reopened.screenY("out one"));
		expect(shut?.component).toBe(scene.tool);
		expect(shut?.expanded).toBe(false);
	});

	it("does not fire on a message that merely quotes the hint", () => {
		// The prose row reads exactly like a hint. It is a `Text`, so nothing in
		// its path exposes `setExpanded` and there is nothing to toggle.
		const scene = makeScene();
		const { lookup, screenY } = lookupFor(scene);

		expect(expandTargetAt(lookup, 4, screenY("for the rest"))).toBeUndefined();
	});

	it("asks to collapse once the box is open, via the hint the row carries", () => {
		const scene = makeScene();
		scene.tool.setExpanded(true);
		const { lookup, screenY } = lookupFor(scene);

		const target = expandTargetAt(lookup, 4, screenY("to collapse)"));

		expect(target?.component).toBe(scene.tool);
		expect(target?.expanded).toBe(false);
	});

	it("asks to collapse from the anchor pi-toolbox draws inside the frame", () => {
		// For the tool types `ToolExecutionComponent` covers, Pi renders no
		// hint at all once expanded — the collapse anchor is a row pi-toolbox
		// appends inside the frame. It is the component's own rendered row, so
		// the same hint rule resolves it.
		const tool = new AnchoredFramedToolComponent("read file.ts", [
			"line one",
			"line two",
			"line three",
		]);
		tool.setExpanded(true);
		const scene = makeScene(24, tool);
		const { lookup, screenY } = lookupFor(scene);

		const target = expandTargetAt(lookup, 4, screenY("to collapse)"));

		expect(target?.component).toBe(tool);
		expect(target?.expanded).toBe(false);
	});

	it("converts a screen row through the scrolled content origin", () => {
		// A short viewport, scrolled to the end: content row N is no longer
		// screen row N, and the box's hint is only reachable through the origin.
		const scene = makeScene(4);
		scene.layout();
		scene.scroll.scrollToEnd();
		const { lookup, screenY, originY } = lookupFor(scene);

		expect(originY).toBeLessThan(0);
		expect(expandTargetAt(lookup, 4, screenY("to expand)"))?.component).toBe(scene.tool);
	});

	it("takes the direction from the state field when no row carries a hint", () => {
		// `ExpandableText` renders no hint in either state — the shape of the
		// skill/branch/compaction summaries once expanded, which the old
		// hint-only rule could never close.
		const scene = makeScene();
		const stateful = new ExpandableText(["shut", "for now"]);
		scene.chat.addChild(stateful);
		const { lookup, screenY } = lookupFor(scene);

		const target = expandTargetAt(lookup, 4, screenY("for now"));
		expect(target?.component).toBe(stateful);
		expect(target?.expanded).toBe(true);

		stateful.setExpanded(true);
		const reopened = lookupFor(scene);
		const shut = expandTargetAt(reopened.lookup, 4, reopened.screenY("for now"));
		expect(shut?.component).toBe(stateful);
		expect(shut?.expanded).toBe(false);
	});

	it("reads the state under its other spelling too — custom entries use `_expanded`", () => {
		const scene = makeScene();
		const stateful = new UnderscoreStateComponent();
		scene.chat.addChild(stateful);
		const { lookup, screenY } = lookupFor(scene);

		const target = expandTargetAt(lookup, 4, screenY("state shut"));
		expect(target?.component).toBe(stateful);
		expect(target?.expanded).toBe(true);
	});

	it("declines a component it cannot read the state of, rather than guessing", () => {
		const scene = makeScene();
		const stateless = new StatelessExpandableComponent();
		scene.chat.addChild(stateless);
		const { lookup, screenY } = lookupFor(scene);

		expect(expandTargetAt(lookup, 4, screenY("state shut"))).toBeUndefined();
	});

	it("leaves a click alone when a component on the row's path handles the mouse", () => {
		// The target itself declares `onMouse`: the layout folds the transcript
		// into one box, so dispatch can never hand it the event, and the only
		// way its handler can mean what it says is for this rule to bow out.
		const direct = makeScene();
		direct.chat.addChild(new MouseAwareComponent());
		const directLookup = lookupFor(direct);
		expect(
			expandTargetAt(directLookup.lookup, 4, directLookup.screenY("clicks are mine")),
		).toBeUndefined();

		// The same guard for a child *deeper* than the expandable target: the
		// box would be toggled, but the row belongs to the child.
		const nested = makeScene();
		nested.tool.addChild(new MouseAwareComponent());
		const nestedLookup = lookupFor(nested);
		expect(
			expandTargetAt(nestedLookup.lookup, 4, nestedLookup.screenY("clicks are mine")),
		).toBeUndefined();
	});

	it("declines a point outside any scroll view", () => {
		const scene = makeScene();
		const { lookup } = lookupFor(scene);

		// The dock row below the viewport belongs to no scroll view.
		expect(expandTargetAt(lookup, 4, 23)).toBeUndefined();
		expect(expandTargetAt(lookup, 4, -1)).toBeUndefined();
	});

	it("declines when no key is bound to app.tools.expand", () => {
		const scene = makeScene();
		const { lookup, screenY } = lookupFor(scene);

		expect(expandTargetAt({ ...lookup, keyText: "" }, 4, screenY("to expand)"))).toBeUndefined();
	});

	it("declines without a layout", () => {
		expect(expandTargetAt({ root: undefined, keyText: EXPAND_KEY_TEXT }, 0, 0)).toBeUndefined();
	});
});

type FakeMouseEvent = { button: number; x: number; y: number; release: boolean };

const PRESS = 0;
const DRAG = 32;
const WHEEL_UP = 64;
const RIGHT_BUTTON = 2;

function makeConfig(clickToExpandTools: boolean): () => PolishedTuiConfig {
	return () =>
		({
			mouse: {
				enabled: true,
				wheelRouting: true,
				copyNotice: true,
				clickToExpandTools,
			},
		}) as PolishedTuiConfig;
}

/**
 * A prototype carrying everything `clickToExpandTools` is gated on, plus a
 * real layout to resolve against. `handleSelectionMouseEvent` records that it
 * was reached, which is how "the press still starts a selection" is asserted.
 */
function makeInstallScene(options?: {
	overlay?: boolean;
	height?: number;
	tool?: HintedToolComponent | AnchoredFramedToolComponent;
}) {
	const scene = makeScene(options?.height ?? 24, options?.tool);
	const throughCalls: FakeMouseEvent[] = [];
	const renders: string[] = [];
	const prototype = {
		handleSelectionMouseEvent(event: FakeMouseEvent) {
			throughCalls.push(event);
		},
		hasOverlay() {
			return options?.overlay === true;
		},
		// The feature consumes the *release* of a plain click, so Pi never
		// reaches its own repaint for it; asking the receiver is the only thing
		// that draws the toggled box.
		requestRender() {
			renders.push("render");
		},
		currentLayout: { root: undefined as BoxLike | undefined },
	};
	/**
	 * Re-lays the scene out and republishes it as `currentLayout`, the way Pi
	 * does on every frame. Row numbers are only ever read from the layout that
	 * is current, never carried across a toggle — a resolution taken before a
	 * render is stale after it.
	 */
	const relayout = () => {
		const { root, lines, originY } = scene.layout();
		prototype.currentLayout.root = root;
		return (needle: string) => originY + rowContaining(lines, needle);
	};
	return { scene, prototype, throughCalls, renders, relayout };
}

describe("installMouse clickToExpandTools", () => {
	const originalKeybindings = getKeybindings();
	let dispose: (() => void) | undefined;

	beforeEach(() => {
		// The double-click debounce reads the wall clock; owning it is what lets
		// a test place its second click inside or past the window.
		vi.useFakeTimers();
	});
	afterEach(() => {
		dispose?.();
		dispose = undefined;
		setKeybindings(originalKeybindings);
		vi.useRealTimers();
	});

	function install(scene: ReturnType<typeof makeInstallScene>, enabled = true) {
		setKeybindings(
			new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }) as never,
		);
		dispose = installMouseShim(scene.prototype, { getConfig: makeConfig(enabled) });
	}

	function send(
		scene: ReturnType<typeof makeInstallScene>,
		y: number,
		button: number,
		release: boolean,
	): void {
		(
			scene.prototype as { handleSelectionMouseEvent(event: FakeMouseEvent): void }
		).handleSelectionMouseEvent({ button, x: 4, y, release });
	}

	function press(scene: ReturnType<typeof makeInstallScene>, y: number, button = PRESS): void {
		send(scene, y, button, false);
	}

	function release(scene: ReturnType<typeof makeInstallScene>, y: number, button = PRESS): void {
		send(scene, y, button, true);
	}

	/** A plain click: press and release on the same cell, no motion between. */
	function click(scene: ReturnType<typeof makeInstallScene>, y: number): void {
		press(scene, y);
		release(scene, y);
	}

	function dragTo(scene: ReturnType<typeof makeInstallScene>, y: number): void {
		send(scene, y, DRAG, false);
	}

	function elapse(ms: number): void {
		vi.setSystemTime(Date.now() + ms);
	}

	it("expands the clicked box on release, and consumes the release", () => {
		const scene = makeInstallScene();
		install(scene);
		const y = scene.relayout()("to expand)");

		press(scene, y);
		// The press is not the click: the box is still shut, and the event went
		// through to Pi's selection anchor.
		expect(scene.scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toEqual([{ button: PRESS, x: 4, y, release: false }]);

		release(scene, y);
		expect(scene.scene.tool.expanded).toBe(true);
		expect(scene.renders).toEqual(["render"]);
		// The consumed release never reaches Pi's own selection handling.
		expect(scene.throughCalls).toHaveLength(1);
	});

	it("toggles from the box's body too — the row need not be the hint", () => {
		const scene = makeInstallScene();
		install(scene);
		const y = scene.relayout()("out one");

		click(scene, y);

		expect(scene.scene.tool.expanded).toBe(true);
	});

	it("collapses it again on a later click over the reopened box's hint", () => {
		const scene = makeInstallScene();
		install(scene);

		click(scene, scene.relayout()("to expand)"));
		expect(scene.scene.tool.expanded).toBe(true);

		// The box re-rendered: the hint moved down and now reads "to collapse".
		// A different cell, so the double-click debounce does not apply.
		click(scene, scene.relayout()("to collapse)"));

		expect(scene.scene.tool.expanded).toBe(false);
	});

	it("collapses a hint-less expanded box through its state field", () => {
		// `AnchoredFramedToolComponent` without `pi-toolbox`'s anchor is the
		// shape of the skill/branch/compaction summaries expanded: no hint row
		// anywhere, so the field is the only direction there is.
		const tool = new AnchoredFramedToolComponent("read file.ts", [
			"line one",
			"line two",
			"line three",
		]);
		tool.setExpanded(true);
		const scene = makeInstallScene({ tool });
		install(scene);
		const y = scene.relayout()("line two");

		click(scene, y);

		expect(tool.expanded).toBe(false);
	});

	it("collapses a framed tool box through pi-toolbox's anchor row", () => {
		const tool = new AnchoredFramedToolComponent("read file.ts", [
			"line one",
			"line two",
			"line three",
		]);
		const scene = makeInstallScene({ tool });
		install(scene);

		click(scene, scene.relayout()("to expand)"));
		expect(tool.expanded).toBe(true);

		click(scene, scene.relayout()("to collapse)"));
		expect(tool.expanded).toBe(false);
	});

	it("still starts a selection when the click drags away", () => {
		const scene = makeInstallScene();
		install(scene);
		const y = scene.relayout()("out one");

		press(scene, y);
		dragTo(scene, y + 1);
		release(scene, y + 1);

		expect(scene.scene.tool.expanded).toBe(false);
		// Press, motion and release all reached Pi untouched — the drag is a
		// selection, and copy-on-select is Pi's own business.
		expect(scene.throughCalls).toHaveLength(3);
	});

	it("does not toggle when the pointer moved between press and release, even back to the same cell", () => {
		const scene = makeInstallScene();
		install(scene);
		const y = scene.relayout()("to expand)");

		press(scene, y);
		dragTo(scene, y + 1);
		release(scene, y);

		expect(scene.scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toHaveLength(3);
	});

	it("does not toggle when the content moved between press and release", () => {
		const scene = makeInstallScene();
		install(scene);
		const y = scene.relayout()("to expand)");
		press(scene, y);

		// A different transcript slides under the pointer before the button
		// comes up: the press's answer is stale, and the release must re-resolve
		// and decline instead of trusting it.
		const other = makeInstallScene();
		other.relayout();
		scene.prototype.currentLayout.root = other.prototype.currentLayout.root;
		release(scene, y);

		expect(scene.scene.tool.expanded).toBe(false);
		// The declined release goes through unconsumed — press and release both
		// reached Pi.
		expect(scene.throughCalls).toHaveLength(2);
	});

	it("lets Pi open the link a click landed on", () => {
		const scene = makeInstallScene();
		(scene.prototype as { pressedUrl?: string }).pressedUrl = "https://example.com";
		install(scene);
		const y = scene.relayout()("to expand)");

		click(scene, y);

		expect(scene.scene.tool.expanded).toBe(false);
		// Press and release both reached Pi — the release is the one that opens
		// the link, and the box keeps its state.
		expect(scene.throughCalls).toHaveLength(2);
	});

	it("stays out of a double-click's second release", () => {
		const scene = makeInstallScene();
		install(scene);
		// The title row keeps its position across the toggle, so both clicks
		// land on the same cell — the shape Pi reads as a word selection.
		const y = scene.relayout()("bash echo hi");

		click(scene, y);
		expect(scene.scene.tool.expanded).toBe(true);
		expect(scene.renders).toEqual(["render"]);

		click(scene, y);
		expect(scene.scene.tool.expanded).toBe(true);
		expect(scene.renders).toEqual(["render"]);
	});

	it("toggles again once the double-click window has passed", () => {
		const scene = makeInstallScene();
		install(scene);
		const y = scene.relayout()("bash echo hi");

		click(scene, y);
		expect(scene.scene.tool.expanded).toBe(true);

		// The same cell, a new click: the field — not the stale hint — now says
		// the box is open, so this one closes it.
		elapse(600);
		click(scene, scene.relayout()("bash echo hi"));
		expect(scene.scene.tool.expanded).toBe(false);
	});

	it("lets a release through when no press of this feature preceded it", () => {
		const scene = makeInstallScene();
		install(scene);
		const y = scene.relayout()("to expand)");

		release(scene, y);

		expect(scene.scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toEqual([{ button: PRESS, x: 4, y, release: true }]);
	});

	it("ignores a wheel notch over the hint row", () => {
		// Pi peels wheel reports off before this handler, but a notch that did
		// arrive here reads as button 0 under the plain left-button mask, and
		// scrolling past a box must never open it.
		const scene = makeInstallScene();
		install(scene);

		press(scene, scene.relayout()("to expand)"), WHEEL_UP);

		expect(scene.scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toHaveLength(1);
	});

	it("ignores a non-left button", () => {
		const scene = makeInstallScene();
		install(scene);

		press(scene, scene.relayout()("to expand)"), RIGHT_BUTTON);

		expect(scene.scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toHaveLength(1);
	});

	it("calls through with the feature switched off", () => {
		const scene = makeInstallScene();
		install(scene, false);
		const y = scene.relayout()("to expand)");

		press(scene, y);
		release(scene, y);

		expect(scene.scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toHaveLength(2);
	});

	it("calls through while an overlay is up", () => {
		// Pi's own press path resolves no scroll view under an overlay
		// (`tui-alt-screen.js:684`); toggling a box hidden behind a dialog would
		// be a click the user never aimed at it.
		const scene = makeInstallScene({ overlay: true });
		install(scene);
		const y = scene.relayout()("to expand)");

		press(scene, y);
		release(scene, y);

		expect(scene.scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toHaveLength(2);
	});
});
