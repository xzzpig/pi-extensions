import { describe, expect, it } from "vitest";
import { externalMouseLayer } from "../../extensions/starline/mouse/external-layer";

/** The upstream external-layer detector remains compatible with the v2 key. */

const KEY = Symbol.for("pi-mouse-events.api.v2");

describe("externalMouseLayer", () => {
	it("is undefined when nothing publishes the key", () => {
		expect(externalMouseLayer({})).toBeUndefined();
	});

	it("is undefined for an object from a different contract major", () => {
		expect(
			externalMouseLayer({ [KEY]: { version: 1 } } as Record<PropertyKey, unknown>),
		).toBeUndefined();
		expect(
			externalMouseLayer({ [KEY]: "not an object" } as Record<PropertyKey, unknown>),
		).toBeUndefined();
	});

	it("names the extension when the contract matches", () => {
		expect(externalMouseLayer({ [KEY]: { version: 2 } } as Record<PropertyKey, unknown>)).toEqual({
			name: "@xzzpig/pi-mouse-events",
			version: 2,
		});
	});
});

// The fork is itself a pi-mouse-events consumer: prototype installation,
// selection-marker cleanup, and missing-API behavior are covered by the
// shared package and the fork's mouse API/installation contract tests.
