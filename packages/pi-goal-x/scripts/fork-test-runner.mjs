#!/usr/bin/env node
/**
 * Fork test runner (design D7/D8): runs the fork-only suites that this change
 * owns, with the Goal-X adapter preload plus the event-loop keepalive those
 * auditor suites need, and NEVER the live E2E entry point.
 *
 * Why a separate entry: the live E2E spends real model tokens and needs tmux, so
 * it must not be discoverable by an auto-discovery runner. This script pins the
 * exact fork suite list, asserts the live entry is excluded, and propagates the
 * child's exit code so a failing fork suite cannot report success.
 *
 * Usage:
 *   node scripts/fork-test-runner.mjs             # run the pinned fork suites
 *   node scripts/fork-test-runner.mjs --selfcheck # verify the list only (no tests)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.dirname(here);

/** Live E2E entry: real pi + tmux + real provider. Never run from here. */
export const LIVE_E2E_ENTRY = "tests/e2e/goal-audit-supervisor-live.mjs";

/** The fork suites this change owns, relative to the package root. */
export const FORK_TEST_FILES = [
	"tests/goal-audit-sidechannel.test.ts",
	"tests/goal-audit-context-snapshot.test.ts",
	"tests/goal-audit-supervisor-flow.test.ts",
	"tests/goal-audit-supervisor-handoff.test.ts",
	"tests/goal-audit-supervisor-card.test.ts",
	"tests/goal-audit-supervisor-usage.test.ts",
	"tests/goal-audit-supervisor-completion.test.ts",
	"tests/goal-auditor-agent-resolver.test.ts",
	"tests/fork-test-runner.test.ts",
];

/** Every preload the fork suites need, in order. */
export const PRELOADS = [
	// Keeps the event loop alive so auditor suites with unref'd timers are not
	// cancelled by Node's test-runner guard before their assertions run.
	'data:text/javascript,import {after} from "node:test";const h=setInterval(()=>{},1000);after(()=>clearInterval(h));',
	"./scripts/test-adapter-hooks.mjs",
];

/**
 * Pure list validation. Returns the problems found (empty = OK). Kept
 * side-effect free so the runner's own unit test can assert the contract
 * without spawning a suite.
 */
export function validateForkTestList({ packageRoot = PACKAGE_ROOT } = {}) {
	const problems = [];
	if (FORK_TEST_FILES.length === 0) problems.push("fork test list is empty");
	for (const file of FORK_TEST_FILES) {
		if (!file.endsWith(".test.ts")) problems.push(`not a .test.ts entry: ${file}`);
		if (!existsSync(path.join(packageRoot, file))) problems.push(`missing fork test file: ${file}`);
	}
	if (FORK_TEST_FILES.includes(LIVE_E2E_ENTRY)) {
		problems.push(`the live E2E entry must never join the fork runner: ${LIVE_E2E_ENTRY}`);
	}
	if (FORK_TEST_FILES.some((file) => file.includes("live"))) {
		problems.push("no live entry may appear in the fork runner list");
	}
	return problems;
}

function main(argv) {
	const selfCheck = argv.includes("--selfcheck");
	const problems = validateForkTestList();
	if (problems.length > 0) {
		console.error("fork-test-runner list FAILED:");
		for (const problem of problems) console.error("  - " + problem);
		return 1;
	}
	if (selfCheck) {
		console.log(`fork-test-runner list OK: ${FORK_TEST_FILES.length} fork suite(s), live E2E excluded.`);
		return 0;
	}
	const args = ["--experimental-strip-types", "--test"];
	for (const preload of PRELOADS) args.push("--import", preload);
	args.push(...FORK_TEST_FILES);
	const result = spawnSync(process.execPath, args, { cwd: PACKAGE_ROOT, stdio: "inherit" });
	if (result.error) throw result.error;
	console.log(`[fork-test-runner] ${FORK_TEST_FILES.length} fork suite(s) executed; live E2E excluded.`);
	return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
