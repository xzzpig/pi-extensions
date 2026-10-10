// Fork harness: preserve the lightweight shim for mock-only suites while testing
// upstream's real-SDK contracts against the pinned workspace Pi installation.
import * as fs from "node:fs";
import * as path from "node:path";
import { registerHooks } from "node:module";
import "./isolated-temp-root.mjs";

// Project discovery considers USERPROFILE a home boundary even on Unix. Keep
// fixtures from inheriting host ancestor .agents/.pi directories outside their
// allocated test root, without changing the isolated HOME used for user files.
process.env.USERPROFILE = process.env.PI_SUBAGENTS_TEMP_ROOT;
fs.mkdirSync(process.env.HOME, { recursive: true });

const realSdkSuites = new Set([
	"child-commands.test.ts",
	"child-prompt-sections.test.ts",
	"child-session-commands.test.ts",
	"command-action.test.ts",
	"declaration-pinning.test.ts",
	"in-process-child.test.ts",
	"notify.test.ts",
	"parent-wake.test.ts",
	"session-liveness-delivery.test.ts",
	"subagent-messages.test.ts",
]);
if (realSdkSuites.has(path.basename(process.argv[1] ?? ""))) {
	const sdkRoot = new URL("../../../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
	const manifest = JSON.parse(fs.readFileSync(new URL("package.json", sdkRoot), "utf8"));
	if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "1.0.0") {
		throw new Error("Real-SDK suites require the pinned workspace Pi 1.0.0 package.");
	}
	const sdkEntry = new URL(manifest.exports["."].import, sdkRoot).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			return specifier === "@earendil-works/pi-coding-agent"
				? { url: sdkEntry, shortCircuit: true }
				: nextResolve(specifier, context);
		},
	});
}
