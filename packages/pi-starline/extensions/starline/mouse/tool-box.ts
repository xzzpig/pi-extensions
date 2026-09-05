/**
 * Toggling an expandable transcript component by clicking it.
 *
 * `ctrl+o` toggles every box in the transcript at once, which is a screenful
 * for the one line of output you wanted. This resolves the component under a
 * mouse click and toggles just that one — from any row it renders, not only
 * its hint row.
 *
 * ## The click, not the press
 *
 * The caller (`mouse/index.ts`) never consumes the press: Pi's selection
 * machinery anchors on it, so a drag that starts anywhere on a box — hint row
 * included — still selects and copies text. The toggle happens when the
 * button is released on the very cell it was pressed on with no motion in
 * between. Pi's own release path treats such a plain click as a no-op (an
 * empty selection copies nothing), so consuming the release costs nothing;
 * every other release — a drag, a different cell, a link — goes to Pi
 * untouched.
 *
 * ## Which way to toggle
 *
 * Two sources, in order:
 *
 * 1. **The hint row.** Pi renders it through `keyHint("app.tools.expand",
 *    description)` (`keybinding-hints.js`), which is `theme.fg("dim",
 *    keyText) + theme.fg("muted", " " + description)`, and every call site
 *    wraps it in parentheses: `bash-execution.js:140,143`,
 *    `core/tools/{bash,find,grep,ls,read,write}.js`,
 *    `read.js:91`, `skill-invocation-message.js:42`,
 *    `branch-summary-message.js:39`, `compaction-summary-message.js:40`.
 *    The description carries the *direction*: `to expand` when collapsed, `to
 *    collapse` when expanded.
 * 2. **The component's own state field.** Every expandable component keeps
 *    its state in a runtime-public boolean — `expanded` (bash-execution,
 *    tool-execution, skill/branch/compaction summaries) or `_expanded`
 *    (custom entries and messages) — and every mutation path writes it,
 *    ctrl+o's global fan-out included. Reading it cannot desync the way a
 *    `WeakMap` of "what I last set" would (the row on screen and the field
 *    are both the component's own truth); `expandedStateOf` duck-types both
 *    spellings and declines to guess when neither is a boolean.
 *
 * The field is what lets a click *collapse* from any row. Most of Pi's tool
 * renderers emit the hint only while collapsed (`remaining > 0` in
 * `core/tools/{read,grep,ls,write,find}.js`; the `else` branch of the
 * skill/branch/compaction summaries), so an expanded box used to have no
 * clickable way back at all without `pi-toolbox`'s collapse anchor.
 *
 * ## A component that handles the mouse keeps its clicks
 *
 * If any component on the clicked row's path implements `onMouse`, resolution
 * declines. The layout folds the whole transcript into one box, so
 * `pi-mouse-events` dispatch can never deliver an event to such a component —
 * bowing out here is the only way its `onMouse` can mean what it says.
 *
 * ## Why resolution goes through the component tree
 *
 * `layoutComponent` builds a child box only for a component carrying a
 * `LAYOUT_NODE`, and only `Stack` and `ScrollView` have one. Every message
 * component extends `Container`, which has none, so the whole transcript is a
 * single leaf box and `boxesAt` can never return a tool box. The layout tree
 * is used for exactly what it does know — which scroll view is under the
 * pointer, and where content row 0 sits on screen — and ownership below that
 * comes from `component-tree.ts`. `test/contract/transcript-layout.test.ts`
 * pins both halves against pi-tui's real engine.
 *
 * ## What this deliberately does not do
 *
 * Nothing here looks at how a component *renders* to decide what it is:
 * `isExpandableComponent` asks whether `setExpanded` is callable, and the
 * hint rule is scoped to that component's own rows. An ordinary message that
 * quotes the hint — an assistant explaining `ctrl+o`, a paste of these very
 * docs — is a `Text` or a `Markdown` with no `setExpanded` anywhere in its
 * path, so it resolves to nothing and the click stays a selection.
 *
 * ## Accepted limitation: a box's own output can read like its hint
 *
 * The component scoping above stops a *different* message from being
 * clickable, but not the box's own body: a line inside an expandable
 * component that literally contains `(ctrl+o to expand)` — `cat` of a file
 * documenting the keybinding, a transcript of this very docstring — matches
 * the hint rule and its direction, because Pi renders the box's output and
 * the box's hint through the same `Text` with the same structure and only
 * different theme colours. Matching the colours instead would make the rule
 * depend on the user's theme. Accepted: the worst case is that a click on a
 * box toggles the box it is already inside — no crash, no lost input, and the
 * same click a row above or below behaves normally.
 */

import { keyText } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createComponentTree, isComponentLike, isExpandableComponent } from "./component-tree";
import { type BoxLike, boxesAt, scrollContentLinesFor, scrollContentOrigin } from "./hit-test";

/** The slice of a Pi message component this module calls. */
export type ExpandableComponent = { setExpanded(expanded: boolean): void };

export type ExpandTarget = {
	component: ExpandableComponent;
	/** What `setExpanded` should be called with — the opposite of today. */
	expanded: boolean;
};

export type ExpandLookup = {
	/** `currentLayout.root`, or undefined before the first frame. */
	root: BoxLike | undefined;
	/** `keyText("app.tools.expand")` for this session; "" when unbound. */
	keyText: string;
};

const KEYBINDING = "app.tools.expand";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One press asks one question, but the pattern is the same on every press of a
// session, so it is built once per distinct key text rather than per call.
let cachedKeyText: string | undefined;
let cachedPattern: RegExp | undefined;

function hintPattern(keyText: string): RegExp {
	if (cachedPattern && cachedKeyText === keyText) return cachedPattern;
	// `\([^()]*` is the parenthesis Pi always opens before the hint, with
	// whatever prefix the call site put inside it ("... 12 more lines, ").
	// Case-insensitive: pi-mcp-adapter renders its collapsed-result hint as
	// `(Ctrl+O to expand)` — capitalized, unlike the `ctrl+o` Pi's own
	// `keyText` yields — and a case-sensitive match declined the press, so MCP
	// tool boxes were the one box a click could not open. Widening the match
	// only reaches rows an expandable component renders about its own key, so
	// the cost is the same accepted false positive as limitation 2 above.
	cachedPattern = new RegExp(`\\([^()]*${escapeRegExp(keyText)} to (expand|collapse)\\)`, "i");
	cachedKeyText = keyText;
	return cachedPattern;
}

/**
 * Whether `line` is Pi's expand hint, and which way clicking it goes.
 *
 * The line arrives with theme colours in it, so it is stripped the same way
 * Pi's own `getWordSelection` strips a selection source line. An empty
 * `keyText` declines everything: with no key bound the pattern would collapse
 * to `(… to expand)` and start matching ordinary prose.
 */
export function expandHintAction(line: string, keyText: string): "expand" | "collapse" | undefined {
	if (!keyText) return undefined;
	const match = hintPattern(keyText).exec(stripTerminalSequences(line));
	if (!match) return undefined;
	return match[1] === "collapse" ? "collapse" : "expand";
}

/**
 * The component's current expansion, read off its own state field.
 *
 * Pi's expandable message components keep a runtime-public boolean —
 * `expanded` on bash-execution, tool-execution and the skill/branch/compaction
 * summaries, `_expanded` on custom entries and messages — and every mutation
 * path writes it, ctrl+o's global fan-out included, so it is the component's
 * own current truth rather than a cached copy. A component that exposes
 * neither spelling gets `undefined`: the caller declines to guess.
 */
export function expandedStateOf(component: object): boolean | undefined {
	const fields = component as { expanded?: unknown; _expanded?: unknown };
	if (typeof fields.expanded === "boolean") return fields.expanded;
	if (typeof fields._expanded === "boolean") return fields._expanded;
	return undefined;
}

/** Whether the component declares its own mouse handling (`onMouse`). */
function handlesMouse(component: unknown): boolean {
	return (
		typeof component === "object" &&
		component !== null &&
		typeof (component as { onMouse?: unknown }).onMouse === "function"
	);
}

/**
 * The keys spelled the way the hint on screen spells them.
 *
 * The primary source is `pi-coding-agent`'s own exported `keyText` — literally
 * the function `keyHint` calls to build the text this module then matches, so
 * there is no second formatting rule to drift (it is `keyText` that turns
 * `alt` into `option` on macOS and joins alternatives with "/"), and no second
 * keybinding registry to disagree.
 *
 * That last point is not theoretical. `getKeybindings()` is a *singleton* per
 * copy of pi-tui, and a copy is per `node_modules` tree: in this repo
 * `pi-coding-agent` nests its own pi-tui, so the registry Starline's direct
 * import reaches is not the registry the hints are rendered from. Production
 * resolves both to Pi's own copy, but reading the value through the same
 * package that renders it makes the question moot instead of assumed.
 *
 * pi-tui's registry is kept as a fallback for the case where `keyText` yields
 * nothing — which also means nothing is on screen to match, so the fallback
 * can only ever turn a non-match into a non-match. Both routes return "" when
 * `app.tools.expand` is unbound, and `expandHintAction` reads "" as "no hint
 * rule at all" rather than as a wildcard.
 */
export function expandKeyText(): string {
	return keyTextFor(KEYBINDING);
}

/**
 * `keyText(keybinding)` with the registry fallback, shared by every feature
 * that quotes a key on screen. See `expandKeyText` for why the primary route
 * is pi-coding-agent's own function rather than this repo's registry.
 */
export function keyTextFor(keybinding: string): string {
	try {
		const rendered = keyText(keybinding as never);
		if (typeof rendered === "string" && rendered.length > 0) return rendered;
	} catch {
		// A Pi build that has moved this function is one where quoting the key
		// simply shows nothing; it is never a reason to break a mouse feature.
	}
	return fallbackKeyText(keybinding);
}

/**
 * `keyText` re-derived from pi-tui's registry: keys joined with "/", `alt`
 * shown as `option` on macOS, matching `formatKeyText` in
 * `keybinding-hints.js`.
 */
function fallbackKeyText(keybinding: string): string {
	try {
		const bound: unknown = getKeybindings().getKeys(keybinding as never);
		if (!Array.isArray(bound) || bound.length === 0) return "";
		const keys = bound.filter((key): key is string => typeof key === "string");
		return keys
			.map((key: string) =>
				key
					.split("+")
					.map((part) =>
						process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part,
					)
					.join("+"),
			)
			.join("/");
	} catch {
		return "";
	}
}

/** The innermost scroll view whose box contains the screen cell. */
function scrollViewAt(root: BoxLike, x: number, y: number): unknown {
	let found: unknown;
	for (const box of boxesAt(root, x, y)) {
		const scrollView = (box as { scrollView?: unknown }).scrollView;
		if (scrollView !== undefined) found = scrollView;
	}
	return found;
}

/**
 * The expandable component under screen cell (`x`, `y`) and the expansion to
 * set on it, or undefined when that cell is anything else.
 *
 * The whole component tree is built and thrown away on every call: it holds
 * no invalidation and a running tool re-renders under it (a
 * `BashExecutionComponent` carries a ticking `Loader`), so the answer is only
 * true of the frame that is on screen at this instant. Callers act on it
 * inside the same event or not at all — the click flow in `mouse/index.ts`
 * resolves once at press (identity only) and once more at release (action).
 */
export function expandTargetAt(
	lookup: ExpandLookup,
	x: number,
	y: number,
): ExpandTarget | undefined {
	// Renamed on the way out of `lookup` so it cannot be read as this module's
	// imported `keyText` function.
	const { root, keyText: keys } = lookup;
	// The keybinding gates the whole feature, hint rule included: an unbound
	// `app.tools.expand` is a user with the expand affordances off, and "" is
	// read as "no hint rule at all" rather than as a wildcard.
	if (!root || !keys) return undefined;

	const scrollView = scrollViewAt(root, x, y);
	if (scrollView === undefined) return undefined;
	const lines = scrollContentLinesFor(root, scrollView);
	const origin = scrollContentOrigin(root, scrollView);
	if (!lines || !origin) return undefined;
	if (!isComponentLike(origin.component)) return undefined;

	// The content box is laid out at `viewportY - scrollTop`, so a screen row
	// becomes a content row by subtracting its origin — the relation pinned in
	// `test/contract/transcript-layout.test.ts`.
	const row = y - origin.rect.y;
	if (row < 0 || row >= lines.length) return undefined;

	const tree = createComponentTree(origin.component, origin.rect.width, lines);
	const path = tree.pathAt(row);

	// A component anywhere on the path that handles the mouse itself owns this
	// click. The layout folds the transcript into one box, so `pi-mouse-events`
	// dispatch can never deliver an event to it — the only way its `onMouse`
	// can mean what it says is for this module to bow out.
	for (const span of path) {
		if (handlesMouse(span.component)) return undefined;
	}

	for (let index = path.length - 1; index >= 0; index--) {
		const span = path[index];
		if (!isExpandableComponent(span.component)) continue;
		const component = span.component as ExpandableComponent;
		// The hint is matched against this component's own rendered row, not
		// against the transcript, so nothing outside the box it would toggle can
		// stand in for its hint.
		const action = expandHintAction(span.lines[row - span.start] ?? "", keys);
		if (action) return { component, expanded: action === "expand" };
		// No hint on this row — or none rendered in this state, which is most
		// components once expanded. The state field is the direction now, and a
		// component that exposes neither source is not guessed at.
		const state = expandedStateOf(component);
		if (state === undefined) return undefined;
		return { component, expanded: !state };
	}
	return undefined;
}
