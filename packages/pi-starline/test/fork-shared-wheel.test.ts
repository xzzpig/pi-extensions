import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMouseEventsApi } from "../../pi-mouse-events/extensions/api-registry.ts";
import {
	type InstalledPatches,
	installMousePatches,
} from "../../pi-mouse-events/extensions/patch.ts";
import { defaultConfig } from "../extensions/starline/config";
import { setActiveEditor } from "../extensions/starline/mouse/editor-mouse";
import { installMouseFeaturesOn } from "../extensions/starline/mouse/index";

const WIDTH = 40;
const HEIGHT = 12;
let patches: InstalledPatches | undefined;
let disposeFeatures: (() => void) | undefined;

afterEach(() => {
	disposeFeatures?.();
	disposeFeatures = undefined;
	patches?.dispose();
	patches = undefined;
	setActiveEditor(undefined);
});

class EditorFixture {
	state = { lines: Array.from({ length: 30 }, (_, i) => `line ${i}`), cursorLine: 0, cursorCol: 0 };
	scrollOffset = 0;
	lastWidth = WIDTH;
	buildVisualLineMap() {
		return this.state.lines.map((line, logicalLine) => ({
			logicalLine,
			startCol: 0,
			length: line.length,
		}));
	}
	render() {
		return this.state.lines.slice(this.scrollOffset, this.scrollOffset + 5);
	}
	invalidate() {}
}

class Renderer {
	terminal = { rows: HEIGHT };
	wheelScrollLines = 3;
	currentLayout: ReturnType<typeof renderLayoutFrame> | undefined;
	nativeConsumes = false;
	delta: number | undefined = 7;
	requestRender = vi.fn();
	originalWheel = vi.fn();
	hasOverlay() {
		return false;
	}
	handleViewportInput(_data: string) {
		if (!this.nativeConsumes)
			this.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1, button: 73 }, this.delta);
		return { consume: true };
	}
	routeWheel(event: unknown, delta?: number) {
		this.originalWheel(event, delta);
	}
}

function setup() {
	const editor = new EditorFixture();
	const container = new Container();
	container.addChild(editor as never);
	const root = new VStack([
		{
			component: new ScrollView(new Text("transcript", 0, 0), { primary: true }),
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
		},
		{
			component: new VStack([{ component: container, shrink: 1, minSize: 3 }]),
			basis: "auto",
			grow: 0,
			shrink: 1,
			minSize: 1,
		},
	]);
	const receiver = new Renderer();
	receiver.currentLayout = renderLayoutFrame(root, WIDTH, HEIGHT, () => {});
	setActiveEditor({ component: editor, scrollable: editor });
	patches = installMousePatches({ events: { emit() {} } } as never, Renderer.prototype);
	if (!patches) throw new Error("shared mouse patch not installed");
	const api = createMouseEventsApi(patches);
	if (!api.addWheelHandler) throw new Error("post-component wheel slot missing");
	disposeFeatures = installMouseFeaturesOn(api, { ui: {} } as never, {
		getConfig: () => defaultConfig,
	});
	return { receiver, editor };
}

describe("Starline's shared post-component wheel slot", () => {
	it("scrolls the draft by Pi's calculated delta exactly once", () => {
		const { receiver, editor } = setup();
		receiver.handleViewportInput("\x1b[<73;11;12M");
		expect(editor.scrollOffset).toBe(7);
		expect(receiver.originalWheel).not.toHaveBeenCalled();
		expect(receiver.requestRender).toHaveBeenCalledOnce();
	});

	it("lets a native component consume the event first", () => {
		const { receiver, editor } = setup();
		receiver.nativeConsumes = true;
		receiver.handleViewportInput("\x1b[<73;11;12M");
		expect(editor.scrollOffset).toBe(0);
		expect(receiver.originalWheel).not.toHaveBeenCalled();
	});

	it("uses the old line count if an older Pi sends no delta", () => {
		const { receiver, editor } = setup();
		receiver.delta = undefined;
		receiver.handleViewportInput("\x1b[<65;11;12M");
		expect(editor.scrollOffset).toBe(3);
	});
});
