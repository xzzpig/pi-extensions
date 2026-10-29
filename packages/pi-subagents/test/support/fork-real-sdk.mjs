// Opt in to the fork's pinned Pi minimum, including for spawned test processes.
import * as fs from "node:fs";
import { registerHooks } from "node:module";

const sdkEntry = import.meta.resolve("pi-subagents-test-sdk");
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", sdkEntry), "utf8"));
if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "1.2.0") {
	throw new Error("Real-SDK suites require the pinned Pi 1.2.0 test SDK.");
}
registerHooks({
	resolve(specifier, context, nextResolve) {
		return specifier === "@earendil-works/pi-coding-agent"
			? { url: sdkEntry, shortCircuit: true }
			: nextResolve(specifier, context);
	},
});
