import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks !== "function") {
	throw new Error("Tests require Node 22.19 or newer.");
}

// Capture the REAL public SDK helpers that the bundled stub cannot honestly
// reimplement (session-context replay), BEFORE the stub resolver is installed.
// The capture is process-local and read-only; production code keeps importing
// the real package, and this hook only exists for the fast unit runner.
const REAL_SDK_KEY = Symbol.for("@xzzpig/pi-goal-x/real-pi-coding-agent");
if (globalThis[REAL_SDK_KEY] === undefined) {
	try {
		const real = await import("@earendil-works/pi-coding-agent");
		globalThis[REAL_SDK_KEY] = { buildSessionContext: real.buildSessionContext };
	} catch (error) {
		globalThis[REAL_SDK_KEY] = { error: error instanceof Error ? error.message : String(error) };
	}
}

const adapters = new Map([
	["@earendil-works/pi-ai", new URL("../tests/stubs/pi-ai.ts", import.meta.url).href],
	["@earendil-works/pi-coding-agent", new URL("../tests/stubs/pi-coding-agent.ts", import.meta.url).href],
	["@earendil-works/pi-tui", new URL("../tests/stubs/pi-tui.ts", import.meta.url).href],
]);

nodeModule.registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = adapters.get(specifier);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
