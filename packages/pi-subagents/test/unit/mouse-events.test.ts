import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMouseWheelEvent } from "../../src/tui/mouse-events.ts";

describe("parseMouseWheelEvent", () => {
	it("parses SGR wheel up", () => {
		assert.deepEqual(parseMouseWheelEvent("\x1b[<64;12;34M"), { direction: -1, x: 11 });
	});

	it("parses SGR wheel down", () => {
		assert.deepEqual(parseMouseWheelEvent("\x1b[<65;12;34M"), { direction: 1, x: 11 });
	});

	it("parses X10 wheel up (button 64, 1-based column 12 encoded +32)", () => {
		const data = `\x1b[M${String.fromCharCode(64 + 32, 12 + 32, 34 + 32)}`;
		assert.equal(data.length, 6);
		assert.deepEqual(parseMouseWheelEvent(data), { direction: -1, x: 11 });
	});

	it("parses X10 wheel down (button 65)", () => {
		const data = `\x1b[M${String.fromCharCode(65 + 32, 12 + 32, 34 + 32)}`;
		assert.deepEqual(parseMouseWheelEvent(data), { direction: 1, x: 11 });
	});

	it("ignores non-wheel buttons (click, drag, release)", () => {
		assert.equal(parseMouseWheelEvent("\x1b[<0;12;34M"), undefined); // left click
		assert.equal(parseMouseWheelEvent("\x1b[<35;12;34M"), undefined); // right click
		assert.equal(parseMouseWheelEvent("\x1b[<96;12;34M"), undefined); // wheel release
		assert.equal(parseMouseWheelEvent("\x1b[<66;12;34M"), undefined); // horizontal wheel
	});

	it("ignores X10 wheel release (button 96)", () => {
		const data = `\x1b[M${String.fromCharCode(96 + 32, 12 + 32, 34 + 32)}`;
		assert.equal(parseMouseWheelEvent(data), undefined);
	});

	it("ignores unrelated input", () => {
		assert.equal(parseMouseWheelEvent("j"), undefined);
		assert.equal(parseMouseWheelEvent("\x1b[A"), undefined);
		assert.equal(parseMouseWheelEvent(""), undefined);
	});
});