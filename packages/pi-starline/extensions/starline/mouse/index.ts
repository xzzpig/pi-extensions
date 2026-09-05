/**
 * Starline's mouse feature set, as a consumer of the `pi-mouse-events`
 * extension.
 *
 * Starline used to install this feature set itself, by wrapping four methods
 * on `TuiAltScreen.prototype`. It no longer touches any prototype: the
 * `pi-mouse-events` extension owns that surface now, and everything here
 * rides on the API it publishes (`mouse/api-consumer.ts` reads it off
 * `globalThis`). When that extension is not installed there is no fallback —
 * `installMouseFeaturesOn` is never called, no handler is registered, the
 * hints derive from nothing, and every mouse feature is simply off. That is
 * the deal: one owner for the prototype, Starline as a plain consumer.
 *
 * The features themselves are unchanged, and each maps onto one API slot:
 *
 * `editorWheelScroll` → `addMouseHandler`
 * - A wheel notch that landed on the input box scrolls the *draft*, when the
 *   draft is taller than the box. `pi-mouse-events` delivers the notch before
 *   Pi's built-in wheel routing; consuming it here is what stops the
 *   transcript from scrolling too. `editor-mouse.ts` carries how the box is
 *   located and how the live editor is reached; the scroll itself is
 *   `editor-scroll.ts`.
 *
 * `clickToExpandTools` → `addMouseHandler`
 * - A left-button press anywhere on an expandable component records the
 *   candidate; when the button is released on the same cell with no motion in
 *   between — a plain click — that one component is toggled and the release
 *   is consumed, so the click does not also drop a selection anchor into the
 *   box it just opened. The press itself is never consumed: a drag that
 *   starts on a box, hint row included, still selects and copies, a click on
 *   an OSC 8 link still opens the link, and a second same-cell click inside
 *   Pi's double-click window stays a word selection. Direction comes from the
 *   hint row when one is rendered and from the component's own `expanded`
 *   state otherwise; `tool-box.ts` carries the reasoning and the accepted
 *   limitation about a box's own output reading like its hint.
 *
 * `editorClickToCaret` → `addMouseHandler` + `ctx.ui.onTerminalInput`
 * - The press half: a left-button press inside the input box moves the caret
 *   to the character under it and never consumes, so Pi still drops its
 *   selection anchor there and a drag from that point still selects and
 *   highlights as it always did. `editor-caret.ts` carries the
 *   screen-to-buffer arithmetic.
 * - The keyboard half: backspace or delete over a live selection inside the
 *   input box removes the whole range instead of one character, through the
 *   editor's own `handleForwardDelete` under a single undo snapshot. This
 *   used to ride the same viewport-input patch as everything else; it is
 *   keyboard, and `ctx.ui.onTerminalInput` — Pi's official extension input
 *   listener, which the renderer's mouse handling never swallows — is the
 *   honest place for it. `isRangeDeleteKey` refuses ctrl+c and ctrl+d
 *   outright, so the interrupt and exit chords cannot be swallowed by it from
 *   either direction. Every backspace it does not act on falls through and
 *   deletes one character.
 *
 * `editorBufferCopy` + `transcriptCleanCopy` → `addCopyHandler`
 * - The copy key's path. A selection lying inside the input box is copied
 *   from the *draft* rather than from the rendered rows — the rows carry the
 *   rail glyph, the frame's padding, and a hard newline wherever the draft
 *   happened to wrap. A selection in the transcript is copied with the chrome
 *   two components paint around their content removed (Starline's rails and
 *   border rules, `pi-toolbox`'s rounded frames); the cleaning itself is
 *   `transcript-copy.ts`, and a selection with no recognised decoration falls
 *   back to Pi's verbatim copy.
 *
 * `selectionHint` → derived, no slot at all
 * - `activeSelectionHintText()` renders the live renderer's state — an active
 *   selection that is not being auto-copied (`getCopyOnSelect() === false`) —
 *   so select-without-copy is Pi's own `fullscreenCopyOnSelect`, and this
 *   module only tells the user what to press. It is computed on demand at
 *   render time from the lazily bound renderer reference (`bindReceiver`);
 *   there is nothing to intercept.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { MouseEventsApi } from "@xzzpig/pi-mouse-events/api";
import type { PolishedTuiConfig } from "../config";
import {
	disabledFeatureWarning,
	enabledFeatures,
	type MouseFeature,
	probeCapabilities,
} from "./capabilities";
import {
	activeEditorViewport,
	deleteEditorSelection,
	editorSelectionTextFor,
	moveEditorCaretTo,
} from "./editor-caret";
import { activeEditor, pointerOverEditor } from "./editor-mouse";
import { scrollEditorBy } from "./editor-scroll";
import { editorVisualRowCount } from "./editor-text-cursor";
import { type BoxLike, scrollContentLinesFor } from "./hit-test";
import { externalEditorName, selectionHintText } from "./selection-state";
import { type ExpandTarget, expandKeyText, expandTargetAt, keyTextFor } from "./tool-box";
import { cleanTranscriptRows } from "./transcript-copy";

/** Pi's interrupt chord — refused by the range-delete branch, never consumed. */
const CTRL_C = "\x03";
/** Pi's exit chord, and `tui.editor.deleteCharForward`'s second default key. */
const CTRL_D = "\x04";

/** The binding Pi's selection copy lives on (`app.message.copy`, default ctrl+x). */
const COPY_KEYBINDING = "app.message.copy";

/**
 * Pi's own double-click window (`DOUBLE_CLICK_INTERVAL_MS` in
 * `tui-alt-screen.js`). A second same-cell click inside it is a word
 * selection to Pi; without the debounce the expand flow would read it as
 * another plain click and toggle the box right back.
 */
const DOUBLE_CLICK_MS = 500;

/** Opens the draft in `$EDITOR` — the hint an editor selection's hint carries. */
const EXTERNAL_EDITOR_KEYBINDING = "app.editor.external";

/**
 * SGR mouse bits, as pi-tui's `parseSgrMouseEvent` decodes them. `button & 3`
 * is the button — 0 is left — bit 32 marks a motion (drag) report and bit 64
 * a wheel notch. `release` is the `m`/`M` terminator.
 */
const BUTTON_MASK = 3;
const LEFT_BUTTON = 0;
const MOTION_BIT = 32;
const WHEEL_BIT = 64;

type MouseEventLike = { button: number; x: number; y: number; release?: boolean };

type SelectionPoint = { scrollView?: unknown; row: number; col: number; boundary?: boolean };
type SelectionBounds = { start: SelectionPoint; end: SelectionPoint };
type SelectionColumns = { start: number; end: number };

/**
 * The slice of the live renderer this module reads. Reached through the
 * `pi-mouse-events` handler context (`tui`) and its `liveReceiver()` hook —
 * pi-tui 0.84.x internals, TS-private but runtime-present, the same surface
 * its own consumers reach.
 */
export type MouseCapableReceiver = {
	getSelectionBounds?(): SelectionBounds | undefined;
	getSelectionColumns(
		this: unknown,
		line: string,
		row: number,
		selection: SelectionBounds,
	): SelectionColumns;
	getCopyOnSelect?(this: unknown): boolean;
	hasActiveSelection?(this: unknown): boolean;
	flash?(this: unknown, message: string, durationMs?: number): void;
	hasOverlay?(this: unknown): boolean;
	requestRender?(this: unknown, force?: boolean): void;
	previousScreen?: readonly string[];
	currentLayout?: { root: BoxLike };
	selectionAnchor?: unknown;
	selectionFocus?: unknown;
	terminal?: { rows?: number; write?: (data: string) => void };
	wheelScrollLines?: number;
};

export type InstallMouseDeps = {
	getConfig: () => PolishedTuiConfig;
};

/** Logged at most once per process — see `disabledFeatureWarning`. */
let hasWarned = false;

/**
 * The live renderer, bound lazily — see `bindReceiver`.
 */
let activeReceiver: MouseCapableReceiver | undefined;

/**
 * Reader for the derived selection hint, mirroring `pasteExpandHintText`'s
 * pattern in `../paste-collapse.ts`. `ui.ts` composes this with the paste hint
 * on every render; there is nothing to wire when no mouse install is active.
 *
 * The hint is computed on demand from the live renderer, never cached:
 * "selected, ctrl+x to copy" is true exactly while Pi is not auto-copying and
 * something is actually selected. The character count goes through the same
 * two copy paths the copy key itself would answer, so the hint's promise and
 * the clipboard's bytes stay in agreement.
 */
let activeHint:
	| { getConfig: () => PolishedTuiConfig; bufferCopy: boolean; cleanCopy: boolean }
	| undefined;

/**
 * Per-install state: how to reach the live renderer (`api.liveReceiver()`),
 * whether the copy slot exists, and the config reader the hint needs. Set at
 * install, cleared on dispose.
 */
let installRefs:
	| {
			liveReceiver: () => unknown;
			copySlot: boolean;
			deps: InstallMouseDeps;
	  }
	| undefined;

/** Whether the probed receiver supports `feature` — false before a first bind. */
function featureOn(feature: MouseFeature): boolean {
	return featureSet?.has(feature) ?? false;
}

/**
 * The press a release-click is waiting to complete. `component` is the
 * candidate resolved at press time — the release re-resolves and requires the
 * same object, so content that scrolled between the two cannot redirect the
 * toggle. `dragged` mirrors Pi's own `selectionDragged`: any button motion
 * between press and release makes it a selection, not a click.
 */
let expandPress: { x: number; y: number; component: object; dragged: boolean } | undefined;

/** The last completed toggle, for the double-click debounce. */
let lastToggle: { x: number; y: number; at: number } | undefined;

let featureSet: ReadonlySet<MouseFeature> | undefined;

/**
 * Binds the renderer this mouse event (or the API's live reference) points at.
 *
 * In a real session there is no renderer to probe at install time: `ctx.ui`
 * is Pi's extension-UI surface, not the renderer, and the live `TuiAltScreen`
 * first appears as `tui` inside a handler invocation and in the API's
 * `liveReceiver()` — which the input wrapper refreshes on every keystroke as
 * well as on every mouse report. Features are therefore registered
 * unconditionally at install and gated here, on the capability set the first
 * bind of each distinct renderer instance computes.
 *
 * With no candidate the last bound receiver stands, so the render-time hint
 * readers and the keyboard listener can work from it without an event of
 * their own.
 */
function bindReceiver(candidate?: unknown): MouseCapableReceiver | undefined {
	if (!installRefs) return undefined;
	const receiver = candidate ?? installRefs.liveReceiver();
	if (!receiver) return activeReceiver;
	if (receiver !== activeReceiver) {
		activeReceiver = receiver as MouseCapableReceiver;
		featureSet = enabledFeatures(probeCapabilities(activeReceiver), installRefs.copySlot);
		const warning = disabledFeatureWarning(featureSet);
		if (warning && !hasWarned) {
			hasWarned = true;
			console.warn(warning);
		}
		const { deps } = installRefs;
		const bufferCopy = featureOn("editorBufferCopy");
		const cleanCopy = featureOn("transcriptCleanCopy");
		activeHint =
			bufferCopy || cleanCopy ? { getConfig: deps.getConfig, bufferCopy, cleanCopy } : undefined;
	}
	return activeReceiver;
}

export function activeSelectionHintText(): string | null {
	const receiver = bindReceiver();
	if (!receiver || !activeHint) return null;
	const { getConfig, bufferCopy, cleanCopy } = activeHint;
	try {
		// Pi auto-copies on release; a selection that is already on the
		// clipboard needs no hint. `getCopyOnSelect()` is the live value, so a
		// setting flipped at runtime flips the hint with it.
		if (receiver.getCopyOnSelect?.()) return null;
		if (!receiver.hasActiveSelection?.()) return null;
		const bounds = receiver.getSelectionBounds?.();
		if (!bounds) return null;
		const pending = pendingSelectionText(receiver, getConfig(), bounds, bufferCopy, cleanCopy);
		return selectionHintText(
			pending.text.length,
			copyKeyText(),
			// An editor selection cannot grow past the visible window — there is
			// no drag-scroll — so the hint for one points at the external editor,
			// the way to act on the whole draft. "" (unbound) shows no suffix.
			pending.inEditor ? keyTextFor(EXTERNAL_EDITOR_KEYBINDING) : undefined,
			externalEditorName(),
		);
	} catch {
		// The renderer is best effort; a receiver that has moved on offers no
		// hint rather than breaking the metadata row.
		return null;
	}
}

/**
 * The "ctrl+g to edit in $EDITOR" hint while the draft outgrows the box.
 *
 * An editor selection cannot grow past the visible window — there is no
 * drag-scroll — so when the draft has more visual rows than the box shows,
 * some of it is unreachable by mouse no matter how you drag. That is exactly
 * when the external editor is the way to act on the whole draft, so the hint
 * is offered whenever the draft outgrows the box, not only while a selection
 * is live. Computed on demand at render time (it used to be refreshed from
 * the viewport patch on every key; the value is a pure read of the live
 * renderer, so deriving it when asked is always at least as fresh).
 */
export function externalEditorHintText(): string | null {
	const receiver = bindReceiver();
	if (!receiver || !activeHint) return null;
	try {
		const viewport = activeEditorViewport(receiver, activeHint.getConfig());
		if (!viewport) return null;
		const visualRows = editorVisualRowCount(viewport.editor);
		if (visualRows > viewport.viewport.contentRows) {
			return `${keyTextFor(EXTERNAL_EDITOR_KEYBINDING)} to edit in ${
				externalEditorName() ?? "$EDITOR"
			}`;
		}
		return null;
	} catch {
		// Best effort: an editor this module cannot read offers no hint.
		return null;
	}
}

/**
 * The rendered name of the copy key, for the hint. `app.message.copy` is what
 * Pi's Ctrl+X path is bound to (see `handleCopyCommand` in
 * interactive-mode.ts), and the registry resolves a user rebind so the hint
 * always quotes the key that really copies.
 */
function copyKeyText(): string {
	return keyTextFor(COPY_KEYBINDING);
}

/**
 * The exact text Pi's selection copy would produce, built the same way it
 * builds it: per row, through the receiver's own `getSelectionColumns`, then
 * `sliceByColumn` and `stripTerminalSequences` (both exported by pi-tui),
 * joined with "\n". Reusing Pi's own helpers instead of re-deriving the
 * column math is what keeps this exact rather than an estimate. The
 * scroll-view case needs the box behind `bounds.start.scrollView`;
 * `getScrollViewBox` is not exported from pi-tui's published entry point, so
 * `scrollContentLinesFor` mirrors its (trivial) tree walk in `hit-test.ts`.
 *
 * This is a *measurement*, not a copy: nothing here writes a clipboard. The
 * pending hint needs to say how many characters ctrl+c would put there. Rows
 * come back verbatim — no frame stripping, no rule-row dropping — so this is
 * the count for a selection Pi's own copy would answer. When
 * `transcriptCleanCopy` would answer the copy instead, `pendingSelectionText`
 * counts the cleaned text — the hint's promise and the clipboard's bytes are
 * kept in agreement there, by counting whichever text the copy will send.
 */
function selectionText(receiver: MouseCapableReceiver, bounds: SelectionBounds): string {
	const scrollView = bounds.start.scrollView;
	const sourceLines = scrollView
		? scrollContentLinesFor(receiver.currentLayout?.root, scrollView)
		: receiver.previousScreen;
	if (!sourceLines) return "";
	const rows: string[] = [];
	for (let row = bounds.start.row; row <= bounds.end.row; row++) {
		const line = sourceLines[row] ?? "";
		const columns = receiver.getSelectionColumns?.(line, row, bounds);
		if (!columns) return "";
		rows.push(
			stripTerminalSequences(
				sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
			).trimEnd(),
		);
	}
	return rows.join("\n");
}

/**
 * Writes the draft's own text to the clipboard for a selection that lies inside
 * the input box, and reports whether it did — `false` means this selection was
 * not the editor's and Pi's own copy must run instead.
 *
 * Pi copies *rendered* rows, so a selection in the input box picks up the rail
 * glyph, the padding the frame fills each row out to, and a newline wherever
 * the draft happened to wrap. None of that is in the draft. The bytes go out
 * the same way Pi's own copy sends them — OSC 52 through `terminal.write` — so
 * nothing downstream can tell the two copies apart.
 *
 * The flash is gated on `copyNotice` at the write itself, exactly once — Pi's
 * own copy flashes unconditionally, so this check is the whole notice path for
 * a clean copy.
 */
function editorTextForSelection(
	receiver: MouseCapableReceiver,
	config: PolishedTuiConfig,
	bounds: SelectionBounds,
): string | undefined {
	try {
		// An overlay is composited over a layout that still contains the editor,
		// so without this a selection dropped on a dialog would be read as text
		// from the draft hidden behind it. Both callers ask it, or the hint could
		// count one text while the copy sends another.
		if (receiver.hasOverlay?.()) return undefined;
		return editorSelectionTextFor(receiver, config, bounds);
	} catch {
		return undefined;
	}
}

function copyEditorSelection(receiver: MouseCapableReceiver, config: PolishedTuiConfig): boolean {
	try {
		const bounds = receiver.getSelectionBounds?.();
		if (!bounds) return false;
		const text = editorTextForSelection(receiver, config, bounds);
		// undefined is "not the editor's"; "" is the editor's and empty, which is
		// still ours to answer — falling through would have Pi copy the rail out
		// of a blank row.
		if (text === undefined) return false;
		if (text.length === 0) return true;
		const write = receiver.terminal?.write;
		if (typeof write !== "function") return false;
		write.call(receiver.terminal, `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		if (config.mouse.copyNotice) receiver.flash?.("Copied!");
		return true;
	} catch {
		// Reading the editor and the layout is best effort. Anything this trips
		// over means Pi's own copy should run.
		return false;
	}
}

/**
 * The transcript's text for this selection with the painted chrome removed,
 * or undefined when there is nothing to clean — in which case Pi's verbatim
 * copy runs, so a selection over plain rows takes exactly the path it always
 * did.
 *
 * Only scroll-view selections are cleaned. A screen-space selection
 * (`bounds.start.scrollView` unset) is over the dock or an overlay, where
 * rows are not transcript content; both stay Pi's. The overlay guard is the
 * same one every feature here asks: an overlay is composited over a layout
 * that still contains the transcript, so without it a selection dropped on a
 * dialog would be read as text from the scrollback behind it.
 *
 * Column mapping: `leftTrim` columns came off the left of a cleaned row, so
 * the selection's start and end columns shift by the same amount on the rows
 * they touch. The shifted bounds go through the receiver's own
 * `getSelectionColumns`, which aligns both ends to grapheme cell ranges — the
 * end column can no more cut a grapheme here than it can in Pi's own copy.
 */
function transcriptSelectionText(
	receiver: MouseCapableReceiver,
	config: PolishedTuiConfig,
	bounds: SelectionBounds,
): string | undefined {
	const scrollView = bounds.start.scrollView;
	if (!scrollView) return undefined;
	if (receiver.hasOverlay?.()) return undefined;
	const sourceLines = scrollContentLinesFor(receiver.currentLayout?.root, scrollView);
	if (!sourceLines) return undefined;
	const cleaned = cleanTranscriptRows(
		sourceLines,
		bounds.start.row,
		bounds.end.row,
		config.icons.rail,
	);
	if (!cleaned.changed) return undefined;
	const adjusted: SelectionBounds = {
		start: bounds.start,
		end: bounds.end,
	};
	const rows: string[] = [];
	for (let i = 0; i < cleaned.rows.length; i++) {
		const entry = cleaned.rows[i];
		if (entry === null) continue;
		const row = bounds.start.row + i;
		if (entry.leftTrim > 0) {
			if (row === bounds.start.row) {
				adjusted.start = { ...bounds.start, col: Math.max(0, bounds.start.col - entry.leftTrim) };
			}
			if (row === bounds.end.row) {
				adjusted.end = { ...bounds.end, col: Math.max(0, bounds.end.col - entry.leftTrim) };
			}
		}
		const columns = receiver.getSelectionColumns?.(entry.text, row, adjusted);
		if (!columns) return undefined;
		rows.push(
			sliceByColumn(
				entry.text,
				columns.start,
				Math.max(0, columns.end - columns.start),
				true,
			).trimEnd(),
		);
	}
	return rows.join("\n");
}

/**
 * Writes the transcript's cleaned text to the clipboard for a selection that
 * carried recognised chrome, and reports whether it did — `false` means
 * there was nothing to clean and Pi's own copy must run instead. The bytes
 * go out the same way Pi's own copy sends them (OSC 52 through
 * `terminal.write`), for the same reason `copyEditorSelection` does.
 *
 * A selection over pure decoration cleans to "" and is consumed without a
 * clipboard write — Pi's own copy has the same shape (`if (text.length === 0)
 * return`), it just gets there after building a string of rails.
 */
function copyTranscriptSelection(
	receiver: MouseCapableReceiver,
	config: PolishedTuiConfig,
): boolean {
	try {
		const bounds = receiver.getSelectionBounds?.();
		if (!bounds) return false;
		const text = transcriptSelectionText(receiver, config, bounds);
		if (text === undefined) return false;
		if (text.length === 0) return true;
		const write = receiver.terminal?.write;
		if (typeof write !== "function") return false;
		write.call(receiver.terminal, `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		if (config.mouse.copyNotice) receiver.flash?.("Copied!");
		return true;
	} catch {
		// Cleaning reads the layout and the selection, both best effort.
		// Anything this trips over means Pi's own copy should run.
		return false;
	}
}

/**
 * Whether `data` is the backspace or delete the range delete acts on.
 *
 * The question is asked of Pi's own keybinding registry, against the two
 * bindings Pi's editor itself dispatches on, so a user who has rebound either
 * gets the key they bound rather than a hardcoded byte. A registry that
 * disagrees makes this return false, which falls through to Pi's own
 * one-character delete. That is the safe direction to be wrong in.
 *
 * ctrl+c and ctrl+d are refused outright, before the registry is consulted at
 * all. `tui.editor.deleteCharForward` binds `ctrl+d` by default, and ctrl+c and
 * ctrl+d are Pi's interrupt and exit chords; consuming either because a
 * selection happens to be live would break a global key to save a keystroke.
 */
function isRangeDeleteKey(data: unknown): boolean {
	if (typeof data !== "string" || data.length === 0) return false;
	if (data === CTRL_C || data === CTRL_D) return false;
	try {
		const keybindings = getKeybindings();
		return (
			keybindings.matches(data, "tui.editor.deleteCharBackward") ||
			keybindings.matches(data, "tui.editor.deleteCharForward")
		);
	} catch {
		// A build that has moved the registry is one where backspace keeps its
		// ordinary meaning; it is never a reason to break a keystroke.
		return false;
	}
}

/**
 * Removes the draft text a live editor selection covers, and clears the
 * selection that described it.
 *
 * Returns false for every selection that is not the input box's, which leaves
 * the key to Pi and an ordinary backspace deleting one character.
 */
function deleteSelectedRange(receiver: MouseCapableReceiver, config: PolishedTuiConfig): boolean {
	try {
		if (!config.editorClickCursor) return false;
		// The same overlay question the rest of this feature asks: a selection
		// dropped on a dialog must not delete the draft behind it.
		if (receiver.hasOverlay?.()) return false;
		const bounds = receiver.getSelectionBounds?.();
		if (!bounds) return false;
		if (!deleteEditorSelection(receiver, config, bounds)) return false;
		// The highlight described text that is gone. Pi clears these two fields
		// itself all through its own selection handling; leaving them set would
		// paint a selection over whatever moved up to fill the gap.
		receiver.selectionAnchor = undefined;
		receiver.selectionFocus = undefined;
		return true;
	} catch {
		// Driving the editor is best effort. Anything this trips over means the
		// key was an ordinary backspace.
		return false;
	}
}

/**
 * The text a copy of this selection would put on the clipboard, for the hint's
 * character count.
 *
 * It has to ask the same two paths the copy itself asks, in the same order, or
 * the hint promises a number the copy does not deliver.
 */
function pendingSelectionText(
	receiver: MouseCapableReceiver,
	config: PolishedTuiConfig,
	bounds: SelectionBounds,
	bufferCopy: boolean,
	cleanCopy: boolean,
): { text: string; inEditor: boolean } {
	const buffered = bufferCopy ? editorTextForSelection(receiver, config, bounds) : undefined;
	if (buffered !== undefined) return { text: buffered, inEditor: true };
	// The count the hint shows must be the number the copy key actually
	// delivers, so a selection the copy would clean is counted after cleaning.
	if (cleanCopy && config.mouse.transcriptCleanCopy) {
		try {
			const cleaned = transcriptSelectionText(receiver, config, bounds);
			if (cleaned !== undefined) return { text: cleaned, inEditor: false };
		} catch {
			// A cleaning failure falls back to the verbatim count, which is what
			// the copy itself falls back to as well.
		}
	}
	return { text: selectionText(receiver, bounds), inEditor: false };
}

/**
 * A left-button press: not a release, not a drag, not another button, not a
 * wheel notch. `pi-mouse-events` classifies the event before handing it here
 * (`event.kind === "down"`); the shape is still checked rather than assumed,
 * and a malformed event must fall through, never throw.
 */
function isLeftButtonPress(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as Partial<MouseEventLike>;
	if (typeof candidate.button !== "number") return false;
	if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return false;
	if (candidate.release) return false;
	if ((candidate.button & (MOTION_BIT | WHEEL_BIT)) !== 0) return false;
	return (candidate.button & BUTTON_MASK) === LEFT_BUTTON;
}

/**
 * A left-button release: the `m` terminator, encoded as button 0 by SGR
 * terminals and as button 3 by the legacy fallback — Pi's own click handling
 * accepts either (`tui-alt-screen.js`'s release branch), so both are here.
 */
function isLeftButtonRelease(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as Partial<MouseEventLike>;
	if (typeof candidate.button !== "number") return false;
	if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return false;
	if (!candidate.release) return false;
	if ((candidate.button & (MOTION_BIT | WHEEL_BIT)) !== 0) return false;
	const button = candidate.button & BUTTON_MASK;
	return button === LEFT_BUTTON || button === 3;
}

/**
 * A motion report with a button held — the drag that turns a press into a
 * selection rather than a click. Motion without a button bit never arrives
 * from SGR terminals while tracking is button-only, but the bit is checked
 * rather than assumed.
 */
function isButtonMotion(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as Partial<MouseEventLike>;
	if (typeof candidate.button !== "number") return false;
	if (candidate.release) return false;
	return (candidate.button & MOTION_BIT) !== 0;
}

/**
 * The expandable component a click should toggle, and the expansion to set —
 * resolved identically at press (identity only) and at release (action), so
 * the release can tell content that scrolled from the box it started on.
 *
 * Everything is resolved here, inside the one call: the layout is read as it
 * is right now, the component tree is built and dropped, and nothing inside
 * the answer outlives the event. A tool that is still running re-renders
 * between press and release, which is exactly why the release re-resolves
 * instead of trusting the press's answer.
 */
function expandClickTarget(
	receiver: MouseCapableReceiver,
	event: MouseEventLike,
	deps: InstallMouseDeps,
): ExpandTarget | undefined {
	try {
		if (!deps.getConfig().mouse.clickToExpandTools) return undefined;
		// Pi resolves no scroll view while an overlay is up, so neither does this
		// — a click on a dialog must not reach the transcript behind it.
		if (receiver.hasOverlay?.()) return undefined;
		return expandTargetAt(
			{ root: receiver.currentLayout?.root, keyText: expandKeyText() },
			event.x,
			event.y,
		);
	} catch {
		// Resolution is a best-effort read of Pi's internals. Anything it trips
		// over means this click was an ordinary click.
		return undefined;
	}
}

/**
 * The OSC 8 link Pi's built-in press branch stored for this press, if any.
 * The built-in runs after this handler declines the press, so by release time
 * a non-empty `pressedUrl` means Pi is about to open a link — the box stays
 * as it is and the release goes through unconsumed.
 */
function pressedUrlAt(receiver: MouseCapableReceiver): unknown {
	return (receiver as { pressedUrl?: unknown }).pressedUrl;
}

/**
 * Puts the caret where a press landed, when the press landed in the input box.
 *
 * Nothing is consumed: the press goes on to Pi, which drops its selection
 * anchor there exactly as it always did, so a drag from that point still
 * highlights and still copies. That is also what pays for the repaint — Pi's
 * own press branch ends in `requestRender()` unconditionally, so this feature
 * never has to ask for one itself.
 */
function moveCaretForPress(
	receiver: MouseCapableReceiver,
	event: unknown,
	deps: InstallMouseDeps,
): void {
	try {
		const config = deps.getConfig();
		if (!config.editorClickCursor) return;
		if (!isLeftButtonPress(event)) return;
		// Pi resolves no scroll view while an overlay is up, so neither does this
		// — a click on a dialog must not move a caret in the box behind it.
		if (receiver.hasOverlay?.()) return;
		moveEditorCaretTo(receiver, config, (event as MouseEventLike).x, (event as MouseEventLike).y);
	} catch {
		// Moving the caret is a best-effort read of Pi's internals and of an
		// editor this module did not necessarily build. Anything it trips over
		// means this press was an ordinary press.
	}
}

/**
 * Scrolls the input box for this notch, or reports that the notch was not the
 * input box's — in which case Pi routes it as it always did.
 *
 * Pi does not scroll the editor: the editor's `scrollOffset` is re-derived from
 * the caret on every render. So a scroll here is an offset *and* a caret move,
 * which is what `scrollEditorBy` does.
 *
 * The window it scrolls within is Pi's own `max(5, rows * 0.3)`, taken from the
 * terminal rather than from the box's rect: the rect includes Starline's border
 * and metadata rows, and guessing how many of those there are would put the
 * boundary in the wrong place. Without a row count there is nothing to compute
 * it from, so the notch falls through.
 */
function scrollEditorForWheel(
	receiver: MouseCapableReceiver,
	event: { direction: number; x: number; y: number },
	deps: InstallMouseDeps,
): boolean {
	try {
		if (!deps.getConfig().mouse.wheelRouting) return false;
		// An overlay is composited over a layout that still contains the editor,
		// so the box is still "under" a pointer aimed at the dialog on top of it.
		if (receiver.hasOverlay?.()) return false;
		const editor = activeEditor();
		if (!editor) return false;
		const rows = receiver.terminal?.rows;
		if (typeof rows !== "number") return false;
		if (!pointerOverEditorBox(receiver, editor.component, event.x, event.y)) return false;
		const lines = event.direction * Math.max(1, receiver.wheelScrollLines ?? 1);
		return scrollEditorBy(editor.scrollable, lines, rows);
	} catch {
		// Routing is a best-effort read of Pi's internals and of an editor this
		// module did not necessarily build. Anything it trips over means this
		// notch was the transcript's.
		return false;
	}
}

/** Whether the input box is what is painted at `(x, y)` — see `editor-mouse.ts`. */
function pointerOverEditorBox(
	receiver: MouseCapableReceiver,
	editor: unknown,
	x: number,
	y: number,
): boolean {
	return pointerOverEditor(receiver.currentLayout?.root, editor, x, y);
}

/**
 * Registers the mouse features with the `pi-mouse-events` extension and
 * returns a disposer that unregisters them all.
 *
 * Every handler is registered unconditionally and gated inside on the
 * capability set `bindReceiver` computes from the live renderer — there is
 * nothing to probe at install time (see `bindReceiver`). The one install-time
 * gate left is `api.copySlotAvailable` for the two copy features: without the
 * copy slot they would register into a method that is never reached (pi-tui
 * < 0.84.3 has no `copyActiveSelectionToClipboard`), and a feature that
 * silently cannot answer its own copy is exactly the half-working install
 * `capabilities.ts` exists to prevent.
 */
export function installMouseFeaturesOn(
	api: MouseEventsApi,
	ctx: ExtensionContext,
	deps: InstallMouseDeps,
): () => void {
	installRefs = {
		liveReceiver: () => api.liveReceiver?.(),
		copySlot: api.copySlotAvailable,
		deps,
	};
	activeReceiver = undefined;
	featureSet = undefined;
	activeHint = undefined;

	const cleanups: Array<() => void> = [];

	// The expand flow never consumes the press — Pi's selection machinery
	// anchors on it, so a drag that starts anywhere on a box still selects —
	// and consumes the release of a plain click, which Pi's own release path
	// treats as a no-op. It still registers ahead of the caret handler, the
	// same precedence the old shared selection patch made explicit.
	cleanups.push(
		api.addMouseHandler(
			({ event, tui }) => {
				const receiver = bindReceiver(tui);
				if (!receiver || !featureOn("clickToExpandTools")) {
					expandPress = undefined;
					return undefined;
				}
				// One cast, here: the guards below classify without narrowing, and
				// the parsed event already carries every field this reads.
				const mouse = event as MouseEventLike;
				if (isLeftButtonPress(mouse)) {
					// Identity only: the release re-resolves, because a running tool
					// re-renders between the two and rows move under the pointer.
					const candidate = expandClickTarget(receiver, mouse, deps);
					expandPress = candidate
						? { x: mouse.x, y: mouse.y, component: candidate.component, dragged: false }
						: undefined;
					return undefined;
				}
				if (expandPress && isButtonMotion(mouse)) {
					expandPress.dragged = true;
					return undefined;
				}
				if (!isLeftButtonRelease(mouse)) return undefined;
				const press = expandPress;
				expandPress = undefined;
				if (!press || press.dragged) return undefined;
				if (press.x !== mouse.x || press.y !== mouse.y) return undefined;
				// A press on an OSC 8 link: Pi's own release opens it, and the box
				// keeps its state.
				if (pressedUrlAt(receiver) !== undefined) return undefined;
				const target = expandClickTarget(receiver, event, deps);
				if (!target || target.component !== press.component) return undefined;
				const now = Date.now();
				if (
					lastToggle &&
					lastToggle.x === press.x &&
					lastToggle.y === press.y &&
					now - lastToggle.at < DOUBLE_CLICK_MS
				) {
					return undefined;
				}
				target.component.setExpanded(target.expanded);
				receiver.requestRender?.();
				lastToggle = { x: press.x, y: press.y, at: now };
				return { handled: true };
			},
			{ priority: 20 },
		),
	);

	cleanups.push(
		api.addMouseHandler(
			({ event, tui }) => {
				if (event.wheel === undefined) return undefined;
				const receiver = bindReceiver(tui);
				if (!receiver || !featureOn("editorWheelScroll")) return undefined;
				const notch = { direction: event.wheel, x: event.x, y: event.y };
				if (!scrollEditorForWheel(receiver, notch, deps)) {
					return undefined;
				}
				// Pi's own wheel routing repaints at the end of every notch;
				// consuming the event means reaching that repaint is now this
				// handler's job.
				receiver.requestRender?.();
				return { handled: true };
			},
			{ priority: 10 },
		),
	);

	cleanups.push(
		api.addMouseHandler(
			({ event, tui }) => {
				const receiver = bindReceiver(tui);
				if (!receiver || !featureOn("editorClickToCaret")) return undefined;
				moveCaretForPress(receiver, event, deps);
				return undefined;
			},
			{ priority: 0 },
		),
	);

	if (api.copySlotAvailable) {
		cleanups.push(
			api.addCopyHandler(({ tui }) => {
				const receiver = bindReceiver(tui);
				if (!receiver) return undefined;
				const config = deps.getConfig();
				// Precedence written down, as it always was: the buffer copy
				// answers first, and only when it declines does the clean copy or
				// Pi's own copy see the call.
				if (featureOn("editorBufferCopy") && copyEditorSelection(receiver, config)) {
					return { handled: true };
				}
				if (
					featureOn("transcriptCleanCopy") &&
					config.mouse.transcriptCleanCopy &&
					copyTranscriptSelection(receiver, config)
				) {
					return { handled: true };
				}
				return undefined;
			}),
		);
	}

	// The keyboard half of click-to-caret: `ctx.ui.onTerminalInput` is Pi's
	// official extension input listener, and the renderer's own handling never
	// swallows a keystroke before it reaches the listener — mouse reports do,
	// which is exactly why they are not handled here.
	if (typeof ctx.ui.onTerminalInput === "function") {
		cleanups.push(
			ctx.ui.onTerminalInput((data: string) => {
				if (!isRangeDeleteKey(data)) return undefined;
				const receiver = bindReceiver();
				if (!receiver || !featureOn("editorClickToCaret")) return undefined;
				if (!deleteSelectedRange(receiver, deps.getConfig())) return undefined;
				// Consuming the key means Pi's `handleInput` never reaches its own
				// repaint; redrawing the changed draft is this branch's job.
				receiver.requestRender?.();
				return { consume: true };
			}),
		);
	}

	return () => {
		for (const cleanup of cleanups) cleanup();
		if (activeHint?.getConfig === deps.getConfig) activeHint = undefined;
		installRefs = undefined;
		activeReceiver = undefined;
		featureSet = undefined;
		expandPress = undefined;
		lastToggle = undefined;
	};
}
