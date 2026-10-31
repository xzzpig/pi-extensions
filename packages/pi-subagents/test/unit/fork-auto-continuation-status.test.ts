import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import type { SubagentState } from "../../src/shared/types.ts";

it("restores schedule wake policy from existing AsyncStatus into the live job projection", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-gate-status-"));
	const asyncId = "quiet-scheduled-run";
	const asyncDir = join(root, asyncId);
	const sessionId = join(root, "parent.jsonl");
	mkdirSync(asyncDir, { recursive: true });
	writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
		runId: asyncId,
		mode: "single",
		state: "running",
		sessionId,
		completionOwnerId: "owner-a",
		scheduleOrigin: { id: "nightly", quiet: true },
		startedAt: 1,
		lastUpdate: 2,
		steps: [{ agent: "worker", status: "running" }],
	}), "utf-8");
	updateActiveRunIndex(asyncDir, "running");

	const state = {
		baseCwd: root,
		currentSessionId: sessionId,
		supervisorOwnerSessionId: "parent-uuid",
		completionOwnerId: "owner-a",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundControls: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as unknown as SubagentState;
	const tracker = createAsyncJobTracker({ events: { emit: () => {}, on: () => () => {} } } as never, state, root, {
		resultsDir: join(root, "results"),
		widgetEnabled: false,
	});
	try {
		tracker.restoreActiveJobs();
		assert.equal(state.asyncJobs.get(asyncId)?.completionOwnerId, "owner-a");
		assert.deepEqual(state.asyncJobs.get(asyncId)?.scheduleOrigin, { id: "nightly", quiet: true });
	} finally {
		tracker.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
