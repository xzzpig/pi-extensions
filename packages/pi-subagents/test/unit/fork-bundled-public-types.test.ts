import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { stageForkPublicTypes } from "../../scripts/fork-stage-public-types.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

it("keeps the fork's AgentToolResult augmentation in compiled package declarations", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-public-types-"));
	try {
		const output = path.join(tmp, "dist-pkg");
		fs.mkdirSync(output);
		fs.writeFileSync(path.join(output, "index.d.ts"), "export {};\n");
		// Model an SDK declaration without isError so the compatibility augmentation
		// is actually exercised; Pi 1.2's own declaration already has the field.
		fs.writeFileSync(path.join(tmp, "agent-core.d.ts"), "export interface AgentToolResult<T> { content: never[]; details: T }\n");
		fs.writeFileSync(path.join(tmp, "consumer.mts"), `import "published-subagents";\nimport type { AgentToolResult } from "@earendil-works/pi-agent-core";\nconst result: AgentToolResult<undefined> = { content: [], details: undefined, isError: true };\nvoid result.isError;\n`);
		fs.writeFileSync(path.join(tmp, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
				noEmit: true, skipLibCheck: true, types: [], baseUrl: tmp,
				paths: {
					"published-subagents": [path.join(output, "index.d.ts")],
					"@earendil-works/pi-agent-core": [path.join(tmp, "agent-core.d.ts")],
				},
			},
			files: [path.join(tmp, "consumer.mts")],
		}));
		const check = () => spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(tmp, "tsconfig.json")], { encoding: "utf8" });
		const withoutForkTypes = check();
		assert.notEqual(withoutForkTypes.status, 0);
		assert.match(withoutForkTypes.stdout + withoutForkTypes.stderr, /isError/u);
		stageForkPublicTypes(root, output);
		const withForkTypes = check();
		assert.equal(withForkTypes.status, 0, withForkTypes.stdout + withForkTypes.stderr);
		assert.equal(fs.readFileSync(path.join(output, "src/types/pi-runtime-compat.d.ts"), "utf8"), fs.readFileSync(path.join(root, "src/types/pi-runtime-compat.d.ts"), "utf8"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
