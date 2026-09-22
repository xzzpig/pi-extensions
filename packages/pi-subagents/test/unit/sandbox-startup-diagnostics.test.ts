import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
	clearSandboxStartupDiagnostic,
	readSandboxStartupDiagnostic,
	SANDBOX_DIAGNOSTICS_PATH_ENV,
} from "../../src/runs/shared/sandbox-startup-diagnostics.ts";
import { buildProfileLaunchEnv } from "../../src/runs/shared/profile-launch-env.ts";

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

// launcher→child integration: the launcher allocates the diagnostics path through
// buildProfileLaunchEnv, the child extension writes its record there, and the
// launcher reads it back. An untrusted project's skipped-profiles warning must be
// a warning, never a startup refusal: pi-sandbox writes `warnings` but no `reason`,
// so the reader (which requires a reason) returns undefined and the launcher's
// startup-blocked branch cannot fire. Selecting an undefined name still writes a
// reason record, which is read back with the correct profile and reason.
test("launcher→child: an untrusted project's skipped-profiles warning is non-fatal", () => {
	const root = fixtureRoot();
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const { childEnv, sandboxDiagnosticsPath } = buildProfileLaunchEnv(
		{
			cwd,
			sandbox: "dev",
			// Untrusted project: the launcher passes the parent-authoritative state
			// and the child's own ctx.isProjectTrusted() is false; project profiles
			// are skipped with a warning instead of failing the launch.
			projectTrusted: false,
			host: "runner",
		},
		{ sandboxExtension: true },
	);
	assert.ok(sandboxDiagnosticsPath);
	assert.equal(childEnv?.[SANDBOX_DIAGNOSTICS_PATH_ENV], sandboxDiagnosticsPath);

	// The child extension writes exactly the record pi-sandbox's reportProfileWarning
	// writes for a skipped project profile: a `warnings` array, no `reason`.
	fs.mkdirSync(path.dirname(sandboxDiagnosticsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		sandboxDiagnosticsPath,
		JSON.stringify({
			version: 1,
			profile: "dev",
			warnings: ["Project defines 1 sandbox profile that was not applied (project is not trusted)."],
		}),
		{ mode: 0o600 },
	);

	// The launcher reads the record back: without a reason it is not a startup
	// refusal, so startupBlocked is never set and the exit code is not flipped
	// by the skipped profile (warning, not failure).
	assert.equal(readSandboxStartupDiagnostic(sandboxDiagnosticsPath), undefined);
});

test("launcher→child: selecting an undefined profile name still fails closed with the correct diagnostic", () => {
	const root = fixtureRoot();
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const { sandboxDiagnosticsPath } = buildProfileLaunchEnv(
		{ cwd, sandbox: "missing-profile", projectTrusted: true, host: "runner" },
		{ sandboxExtension: true },
	);
	assert.ok(sandboxDiagnosticsPath);

	// The child extension writes the reason record exactly as pi-sandbox's
	// writeStartupFailureDiagnostic does for a profile that cannot resolve.
	const reason = "Sandbox profile 'missing-profile' could not initialize: "
		+ "Sandbox profile 'missing-profile' is not defined in the global or project "
		+ "sandbox configuration. Add it to a profiles map. Available profiles: (none).";
	fs.mkdirSync(path.dirname(sandboxDiagnosticsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		sandboxDiagnosticsPath,
		JSON.stringify({ version: 1, profile: "missing-profile", reason }),
		{ mode: 0o600 },
	);

	// The launcher reads the record back with the correct profile and reason,
	// which is what sets result.startupBlocked = true and the child's exit code.
	assert.deepEqual(readSandboxStartupDiagnostic(sandboxDiagnosticsPath), {
		version: 1,
		profile: "missing-profile",
		reason,
	});
	// The launcher clears the consumed record so a stale diagnostic cannot
	// describe a later attempt.
	clearSandboxStartupDiagnostic(sandboxDiagnosticsPath);
	assert.equal(fs.existsSync(sandboxDiagnosticsPath), false);
});
