import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";
import type { GoalCore } from "../../extensions/goal-state.ts";
import { createGoal } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";

for (const submitDuring of ["abort", "agent_settled", "selection-overlap", "run-started-during-selection", "run-started-just-before-resume", "escape-during-resume"] as const) {
	test(`resume with a message: ${submitDuring}`, { timeout: 15_000 }, async t => {
		const startupRace = submitDuring === "run-started-just-before-resume";
		const lateRun = startupRace || submitDuring === "run-started-during-selection";
		const chooseTarget = lateRun || submitDuring === "selection-overlap";
		const escapeDuringResume = submitDuring === "escape-during-resume";
		let terminalInput: TerminalInputHandler | undefined;
		const cwd = mkdtempSync(join(tmpdir(), "goal-resume-sdk-"));
		const agentDir = join(cwd, "agent");
		const oldGlobal = process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
		process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = join(cwd, "global.json");
		const settings = { pauseOrder: "goal-first", maxAutonomousRuns: 1 } as const;
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi/pi-goal-x-settings.json"), JSON.stringify(settings));
		const initialRequest = Promise.withResolvers<void>();
		const settlementStarted = Promise.withResolvers<void>();
		const releaseSettlement = Promise.withResolvers<void>();
		const startupEntered = Promise.withResolvers<void>();
		const releaseStartup = Promise.withResolvers<void>();
		let resumeWaitCalls = 0;
		const latePromptText = "A run started after the chooser opened";
		const choicesShown = Promise.withResolvers<string[]>();
		const selection = Promise.withResolvers<string | undefined>();
		const sent: { content: unknown; oldSettled: boolean }[] = [];
		const replyReceived = Promise.withResolvers<void>();
		const requests: unknown[] = [];
		const errors: string[] = [];
		const starts: unknown[] = [];
		const correction = "先定位失败用例";
		let core: GoalCore | undefined;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let oldSettled = false;
		let aborted: boolean | undefined;
		const server = createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			requests.push(JSON.parse(body));
			if (requests.length === 1) {
				initialRequest.resolve();
				return; // The first provider request is intentionally interrupted by Esc.
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const choice of [{ delta: { role: "assistant", content: "Understood." }, finish_reason: null }, { delta: {}, finish_reason: "stop" }]) {
				res.write(`data: ${JSON.stringify({ id: "resume", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
			}
			res.end("data: [DONE]\n\n");
		});
		t.after(async () => {
			selection.resolve(undefined);
			releaseStartup.resolve();
			releaseSettlement.resolve();
			try {
				if (session) {
					await session.abort();
					await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
					session.dispose();
				}
			} finally {
				server.closeAllConnections();
				await new Promise<void>(resolve => server.close(() => resolve()));
				rmSync(cwd, { recursive: true, force: true });
				if (oldGlobal === undefined) delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
				else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = oldGlobal;
			}
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		runtime.registerProvider("fixture", {
			baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture",
			models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 512 }],
		});
		const loader = new DefaultResourceLoader({
			cwd, agentDir, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
			extensionFactories: [pi => {
				// Hold the host's settled event before Goal-X receives it.
				pi.on("agent_settled", async event => {
					if (aborted !== undefined) return;
					aborted = event.aborted;
					settlementStarted.resolve();
					await releaseSettlement.promise;
				});
				pi.on("before_agent_start", async event => {
					if (startupRace && event.messageType === "user" && event.prompt === latePromptText) {
						startupEntered.resolve();
						await releaseStartup.promise;
					}
				});
				const send = pi.sendUserMessage.bind(pi);
				pi.sendUserMessage = (content, options) => {
					sent.push({ content, oldSettled });
					send(content, options);
				};
				goalExtension(pi);
				core = (pi as unknown as { _goalCore: GoalCore })._goalCore;
				pi.on("agent_settled", () => { oldSettled = true; });
				pi.on("before_agent_start", event => {
					starts.push({ kind: event.messageType, prompt: event.messageType === "user" ? event.prompt : undefined,
						oldSettled, status: core?.state.goal?.status, used: core?.state.goal?.scheduler?.used,
						decision: core?.state.goal?.scheduler?.decision });
				});
				pi.on("agent_before_settle", (_event, ctx) => {
					if (requests.length === 2) {
						core?.pauseActiveGoal(ctx); // End the fixture after the one user-driven reply.
						replyReceived.resolve();
					}
				});
			}],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("fixture", "fixture"), resourceLoader: loader,
			sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		}));
		const unsupported = async (): Promise<never> => { throw new Error("Unexpected session command"); };
		await session.bindExtensions({
			mode: "rpc", onError: event => errors.push(event.error),
			uiContext: {
				...session.extensionRunner!.createContext().ui,
				onTerminalInput(handler) {
					terminalInput = handler;
					return () => { if (terminalInput === handler) terminalInput = undefined; };
				},
				async select(_title, options) {
					choicesShown.resolve(options);
					return selection.promise;
				},
			},
			commandContextActions: {
				waitForIdle: async () => {
					const idle = session!.waitForIdle();
					if (startupRace && ++resumeWaitCalls === 2) {
						assert.equal(session!.isIdle, true);
						const started = session!.prompt(latePromptText);
						t.after(() => started);
						await startupEntered.promise;
					}
					await idle;
				},
				newSession: unsupported, fork: unsupported, navigateTree: unsupported, switchSession: unsupported, reload: unsupported,
			},
		});
		assert.ok(core && session.extensionRunner);
		const ctx = session.extensionRunner.createContext();
		assert.ok(terminalInput, "Goal-X registered its real terminal-input handler");
		const pressEsc = () => terminalInput!("\x1b");
		const submit = () => session!.prompt(`/goal-resume ${correction}`);
		let early: Promise<void> | undefined;
		const savedGoal = (objective: string) => writeActiveGoalFile(ctx, {
			...createGoal({ objective, sisyphus: false, autoContinue: false }), status: "paused",
		});
		let goalId: string;
		if (lateRun) {
			goalId = savedGoal("Investigate an interrupted run").id;
			assert.equal(session.isIdle, true);
		} else {
			await session.prompt("/goal-direct Investigate an interrupted run");
			await initialRequest.promise;
			assert.ok(core.state.goal?.id);
			goalId = core.state.goal.id;
			assert.equal(core.state.goal.scheduler?.used, 1);
			if (escapeDuringResume) {
				early = submit();
				await setImmediate();
				assert.equal(core.state.goal?.status, "active");
				assert.deepEqual(sent, []);
			}
			assert.deepEqual(pressEsc(), { consume: true }, "Goal-X still handles the first Esc");
			assert.equal(core.state.goal?.status, "paused");
			assert.equal(ctx.signal?.aborted, false, "the first Esc does not abort the old turn");
			assert.equal(session.isIdle, false, "the first Esc pauses without ending the streaming run");
			assert.deepEqual(pressEsc(), { consume: true }, "Goal-X still handles the second Esc");
		}
		if (chooseTarget) {
			savedGoal("Another open goal");
			core.setFocusedGoalId(null, ctx, "unfocused");
		}
		if (!early && submitDuring !== "agent_settled") early = submit();
		const choose = (choices: string[]) => {
			assert.equal(choices.length, 2);
			const original = choices.find(label => label.includes(goalId));
			assert.ok(original);
			selection.resolve(original);
		};
		const choices = chooseTarget ? await choicesShown.promise : undefined;
		if (choices) assert.ok(core.goalModalDepth > 0, "the actual picker still owns terminal input");
		if (startupRace) {
			choose(choices!);
			await startupEntered.promise;
			await setImmediate();
			assert.equal(session.isIdle, false);
			assert.equal(core.state.goal?.status, "paused", "busy before Goal-X has received before_agent_start");
			assert.deepEqual(sent, []);
			releaseStartup.resolve();
		} else if (lateRun) {
			const started = session.prompt(latePromptText);
			t.after(() => started);
		}
		if (lateRun) {
			await initialRequest.promise;
			const aborting = session.abort();
			t.after(() => aborting);
		}
		await settlementStarted.promise;
		const resuming = early ?? submit();
		if (choices && !startupRace) choose(choices);
		await setImmediate();
		assert.equal(core.focusedGoalId, goalId);
		assert.deepEqual(sent, [], "do not call sendUserMessage while the old run is settling");
		assert.equal(aborted, true);
		assert.equal(oldSettled, false);
		assert.equal(core.state.goal?.status, "paused");
		assert.equal(requests.length, 1);
		assert.equal(starts.length, 1);
		releaseSettlement.resolve();
		await resuming;
		assert.deepEqual(errors, []);
		await replyReceived.promise;
		await session.waitForIdle();
		assert.deepEqual(errors, []);
		assert.equal(starts.length, 2, "only the interrupted run and the correction started a run");
		assert.deepEqual(starts[1], { kind: "user", prompt: correction, oldSettled: true, status: "active", used: 0, decision: undefined });
		assert.equal(requests.length, 2);
		assert.deepEqual(sent, [{ content: correction, oldSettled: true }]);
		const payload = JSON.stringify(requests[1]);
		assert.ok(payload.includes(`[PI GOAL ACTIVE goalId=${goalId}]`) || payload.includes(`[PI GOAL STATE goalId=${goalId}]`));
		assert.ok(!payload.includes(`[PI GOAL PAUSED goalId=${goalId}]`));
		assert.equal(payload.split(correction).length - 1, 1, "one correction reaches the provider");
	});
}
