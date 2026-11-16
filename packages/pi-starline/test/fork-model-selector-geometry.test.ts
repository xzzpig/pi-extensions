import { describe, expect, it } from "vitest";
import {
	modelRowAt,
	selectorGeometry,
	selectorState,
} from "../extensions/starline/fork-model-selector-geometry";
import { makeSelector, requiredGeometry } from "./fork-model-selector-fixture";

describe("真实原生模型选择器几何契约", () => {
	it("拒绝不可验证结构", () => {
		for (const value of [
			null,
			{},
			{
				render() {
					return [];
				},
				children: [],
			},
		]) {
			expect(selectorState(value)).toBeUndefined();
		}
	});
	it("拒绝缺失或无效的终端行数，不能假设组件高度就是视口高度", async () => {
		const f = await makeSelector();
		for (const rows of [undefined, 0, -1, NaN, 65.5, "65"]) {
			Object.assign(f.terminal, { rows });
			expect(selectorState(f.selector)).toBeUndefined();
			expect(selectorGeometry(f.selector, 80)).toBeUndefined();
		}
		f.terminal.rows = 65;
		expect(selectorState(f.selector)).toBeDefined();
	});
	it("超过一屏时映射原生可见切片，不截断候选", async () => {
		const { selector, state } = await makeSelector();
		state.selectedIndex = 17;
		state.updateList();
		const rendered = selector.render(100);
		const geometry = requiredGeometry(selector, 100);
		expect(geometry.height).toBe(rendered.length);
		expect(geometry.rows.map((row) => row.index)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
		for (const row of geometry.rows) {
			expect(rendered.slice(row.start, row.end).join("\n")).toContain(row.model.id);
			expect(modelRowAt(geometry, 5, row.start)?.model).toBe(row.model);
		}
		expect(state.filteredModels).toHaveLength(24);
	});
	it("换行续行全部指向同一模型，resize 重新计算命中", async () => {
		const { selector } = await makeSelector();
		selector.render(18);
		const narrow = requiredGeometry(selector, 18);
		expect(narrow.rows.some((row) => row.end - row.start > 1)).toBe(true);
		for (const row of narrow.rows) {
			for (let y = row.start; y < row.end; y++) {
				expect(modelRowAt(narrow, 2, y)?.model).toBe(row.model);
			}
		}
		selector.render(120);
		const wide = requiredGeometry(selector, 120);
		expect(wide.signature).not.toBe(narrow.signature);
		expect(wide.height).toBeLessThan(narrow.height);
	});
	it("标题和列表说明不是模型，非法坐标不命中", async () => {
		const { selector } = await makeSelector(3);
		selector.render(80);
		const g = requiredGeometry(selector, 80);
		expect(modelRowAt(g, 2, 0)).toBeUndefined();
		expect(modelRowAt(g, 2, g.rows[g.rows.length - 1].end)).toBeUndefined();
		for (const x of [-1, 80, NaN, Infinity])
			expect(modelRowAt(g, x, g.rows[0].start)).toBeUndefined();
	});
	it("搜索空结果、清空搜索与候选刷新不沿用旧映射", async () => {
		const { selector, models } = await makeSelector();
		selector.render(80);
		const before = requiredGeometry(selector, 80);
		selector.handleInput("no-such-result");
		selector.render(80);
		expect(selectorGeometry(selector, 80)?.rows).toEqual([]);
		selector.getSearchInput().setValue("");
		selector.handleInput("");
		models.splice(5);
		// SAFETY: refreshModels is the real class method inspected by this contract test.
		await (selector as unknown as { refreshModels(): Promise<void> }).refreshModels();
		selector.render(80);
		const after = requiredGeometry(selector, 80);
		expect(after.rows).toHaveLength(5);
		expect(after.signature).not.toBe(before.signature);
	});
	it("范围切换保留原生候选，关闭后不提供几何", async () => {
		const { selector, state } = await makeSelector(24, true);
		expect(state.filteredModels).toHaveLength(14);
		// SAFETY: setScope is the real class method inspected by this contract test.
		(selector as unknown as { setScope(scope: string): void }).setScope("all");
		expect(state.filteredModels).toHaveLength(24);
		selector.dispose();
		expect(selectorGeometry(selector, 80)).toBeUndefined();
	});
});
