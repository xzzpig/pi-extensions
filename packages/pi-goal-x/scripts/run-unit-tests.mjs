import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = join(projectRoot, "tests");
const integrationRoot = join(testsRoot, "integration");
const e2eRoot = join(testsRoot, "e2e");
const manifestPath = join(testsRoot, ".test-manifest.json");
const suite = process.argv[2] ?? "unit";
const wantSelfCheck = process.argv.includes("--selfcheck");
const wantWriteManifest = process.argv.includes("--write-manifest");

function discover(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => join(directory, entry.name))
		.sort();
}

const unitFiles = discover(testsRoot);
const integrationFiles = discover(integrationRoot);
const e2eFiles = discover(e2eRoot);
const testFiles = suite === "integration"
	? integrationFiles
	: suite === "e2e"
		? e2eFiles
		: suite === "all"
			? [...unitFiles, ...integrationFiles, ...e2eFiles]
			: unitFiles;

if (testFiles.length === 0) {
	throw new Error("No " + suite + " test files were discovered.");
}

// ---- Self-check / manifest maintenance -------------------------------
// The manifest pins the EXPECTED discovered entries so drift (a new test
// file, a deleted one, or a directory change) is caught explicitly instead
// of silently changing what `npm test` covers.
if (wantWriteManifest) {
	writeFileSync(manifestPath, JSON.stringify({
		version: 1,
		note: "Expected test-entry manifest for the runner self-check (pnpm run test:selfcheck). Regenerate with: node scripts/run-unit-tests.mjs --write-manifest",
		unitFiles: unitFiles.map((file) => file.replace(projectRoot, ".")),
		integrationFiles: integrationFiles.map((file) => file.replace(projectRoot, ".")),
		e2eFiles: e2eFiles.map((file) => file.replace(projectRoot, ".")),
	}, null, 2) + "\n");
	console.log("Wrote " + manifestPath + " (" + unitFiles.length + " unit, " + integrationFiles.length + " integration, " + e2eFiles.length + " e2e entries).");
	process.exit(0);
}

if (wantSelfCheck) {
	if (!existsSync(manifestPath)) {
		throw new Error("Missing " + manifestPath + ". Run: node scripts/run-unit-tests.mjs --write-manifest");
	}
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error("Unreadable test manifest " + manifestPath + ": " + (error instanceof Error ? error.message : String(error)));
	}
	const rel = (file) => file.replace(projectRoot, ".");
	const expectedUnit = new Set(manifest.unitFiles ?? []);
	const expectedIntegration = new Set(manifest.integrationFiles ?? []);
	const expectedE2e = new Set(manifest.e2eFiles ?? []);
	const problems = [];
	for (const file of unitFiles) if (!expectedUnit.has(rel(file))) problems.push("unexpected unit entry: " + rel(file));
	for (const file of integrationFiles) if (!expectedIntegration.has(rel(file))) problems.push("unexpected integration entry: " + rel(file));
	for (const file of e2eFiles) if (!expectedE2e.has(rel(file))) problems.push("unexpected e2e entry: " + rel(file));
	for (const file of manifest.unitFiles ?? []) if (!unitFiles.map(rel).includes(file)) problems.push("missing unit entry: " + file);
	for (const file of manifest.integrationFiles ?? []) if (!integrationFiles.map(rel).includes(file)) problems.push("missing integration entry: " + file);
	for (const file of manifest.e2eFiles ?? []) if (!e2eFiles.map(rel).includes(file)) problems.push("missing e2e entry: " + file);
	if (problems.length > 0) {
		console.error("Runner self-check FAILED:");
		for (const problem of problems) console.error("  - " + problem);
		console.error("Refresh the manifest with: node scripts/run-unit-tests.mjs --write-manifest");
		process.exit(1);
	}
	console.log("Runner self-check OK: " + unitFiles.length + " unit + " + integrationFiles.length + " integration + " + e2eFiles.length + " e2e entries match " + manifestPath + ".");
	// The self-check is a LIST gate: it must not silently continue into a full
	// suite run (the approved fork/flake-free contract expects a check-and-exit).
	process.exit(0);
}

// ---- Execution ---------------------------------------------------------
const startedAt = Date.now();
// `--test-isolation=none` (single-process suite, shared module state) is only
// accepted by Node >= 23.4; probe the running binary and omit it on older
// releases so the same script works across the supported Node range (22.19+).
const { planTestGroups, groupArgs } = await import("./test-groups.mjs");
const { validateForkTestList } = await import("./fork-test-runner.mjs");
// The fork suite list is part of this runner's contract: a broken list must fail
// here instead of silently shrinking what the fork gate covers.
const forkProblems = validateForkTestList({ packageRoot: projectRoot });
if (forkProblems.length > 0) {
	console.error("fork suite list FAILED:");
	for (const problem of forkProblems) console.error("  - " + problem);
	process.exit(1);
}

const isolationProbe = spawnSync(process.execPath, ["--test-isolation=none", "--test", "--help"], { stdio: "ignore" });
const isolationArgs = isolationProbe.status === 0 ? ["--test-isolation=none"] : [];
// Precise groups (approved supplement): stub suites with the adapter, real-SDK
// suites WITHOUT it and with NODE_OPTIONS cleared, all non-empty groups executed
// even when an earlier one fails, and the first failure propagated.
const groups = planTestGroups({ unitFiles, integrationFiles, e2eFiles, suite });
const adapterPath = join(projectRoot, "scripts", "test-adapter-hooks.mjs");
let firstFailure = 0;
const executed = [];
for (const group of groups) {
	const env = { ...process.env };
	if (group.clearNodeOptions) delete env.NODE_OPTIONS;
	console.log(`[runner] group '${group.name}': ${group.files.length} file(s)${group.adapter ? "" : " (real SDK, no stub adapter)"}`);
	const result = spawnSync(process.execPath, groupArgs(group, { adapterPath, isolationArgs }), {
		cwd: projectRoot,
		stdio: "inherit",
		env,
	});
	if (result.error) throw result.error;
	const status = result.status ?? 1;
	executed.push({ name: group.name, status });
	if (status !== 0 && firstFailure === 0) firstFailure = status;
}

const elapsedMs = Date.now() - startedAt;
console.log(`[runner] ${testFiles.length} test file(s) discovered; suite finished in ${elapsedMs} ms.`);
console.log(`[runner] groups executed: ${executed.map((entry) => entry.name + "=" + entry.status).join(", ")}`);
console.log("[runner] Timings are evidence on this machine, not machine-independent performance promises.");

process.exitCode = firstFailure;
