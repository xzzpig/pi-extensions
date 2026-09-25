import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

// Upstream-original preload: JITI_ALIAS is written by the runner launcher, so a malformed value must fail loudly.
// pi-lens-ignore: unchecked-throwing-call-js
const aliases = JSON.parse(process.env.JITI_ALIAS ?? "{}");
const nativeRunner = process.env.PI_ASYNC_NATIVE_RUNNER === "1";
const redirected = new Set([
	"@earendil-works/pi-tui",
]);

// Upstream-original: Node version feature detection for registerHooks (Node 22.12+ vs register()).
// pi-lens-ignore: no-runtime-typeof
if (typeof nodeModule.registerHooks === "function") {
	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			const alias = nativeRunner ? aliases[specifier] : redirected.has(specifier) && aliases[specifier];
			if (alias) {
				const target = pathToFileURL(alias).href;
				return nativeRunner ? { url: target, shortCircuit: true } : nextResolve(target, context);
			}
			try {
				return nextResolve(specifier, context);
			} catch (error) {
				if (nativeRunner && specifier.endsWith(".js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
				throw error;
			}
		},
	});
} else {
	nodeModule.register(new URL("./runner-peer-loader.mjs", import.meta.url), {
		data: { aliases, nativeRunner },
	});
}
