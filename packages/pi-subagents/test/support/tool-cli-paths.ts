import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

function packageCliPath(packageName: string, relativeCli: string): string {
	return path.join(path.dirname(require.resolve(`${packageName}/package.json`)), relativeCli);
}

/**
 * jiti's CLI entry point, resolved through Node instead of a fixed relative
 * path.
 *
 * Integration tests spawn the background runner through jiti. `jiti` is a
 * runtime dependency of this package, but pnpm may hoist it to the workspace
 * root, so `<package>/node_modules/jiti` does not always exist; Node's own
 * resolution follows whichever layout is installed.
 */
export function jitiCliPath(): string {
	return packageCliPath("jiti", "lib/jiti-cli.mjs");
}

/**
 * TypeScript's CLI entry point, resolved the same way.
 *
 * `typescript` is a devDependency, so a hoisted workspace install has no
 * `<package>/node_modules/typescript` directory to hardcode.
 */
export function typescriptCliPath(): string {
	return packageCliPath("typescript", "bin/tsc");
}
