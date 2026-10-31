/**
 * Test-group planning shared by `run-unit-tests.mjs` and its regression test.
 *
 * The approved supplement requires three precisely separated groups:
 *   1. stub suites      — the bulk, preloaded with the Goal-X adapter;
 *   2. SDK suites       — real SDK, so the adapter must NOT be preloaded and the
 *                         inherited NODE_OPTIONS must be cleared;
 *   3. every non-empty group must still execute when another group fails.
 *
 * Pure functions only, so the contract is testable without spawning a suite.
 */

/** Integration files that must run against the REAL SDK, never the stub adapter. */
export const SDK_TEST_FILES = [
	"tests/integration/goal-audit-sidechannel-sdk.test.ts",
	"tests/integration/goal-auto-continue-gate-sdk.test.ts",
];

/**
 * @param {{ unitFiles: string[], integrationFiles: string[] }} discovered
 * @returns {Array<{ name: string, files: string[], adapter: boolean, clearNodeOptions: boolean }>}
 */
export function planTestGroups(discovered) {
	const suite = discovered.suite ?? "unit";
	const sdk = new Set(SDK_TEST_FILES.map(normalize));
	// Discovered paths are absolute; compare by suffix so the match never depends on cwd.
	const isSdk = (file) => [...sdk].some((candidate) => normalize(file).endsWith(candidate));
	const integrationFiles = discovered.integrationFiles ?? [];
	const e2eFiles = discovered.e2eFiles ?? [];
	const stubIntegration = integrationFiles.filter((file) => !isSdk(file));
	const sdkFiles = integrationFiles.filter((file) => isSdk(file));
	const all = [
		{ name: "unit", files: [...(discovered.unitFiles ?? [])], adapter: true, clearNodeOptions: false },
		{ name: "integration", files: stubIntegration, adapter: true, clearNodeOptions: false },
		{ name: "sdk", files: sdkFiles, adapter: false, clearNodeOptions: true },
		{ name: "e2e", files: [...e2eFiles], adapter: true, clearNodeOptions: false },
	];
	// Only the requested suite(s) run: `test:unit` must never drag the integration
	// debt (or the real-SDK group) into its own exit code.
	// integration implies the isolated real-SDK group as well: the SDK file belongs to
	// the integration suite but must never share the stub adapter's process.
	const wanted = suite === "all"
		? new Set(["unit", "integration", "sdk", "e2e"])
		: suite === "integration"
			? new Set(["integration", "sdk"])
			: new Set([suite]);
	return all.filter((group) => wanted.has(group.name) && group.files.length > 0);
}

/** The argv tail for one group, given the preload path and isolation args. */
export function groupArgs(group, { adapterPath, isolationArgs = [] } = {}) {
	const args = [];
	if (group.adapter && adapterPath) args.push("--import", adapterPath);
	args.push("--experimental-strip-types", "--test", ...isolationArgs, ...group.files);
	return args;
}

function normalize(file) {
	return String(file).replace(/^\.\//, "");
}
