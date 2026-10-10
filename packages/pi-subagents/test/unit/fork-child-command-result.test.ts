import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createChildCommandRuntime } from "../../src/runs/shared/child-commands.ts";

for (const mode of ["failure", "cancel", "run-abort"] as const) {
	it(`handles Pi error results as ${mode === "cancel" ? "cancelled" : "failed"} without poisoning the command controller (${mode})`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-command-result-"));
		const commands = createChildCommandRuntime(dir);
		const controller = new AbortController();
		let complete!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const tool: ToolDefinition = {
			name: "bash", label: "Mock bash", description: "No shell is executed", parameters: Type.Object({}),
			async execute(_id, _params, signal) {
				await new Promise<void>((resolve) => {
					complete = resolve;
					signal?.addEventListener("abort", () => resolve(), { once: true });
					entered();
				});
				return { content: [{ type: "text", text: "Command exited with code 7" }], details: undefined, isError: true };
			},
		};
		try {
			const pending = commands.wrap(tool).execute("failed", {}, controller.signal, undefined, {} as never);
			const rejected = assert.rejects(pending, /Command exited with code 7/);
			await started;
			if (mode === "cancel") commands.operate("cancel", "failed");
			else if (mode === "run-abort") controller.abort();
			else complete();
			await rejected;
			const snapshot = commands.state().commands[0]!;
			assert.equal(snapshot.state, mode === "cancel" ? "cancelled" : "failed");
			assert.ok(snapshot.endedAt);
			assert.match(snapshot.output, /code 7/);
			const success = { content: [{ type: "text" as const, text: "recovered" }], details: undefined };
			const recovered = await commands.wrap({ ...tool, execute: async () => success }).execute("recovered", {}, undefined, undefined, {} as never);
			assert.equal(recovered, success);
			assert.equal(commands.operate("status", "recovered").commands[0]!.state, "completed");
			await commands.finish();
		} finally {
			complete?.();
			await commands.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}
