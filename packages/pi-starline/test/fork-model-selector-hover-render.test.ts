import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { decorateModelHover } from "../extensions/starline/fork-model-selector-hover";
import { host, makeSelector, requiredGeometry } from "./fork-model-selector-fixture";

describe("悬停装饰的原生渲染与代次契约", () => {
	it("普通重绘保持列表身份，原生导航、范围、同结果刷新及列表更新重建身份", async () => {
		const f = await makeSelector(24, true);
		const snapshot = () => f.state.listContainer.children.slice();
		let previous = snapshot();
		f.selector.render(80);
		f.selector.render(80);
		expect(snapshot()).toHaveLength(previous.length);
		expect(snapshot().every((child, index) => child === previous[index])).toBe(true);
		const rebuilt = () => {
			const current = snapshot();
			expect(current[0]).not.toBe(previous[0]);
			previous = current;
		};
		f.selector.handleInput("\x1b[B");
		rebuilt();
		f.selector.handleInput("\t");
		rebuilt();
		const before = requiredGeometry(f.selector, 80).signature;
		// SAFETY: actual class refresh method, as in the existing geometry contract.
		await (f.selector as unknown as { refreshModels(): Promise<void> }).refreshModels();
		rebuilt();
		expect(requiredGeometry(f.selector, 80).signature).toBe(before);
		f.state.updateList(); // Also the native rebuild used by the wheel adapter, including boundaries.
		rebuilt();
	});

	for (const [theme, background] of [
		["dark", "\x1b[48;2;49;50;68m"],
		["light", "\x1b[48;2;208;208;208m"],
	] as const) {
		it(`${theme} 原生文本与标记保留，模型全部续行装饰，非目标行字节不变`, async () => {
			host.initTheme(theme);
			const f = await makeSelector(4);
			const lines = f.selector.render(18);
			const g = requiredGeometry(f.selector, 18);
			const row = g.rows[0];
			expect(row.end - row.start).toBeGreaterThan(1);
			const output = decorateModelHover(lines, g, row, background);
			expect(output).toHaveLength(lines.length);
			for (let y = 0; y < lines.length; y++) {
				expect(stripTerminalSequences(output[y])).toBe(stripTerminalSequences(lines[y]));
				expect(visibleWidth(output[y])).toBe(visibleWidth(lines[y]));
				if (y >= row.start && y < row.end) {
					expect(output[y].startsWith(background)).toBe(true);
					expect(output[y].endsWith("\x1b[49m")).toBe(true);
					expect(
						output[y]
							.split(background)
							.join("")
							.replace(/\x1b\[49m$/, ""),
					).toBe(lines[y]);
				} else expect(output[y]).toBe(lines[y]);
			}
			expect(stripTerminalSequences(output.slice(row.start, row.end).join(""))).toContain("→");
			expect(stripTerminalSequences(output.slice(row.start, row.end).join(""))).toContain(
				"model-00",
			);
			host.initTheme("dark");
		});
	}

	it("内部 ANSI 全重置及背景重置后重申背景，保留前景、宽字符和行尾空白", async () => {
		const f = await makeSelector(1);
		const g = requiredGeometry(f.selector, 80);
		const row = g.rows[0];
		const lines = f.selector.render(80);
		const bg = "\x1b[48;5;237m";
		lines[row.start] = "→ ✓ \x1b[31m中\x1b[0m文\x1b[49m宽\x1b[1;39m字符 · default  ";
		const output = decorateModelHover(lines, g, row, bg);
		expect(stripTerminalSequences(output[row.start])).toBe("→ ✓ 中文宽字符 · default  ");
		expect(visibleWidth(output[row.start])).toBe(visibleWidth(lines[row.start]));
		for (const sequence of ["\x1b[31m", "\x1b[0m", "\x1b[49m", "\x1b[1;39m"])
			expect(output[row.start]).toContain(sequence + bg);
		expect(output[row.start].endsWith("  \x1b[49m")).toBe(true);
		expect(output[row.end]).toBe(lines[row.end]);
		expect(decorateModelHover(lines.slice(1), g, row, bg)).toEqual(lines.slice(1));
	});
});
