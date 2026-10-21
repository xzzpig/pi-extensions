import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Compatibility contract the normal suites cannot express: on a pi-subagents install that does
 * NOT export ./supervisor-routing, importing the goal extension must not crash, the first audit
 * must load the API lazily and fail closed, and no child may be launched.
 */
describe("audit side channel compatibility", () => {
	for (const mode of ["missing_subpath", "missing_export"] as const) {
		it(`loads without './supervisor-routing' (${mode}) and fails the first audit closed`, () => {
			const hook = `
				import { registerHooks } from "node:module";
				globalThis.__routingResolutions = 0;
				registerHooks({
					resolve(specifier, context, nextResolve) {
						if (!specifier.endsWith("pi-subagents/supervisor-routing")) return nextResolve(specifier, context);
						globalThis.__routingResolutions += 1;
						if (process.env.ROUTING_MODE === "missing_subpath") {
							throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED: ./supervisor-routing");
						}
						// Missing EXPORT: resolvable module that exports nothing.
						return { url: "data:text/javascript,export const unrelated = 1;", shortCircuit: true };
					},
				});
			`;
			const worker = `
				const { pathToFileURL } = await import("node:url");
				const path = await import("node:path");
				const target = pathToFileURL(path.join(process.env.PKG_DIR, "extensions/goal-auditor-delegation.ts")).href;
				const { runGoalCompletionAuditor } = await import(target);
				const atImport = globalThis.__routingResolutions;
				const requests = [];
				const handlers = new Map();
				const events = {
					on(event, handler) {
						const list = handlers.get(event) ?? [];
						list.push(handler);
						handlers.set(event, list);
						return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
					},
					emit(event, value) {
						if (event === "pi-subagents:delegation-request:v1") requests.push(value);
						for (const handler of handlers.get(event) ?? []) handler(value);
					},
				};
				const result = await runGoalCompletionAuditor({
					ctx: {
						cwd: process.cwd(),
						sessionManager: { getSessionId: () => "s", getEntries: () => [], getLeafId: () => null },
						model: { provider: "mock", id: "mock" },
						modelRegistry: { getAvailable: () => [] },
						getSystemPrompt: () => "SYSTEM",
					},
					events,
					goal: { id: "g1", revision: 0, objective: "o", status: "active", tasks: [], createdAt: new Date().toISOString() },
					detailedSummary: "Goal: g1",
					skipPreflight: true,
					timeouts: { startedMs: 200, terminalMs: 400, cancellationMs: 100 },
				});
				console.log(JSON.stringify({
					approved: result.approved,
					error: String(result.error ?? ""),
					requests: requests.length,
					atImport,
					afterAudit: globalThis.__routingResolutions,
				}));
			`;
			const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
			const adapter = path.join(pkgDir, "scripts", "test-adapter-hooks.mjs");
			const run = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--import",
					`data:text/javascript,${encodeURIComponent(hook)}`,
					"--import",
					adapter,
					"--input-type=module",
					"-e",
					worker,
				],
				{
					cwd: pkgDir,
					encoding: "utf8",
					timeout: 120_000,
					env: { ...process.env, NODE_OPTIONS: "", PKG_DIR: pkgDir, ROUTING_MODE: mode },
				},
			);
			assert.equal(run.status, 0, `the worker must load and settle (stderr: ${String(run.stderr).slice(-600)})`);
			const line = String(run.stdout).trim().split("\n").filter(Boolean).pop() ?? "";
			const parsed = JSON.parse(line) as {
				approved: boolean;
				error: string;
				requests: number;
				atImport: number;
				afterAudit: number;
			};
			assert.equal(parsed.approved, false);
			assert.equal(parsed.atImport, 0, "importing the extension must not resolve the API");
			assert.ok(parsed.afterAudit > 0, "the first audit is what loads it");
			assert.match(parsed.error, /does not expose the supervisor responder API/);
			assert.equal(parsed.requests, 0, "no child is launched when the API is missing");
		});
	}

	it("a lifecycle revocation makes a late answer impossible while a new audit can still answer", async () => {
		const {
			createAuditSupervisorSidechannel,
			invalidateAuditSidechannels,
			invalidateAuditSidechannelsForOwner,
			registerAuditSidechannelLifecycle,
		} = await import("../extensions/goal-audit-sidechannel.ts");
		const prompts: string[] = [];
		const factory = async () => ({
			prompt: async (text: string) => {
				prompts.push(text);
			},
			waitForIdle: async () => {},
			abort: async () => {},
			dispose: () => {},
			subscribeMessageEnd: () => () => {},
		});
		const deps = {
			ctx: {
				cwd: process.cwd(),
				sessionManager: { getSessionId: () => "session-1", getEntries: () => [], getLeafId: () => null },
				model: { provider: "mock", id: "mock" },
				modelRegistry: { runtime: { borrowed: true } },
				getSystemPrompt: () => "SYSTEM",
			},
			goalPayload: { goal: "g1" },
			requestId: "attempt-1",
			ownerRunId: "g1",
			nodeId: "goal-completion:g1:0",
			sessionFactory: factory as never,
			getAuditDeadlineAt: () => Date.now() + 60_000,
		};
		const ask: Record<string, unknown> = {
			requestId: "ask-1",
			runId: "run-1",
			agent: "goal-auditor",
			childIndex: 0,
			reason: "need_decision" as const,
			message: "q",
			deadlineAt: Date.now() + 60_000,
		};
		// focus switch away/back and same-id pause both land on this seam
		for (const revoke of [
			() => invalidateAuditSidechannelsForOwner("session-1", "g1", "focus_changed"),
			() => invalidateAuditSidechannels("session-1", "session_shutdown"),
		]) {
			const channel = createAuditSupervisorSidechannel(deps as never);
			const release = registerAuditSidechannelLifecycle("session-1", "g1", {
				invalidate: (reason: string) => channel.invalidate(reason),
			});
			revoke();
			release();
			const outcome = await channel.respond(ask as never);
			assert.equal(outcome.kind, "error", "a revoked generation never answers");
		}
		const fresh = createAuditSupervisorSidechannel(deps as never);
		const nextAsk: Record<string, unknown> = { ...ask };
		nextAsk.requestId = "ask-2";
		const freshOutcome = await fresh.respond(nextAsk as never);
		assert.equal(freshOutcome.kind, "error", "without a submitted reply the fresh ask fails closed");
	});

	it("an in-flight ask is cancelled by a real GoalCore pause and a late legal answer is never delivered", async () => {
		const { createGoalCore } = await import("../extensions/goal-state.ts");
		const { createAuditSupervisorSidechannel, registerAuditSidechannelLifecycle } =
			await import("../extensions/goal-audit-sidechannel.ts");
		const handlers = new Map<string, Array<(value: unknown) => void>>();
		const pi = {
			events: {
				on(event: string, handler: (value: unknown) => void) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
					return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
				},
				emit() {},
			},
			registerTool() {},
			registerCommand() {},
			sendMessage() {},
		};
		const core = createGoalCore(pi as never);
		core.setAuditSessionId("session-1");
		const ctx = {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "session-1", getEntries: () => [], getLeafId: () => null },
			model: { provider: "mock", id: "mock" },
			modelRegistry: { runtime: { borrowed: true } },
			getSystemPrompt: () => "SYSTEM",
			ui: { setStatus: () => {}, notify: () => {} },
		};
		const record = { id: "g1", revision: 0, objective: "o", status: "active" as const, tasks: [], createdAt: new Date().toISOString() };
		core.setGoal(record as never, ctx as never, false);
		const makeDeps = (onPrompt: (input: never) => Promise<void>) => ({
			ctx: ctx as never,
			goalPayload: { goal: record },
			requestId: "attempt-1",
			ownerRunId: "g1",
			nodeId: "goal-completion:g1:0",
			getAuditDeadlineAt: () => Date.now() + 60_000,
			sessionFactory: (async (input: never) => {
				let listener: ((message: unknown) => void) | undefined;
				const session = {
					prompt: async () => {
						await onPrompt(input);
					},
					waitForIdle: async () => {},
					abort: async () => {
						release?.();
					},
					dispose: () => {},
					subscribeMessageEnd: (handler: (message: unknown) => void) => {
						listener = handler;
						return () => {
							listener = undefined;
						};
					},
				};
				return session;
			}) as never,
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const submitRef: { execute?: (id: string, args: unknown) => Promise<unknown> } = {};
		const inFlight = createAuditSupervisorSidechannel(
			makeDeps(async (input) => {
				const tools = (input as { customTools?: Array<{ execute?: (id: string, args: unknown) => Promise<unknown> }> }).customTools ?? [];
				submitRef.execute = tools[0]?.execute;
				await gate;
			}) as never,
		);
		const releaseLifecycle = registerAuditSidechannelLifecycle("session-1", "g1", {
			invalidate: (reason: string) => inFlight.invalidate(reason),
		});
		const ask = {
			requestId: "ask-1",
			runId: "run-1",
			agent: "goal-auditor",
			childIndex: 0,
			reason: "need_decision" as const,
			message: "交付标记是什么",
			deadlineAt: Date.now() + 60_000,
		};
		const pending = inFlight.respond(ask as never);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(submitRef.execute, "the ask is really in flight");
		// REAL seam: the goal leaves active while the model is still running.
		core.setGoal({ ...record, revision: 1, status: "paused" } as never, ctx as never, false);
		// A LATE, perfectly legal answer arrives after the revocation.
		await submitRef.execute!("call-1", { kind: "reply", message: "ALPHA" });
		releaseLifecycle();
		release?.();
		const outcome = await pending;
		assert.equal(outcome.kind, "error", "the late answer is not delivered");
		assert.equal(inFlight.records().some((entry) => entry.deliveryStatus === "delivered"), false);
		// Positive control: a healthy attempt on the SAME goal still answers normally.
		let submitted = false;
		const healthy = createAuditSupervisorSidechannel(
			makeDeps(async (input) => {
				const tools = (input as { customTools?: Array<{ execute?: (id: string, args: unknown) => Promise<unknown> }> }).customTools ?? [];
				await tools[0]?.execute?.("call-2", { kind: "reply", message: "BETA" });
				submitted = true;
			}) as never,
		);
		const healthyOutcome = await healthy.respond({ ...ask, requestId: "ask-2" } as never);
		assert.equal(submitted, true, "the control attempt reaches the submit tool");
		assert.equal(healthyOutcome.kind, "reply", "a healthy attempt answers");
	});




	it("a real session_shutdown handler revokes an in-flight ask and its late answer is dropped", async () => {
		const { createGoalCore } = await import("../extensions/goal-state.ts");
		const { registerGoalEvents } = await import("../extensions/goal-events.ts");
		const { createAuditSupervisorSidechannel, registerAuditSidechannelLifecycle } =
			await import("../extensions/goal-audit-sidechannel.ts");
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
		const on = (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
		};
		const pi = { events: { on, emit() {} }, on, registerTool() {}, registerCommand() {}, sendMessage() {} };
		const core = createGoalCore(pi as never);
		registerGoalEvents(core);
		core.setAuditSessionId("session-1");
		const ctx = {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "session-1", getEntries: () => [], getLeafId: () => null },
			model: { provider: "mock", id: "mock" },
			modelRegistry: { runtime: { borrowed: true } },
			getSystemPrompt: () => "SYSTEM",
			ui: { setStatus: () => {}, notify: () => {} },
		};
		const record = { id: "g1", revision: 0, objective: "o", status: "active" as const, tasks: [], createdAt: new Date().toISOString() };
		core.setGoal(record as never, ctx as never, false);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ref: { execute?: (id: string, args: unknown) => Promise<unknown> } = {};
		const channel = createAuditSupervisorSidechannel({
			ctx: ctx as never,
			goalPayload: { goal: record },
			requestId: "attempt-1",
			ownerRunId: "g1",
			nodeId: "goal-completion:g1:0",
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
		const releaseLifecycle = registerAuditSidechannelLifecycle("session-1", "g1", {
			invalidate: (reason: string) => channel.invalidate(reason),
		});
		const pending = channel.respond({
			requestId: "ask-1",
			runId: "run-1",
			agent: "goal-auditor",
			childIndex: 0,
			reason: "need_decision" as const,
			message: "q",
			deadlineAt: Date.now() + 60_000,
		} as never);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(ref.execute, "the ask is in flight");
		// REAL handler: session_shutdown receives (event, ctx).
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
		await ref.execute!("call-1", { kind: "reply", message: "LATE" });
		releaseLifecycle();
		release?.();
		const outcome = await pending;
		assert.equal(outcome.kind, "error", "the late answer is dropped");
		assert.equal(channel.records().some((entry) => entry.deliveryStatus === "delivered"), false);
	});
});
