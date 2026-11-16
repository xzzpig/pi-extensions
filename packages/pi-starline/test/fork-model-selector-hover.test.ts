import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installNativeModelMouse } from "../extensions/starline/fork-model-selector-mouse";
import { host, makeSelector, requiredGeometry } from "./fork-model-selector-fixture";

const BG = "\x1b[48;5;237m";
const KEY = Symbol.for("pi-mouse-events.api.v2");
const globalApi = globalThis as typeof globalThis & { [KEY]?: unknown };
const originalApi = globalApi[KEY];
const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	vi.restoreAllMocks();
	if (originalApi === undefined) delete globalApi[KEY];
	else globalApi[KEY] = originalApi;
});
async function fixture(count = 24, scoped = false) {
	const warn = vi.fn();
	disposers.push(installNativeModelMouse(warn, host.ModelSelectorComponent.prototype, () => BG));
	const f = await makeSelector(count, scoped);
	let width = 80;
	const draw = (nextWidth = width) => {
		width = nextWidth;
		return f.selector.render(width);
	};
	draw();
	const geometry = () => requiredGeometry(f.selector, width);
	const send = (type: TuiMouseEvent["type"], y: number, extra: Partial<TuiMouseEvent> = {}) =>
		f.selector.handleMouse({
			type,
			button: type === "move" ? "none" : "left",
			x: 3,
			y,
			width,
			height: geometry().height,
			screenX: 3,
			screenY: y,
			shift: false,
			alt: false,
			ctrl: false,
			...extra,
		});
	const hover = (index = 2) => {
		const row = geometry().rows[index];
		return send("move", row.end - 1);
	};
	const highlighted = () => draw().some((line) => line.includes(BG));
	return { ...f, warn, draw, geometry, send, hover, highlighted };
}

describe("模型悬停只装饰，不接管原生选择", () => {
	for (const kind of ["absent", "old", "pointer"] as const) {
		it(`共享 API ${kind} 时背景独立可用，指针仍只走可选接口`, async () => {
			const pointer = vi.fn();
			if (kind === "absent") delete globalApi[KEY];
			else
				globalApi[KEY] = {
					version: 2,
					...(kind === "pointer" ? { requestPointerShape: pointer } : {}),
				};
			const f = await fixture();
			f.hover();
			expect(f.highlighted()).toBe(true);
			expect(pointer).toHaveBeenCalledTimes(kind === "pointer" ? 1 : 0);
			expect(f.warn).not.toHaveBeenCalled();
		});
	}
	it("前驱消费非模型移动仍清理装饰，保留其焦点及处理语义", async () => {
		const proto = host.ModelSelectorComponent.prototype;
		const predecessor = proto.handleMouse;
		vi.spyOn(proto, "handleMouse").mockImplementation(function (this: typeof proto, event) {
			if (event.x === 7)
				return {
					handled: true,
					focus: true,
					render: false,
					target: {
						component: this,
						originX: event.screenX - event.x,
						originY: event.screenY - event.y,
						width: event.width,
						height: event.height,
					},
				};
			return predecessor.call(this, event);
		});
		const f = await fixture();
		f.hover();
		expect(f.highlighted()).toBe(true);
		expect(f.send("move", 0, { x: 7 })).toMatchObject({ handled: true, focus: true, render: true });
		expect(f.highlighted()).toBe(false);
		// A handled native model-row move must not establish our own new hover.
		f.send("move", f.geometry().rows[2].start, { x: 7 });
		expect(f.highlighted()).toBe(false);
	});
	it("续行高亮、重复移动不重绘，普通重绘和组件外无事件保留提示", async () => {
		const f = await fixture();
		f.draw(18);
		const before = f.geometry();
		const row = before.rows[2];
		expect(row.end - row.start).toBeGreaterThan(1);
		expect(f.hover()).toMatchObject({ handled: true, render: true });
		const lines = f.draw();
		for (let y = row.start; y < row.end; y++) expect(lines[y]).toContain(BG);
		expect(lines[row.end]).not.toContain(BG);
		expect(f.hover()).toBeUndefined();
		expect(f.highlighted()).toBe(true);
		expect(f.geometry().signature).toBe(before.signature);
		expect(f.state.selectedIndex).toBe(0);
		expect(f.selected).not.toHaveBeenCalled();
		f.hover(3);
		expect(f.draw()[row.start]).not.toContain(BG);
		expect(f.highlighted()).toBe(true);
	});
	for (const key of ["\r", "\x13"]) {
		it(`悬停另一项后 ${key === "\r" ? "Enter" : "Ctrl+S"} 仍针对原生候选`, async () => {
			const f = await fixture();
			f.hover();
			f.draw();
			f.selector.handleInput(key);
			const callback = key === "\r" ? f.selected : f.saved;
			expect(callback).toHaveBeenCalledExactlyOnceWith(f.models[0]);
		});
	}
	it("悬停不阻止完整点击确认鼠标模型一次", async () => {
		const f = await fixture();
		const row = f.geometry().rows[2];
		f.hover();
		f.draw();
		for (const type of ["press", "release", "click"] as const) f.send(type, row.start);
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(row.model);
	});
	it("视窗边缘悬停不滚动，非模型行清理不改选择", async () => {
		const f = await fixture();
		const before = f.geometry().signature;
		f.hover(9);
		f.draw();
		f.hover(0);
		expect(f.geometry().signature).toBe(before);
		expect(f.state.selectedIndex).toBe(0);
		expect(f.send("move", 0)).toMatchObject({ render: true });
		expect(f.highlighted()).toBe(false);
	});
	for (const change of [
		"search",
		"scope",
		"refresh",
		"identity",
		"keyboard",
		"wheel",
		"resize",
		"empty",
	] as const) {
		it(`${change} 清理旧背景，须重新移动才能建立`, async () => {
			const f = await fixture(24, true);
			f.hover();
			expect(f.highlighted()).toBe(true);
			if (change === "search") f.selector.handleInput("model-0");
			if (change === "scope") f.selector.handleInput("\t");
			if (change === "refresh" || change === "identity") {
				if (change === "identity") f.models.shift();
				// SAFETY: actual native catalog refresh, also pinned by the geometry contract.
				await (f.selector as unknown as { refreshModels(): Promise<void> }).refreshModels();
			}
			if (change === "keyboard") f.selector.handleInput("\x1b[B");
			if (change === "wheel") f.send("wheel", 0, { wheelDelta: -1 }); // Already at first boundary.
			if (change === "resize") f.draw(40);
			if (change === "empty") f.selector.handleInput("no-such-model");
			expect(f.highlighted()).toBe(false);
			if (change !== "empty") {
				f.hover(0);
				expect(f.highlighted()).toBe(true);
			}
		});
	}
	it("按下、拖拽、右击与不合法的有按键 move 不建立提示", async () => {
		const f = await fixture();
		const row = f.geometry().rows[2];
		for (const type of ["press", "drag", "release"] as const) f.send(type, row.start);
		f.send("move", row.start, { button: "left" });
		f.send("press", row.start, { button: "right" });
		expect(f.highlighted()).toBe(false);
		expect(f.selected).not.toHaveBeenCalled();
	});
	it("高度单独 resize 清理旧背景，即使宽度与组件行数不变", async () => {
		const f = await fixture();
		f.hover();
		expect(f.highlighted()).toBe(true);
		const before = f.geometry();
		const children = f.state.listContainer.children.slice();
		f.terminal.rows = 70;
		f.selector.invalidate();
		expect(f.highlighted()).toBe(false);
		const after = f.geometry();
		expect(after.width).toBe(before.width);
		expect(after.height).toBe(before.height);
		expect(after.signature).not.toBe(before.signature);
		expect(f.state.listContainer.children.every((child, index) => child === children[index])).toBe(
			true,
		);
		f.draw();
		expect(f.highlighted()).toBe(false);
		f.hover();
		expect(f.highlighted()).toBe(true);
		expect(f.warn).not.toHaveBeenCalled();
	});
	it("零宽与关闭只清理已有背景，不产生兼容告警", async () => {
		const f = await fixture();
		f.hover();
		expect(f.highlighted()).toBe(true);
		f.draw(0);
		f.draw(80);
		expect(f.highlighted()).toBe(false);
		f.hover();
		f.selector.dispose();
		expect(f.draw().some((line) => line.includes(BG))).toBe(false);
		expect(f.warn).not.toHaveBeenCalled();
	});
	it("render 发现零高度模型行后清理背景且只告警一次", async () => {
		const f = await fixture();
		f.hover();
		expect(f.highlighted()).toBe(true);
		const children = f.state.listContainer.children;
		f.state.listContainer.children = children.map(() => ({ render: () => [], invalidate() {} }));
		expect(f.draw().some((line) => line.includes(BG))).toBe(false);
		f.draw();
		f.state.listContainer.children = children;
		expect(f.highlighted()).toBe(false);
		expect(f.warn).toHaveBeenCalledOnce();
	});
	it("失效几何明确告警并清除背景，恢复几何也不复活旧提示", async () => {
		const f = await fixture();
		f.hover();
		expect(f.highlighted()).toBe(true);
		const children = f.state.listContainer.children;
		f.state.listContainer.children = [];
		// Direct event avoids requiring valid geometry in this intentionally incompatible fixture.
		f.selector.handleMouse({
			type: "move",
			button: "none",
			x: 3,
			y: 0,
			width: 80,
			height: 42,
			screenX: 3,
			screenY: 0,
			shift: false,
			alt: false,
			ctrl: false,
		});
		f.state.listContainer.children = children;
		expect(f.highlighted()).toBe(false);
		expect(f.warn).toHaveBeenCalledOnce();
	});
});
