import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
	clearSandboxStartupDiagnostic,
	readSandboxStartupDiagnostic,
} from "../../src/runs/shared/sandbox-startup-diagnostics.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-startup-diagnostics-"));
	roots.push(root);
	return root;
}

test("reads a well-formed startup diagnostic written by a blocked child", () => {
	const file = path.join(fixtureRoot(), "diagnostic.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			version: 1,
			profile: "e2e-deny",
			reason: "Sandbox profile 'e2e-deny' could not initialize: not defined in the global sandbox configuration.",
		}),
	);
	assert.deepEqual(readSandboxStartupDiagnostic(file), {
		version: 1,
		profile: "e2e-deny",
		reason: "Sandbox profile 'e2e-deny' could not initialize: not defined in the global sandbox configuration.",
	});
});

test("ignores a missing path so an untouched child keeps its normal error", () => {
	assert.equal(readSandboxStartupDiagnostic(undefined), undefined);
	assert.equal(readSandboxStartupDiagnostic(path.join(fixtureRoot(), "absent.json")), undefined);
});

test("rejects malformed, oversized, and symlinked diagnostics as untrusted input", () => {
	const root = fixtureRoot();
	const malformed = path.join(root, "malformed.json");
	fs.writeFileSync(malformed, "{not json");
	assert.equal(readSandboxStartupDiagnostic(malformed), undefined);

	const wrongVersion = path.join(root, "wrong-version.json");
	fs.writeFileSync(wrongVersion, JSON.stringify({ version: 2, reason: "blocked" }));
	assert.equal(readSandboxStartupDiagnostic(wrongVersion), undefined);

	const emptyReason = path.join(root, "empty-reason.json");
	fs.writeFileSync(emptyReason, JSON.stringify({ version: 1, profile: "p", reason: "   " }));
	assert.equal(readSandboxStartupDiagnostic(emptyReason), undefined);

	const oversized = path.join(root, "oversized.json");
	fs.writeFileSync(oversized, JSON.stringify({ version: 1, reason: "x".repeat(9000) }));
	assert.equal(readSandboxStartupDiagnostic(oversized), undefined);

	const target = path.join(root, "target.json");
	fs.writeFileSync(target, JSON.stringify({ version: 1, reason: "blocked" }));
	const link = path.join(root, "link.json");
	fs.symlinkSync(target, link);
	assert.equal(readSandboxStartupDiagnostic(link), undefined);
});

test("clear removes the diagnostic without failing on an absent file", () => {
	const file = path.join(fixtureRoot(), "diagnostic.json");
	fs.writeFileSync(file, JSON.stringify({ version: 1, reason: "blocked" }));
	clearSandboxStartupDiagnostic(file);
	assert.equal(fs.existsSync(file), false);
	clearSandboxStartupDiagnostic(file);
	clearSandboxStartupDiagnostic(undefined);
});
