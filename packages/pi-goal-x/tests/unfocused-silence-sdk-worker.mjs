/**
 * Fork-only real-SDK regression for openspec change `silence-unfocused-goal-prompts`.
 *
 * Boots the extension inside real Pi agent sessions with a local fixture
 * provider, so every assertion inspects the actual outbound request bodies
 * (the assembled request) instead of a stubbed hook return value.
 *
 * Phases:
 *  1. fresh unfocused session: repeated turns and a tool loop stay silent;
 *  2. a session restored from history whose compaction summary already carries
 *     the old reminder: the summary is replayed verbatim, exactly once, and no
 *     new reminder is generated;
 *  3. a real reload (`SessionManager.open`) of that same session file: still
 *     silent, the summary still appears exactly once;
 *  4. focus -> `/goal-unfocus`: a focused goal still delivers `PI GOAL ACTIVE`,
 *     and unfocusing never adds a reminder or a steering message.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';
import goalExtension from '../extensions/goal.ts';
import { createGoal, goalFocusDetails } from '../extensions/goal-record.ts';
import { writeActiveGoalFile } from '../extensions/storage/goal-files.ts';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-unfocused-sdk-'));
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, 'absent-global');
fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
fs.writeFileSync(path.join(cwd, '.pi/pi-goal-x-settings.json'), JSON.stringify({ autoSelectSingleGoal: false, disabled: true }));
fs.writeFileSync(path.join(cwd, 'note.txt'), 'fixture note\n');

const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: 'Keep this pool goal unfocused', autoContinue: true, sisyphus: false }));
const goalBefore = fs.readFileSync(path.join(cwd, goal.activePath), 'utf8');

const OLD_REMINDER = [
	'[PI GOAL UNFOCUSED]',
	'1 open pi goal exists, but this session has no focused goal.',
	'Do not choose or switch focus autonomously. Focus is human-owned intent.',
	'Ask the user to run /goal-focus, /goal-list, or /goal-resume before doing goal work.',
].join('\n');
const COMPACTION_SUMMARY = `Earlier work on the goal.\n\n${OLD_REMINDER}\n\nThe user then asked to keep the session ordinary.`;
/** How Pi replays a compaction summary to the model. */
const COMPACTED_TEXT = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${COMPACTION_SUMMARY}\n</summary>`;

const textOf = (message) => typeof message.content === 'string'
	? message.content
	: (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '');
const findCompacted = (body) => body.messages.find((message) => textOf(message).includes('compacted into the following summary'));

const calls = [];
let session;
let core;

const server = http.createServer(async (req, res) => {
	let body = '';
	for await (const chunk of req) body += chunk;
	calls.push(JSON.parse(body));
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (delta, finishReason = null) => {
		res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finishReason }], ...(finishReason ? { usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } } : {}) })}\n\n`);
	};
	if (calls.length === 1) {
		emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) } }] });
		emit({}, 'tool_calls');
	} else {
		emit({ role: 'assistant', content: 'Ordinary answer.' });
		emit({}, 'stop');
	}
	res.end('data: [DONE]\n\n');
});

const runtimeState = { runtime: undefined };

async function bootSession(manager, { label }) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [pi => { goalExtension(pi, {}); core = pi._goalCore; }],
	});
	await loader.reload();
	const created = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: runtimeState.runtime,
		model: runtimeState.runtime.getModel('fixture', 'fixture'),
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	});
	session = created.session;
	await session.bindExtensions({});
	return { session, label };
}

const until = async (predicate) => {
	const end = Date.now() + 5000;
	while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(predicate(), 'SDK did not settle');
};

const occurrences = (text, needle) => text.split(needle).length - 1;
const bodies = () => calls.map((call) => JSON.stringify(call));

try {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	runtimeState.runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtimeState.runtime.registerProvider('fixture', {
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		api: 'openai-completions',
		apiKey: 'fixture',
		models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 512 }],
	});

	// ── Phase 1: fresh unfocused session ───────────────────────────────────
	const freshManager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
	await bootSession(freshManager, { label: 'fresh' });
	assert.equal(core.focusedGoalId, null, 'the fresh fixture session must start unfocused');

	await session.prompt('Read the note and answer briefly.');
	await until(() => session.isIdle);
	await session.prompt('Now answer without tools.');
	await until(() => session.isIdle);

	// Turn 1 is a tool loop (call, then the answer with its tool result) and turn
	// 2 is a plain answer: three requests in total, none of them goal-triggered.
	assert.equal(calls.length, 3, 'only the deterministic tool loop and the second turn may reach the provider');
	for (const [index, body] of bodies().entries()) {
		assert.ok(!body.includes('PI GOAL UNFOCUSED'), `fresh request ${index + 1} must not carry the retired reminder`);
		assert.ok(!body.includes('pi-goal-steering-event'), `fresh request ${index + 1} must not carry a steering message`);
		assert.ok(!body.includes('open pi goal'), `fresh request ${index + 1} must not announce the open goal`);
		assert.ok(!body.includes('pi_goal_continuation'), `fresh request ${index + 1} must not carry a continuation checkpoint`);
		assert.ok(!body.includes('PI GOAL ACTIVE'), `fresh request ${index + 1} must not claim a focused goal`);
	}
	const secondMessages = calls[1].messages;
	const toolCall = secondMessages.find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
	assert.ok(toolCall, 'the tool call is replayed in the follow-up request');
	const toolCallId = toolCall.tool_calls[0].id;
	assert.ok(
		secondMessages.some((message) => message.role === 'tool' && message.tool_call_id === toolCallId),
		'the tool result is paired with its call in the same request',
	);
	assert.deepEqual(
		session.messages.filter((message) => message.role === 'custom' && message.customType === 'pi-goal-steering-event'),
		[],
		'no hidden unfocused steering message may be appended to the fresh session',
	);

	// ── Phase 2: restored history whose compaction summary carries the old reminder ──
	const historyManager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
	historyManager.appendMessage({ role: 'user', content: 'earlier request', timestamp: Date.now() - 3000 });
	historyManager.appendMessage({ role: 'custom', customType: 'pi-goal-steering-event', content: OLD_REMINDER, display: false, timestamp: Date.now() - 2000 });
	const keptEntryId = historyManager.appendMessage({
		role: 'assistant',
		content: [{ type: 'text', text: 'noted' }],
		api: 'openai-completions',
		provider: 'fixture',
		model: 'fixture',
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: 'stop',
		timestamp: Date.now() - 1000,
	});
	historyManager.appendCompaction(COMPACTION_SUMMARY, keptEntryId, 1234);

	const phase2Start = calls.length;
	await bootSession(historyManager, { label: 'history' });
	await session.prompt('Continue as an ordinary conversation.');
	await until(() => session.isIdle);
	assert.equal(calls.length - phase2Start, 1, 'the restored history turn makes exactly one provider request');
	const historyBody = bodies()[phase2Start];
	const historyCompacted = findCompacted(calls[phase2Start]);
	assert.ok(historyCompacted, 'the restored request must replay the compaction summary');
	assert.equal(textOf(historyCompacted), COMPACTED_TEXT, 'the compaction summary is replayed byte-identically');
	assert.equal(occurrences(historyBody, 'PI GOAL UNFOCUSED'), 1, 'the old reminder is replayed exactly once, from the summary');
	assert.ok(!historyBody.includes('pi-goal-steering-event'), 'the compacted steering message must not be replayed');
	assert.deepEqual(
		session.messages.filter((message) => message.role === 'custom' && message.customType === 'pi-goal-steering-event'),
		[],
		'no new steering message is appended on top of the restored history',
	);

	// ── Phase 3: real reload of the same session file ──────────────────────
	const sessionFile = historyManager.getSessionFile();
	assert.ok(sessionFile && fs.existsSync(sessionFile), 'the restored session must have a session file');
	const reopened = SessionManager.open(sessionFile, path.join(cwd, 'sessions'));
	const phase3Start = calls.length;
	await bootSession(reopened, { label: 'reload' });
	assert.equal(core.focusedGoalId, null, 'reload must not restore a focus');
	await session.prompt('Reloaded ordinary turn.');
	await until(() => session.isIdle);
	assert.equal(calls.length - phase3Start, 1, 'the reloaded turn makes exactly one provider request');
	const reloadBody = bodies()[phase3Start];
	const reloadCompacted = findCompacted(calls[phase3Start]);
	assert.ok(reloadCompacted, 'reload must still replay the compaction summary');
	assert.equal(textOf(reloadCompacted), COMPACTED_TEXT, 'reload keeps the summary byte-identical');
	assert.equal(occurrences(reloadBody, 'PI GOAL UNFOCUSED'), 1, 'reload replays the summary reminder once and adds none');
	assert.ok(!reloadBody.includes('PI GOAL ACTIVE'), 'reload must not claim a focused goal');

	// Phases 1-3 are all unfocused: nothing may touch the goal or the ledger.
	assert.equal(fs.readFileSync(path.join(cwd, goal.activePath), 'utf8'), goalBefore, 'unfocused phases must leave the open goal byte-identical');
	assert.equal(fs.existsSync(path.join(cwd, '.pi/goals/goal_events.jsonl')), false, 'no shared ledger writes while unfocused');

	// ── Phase 4: focus -> unfocus in a real session ────────────────────────
	const focusManager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
	focusManager.appendCustomEntry('pi-goal-focus', goalFocusDetails(goal.id, 'selected'));
	const phase4Start = calls.length;
	await bootSession(focusManager, { label: 'focus-cycle' });
	assert.equal(core.focusedGoalId, goal.id, 'the focus entry must focus the goal');

	await session.prompt('Focused ordinary turn.');
	await until(() => session.isIdle);
	const focusedBody = bodies()[phase4Start];
	assert.ok(focusedBody.includes(`[PI GOAL ACTIVE goalId=${goal.id}]`), 'a focused goal still delivers its active context');
	assert.ok(!focusedBody.includes('PI GOAL UNFOCUSED'), 'a focused goal never carries the unfocused reminder');
	const focusedGoal = JSON.parse(fs.readFileSync(path.join(cwd, goal.activePath), 'utf8').split('\n\n')[0]);
	assert.equal(focusedGoal.status, 'active', 'focused execution keeps the goal active');
	assert.ok(focusedGoal.usage.tokensUsed > 0, 'focused execution still accounts usage normally');

	const unfocusStart = calls.length;
	await session.prompt('/goal-unfocus');
	await until(() => session.isIdle);
	assert.equal(core.focusedGoalId, null, '/goal-unfocus detaches the session');
	await session.prompt('Unfocused ordinary turn.');
	await until(() => session.isIdle);
	assert.equal(calls.length - unfocusStart, 1, 'the unfocused turn makes exactly one provider request');
	const unfocusedBody = bodies()[unfocusStart];
	assert.ok(!unfocusedBody.includes('PI GOAL UNFOCUSED'), 'unfocus must not add a reminder');
	assert.ok(!unfocusedBody.includes('PI GOAL ACTIVE'), 'unfocus must drop the active context');
	assert.equal(fs.existsSync(path.join(cwd, goal.activePath)), true, 'unfocus must not archive or delete the goal');
	const afterUnfocus = JSON.parse(fs.readFileSync(path.join(cwd, goal.activePath), 'utf8').split('\n\n')[0]);
	assert.equal(afterUnfocus.status, 'active', 'unfocus leaves the goal active');

	console.log(JSON.stringify({
		passed: true,
		providerRequests: calls.length,
		phases: { fresh: 3, history: 1, reload: 1, focusCycle: 2 },
		reminderOccurrences: {
			history: occurrences(historyBody, 'PI GOAL UNFOCUSED'),
			reload: occurrences(reloadBody, 'PI GOAL UNFOCUSED'),
		},
	}));
} finally {
	server.close();
	fs.rmSync(cwd, { recursive: true, force: true });
}
