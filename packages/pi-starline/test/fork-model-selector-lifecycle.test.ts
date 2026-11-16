import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initTheme, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installNativeModelMouse } from "../extensions/starline/fork-model-selector-mouse";
import starline from "../extensions/starline/index";
import { patchSelectorBorderStyle } from "../extensions/starline/selector-border";
import { host, makeSelector, requiredGeometry } from "./fork-model-selector-fixture";

const BG = "\x1b[48;5;237m";
function showHover(selector: InstanceType<typeof ModelSelectorComponent>) {
	selector.render(80);
	const g = requiredGeometry(selector, 80);
	const y = g.rows[2].start;
	selector.handleMouse({
		type: "move",
		button: "none",
		x: 3,
		y,
		width: 80,
		height: g.height,
		screenX: 3,
		screenY: y,
		shift: false,
		alt: false,
		ctrl: false,
	});
	expect(selector.render(80).some((line) => line.includes(BG))).toBe(true);
}

vi.mock("../extensions/starline/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../extensions/starline/config")>();
	return {
		...actual,
		ensureConfigExists() {},
		loadConfig: () => ({
			...actual.defaultConfig,
			features: { editor: true, statusLine: false },
			mouse: { ...actual.defaultConfig.mouse, enabled: false },
		}),
	};
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function lifecycle() {
	const handlers = new Map<string, Handler[]>();
	starline({
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
		getThinkingLevel: () => "off",
	} as never);
	let factory: unknown;
	// SAFETY: lifecycle-only fixture supplies all context fields reached here; it never creates an editor or model request.
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		model: { id: "fixture", provider: "fixture", contextWindow: 128000 },
		sessionManager: {
			getSessionId: () => "fixture",
			getBranch: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 128000, percent: 0 }),
		ui: {
			theme: { fg: (_color: string, text: string) => text, getBgAnsi: () => BG },
			notify: vi.fn(),
			setFooter() {},
			setEditorComponent(value: unknown) {
				factory = value;
			},
			getEditorComponent: () => factory,
		},
	} as unknown as ExtensionContext;
	return async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
	};
}

function descriptors(prototype: { render(width: number): string[] }) {
	return {
		render: Object.getOwnPropertyDescriptor(prototype, "render"),
		mouse: Object.getOwnPropertyDescriptor(prototype, "handleMouse"),
	};
}

describe("模型鼠标与既有选择器边框的组合生命周期", () => {
	it("真实 Starline 会话启动/结束重复周期恢复方法和描述符，不累积停用包装", async () => {
		initTheme("dark");
		const proto = ModelSelectorComponent.prototype;
		const before = descriptors(proto);
		const originalRender = proto.render;
		const originalMouse = proto.handleMouse;
		for (let cycle = 0; cycle < 5; cycle++) {
			const emit = lifecycle();
			try {
				await emit("session_start");
				expect(proto.render).not.toBe(originalRender);
				expect(proto.handleMouse).not.toBe(originalMouse);
				const f = await makeSelector(24, false, ModelSelectorComponent);
				expect(f.selector.render(80).some((line) => line.includes(BG))).toBe(false);
				showHover(f.selector);
			} finally {
				await emit("session_shutdown");
			}
			expect(proto.render).toBe(originalRender);
			expect(proto.handleMouse).toBe(originalMouse);
			expect(descriptors(proto)).toEqual(before);
		}
	});
	it("后续 render 包装保持所有权，旧适配停止后不再装饰", async () => {
		const proto = host.ModelSelectorComponent.prototype;
		const original = Object.getOwnPropertyDescriptor(proto, "render");
		const stop = installNativeModelMouse(vi.fn(), proto, () => BG);
		const wrapped = proto.render;
		const f = await makeSelector();
		const later = function (this: typeof proto, width: number) {
			return wrapped.call(this, width);
		};
		try {
			showHover(f.selector);
			proto.render = later;
			stop();
			expect(proto.render).toBe(later);
			expect(f.selector.render(80).some((line) => line.includes(BG))).toBe(false);
		} finally {
			stop();
			if (original) Object.defineProperty(proto, "render", original);
			else Reflect.deleteProperty(proto, "render");
		}
	});
	it("真实宿主两个补丁按安装逆序清理，重复周期恢复继承状态", async () => {
		const proto = host.ModelSelectorComponent.prototype;
		const before = descriptors(proto);
		const originalRender = proto.render;
		for (let cycle = 0; cycle < 5; cycle++) {
			const stopMouse = installNativeModelMouse(vi.fn(), proto, () => BG);
			const stopBorder = patchSelectorBorderStyle(proto);
			const f = await makeSelector();
			try {
				expect(f.selector.render(80).some((line) => line.includes(BG))).toBe(false);
				showHover(f.selector);
			} finally {
				stopBorder();
				stopMouse();
			}
			expect(f.selector.render(80).some((line) => line.includes(BG))).toBe(false);
			expect(proto.render).toBe(originalRender);
			expect(descriptors(proto)).toEqual(before);
		}
	});
});
