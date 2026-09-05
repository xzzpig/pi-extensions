/**
 * Asserts the shape of Pi that Starline reads, against the real installed
 * package rather than a fake. When Pi renames or freezes one of these, CI goes
 * red here — loudly, at build time — instead of a feature silently vanishing
 * at runtime on a user's machine.
 *
 * Starline no longer patches any of `TuiAltScreen.prototype` — the mouse
 * methods belong to the `pi-mouse-events` extension, and its own contract test
 * pins the dispatch surface (`handleViewportInput`, the parsers, the layout
 * fields). What Starline still needs Pi to expose is the read surface below:
 * the selection state its features interpret, and the editor internals its
 * caret/copy arithmetic drives.
 */
import { Editor, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

function descriptorInChain(target: object, name: string): PropertyDescriptor | undefined {
	let current: object | null = target;
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor) return descriptor;
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

// Read, not patched — the selection itself stays Pi's, and `hasOverlay` is
// asked the same question Pi's own press path asks before it resolves a scroll
// view, so click-to-expand does not reach through a dialog. `getCopyOnSelect`
// and `hasActiveSelection` are read the same way: the hint is derived from
// them, never intercepted.
const READ_METHODS = [
	"getSelectionBounds",
	"getSelectionColumns",
	"getCopyOnSelect",
	"hasActiveSelection",
	"flash",
	"hasOverlay",
];

const EDITOR_METHODS = [
	"getCursor",
	"moveCursor",
	"setCursorCol",
	"buildVisualLineMap",
	"findVisualLineAt",
	"moveToVisualLine",
	"getLines",
	"getText",
	"handleBackspace",
	"handleForwardDelete",
];

describe("TuiAltScreen contract", () => {
	it.each(READ_METHODS)("exposes %s for reading", (name) => {
		expect(typeof descriptorInChain(TuiAltScreen.prototype, name)?.value).toBe("function");
	});

	it("declares no #private fields, which reflection cannot reach", () => {
		expect(TuiAltScreen.toString()).not.toMatch(/this\.#/);
	});
});

describe("Editor contract", () => {
	it.each(EDITOR_METHODS)("exposes %s", (name) => {
		expect(typeof descriptorInChain(Editor.prototype, name)?.value).toBe("function");
	});

	it("declares no #private fields", () => {
		expect(Editor.toString()).not.toMatch(/this\.#/);
	});
});
