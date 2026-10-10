import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { buildNativeFleetTranscript, loadNativeTranscriptSupport } from "../../src/tui/fleet-native-transcript.ts";

it("native Fleet reports transient read failures without treating malformed records as failed reads", async (t) => {
	const mod = await loadNativeTranscriptSupport();
	assert.ok(mod, "native transcript module must be available");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-native-read-"));
	const filePath = path.join(root, "transcript.jsonl");
	fs.writeFileSync(filePath, "not json\n");
	const openSync = fsDefault.openSync;
	let failNextOpen = true;
	t.mock.method(fsDefault, "openSync", (...args: Parameters<typeof fs.openSync>) => {
		if (String(args[0]) === filePath && failNextOpen) {
			failNextOpen = false;
			throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
		}
		return openSync(...args);
	});
	syncBuiltinESMExports();
	const input = { filePath, trustedRoots: [root], width: 80, expandedTools: false, theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } };
	try {
		assert.equal(buildNativeFleetTranscript(mod, input).readFailed, true);
		const recovered = buildNativeFleetTranscript(mod, input);
		assert.equal(recovered.readFailed, undefined);
		assert.match(recovered.warning ?? "", /malformed/);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
