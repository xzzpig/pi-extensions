import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerGoalCommands } from "../extensions/goal-commands.ts";
import type { GoalCore } from "../extensions/goal-state.ts";

function fixture(t: TestContext, admission = true) {
	const calls: unknown[] = [];
	const notices: string[] = [];
	let focusRevision = 0;
	const state: { goal: { id: string } | null } = { goal: { id: "target" } };
	const focus = (id: string) => { state.goal = { id }; focusRevision++; };
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const core = {
		pi: {
			on: () => () => {},
			registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, def.handler),
			sendUserMessage: (message: string) => calls.push(["user", message]),
		},
		state,
		goalsById: new Map(),
		openGoals: () => [...core.goalsById.values()],
		setFocusedGoalId: t.mock.fn(focus),
		scheduler: { resume: (_ctx: unknown, mode: string) => { calls.push(["resume", mode]); return admission; } },
		goalService: { appendEvents: () => calls.push("ledger") },
		reconcileFocusedGoalFromDisk: () => true,
		focusedOperationToken: (goalId: string) => ({ goalId, revision: focusRevision }),
		isFocusedOperationCurrent: ({ goalId, revision }) => goalId === state.goal?.id && revision === focusRevision,
		enterGoalModal: () => {},
		exitGoalModal: () => {},
		sessionOwner: {},
	} satisfies Pick<GoalCore, "reconcileFocusedGoalFromDisk" | "focusedOperationToken" | "isFocusedOperationCurrent" | "enterGoalModal" | "exitGoalModal" | "sessionOwner"> & Record<string, unknown>;
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (text: string) => notices.push(text), select: async (_title: string, options: string[]) => options[0] },
		waitForIdle: t.mock.fn(async () => { calls.push("idle"); }),
	};
	registerGoalCommands(core as unknown as GoalCore);
	const resume = (args: string) => commands.get("goal-resume")!(args, ctx as unknown as ExtensionCommandContext);
	return { core, ctx, resume, calls, notices, focus, changeFocus: () => focus("replacement") };
}

test("an idle resume waits and sends just the message after successful resume", async t => {
	const f = fixture(t);
	await f.resume("先定位失败用例\n不要改接口");
	assert.deepEqual(f.calls, ["idle", ["resume", "user-message"], "ledger", ["user", "先定位失败用例\n不要改接口"]]);
});

for (const args of ["", " \t\n"]) test(`resume without a message preserves kickoff (${JSON.stringify(args)})`, async t => {
	const f = fixture(t);
	await f.resume(args);
	assert.deepEqual(f.calls, [["resume", "kickoff"], "ledger"]);
});

test("rejected resume never sends a user message", async t => {
	const f = fixture(t, false);
	await f.resume("do not send");
	assert.deepEqual(f.calls, ["idle", ["resume", "user-message"]]);
});

for (const change of ["focus", "session"]) test(`resume does not follow a changed ${change}`, async t => {
	const f = fixture(t);
	const idle = Promise.withResolvers<void>();
	f.ctx.waitForIdle.mock.mockImplementation(() => idle.promise);
	const resuming = f.resume("do not send");
	assert.equal(f.ctx.waitForIdle.mock.callCount(), 1);
	if (change === "focus") f.changeFocus();
	else f.core.sessionOwner = {};
	idle.resolve();
	await resuming;
	assert.deepEqual(f.calls, []);
	assert.match(f.notices.at(-1)!, /nothing was resumed or sent/);
});

for (const change of ["focus", "session"]) test(`resume rejects a ${change} change just after the idle wait resolves`, async t => {
	const f = fixture(t);
	const idle = Promise.withResolvers<void>();
	f.ctx.waitForIdle.mock.mockImplementation(() => idle.promise);
	const resuming = f.resume("do not send");
	assert.equal(f.ctx.waitForIdle.mock.callCount(), 1);
	idle.resolve();
	// Runs after the wait helper resumes but before the command continues.
	queueMicrotask(() => {
		if (change === "focus") f.changeFocus();
		else f.core.sessionOwner = {};
	});
	await resuming;
	assert.deepEqual(f.calls, []);
	assert.match(f.notices.at(-1)!, /nothing was resumed or sent/);
});

for (const change of ["focus", "round trip", "session"] as const) test(`resume rejects a ${change} change between selection and command continuation`, async t => {
	const f = fixture(t);
	f.core.state.goal = null;
	for (const id of ["target", "replacement"]) {
		f.core.goalsById.set(id, { id, objective: id, status: "paused", usage: {} });
	}
	f.ctx.waitForIdle.mock.mockImplementation(async () => {});
	f.core.setFocusedGoalId.mock.mockImplementation(id => {
		f.focus(id);
		// The selector has focused the target, but the command has not resumed from await.
		queueMicrotask(() => {
			if (change === "session") f.core.sessionOwner = {};
			else {
				f.changeFocus();
				if (change === "round trip") f.focus(id);
			}
		});
	});
	await f.resume("do not send");
	assert.equal(f.core.setFocusedGoalId.mock.calls[0]?.arguments[0], "target");
	assert.deepEqual(f.calls, []);
	assert.match(f.notices.at(-1)!, /nothing was resumed or sent/);
});
