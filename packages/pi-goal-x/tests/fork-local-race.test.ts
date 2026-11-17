import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { goalLocalSettingsPath, mutateSettingsLayer } from "../extensions/goal-settings.ts";

test("local writers preserve concurrent fields and refuse symlink targets", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-local-race-"));
	try {
		const worker = (key: string) => new Promise<void>((resolve, reject) => {
			const child = new Worker(new URL("./fork-local-race-worker.mjs", import.meta.url), { workerData: { cwd, key }, execArgv: ["--experimental-strip-types"] });
			child.on("error", reject);
			child.on("exit", code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
		});
		await Promise.all([worker("provider"), worker("model")]);
		const local = goalLocalSettingsPath(cwd);
		const result = JSON.parse(fs.readFileSync(local, "utf8"));
		assert.equal(result.auditor.provider, "provider-11");
		assert.equal(result.auditor.model, "model-11");
		const target = path.join(cwd, "target.json");
		fs.writeFileSync(target, "{}"); fs.unlinkSync(local); fs.symlinkSync(target, local);
		assert.throws(() => mutateSettingsLayer({ cwd, scope: "local", env: { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(cwd, "missing") }, mutation: { op: "set", path: ["disableTasks"], value: true } }), /symlink/i);
		assert.equal(fs.readFileSync(target, "utf8"), "{}");
	} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
