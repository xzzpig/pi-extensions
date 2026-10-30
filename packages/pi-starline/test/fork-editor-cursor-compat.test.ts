import { CURSOR_MARKER, Editor, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../extensions/starline/config";
import { applyEditorCursorStyle } from "../extensions/starline/editor-cursor";
import { PolishedEditor, WrappedPolishedEditor } from "../extensions/starline/ui";

// Pi 1.2+ wraps the cursor cell in APC markers until the TUI renders the frame.
const FAKE_START = "\x1b_pi:fc\x07";
const FAKE_END = "\x1b_pi:/fc\x07";
const wrap = (text: string) => `${FAKE_START}${text}${FAKE_END}`;

describe("editor cursor styles on Pi 1.2+", () => {
	it("keeps the default block intact and rewrites only the marked cursor", () => {
		const line = `hello ${CURSOR_MARKER}${wrap("w")}orld`;
		expect(applyEditorCursorStyle(line, "block")).toBe(line);
		expect(applyEditorCursorStyle(line, "underline")).toBe(
			`hello ${CURSOR_MARKER}\x1b[4mw\x1b[0morld`,
		);
		expect(applyEditorCursorStyle(line, "terminal")).toBe(`hello ${CURSOR_MARKER}world`);
	});

	it("handles an unfocused cursor, trailing space and multi-codepoint graphemes", () => {
		for (const value of [" ", "🎉", "🇯🇵", "e\u0301"]) {
			const line = `left${wrap(value)}right`;
			expect(applyEditorCursorStyle(line, "underline")).toBe(`left\x1b[4m${value}\x1b[0mright`);
			expect(applyEditorCursorStyle(line, "terminal")).toBe(`left${value}right`);
		}
	});

	it("leaves plain text, unrelated styling, and incomplete markers untouched", () => {
		const line = `plain \x1b[7mselection\x1b[0m ${FAKE_START}broken`;
		expect(applyEditorCursorStyle(line, "underline")).toBe(line);
		expect(applyEditorCursorStyle(line, "terminal")).toBe(line);
	});

	it("restyles the real Starline editor frame, including a wrapped editor", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
			underline: (text: string) => text,
			strikethrough: (text: string) => text,
			getThinkingBorderColor: () => (text: string) => text,
		} as never;
		for (const style of ["underline", "terminal"] as const) {
			const config = { ...defaultConfig, editorCursor: style };
			const editor = new PolishedEditor(
				{ requestRender() {}, terminal: { rows: 24, cols: 80 } } as never,
				{ borderColor: (text: string) => text, selectList: {} } as never,
				{} as never,
				theme,
				() => config,
			);
			editor.focused = true;
			editor.setText("hello");
			const wrapped = new WrappedPolishedEditor(editor as never, theme, () => config);
			for (const rendered of [editor.render(80), wrapped.render(80)]) {
				const line = rendered.find((row) => row.includes(CURSOR_MARKER));
				expect(line).toBeDefined();
				expect(line).toContain(
					style === "underline" ? `${CURSOR_MARKER}\x1b[4m \x1b[0m` : `${CURSOR_MARKER} `,
				);
				expect(line).not.toContain(FAKE_START);
			}
		}
	});

	it("restyles actual Pi Editor output and preserves the hardware position marker", () => {
		const terminal = { columns: 80, rows: 24 } as never;
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, { borderColor: (s: string) => s, selectList: {} as never });
		editor.focused = true;
		editor.setText("hello");
		const line = editor.render(80).find((row) => row.includes(CURSOR_MARKER));
		if (line === undefined) throw new Error("focused editor emitted no cursor marker");
		const underline = applyEditorCursorStyle(line, "underline");
		const terminalCursor = applyEditorCursorStyle(line, "terminal");
		expect(underline).toContain(`${CURSOR_MARKER}\x1b[4m \x1b[0m`);
		expect(terminalCursor).toContain(`${CURSOR_MARKER} `);
		expect(underline).not.toContain(FAKE_START);
		expect(terminalCursor).not.toContain(FAKE_START);
	});
});
