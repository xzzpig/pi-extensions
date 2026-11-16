import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	type ModelSelectorState,
	modelRowAt,
	type SelectorGeometry,
	selectorGeometry,
	selectorState,
} from "./fork-model-selector-geometry";
import { decorateModelHover } from "./fork-model-selector-hover";
import { getMouseEventsApi } from "./mouse/api-consumer";

type Mouse = (this: unknown, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
type Render = (this: unknown, width: number) => string[];
type Prototype = { render: Render; handleMouse?: Mouse; [REGISTRY]?: Registration };
type Gesture = { signature: string; provider: string; id: string; x: number; y: number };
type Instance = {
	drawn?: SelectorGeometry;
	press?: Gesture;
	children?: ModelSelectorState["children"];
	hover?: number;
};
function sameChildren(instance: Instance, state: ModelSelectorState): boolean {
	const children = state.listContainer.children;
	return (
		instance.children?.length === children.length &&
		children.every((child, index) => child === instance.children?.[index])
	);
}
type Registration = { dispose(): void };
const REGISTRY = Symbol.for("pi-starline.native-model-selector-mouse");

/** Reversible component-only adaptation. No TUI/global input methods are patched. */
export function installNativeModelMouse(
	warn: (message: string) => void,
	prototype: Prototype = ModelSelectorComponent.prototype,
	getHoverBackground?: () => string,
): () => void {
	const previous = prototype[REGISTRY];
	previous?.dispose();
	const descriptors = {
		render: Object.getOwnPropertyDescriptor(prototype, "render"),
		handleMouse: Object.getOwnPropertyDescriptor(prototype, "handleMouse"),
	};
	const predecessorRender = prototype.render;
	const predecessorMouse = prototype.handleMouse;
	if (typeof predecessorRender !== "function" || typeof predecessorMouse !== "function") {
		warn("Model picker mouse support unavailable: Pi has no component mouse dispatch.");
		return () => {};
	}
	let active = true;
	let warned = false;
	let instances = new WeakMap<object, Instance>();
	const incompatible = () => {
		if (warned || !active) return;
		warned = true;
		warn(
			"Model picker mouse support unavailable: incompatible native selector structure. Keyboard search remains available.",
		);
	};
	const instanceFor = (receiver: ModelSelectorState): Instance => {
		let instance = instances.get(receiver);
		if (!instance) {
			instance = {};
			instances.set(receiver, instance);
		}
		return instance;
	};
	const render: Render = function (width) {
		const lines = predecessorRender.call(this, width);
		if (active && typeof this === "object" && this !== null) {
			const state = selectorState(this);
			if (!state) {
				const instance = instances.get(this);
				if (instance) instance.hover = undefined;
				incompatible();
			} else {
				const instance = instanceFor(state);
				const drawn = selectorGeometry(state, width);
				if (!drawn && !state.closed && Number.isInteger(width) && width > 0) incompatible();
				if (
					!drawn ||
					drawn.signature !== instance.drawn?.signature ||
					!sameChildren(instance, state)
				) {
					instance.press = undefined;
					instance.hover = undefined;
				}
				instance.drawn = drawn;
				instance.children = state.listContainer.children.slice();
				const row = drawn?.rows.find((entry) => entry.index === instance.hover);
				if (drawn && row && getHoverBackground) {
					const background = getHoverBackground();
					if (background) return decorateModelHover(lines, drawn, row, background);
					instance.hover = undefined;
					incompatible();
				}
			}
		}
		return lines;
	};
	const handleMouse: Mouse = function (event) {
		// Give a future native handler (or an earlier adapter) first refusal.
		const result = predecessorMouse.call(this, event);
		if (!active) return result;
		const nativeHandled = result?.handled || result?.capture || result?.focus;
		if (typeof this !== "object" || this === null) return result;
		const state = selectorState(this);
		if (!state) {
			const instance = instances.get(this);
			const hadHover = instance?.hover !== undefined;
			if (instance) instance.hover = undefined;
			incompatible();
			return hadHover ? { ...result, handled: true, render: true } : result;
		}
		const instance = instanceFor(state);
		let decorationChanged = false;
		const clearHover = () => {
			decorationChanged ||= instance.hover !== undefined;
			instance.hover = undefined;
		};
		const finish = () => (decorationChanged ? { ...result, handled: true, render: true } : result);
		if (state.closed) {
			clearHover();
			return finish();
		}
		if (nativeHandled && event.type !== "move") {
			if (event.type === "wheel") clearHover();
			return finish();
		}
		const drawn = instance.drawn;
		if (
			!drawn ||
			event.width !== drawn.width ||
			!Number.isFinite(event.x) ||
			!Number.isFinite(event.y) ||
			event.x < 0 ||
			event.x >= drawn.width ||
			event.y < 0 ||
			event.y >= drawn.height
		) {
			if (event.type === "move") clearHover();
			return finish();
		}
		const current = selectorGeometry(state, event.width);
		if (!current) {
			instance.press = undefined;
			clearHover();
			incompatible();
			return finish();
		}
		const stale = current.signature !== drawn.signature || !sameChildren(instance, state);
		if (stale) {
			instance.press = undefined;
			clearHover();
		}
		if (event.type === "wheel") {
			const wheelDelta = event.wheelDelta;
			if (typeof wheelDelta !== "number" || !Number.isFinite(wheelDelta) || !wheelDelta)
				return result;
			instance.press = undefined;
			clearHover();
			const delta = Math.sign(wheelDelta) * Math.max(1, Math.floor(Math.abs(wheelDelta)));
			state.selectedIndex = Math.max(
				0,
				Math.min(state.filteredModels.length - 1, state.selectedIndex + delta),
			);
			state.updateList();
			return { handled: true, render: true };
		}
		const row = modelRowAt(current, event.x, event.y);
		if (event.type === "move") {
			if (nativeHandled || stale || !row) {
				clearHover();
				return finish();
			}
			if (event.button !== "none") return finish();
			getMouseEventsApi()?.requestPointerShape?.("pointer");
			if (getHoverBackground && instance.hover !== row.index) {
				instance.hover = row.index;
				decorationChanged = true;
			}
			return finish();
		}
		if (event.type === "drag" && instance.press) {
			instance.press = undefined;
			return { handled: true };
		}
		if (event.button !== "left") return result;
		if (event.type === "press") {
			instance.press = undefined;
			if (!row || current?.signature !== drawn.signature) return result;
			instance.press = {
				signature: current.signature,
				provider: row.model.provider,
				id: row.model.id,
				x: event.x,
				y: event.y,
			};
			// Claim the press so Pi remembers this component as the click target.
			// Pi still synthesizes click only for a same-cell, non-drag release.
			return { handled: true };
		}
		if (event.type === "release") {
			if (instance.press && (event.x !== instance.press.x || event.y !== instance.press.y))
				instance.press = undefined;
			return instance.press ? { handled: true, render: false } : result;
		}
		if (event.type !== "click") return result;
		const press = instance.press;
		instance.press = undefined;
		if (!press) return result;
		if (
			row &&
			current?.signature === drawn.signature &&
			current.signature === press.signature &&
			row.model.provider === press.provider &&
			row.model.id === press.id &&
			event.x === press.x &&
			event.y === press.y &&
			(event.clickCount ?? 1) === 1
		) {
			state.handleSelect(row.model);
		}
		return { handled: true };
	};
	prototype.render = render;
	prototype.handleMouse = handleMouse;
	const registration: Registration = {
		dispose() {
			if (!active) return;
			active = false;
			instances = new WeakMap();
			for (const key of ["render", "handleMouse"] as const) {
				if (prototype[key] !== (key === "render" ? render : handleMouse)) continue;
				const descriptor = descriptors[key];
				if (descriptor) Object.defineProperty(prototype, key, descriptor);
				else Reflect.deleteProperty(prototype, key);
			}
			if (prototype[REGISTRY] === registration) Reflect.deleteProperty(prototype, REGISTRY);
		},
	};
	Object.defineProperty(prototype, REGISTRY, { value: registration, configurable: true });
	return () => registration.dispose();
}
