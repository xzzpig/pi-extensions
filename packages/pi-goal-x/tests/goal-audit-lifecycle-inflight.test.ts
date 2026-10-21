import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

type Handler = (event: unknown, ctx: unknown) => unknown;

/**
 * Success criterion 6: every lifecycle seam must be proven with an ask that is REALLY in flight
 * (a deferred sessionFactory holds the prompt), and a LATE but perfectly legal answer must never
 * be delivered afterwards.
 */
async function makeRig() {
	const { createGoalCore } = await import("../extensions/goal-state.ts");
	const { registerGoalEvents } = await import("../extensions/goal-events.ts");
	const { createAuditSupervisorSidechannel, registerAuditSidechannelLifecycle } =
		await import("../extensions/goal-audit-sidechannel.ts");
	const handlers = new Map<string, Handler[]>();
	const on = (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	};
	const pi = {
		events: { on, emit() {} },
		on,
		registerTool() {},
		registerCommand() {},
		sendMessage() {},
	};
	const core = createGoalCore(pi as never);
	const dir = mkdtempSync(path.join(os.tmpdir(), "goal-audit-lifecycle-"));
	const ctx = {
		cwd: dir,
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => [],
			getLeafId: () => null,
			getCwd: () => dir,
			getSessionDir: () => dir,
			getSessionFile: () => undefined,
		},
		model: { provider: "mock", id: "mock" },
		modelRegistry: { runtime: { borrowed: true } },
		getSystemPrompt: () => "SYSTEM",
		ui: { setStatus() {}, notify() {}, select: async () => undefined, input: async () => undefined },
		hasUI: false,
	};
	core.setAuditSessionId("session-1");
	const a = { id: "gA", revision: 0, objective: "A", status: "active" as const, tasks: [], createdAt: new Date().toISOString() };
	const b = { id: "gB", revision: 0, objective: "B", status: "active" as const, tasks: [], createdAt: new Date().toISOString() };
	core.setGoal(a as never, ctx as never, false);
	const makeChannel = (goalId: string) => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ref: { execute?: (id: string, args: unknown) => Promise<unknown> } = {};
		const channel = createAuditSupervisorSidechannel({
			ctx: ctx as never,
			goalPayload: { goal: goalId },
			requestId: `attempt-${goalId}`,
			ownerRunId: goalId,
			nodeId: `goal-completion:${goalId}:0`,
			getAuditDeadlineAt: () => Date.now() + 60_000,
			sessionFactory: (async (input: never) => {
				const tools = (input as { customTools?: Array<{ execute?: (id: string, args: unknown) => Promise<unknown> }> }).customTools ?? [];
				ref.execute = tools[0]?.execute;
				return {
					prompt: async () => {
						await gate;
					},
					waitForIdle: async () => {},
					abort: async () => {},
					dispose: () => {},
					subscribeMessageEnd: () => () => {},
				};
			}) as never,
		} as never);
		const releaseLifecycle = registerAuditSidechannelLifecycle("session-1", goalId, {
			invalidate: (reason: string) => channel.invalidate(reason),
		});
		return { channel, ref, release: () => release?.(), releaseLifecycle };
	};
	const ask = (goalId: string) => ({
		requestId: `ask-${goalId}`,
		runId: `run-${goalId}`,
		agent: "goal-auditor",
		childIndex: 0,
		reason: "need_decision" as const,
		message: "q",
		deadlineAt: Date.now() + 60_000,
	});
	/** Start an ask, wait until the prompt is really running, then return its handle. */
	const startInFlight = async (goalId: string) => {
		const rig = makeChannel(goalId);
		const pending = rig.channel.respond(ask(goalId) as never);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(rig.ref.execute, "the ask is really in flight");
		return { ...rig, pending };
	};
	/** Submit a LATE but perfectly legal answer, release the gate and require it was dropped. */
	const finishAndAssertDropped = async (rig: Awaited<ReturnType<typeof startInFlight>>, label: string) => {
		await rig.ref.execute!("call-late", { kind: "reply", message: "LATE" });
		rig.releaseLifecycle();
		rig.release();
		const outcome = await rig.pending;
		assert.equal(outcome.kind, "error", `${label}: the late answer is not delivered`);
		assert.equal(rig.channel.records().some((entry) => entry.deliveryStatus === "delivered"), false, `${label}: no delivered record`);
	};
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return { createGoalCore, registerGoalEvents, core, ctx, a, b, handlers, startInFlight, makeChannel, finishAndAssertDropped, cleanup };
}

describe("audit side channel in-flight lifecycle", () => {
	it("focus switch away and back", async () => {
		const rig = await makeRig();
		try {
			rig.registerGoalEvents(rig.core);
			const inflight = await rig.startInFlight("gA");
			rig.core.setGoal(rig.b as never, rig.ctx as never, false);
			rig.core.setGoal(rig.a as never, rig.ctx as never, false);
			await rig.finishAndAssertDropped(inflight, "focus round-trip");
		} finally {
			rig.cleanup();
		}
	});

	it("same-id removal (goal leaves active with the same id)", async () => {
		const rig = await makeRig();
		try {
			const inflight = await rig.startInFlight("gA");
			rig.core.setGoal({ ...rig.a, revision: 1, status: "archived" } as never, rig.ctx as never, false);
			await rig.finishAndAssertDropped(inflight, "same-id removal");
		} finally {
			rig.cleanup();
		}
	});

	for (const seam of ["session_start", "session_tree", "session_shutdown"] as const) {
		it(`real ${seam} handler`, async () => {
			const rig = await makeRig();
			try {
				rig.registerGoalEvents(rig.core);
				const inflight = await rig.startInFlight("gA");
				for (const handler of rig.handlers.get(seam) ?? []) {
					try {
						await handler({ type: seam }, rig.ctx);
					} catch {
						// Later handler steps may need a fuller ctx; the revocation is the first step.
					}
				}
				await rig.finishAndAssertDropped(inflight, seam);
			} finally {
				rig.cleanup();
			}
		});
	}

	it("reload (session_start after a tree change) while an ask is in flight", async () => {
		const rig = await makeRig();
		try {
			rig.registerGoalEvents(rig.core);
			const inflight = await rig.startInFlight("gA");
			for (const seam of ["session_tree", "session_start"] as const) {
				for (const handler of rig.handlers.get(seam) ?? []) {
					try {
						await handler({ type: seam, reason: "reload" }, rig.ctx);
					} catch {
						// As above: only the revocation step matters for this assertion.
					}
				}
			}
			await rig.finishAndAssertDropped(inflight, "reload");
		} finally {
			rig.cleanup();
		}
	});

	it("a goal that is NOT revoked keeps working (session isolation)", async () => {
		const rig = await makeRig();
		try {
			// A second goal's channel is untouched by gA's lifecycle events.
			const alive = rig.makeChannel("gB");
			const pending = alive.channel.respond({
				requestId: "ask-gB",
				runId: "run-gB",
				agent: "goal-auditor",
				childIndex: 0,
				reason: "need_decision" as const,
				message: "q",
				deadlineAt: Date.now() + 60_000,
			} as never);
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.ok(alive.ref.execute, "the control ask is in flight");
			await alive.ref.execute!("call-ok", { kind: "reply", message: "OK" });
			alive.release();
			const outcome = await pending;
			alive.releaseLifecycle();
			assert.equal(outcome.kind, "reply", "an untouched goal still answers");
		} finally {
			rig.cleanup();
		}
	});


	it("revoking one goal leaves a PARALLEL in-flight goal answering, and cleanup is idempotent", async () => {
		const rig = await makeRig();
		try {
			rig.core.setGoal(rig.a as never, rig.ctx as never, false);
			const victim = await rig.startInFlight("gA");
			const survivor = await rig.startInFlight("gB"); // both in flight at the same time
			// Only gA is revoked (focus moves away from it).
			rig.core.setGoal(rig.b as never, rig.ctx as never, false);
			await rig.finishAndAssertDropped(victim, "revoked goal");
			// The parallel survivor still answers normally.
			await survivor.ref.execute!("call-ok", { kind: "reply", message: "OK" });
			survivor.release();
			const survivorOutcome = await survivor.pending;
			assert.equal(survivorOutcome.kind, "reply", "the parallel in-flight goal is unaffected");
			survivor.releaseLifecycle();
			// Idempotent cleanup: a second release/dispose must not throw or double-settle.
			survivor.releaseLifecycle();
			await survivor.channel.dispose();
			await survivor.channel.dispose();
			assert.equal(survivor.channel.records().filter((entry) => entry.deliveryStatus === "delivered").length, 1);
		} finally {
			rig.cleanup();
		}
	});
});
