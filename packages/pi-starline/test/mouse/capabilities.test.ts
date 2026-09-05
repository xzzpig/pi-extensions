import { describe, expect, it } from "vitest";
import {
	disabledFeatureWarning,
	enabledFeatures,
	type MouseFeature,
	probeCapabilities,
} from "../../extensions/starline/mouse/capabilities";

/**
 * The probe runs against the live renderer (`ctx.ui`), not a prototype being
 * patched, so a capability is simply a callable method. The copy slot is not
 * on the receiver at all — it is the `pi-mouse-events` extension's
 * `addCopyHandler` backing, reported as `copySlotAvailable` — which is why it
 * is a separate argument rather than something this probe can see.
 */
function receiverWith(names: string[]): object {
	const receiver: Record<string, unknown> = {};
	for (const name of names) receiver[name] = function stub() {};
	return receiver;
}

const ALL = [
	"getCopyOnSelect",
	"hasActiveSelection",
	"getSelectionBounds",
	"getSelectionColumns",
	"flash",
	"hasOverlay",
	"requestRender",
];

const ALL_FEATURES = [
	"clickToExpandTools",
	"editorBufferCopy",
	"editorClickToCaret",
	"editorWheelScroll",
	"selectionHint",
	"transcriptCleanCopy",
];

function featuresWith(names: string[], copySlot = true): ReadonlySet<MouseFeature> {
	return enabledFeatures(probeCapabilities(receiverWith(names)), copySlot);
}

describe("probeCapabilities", () => {
	it("finds every capability on a complete receiver", () => {
		expect([...probeCapabilities(receiverWith(ALL))].sort()).toEqual([...ALL].sort());
	});

	it("skips a non-function property", () => {
		const receiver = receiverWith(ALL) as Record<string, unknown>;
		receiver.getSelectionBounds = 42;
		expect(probeCapabilities(receiver).has("getSelectionBounds")).toBe(false);
	});

	it("never propagates a receiver that throws on inspection", () => {
		// `ctx.ui` is a Proxy over Pi's renderer, so a probe can be pointed at
		// one whose traps throw. The rule is that a probe never propagates: it
		// reports the capability as unavailable and the feature depending on it
		// stays off.
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error("boom");
				},
			},
		);
		expect(() => probeCapabilities(hostile)).not.toThrow();
		expect(probeCapabilities(hostile).size).toBe(0);
	});
});

describe("enabledFeatures", () => {
	it("enables everything when every capability is present and the copy slot exists", () => {
		const features = featuresWith(ALL, true);
		expect([...features].sort()).toEqual(ALL_FEATURES);
	});

	it("disables both copy features without the extension's copy slot", () => {
		// The copy features answer the copy key through `addCopyHandler`; on a
		// pi-tui without `copyActiveSelectionToClipboard` (< 0.84.3) the slot is
		// not installed, and a feature that cannot answer its own copy is the
		// half-working install the table exists to prevent.
		const features = featuresWith(ALL, false);
		expect(features.has("editorBufferCopy")).toBe(false);
		expect(features.has("transcriptCleanCopy")).toBe(false);
		expect(features.has("editorClickToCaret")).toBe(true);
		expect(features.has("selectionHint")).toBe(true);
	});

	it("disables the hint when Pi's selection APIs are missing", () => {
		// The hint is derived from Pi's own select-without-copy state; without
		// `getCopyOnSelect` or `hasActiveSelection` there is nothing to derive
		// it from. Copying still answers the copy key, which needs neither.
		for (const capability of ["getCopyOnSelect", "hasActiveSelection"] as const) {
			const features = featuresWith(ALL.filter((name) => name !== capability));
			expect(features.has("selectionHint")).toBe(false);
			expect(features.has("transcriptCleanCopy")).toBe(true);
		}
	});

	it("disables both repainting features when the renderer cannot be asked to repaint", () => {
		// `requestRender` is the one capability these features only ever *call*.
		// Consuming a press or a notch means Pi never reaches its own repaint,
		// so without one of its own a toggled tool box would stay off screen
		// until some unrelated frame arrived.
		const features = featuresWith(ALL.filter((name) => name !== "requestRender"));
		expect(features.has("selectionHint")).toBe(true);
		expect(features.has("clickToExpandTools")).toBe(false);
		expect(features.has("editorWheelScroll")).toBe(false);
		expect(features.has("editorClickToCaret")).toBe(false);
		// The copy features call through to Pi's own copy on the fall-through
		// path, which repaints on its own; they stay on.
		expect(features.has("editorBufferCopy")).toBe(true);
	});

	it("disables the pointer features when overlays cannot be detected", () => {
		// Without `hasOverlay` the features would act through an open dialog:
		// expanding a tool box behind it, scrolling a draft behind it, moving a
		// caret behind it, or reading a dialog's rows as a selection.
		const features = featuresWith(ALL.filter((name) => name !== "hasOverlay"));
		expect(features.has("clickToExpandTools")).toBe(false);
		expect(features.has("editorWheelScroll")).toBe(false);
		expect(features.has("editorClickToCaret")).toBe(false);
		expect(features.has("editorBufferCopy")).toBe(false);
		expect(features.has("transcriptCleanCopy")).toBe(false);
		expect(features.has("selectionHint")).toBe(true);
	});

	it("disables the copy features without the selection they would have to recognise", () => {
		// They have to read the bounds to find out which selection they are
		// answering; the clean copy additionally slices through
		// `getSelectionColumns`.
		for (const capability of ["getSelectionBounds", "getSelectionColumns"] as const) {
			const features = featuresWith(ALL.filter((name) => name !== capability));
			if (capability === "getSelectionBounds") {
				expect(features.has("editorBufferCopy")).toBe(false);
				expect(features.has("transcriptCleanCopy")).toBe(false);
			} else {
				expect(features.has("editorBufferCopy")).toBe(true);
				expect(features.has("transcriptCleanCopy")).toBe(false);
			}
		}
	});

	it("disables the copy features without the notice channel they answer through", () => {
		// `flash` is how a copy Starline answers itself says "Copied!" — Pi's
		// own copy flashes unconditionally, so a clean copy without one would be
		// the only silent copy on screen.
		const features = featuresWith(ALL.filter((name) => name !== "flash"));
		expect(features.has("editorBufferCopy")).toBe(false);
		expect(features.has("transcriptCleanCopy")).toBe(false);
		// The caret is not the copy features', so it survives.
		expect(features.has("editorClickToCaret")).toBe(true);
	});
});

describe("disabledFeatureWarning", () => {
	it("is silent when nothing is disabled", () => {
		expect(disabledFeatureWarning(featuresWith(ALL, true))).toBeNull();
	});

	it("names every disabled feature in one message", () => {
		const features = featuresWith([], false);
		const warning = disabledFeatureWarning(features);
		expect(warning).toContain("selectionHint");
		expect(warning).toContain("editorWheelScroll");
		expect(warning?.split("\n")).toHaveLength(1);
	});
});
