import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configureNativeModelEntry,
	openNativeModelSelector,
} from "../extensions/starline/fork-model-selector-entry";
import { setActiveEditor } from "../extensions/starline/mouse/editor-mouse";
import { pillActionFor, setModelSwitcher } from "../extensions/starline/pill-actions";

function fixture(id = "session") {
	const notify = vi.fn();
	const custom = vi.fn(async () => undefined);
	const action = vi.fn();
	const editor = {
		focused: true,
		draft: "未提交草稿",
		actionHandlers: new Map([["app.model.select", action]]),
		tui: { hasOverlay: () => false },
	};
	// SAFETY: the entry reads only these context fields; no session or model requests run.
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => id },
		ui: { notify, custom },
	} as unknown as ExtensionContext;
	setActiveEditor({ component: editor, scrollable: editor });
	configureNativeModelEntry(ctx);
	return { ctx, editor, action, notify, custom };
}
afterEach(() => {
	configureNativeModelEntry(undefined);
	setActiveEditor(undefined);
	setModelSwitcher(undefined);
});

describe("模型药丸原生入口", () => {
	it("点击经药丸动作调用原生动作，不打开气泡、不覆盖草稿", async () => {
		const { ctx, editor, action, custom } = fixture();
		await pillActionFor("model")?.({ ctx, via: "click" });
		expect(action).toHaveBeenCalledOnce();
		expect(custom).not.toHaveBeenCalled();
		expect(editor.draft).toBe("未提交草稿");
	});
	it("选择器接管焦点后不重复挂载，取消恢复焦点后可重开", () => {
		const { ctx, editor, action } = fixture();
		action.mockImplementation(() => {
			editor.focused = false;
		});
		expect(openNativeModelSelector(ctx)).toBe(true);
		expect(openNativeModelSelector(ctx)).toBe(false);
		expect(action).toHaveBeenCalledOnce();
		editor.focused = true;
		expect(openNativeModelSelector(ctx)).toBe(true);
	});
	it("包装编辑器转发动作表，基础编辑器的浮层阻止重入", () => {
		const { ctx, editor, action } = fixture();
		const wrapper = {
			focused: true,
			get actionHandlers() {
				return editor.actionHandlers;
			},
		};
		setActiveEditor({ component: wrapper, scrollable: editor });
		expect(openNativeModelSelector(ctx)).toBe(true);
		editor.tui.hasOverlay = () => true;
		expect(openNativeModelSelector(ctx)).toBe(false);
		expect(action).toHaveBeenCalledOnce();
	});
	it("缺少动作按会话去重说明，不猜测快捷键或提交文本", () => {
		const { ctx, editor, notify, custom } = fixture();
		editor.actionHandlers.clear();
		expect(openNativeModelSelector(ctx)).toBe(false);
		expect(openNativeModelSelector(ctx)).toBe(false);
		expect(notify).toHaveBeenCalledOnce();
		expect(custom).not.toHaveBeenCalled();
		expect(editor.draft).toBe("未提交草稿");
	});
	it("无 UI 和 RPC 不打开界面", () => {
		const { ctx, action } = fixture();
		expect(openNativeModelSelector({ ...ctx, hasUI: false })).toBe(false);
		// SAFETY: mode is present on current Pi; older workspace context types omit it.
		expect(openNativeModelSelector({ ...ctx, mode: "rpc" } as unknown as ExtensionContext)).toBe(
			false,
		);
		expect(action).not.toHaveBeenCalled();
	});
	it("会话替换和卸载不允许旧动作执行", () => {
		const old = fixture("old");
		const current = fixture("new");
		expect(openNativeModelSelector(old.ctx)).toBe(false);
		expect(current.action).not.toHaveBeenCalled();
		configureNativeModelEntry(undefined);
		expect(openNativeModelSelector(current.ctx)).toBe(false);
	});
});
