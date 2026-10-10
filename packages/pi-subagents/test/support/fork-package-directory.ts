import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** Locate a dependency in npm's local or pnpm's hoisted workspace layout. */
export function forkTestPackageDirectory(projectRoot: string, name: string): string {
	const require = createRequire(path.join(projectRoot, "package.json"));
	for (const nodeModules of require.resolve.paths(name) ?? []) {
		const candidate = path.join(nodeModules, name);
		if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
	}
	throw new Error(`Missing test dependency '${name}' from ${projectRoot}`);
}
