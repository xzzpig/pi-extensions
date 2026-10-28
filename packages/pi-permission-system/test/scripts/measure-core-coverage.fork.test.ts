import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/measure-core-coverage.mjs");
const temporaryDirs: string[] = [];
afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(declarations: string | undefined) {
	const dir = mkdtempSync(join(tmpdir(), "pi-permission-measure-"));
	temporaryDirs.push(dir);
	const log = join(dir, "log.jsonl");
	const config = join(dir, "declarations.json");
	writeFileSync(log, "");
	if (declarations !== undefined) writeFileSync(config, declarations);
	return { log, config };
}

function run(log: string, config: string) {
	return spawnSync(process.execPath, [script, log, "--declarations", config], { encoding: "utf8" });
}

describe("coverage measurement declaration errors", () => {
	it.each([undefined, "{invalid"])("fails clearly for a missing or malformed declaration file", (data) => {
		const { log, config } = fixture(data);
		const result = run(log, config);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(`Cannot read or parse declarations: ${config}`);
	});

	it("still accepts a valid declarations object", () => {
		const { log, config } = fixture('{}');
		expect(run(log, config).status).toBe(0);
	});
});
