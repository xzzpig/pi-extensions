/**
 * What of the live renderer Starline's mouse features can actually reach.
 *
 * Starline no longer patches anything — the `pi-mouse-events` extension owns
 * the prototype — so the probe is about *calling*, not replacing: every
 * method a feature needs on the receiver must exist and be callable, probed
 * structurally on the instance the extension hands over (`ctx.ui`, the Proxy
 * that forwards to the live renderer). Signature drift is caught by the
 * contract tests rather than guessed at here.
 *
 * The `pi-mouse-events` API gates everything before this table runs: without
 * it no feature registers at all (see `installMouseFeaturesOn`). The one API
 * capability that varies on its own is the copy slot — the extension installs
 * it only when `copyActiveSelectionToClipboard` exists (pi-tui ≥ 0.84.3) —
 * so it arrives as `copySlotAvailable` rather than being probed here.
 */

/** The receiver methods the features call, probed on the live renderer. */
export type MouseReceiverCapabilities =
	| "getCopyOnSelect"
	| "hasActiveSelection"
	| "getSelectionBounds"
	| "getSelectionColumns"
	| "flash"
	| "hasOverlay"
	| "requestRender";

export type MouseCapability = MouseReceiverCapabilities | "copySlot";

export type MouseFeature =
	| "selectionHint"
	| "clickToExpandTools"
	| "editorWheelScroll"
	| "editorClickToCaret"
	| "editorBufferCopy"
	| "transcriptCleanCopy";

const CAPABILITIES: readonly MouseCapability[] = [
	"getCopyOnSelect",
	"hasActiveSelection",
	"getSelectionBounds",
	"getSelectionColumns",
	"flash",
	"hasOverlay",
	"requestRender",
	"copySlot",
];

/**
 * Every capability a feature needs before it may register.
 *
 * There is no `frameFreeSelection` entry, deliberately: the feature is cut
 * (see the header of `mouse/index.ts` before the clean-copy successor
 * replaced it). A feature listed here is one `installMouseFeaturesOn`
 * registers, and a table that claims a feature nothing registers is worse
 * than no table.
 */
const REQUIREMENTS: Record<MouseFeature, readonly MouseCapability[]> = {
	// Derived from Pi's own select-without-copy state: the hint shows only
	// while the renderer is NOT auto-copying (`getCopyOnSelect` false) and
	// something is actually selected (`hasActiveSelection`). The character
	// count is computed from the live selection through `getSelectionBounds`
	// and `getSelectionColumns`, matching the columns the copy itself would
	// slice — the hint promises what ctrl+x delivers. No release interception,
	// no pending state: Pi's `copyOnSelect: false` already keeps the selection
	// highlighted, and the hint rides Pi's own repaints.
	selectionHint: [
		"getCopyOnSelect",
		"hasActiveSelection",
		"getSelectionBounds",
		"getSelectionColumns",
	],
	// The press arrives through the `pi-mouse-events` handler slot, which
	// always exists once the API does; what this feature needs beyond that is
	// `hasOverlay` — the same question Pi's own press path asks before
	// resolving a scroll view, without which a click on a dialog would toggle
	// whatever tool box happens to sit behind it — and `requestRender`, because
	// consuming the press means Pi never reaches its own repaint for that
	// event.
	clickToExpandTools: ["hasOverlay", "requestRender"],
	// Same shape as click-to-expand: the notch arrives through the handler
	// slot, `hasOverlay` keeps a notch aimed at a dialog from scrolling the
	// draft hidden behind it, and consuming the notch means `requestRender` is
	// the only thing that draws the scrolled box.
	editorWheelScroll: ["hasOverlay", "requestRender"],
	// The press half rides the same slot as click-to-expand; the keyboard half
	// (backspace/delete over a selection) rides `ctx.ui.onTerminalInput`, which
	// every interactive session exposes. Range delete reads the selection
	// through `getSelectionBounds`, and because it *consumes* the key — so
	// Pi's `handleInput` never reaches its own repaint — `requestRender` is
	// the only thing that draws the shortened draft.
	editorClickToCaret: ["getSelectionBounds", "hasOverlay", "requestRender"],
	// Registers an `addCopyHandler`; needs the extension's copy slot to exist
	// (`copyActiveSelectionToClipboard`, pi-tui ≥ 0.84.3), reads the selection
	// through `getSelectionBounds` to find out whether it is the editor's, and
	// raises its own "Copied!" through `flash`. `hasOverlay` again: a selection
	// dropped on a dialog must not be read as text from the draft behind it.
	// The clipboard write goes through `terminal.write`, unlisted because
	// `terminal` is a plain instance field — checked at the call site, where a
	// terminal that cannot be written to makes the copy fall through to Pi.
	editorBufferCopy: ["copySlot", "getSelectionBounds", "hasOverlay", "flash"],
	// Shares the copy slot with editorBufferCopy. It reads the selection
	// through `getSelectionBounds` to find the rows, through
	// `getSelectionColumns` to slice the cleaned text along the same
	// grapheme-aligned columns Pi would have used, and asks `hasOverlay`
	// before trusting those rows.
	transcriptCleanCopy: [
		"copySlot",
		"getSelectionBounds",
		"getSelectionColumns",
		"hasOverlay",
		"flash",
	],
};

function isCallable(receiver: object, name: string): boolean {
	try {
		return typeof (receiver as Record<string, unknown>)[name] === "function";
	} catch {
		// A receiver that throws on inspection is one we do not touch.
		return false;
	}
}

export function probeCapabilities(receiver: object): ReadonlySet<MouseCapability> {
	const found = new Set<MouseCapability>();
	for (const capability of CAPABILITIES) {
		if (capability === "copySlot") continue;
		if (isCallable(receiver, capability)) found.add(capability);
	}
	return found;
}

export function enabledFeatures(
	available: ReadonlySet<MouseCapability>,
	copySlotAvailable: boolean,
): ReadonlySet<MouseFeature> {
	const withSlot = new Set(available);
	if (copySlotAvailable) withSlot.add("copySlot");
	const enabled = new Set<MouseFeature>();
	for (const [feature, needed] of Object.entries(REQUIREMENTS) as [
		MouseFeature,
		readonly MouseCapability[],
	][]) {
		if (needed.every((capability) => withSlot.has(capability))) enabled.add(feature);
	}
	return enabled;
}

/**
 * One line naming everything that will not run, or null when all is well. Pi
 * prints this once per process — a line per feature would be noise on a build
 * where Pi has moved on.
 */
export function disabledFeatureWarning(enabled: ReadonlySet<MouseFeature>): string | null {
	const disabled = (Object.keys(REQUIREMENTS) as MouseFeature[]).filter(
		(feature) => !enabled.has(feature),
	);
	if (disabled.length === 0) return null;
	return `[starline] This Pi build does not expose what these mouse features need, so they are off: ${disabled.join(", ")}. Everything else still works.`;
}
