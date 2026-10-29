import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { stageForkBundledComponents } from "../../scripts/fork-stage-bundled-components.mjs";

it("stages the private component with a runnable JavaScript export without changing its workspace manifest", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-bundled-components-"));
	try {
		const source = path.join(tmp, "root/node_modules/@xzzpig/pi-components");
		const output = path.join(tmp, "package");
		fs.mkdirSync(path.join(source, "src"), { recursive: true });
		fs.mkdirSync(path.join(source, "dist/src"), { recursive: true });
		const manifest = {
			name: "@xzzpig/pi-components", version: "0.4.0", type: "module", files: ["src", "dist"],
			exports: { "./transcript": { types: "./dist/src/transcript.d.ts", default: "./src/transcript.ts" } },
		};
		fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(manifest));
		fs.writeFileSync(path.join(source, "src/transcript.ts"), "throw new Error('source must not load');\n");
		fs.writeFileSync(path.join(source, "dist/src/transcript.js"), "export const nativeTranscript = true;\n");
		fs.writeFileSync(path.join(source, "dist/src/transcript.d.ts"), "export declare const nativeTranscript: boolean;\n");
		stageForkBundledComponents(path.join(tmp, "root"), output, {
			bundledDependencies: ["@xzzpig/pi-components"], dependencies: { "@xzzpig/pi-components": "0.4.0" },
		});
		const staged = JSON.parse(fs.readFileSync(path.join(output, "node_modules/@xzzpig/pi-components/package.json"), "utf8"));
		assert.equal(staged.exports["./transcript"].default, "./dist/src/transcript.js");
		assert.equal(staged.exports["./transcript"].types, "./dist/src/transcript.d.ts");
		assert.deepEqual(staged.files, ["dist"]);
		assert.equal(fs.existsSync(path.join(output, "node_modules/@xzzpig/pi-components/src")), false);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")), manifest);
		const probe = path.join(output, "probe.mjs");
		fs.writeFileSync(probe, 'import { nativeTranscript } from "@xzzpig/pi-components/transcript";\nif (!nativeTranscript) process.exitCode = 1;\n');
		const result = spawnSync(process.execPath, [probe], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
