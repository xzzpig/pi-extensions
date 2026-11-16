import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installNativeModelMouse } from "../extensions/starline/fork-model-selector-mouse";
import { host, makeSelector, requiredGeometry } from "./fork-model-selector-fixture";

const KEY = Symbol.for("pi-mouse-events.api.v2");
const globalApi = globalThis as typeof globalThis & { [KEY]?: unknown };
const originalApi = globalApi[KEY];
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	if (originalApi === undefined) delete globalApi[KEY];
	else globalApi[KEY] = originalApi;
});
function install() {
	const warn = vi.fn();
	cleanups.push(installNativeModelMouse(warn, host.ModelSelectorComponent.prototype));
	return warn;
}
async function fixture(count = 24, width = 80, scoped = false) {
	const warn = install();
	const f = await makeSelector(count, scoped);
	const draw = () => {
		f.selector.render(width);
		return requiredGeometry(f.selector, width);
	};
	const g = draw();
	function send(
		type: TuiMouseEvent["type"],
		y = g.rows[0]?.start ?? 0,
		extra: Partial<TuiMouseEvent> = {},
	) {
		return f.selector.handleMouse({
			type,
			button: type === "move" ? "none" : "left",
			x: 3,
			y,
			width,
			height: g.height,
			screenX: 3,
			screenY: y,
			shift: false,
			alt: false,
			ctrl: false,
			...extra,
		});
	}
	return { ...f, warn, send, draw, geometry: g };
}

describe("原生组件模型鼠标适配", () => {
	for (const failure of ["missing-children", "zero-height"] as const) {
		it(`有效绘制中几何不兼容 ${failure} 明确告警一次并保留键盘`, async () => {
			const f = await fixture(1);
			f.state.listContainer.children =
				failure === "missing-children" ? [] : [{ render: () => [], invalidate() {} }];
			f.selector.render(80);
			f.selector.render(80);
			expect(f.warn).toHaveBeenCalledOnce();
			expect(f.warn.mock.calls[0][0]).toContain("incompatible");
			expect(f.send("wheel", 0, { wheelDelta: 1 })).toBeUndefined();
			f.selector.getSearchInput().onSubmit?.("");
			expect(f.selected).toHaveBeenCalledOnce();
		});
		it(`事件到达后才发现几何不兼容 ${failure} 也不静默退出`, async () => {
			const f = await fixture(1);
			f.state.listContainer.children =
				failure === "missing-children" ? [] : [{ render: () => [], invalidate() {} }];
			expect(f.send("wheel", 0, { wheelDelta: 1 })).toBeUndefined();
			f.send("press", f.geometry.rows[0].start);
			expect(f.warn).toHaveBeenCalledOnce();
			expect(f.selected).not.toHaveBeenCalled();
		});
	}
	it("未绘制、零宽度和已关闭是正常不可交互状态，不误报告警", async () => {
		const warn = install();
		const f = await makeSelector(1);
		f.selector.handleMouse({
			type: "wheel",
			button: "left",
			x: 0,
			y: 0,
			width: 80,
			height: 42,
			screenX: 0,
			screenY: 0,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 1,
		});
		f.selector.render(0);
		f.selector.dispose();
		f.selector.render(80);
		expect(warn).not.toHaveBeenCalled();
	});
	it("按下后切换范围不确认旧目标，重新点击使用新范围", async () => {
		const f = await fixture(24, 80, true);
		f.send("press");
		f.selector.handleInput("\t");
		expect(f.state.scope).toBe("all");
		f.draw();
		f.send("release");
		f.send("click");
		expect(f.selected).not.toHaveBeenCalled();
		const row = f.draw().rows[1];
		f.send("press", row.start);
		f.send("release", row.start);
		f.send("click", row.start);
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(row.model);
	});
	it("只适配模型原型，不修改其他原生选择器", () => {
		const settings = host.SettingsSelectorComponent.prototype;
		const before = { render: settings.render, mouse: settings.handleMouse };
		install();
		expect(settings.render).toBe(before.render);
		expect(settings.handleMouse).toBe(before.mouse);
	});
	it("完整点击换行续行只确认一次，按下和释放不确认", async () => {
		const f = await fixture(24, 18);
		const row = f.geometry.rows[2];
		expect(row.end - row.start).toBeGreaterThan(1);
		f.send("press", row.end - 1);
		f.send("release", row.end - 1);
		expect(f.selected).not.toHaveBeenCalled();
		f.send("click", row.end - 1);
		f.send("click", row.end - 1);
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(row.model);
	});
	it("滚轮使用宿主步长，首尾停止且不确认", async () => {
		const f = await fixture();
		expect(f.send("wheel", 0, { wheelDelta: 7, alt: true })?.handled).toBe(true);
		expect(f.state.selectedIndex).toBe(7);
		f.draw();
		f.send("wheel", 0, { wheelDelta: 100 });
		expect(f.state.selectedIndex).toBe(23);
		f.draw();
		expect(f.send("wheel", 0, { wheelDelta: 3 })?.handled).toBe(true);
		expect(f.state.selectedIndex).toBe(23);
		f.draw();
		f.send("wheel", 0, { wheelDelta: -100 });
		expect(f.state.selectedIndex).toBe(0);
		expect(f.selected).not.toHaveBeenCalled();
	});
	it("空结果消费滚轮，区域外透传", async () => {
		const f = await fixture(0);
		expect(f.send("wheel", 0, { wheelDelta: 2 })?.handled).toBe(true);
		expect(f.send("wheel", -1, { wheelDelta: 2 })).toBeUndefined();
		expect(f.send("wheel", 0, { wheelDelta: NaN })).toBeUndefined();
		expect(f.state.selectedIndex).toBe(0);
	});
	it("非模型行、右键、无按下点击不确认", async () => {
		const f = await fixture();
		f.send("press", 0);
		f.send("release", 0);
		f.send("click", 0);
		f.send("press", undefined, { button: "right" });
		f.send("click", undefined, { button: "right" });
		f.send("click");
		expect(f.selected).not.toHaveBeenCalled();
	});
	it("拖动和不同单元格释放不确认", async () => {
		const f = await fixture();
		f.send("press");
		f.send("drag");
		f.send("release");
		f.send("click");
		f.send("press");
		f.send("release", undefined, { x: 4 });
		f.send("click");
		expect(f.selected).not.toHaveBeenCalled();
	});
	it("按下后筛选改变目标不误选", async () => {
		const f = await fixture();
		f.send("press");
		f.selector.handleInput("model-23");
		f.draw();
		f.send("release");
		f.send("click");
		expect(f.selected).not.toHaveBeenCalled();
		const row = f.draw().rows[0];
		f.send("press", row.start);
		f.send("release", row.start);
		f.send("click", row.start);
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(row.model);
	});
	it("按下后刷新、resize 或滚轮使旧手势失效", async () => {
		const f = await fixture();
		f.send("press");
		f.models.shift();
		// SAFETY: refreshModels is the real native asynchronous catalog refresh method.
		await (f.selector as unknown as { refreshModels(): Promise<void> }).refreshModels();
		f.draw();
		f.send("release");
		f.send("click");
		f.send("press");
		f.selector.render(40);
		f.send("release");
		f.send("click");
		f.draw();
		f.send("press");
		f.send("wheel", 0, { wheelDelta: 1 });
		f.draw();
		f.send("click");
		expect(f.selected).not.toHaveBeenCalled();
	});
	for (const kind of ["absent", "old", "pointer"] as const) {
		it(`共享包状态 ${kind} 不阻断原生点击和滚轮`, async () => {
			const pointer = vi.fn();
			if (kind === "absent") delete globalApi[KEY];
			else
				globalApi[KEY] = {
					version: 2,
					...(kind === "pointer" ? { requestPointerShape: pointer } : {}),
				};
			const f = await fixture();
			f.send("wheel", 0, { wheelDelta: 2 });
			const row = f.draw().rows[3];
			f.send("move", row.start);
			expect(pointer).toHaveBeenCalledTimes(kind === "pointer" ? 1 : 0);
			f.send("press", row.start);
			f.send("release", row.start);
			f.send("click", row.start);
			expect(f.selected).toHaveBeenCalledExactlyOnceWith(row.model);
			expect(f.warn).not.toHaveBeenCalled();
		});
	}
	it("卸载恢复继承属性，重复安装后旧清理不拆新安装", () => {
		const proto = host.ModelSelectorComponent.prototype;
		const beforeRender = Object.getOwnPropertyDescriptor(proto, "render");
		const beforeMouse = Object.getOwnPropertyDescriptor(proto, "handleMouse");
		const stop1 = installNativeModelMouse(vi.fn(), proto);
		const stop2 = installNativeModelMouse(vi.fn(), proto);
		const current = proto.handleMouse;
		stop1();
		expect(proto.handleMouse).toBe(current);
		stop2();
		expect(Object.getOwnPropertyDescriptor(proto, "render")).toEqual(beforeRender);
		expect(Object.getOwnPropertyDescriptor(proto, "handleMouse")).toEqual(beforeMouse);
	});
	it("后续拥有者的处理器不被清理覆盖", () => {
		const proto = host.ModelSelectorComponent.prototype;
		const original = Object.getOwnPropertyDescriptor(proto, "handleMouse");
		const stop = installNativeModelMouse(vi.fn(), proto);
		const later = vi.fn();
		proto.handleMouse = later;
		stop();
		expect(proto.handleMouse).toBe(later);
		if (original) Object.defineProperty(proto, "handleMouse", original);
		else Reflect.deleteProperty(proto, "handleMouse");
	});
	it("原生前驱已处理时不重复执行，结构不兼容仅告警一次", () => {
		const originalMouse = vi.fn((_event: TuiMouseEvent) => ({ handled: true }));
		const proto = { render: () => [], handleMouse: originalMouse };
		const warn = vi.fn();
		const stop = installNativeModelMouse(warn, proto);
		proto.render();
		proto.render();
		expect(warn).toHaveBeenCalledOnce();
		expect(proto.handleMouse({} as never)).toEqual({ handled: true });
		stop();
	});
});
