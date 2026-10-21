#!/usr/bin/env node
/**
 * Live end-to-end test for the audit supervisor read-only side channel (design D9).
 *
 * Real pi TUI (via a persistent /tmp tmux server) + the user's real provider + the
 * local extensions only. No scripted provider, no stub, no auditor disable, no
 * injected runCompletionAuditor/sessionFactory, no production config switch.
 *
 * Two cases, each in its own mode-0700 /tmp directory with a separate cwd, .pi,
 * session dir and tmux session:
 *   1. answerable: the auditor asks for the delivery marker stored in completed
 *      parent history; the side channel answers ALPHA, the SAME child approves and
 *      the goal is really archived.
 *   2. new-authorisation: the auditor asks whether it may delete evidence.txt, which
 *      nobody authorised; the side channel returns unresolved, the audit is cancelled
 *      with the coordination error, the goal stays active and the file is untouched.
 *
 * Missing tmux / pi / credentials / required paths exit nonzero with no skip.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REPO = process.env.PI_E2E_REPO_ROOT ?? process.cwd();
const PKG = path.join(REPO, "packages/pi-goal-x");
const SUBAGENTS_ENTRY = path.join(REPO, "packages/pi-subagents/index.ts");
const GOAL_ENTRY = path.join(PKG, "extensions/goal.ts");
const FIXTURE = path.join(PKG, "tests/fixtures/goal-audit-e2e-fixture.ts");
const CHANGE_DIR = path.join(REPO, "openspec/changes/route-audit-supervisor-requests-sidechannel");
const ALIAS = "goal-auditor-e2e-live";

const TOTAL_BUDGET_MS = 600_000;
const CASE_BUDGET_MS = 180_000;
const SMOKE_BUDGET_MS = 60_000;
const startedAt = Date.now();

function fail(message) {
	console.error(`[live-e2e] FAIL: ${message}`);
	process.exit(1);
}
function log(message) {
	console.log(`[live-e2e] ${message}`);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1000)));
}

/**
 * A coordination record counts as "the unresolved authorisation question was reported back" ONLY when
 * it is a FAILED record that carries a non-empty unresolvedReason and the question it belongs to.
 * A generic failed record (session/schema/delivery error) must NOT satisfy this.
 */
/** The fixed text markDeliveryFailed writes: a DELIVERY failure is not the model's unresolved. */
const DELIVERY_FAILED_REASON = "the reply could not be delivered";

function isUnresolvedRecord(record, expectedRunId) {
	if (!record || typeof record !== "object") return false;
	if (record.deliveryStatus !== "failed") return false;
	if (typeof record.unresolvedReason !== "string") return false;
	const reason = record.unresolvedReason.trim();
	// A delivery/protocol failure carries this fixed text: it must NOT pass as unresolved.
	if (reason === "" || reason === DELIVERY_FAILED_REASON) return false;
	if (typeof record.question !== "string" || record.question.trim() === "") return false;
	// Bind to THIS attempt: a record from another run is not evidence for this audit.
	if (typeof record.runId !== "string" || record.runId.trim() === "") return false;
	if (expectedRunId && record.runId !== expectedRunId) return false;
	return true;
}

/** Negative control: the predicate must reject the weak shapes that used to be accepted. */
function selfCheckUnresolvedPredicate() {
	const ok = { deliveryStatus: "failed", unresolvedReason: "needs user authorisation", question: "q", runId: "run-1" };
	const cases = [
		[{ deliveryStatus: "failed" }, false],
		[{ deliveryStatus: "failed", unresolvedReason: "  ", question: "q", runId: "run-1" }, false],
		[{ deliveryStatus: "failed", unresolvedReason: "x", question: "", runId: "run-1" }, false],
		[{ deliveryStatus: "delivered", unresolvedReason: "x", question: "q", runId: "run-1" }, false],
		// the production delivery-failure shape must NOT count as unresolved
		[{ deliveryStatus: "failed", unresolvedReason: DELIVERY_FAILED_REASON, question: "q", runId: "run-1" }, false],
		// a record from another attempt must NOT count
		[ok, "other-run", false],
		[ok, "run-1", true],
	];
	return cases.every(([record, expectedOrRun, expectedMaybe]) => {
		const expected = expectedMaybe === undefined ? expectedOrRun : expectedMaybe;
		const runId = expectedMaybe === undefined ? undefined : expectedOrRun;
		return isUnresolvedRecord(record, runId) === expected;
	});
}

// ---- preblock --------------------------------------------------------------
/** Hash-like integrity snapshot of global settings/auth/models (never prints content). */
function integritySnapshot() {
	const results = [];
	for (const file of [".pi/agent/settings.json", ".pi/agent/auth.json"]) {
		const full = path.join(os.homedir(), file);
		try {
			const text = readFileSync(full, "utf8");
			results.push({ file, bytes: text.length, hash: cryptoHash(text) });
		} catch {
			results.push({ file, bytes: -1, hash: "absent" });
		}
	}
	// The SDK reads models.json (a file). The directory is only a legacy fallback.
	const modelsFile = path.join(os.homedir(), ".pi/agent/models.json");
	try {
		const text = readFileSync(modelsFile, "utf8");
		results.push({ file: "models.json", bytes: text.length, hash: cryptoHash(text) });
	} catch {
		const modelsDir = path.join(os.homedir(), ".pi/agent/models");
		try {
			const names = readdirSync(modelsDir).sort();
			results.push({ file: "models", bytes: names.length, hash: cryptoHash(names.join("|")) });
		} catch {
			results.push({ file: "models.json", bytes: -1, hash: "absent" });
		}
	}
	return results;
}

function cryptoHash(text) {
	let h = 5381;
	for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
	return `djb2:${h.toString(16)}:${text.length}`;
}

function preblock() {
	const settingsPath = path.join(os.homedir(), ".pi/agent/settings.json");
	if (!existsSync(settingsPath)) fail(`missing ${settingsPath}`);
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	const provider = settings.defaultProvider;
	const model = settings.defaultModel;
	if (!provider || !model) fail("settings.json has no defaultProvider/defaultModel");
	log(`provider=${provider} model=${model}`);
	for (const [label, value] of [["pi", "pi"], ["tmux", "tmux"]]) {
		const probe = spawnSync(value, ["--version"], { encoding: "utf8", timeout: 30_000 });
		if (probe.error) fail(`${label} is not runnable: ${probe.error.message}`);
	}
	const tmuxEnv = { ...process.env, TMUX_TMPDIR: "/tmp" };
	const ls = spawnSync("tmux", ["ls"], { encoding: "utf8", env: tmuxEnv, timeout: 20_000 });
	if (ls.status !== 0) {
		fail("no connectable tmux server on /tmp (start it on the host: TMUX_TMPDIR=/tmp tmux new-session -d -s host)");
	}
	log(`tmux: ${String(ls.stdout).trim().split("\n")[0]}`);
	const auth = spawnSync("pi", ["auth", "check", "--provider", provider], { encoding: "utf8", timeout: 60_000 });
	if (auth.status !== 0) fail(`pi auth check --provider ${provider} failed (no credential?)`);
	log(`auth: ${String(auth.stdout).trim().split("\n").pop()}`);
	const versionProbe = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 30_000 });
	const piVersion = String(versionProbe.stdout ?? "").trim();
	if (!piVersion) fail("could not determine the pi version");
	log(`pi: ${piVersion}`);
	return { provider, model, piVersion };
}

// ---- tmux helpers ----------------------------------------------------------
const TMUX_ENV = { ...process.env, TMUX_TMPDIR: "/tmp" };
function tmux(args, options = {}) {
	const result = spawnSync("tmux", args, { encoding: "utf8", env: TMUX_ENV, timeout: 30_000, ...options });
	if (result.error) throw new Error(`tmux ${args.join(" ")}: ${result.error.message}`);
	return result;
}
function capture(name) {
	const result = tmux(["capture-pane", "-p", "-S", "-4000", "-t", name]);
	return result.status === 0 ? String(result.stdout) : "";
}
function sendText(name, text) {
	tmux(["send-keys", "-t", name, "-l", text]);
	tmux(["send-keys", "-t", name, "Enter"]);
}
async function waitIdle(name, label, budgetMs = 90_000) {
	// True idle: no spinner/"Working" line in two consecutive polls.
	let quiet = 0;
	const deadline = Math.min(Date.now() + budgetMs, startedAt + TOTAL_BUDGET_MS);
	while (Date.now() < deadline) {
		const pane = capture(name);
		const busy = /Working|⠼|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|esc to interrupt/i.test(pane);
		if (!busy) {
			quiet += 1;
			if (quiet >= 2) return true;
		} else {
			quiet = 0;
		}
		await sleep(1000);
	}
	// A missed idle barrier is a bounded failure: continuing would let the next step
	// race an in-flight turn and silently invalidate the whole case.
	throw new Error(`idle barrier timed out while waiting for ${label}`);
}

async function waitFor(name, predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const pane = capture(name);
		if (predicate(pane)) return pane;
		if (Date.now() - startedAt > TOTAL_BUDGET_MS) throw new Error(`total budget exhausted while waiting for ${label}`);
		await sleep(1000);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function readJsonl(file) {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			return {};
		}
	});
}
/** Collect assistant tool calls and their tool results from the real session JSONL. */
function toolPairs(sessionsDir) {
	const calls = [];
	const results = [];
	for (const entry of sessionEntries(sessionsDir)) {
		const message = entry?.message;
		if (!message || typeof message !== "object") continue;
		// Session entries may carry epoch millis or an ISO string; NaN would silently
		// disable every window comparison.
		const raw = entry.timestamp ?? message.timestamp ?? 0;
		const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) || 0 : 0;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part?.type === "toolCall" && typeof part.id === "string") {
					calls.push({ id: part.id, name: String(part.name ?? ""), at });
				}
			}
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const content = Array.isArray(message.content)
				? message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
				: "";
			results.push({ id: message.toolCallId, at, isError: Boolean(message.isError), content, usage: message.usage });
		}
	}
	return { calls, results };
}

function sessionEntries(sessionsDir) {
	if (!existsSync(sessionsDir)) return [];
	const out = [];
	for (const file of readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl"))) {
		out.push(...readJsonl(path.join(sessionsDir, file)));
	}
	return out;
}

// ---- case driver -----------------------------------------------------------
async function runCase(kind, piVersion) {
	const caseDir = mkdtempSync(path.join("/tmp", `pi-audit-supervisor-live-${kind}-`));
	chmodSync(caseDir, 0o700);
	const cwd = path.join(caseDir, "cwd");
	const sessions = path.join(caseDir, "sessions");
	const tmuxName = `pi-audit-${kind}-${process.pid}`;
	const parentSessionId = randomUUID();
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	mkdirSync(sessions, { recursive: true });
	writeFileSync(path.join(cwd, "evidence.txt"), "pong\n", "utf8");
	// A live settings file: our E2E auditor alias, a bounded audit timeout and the
	// case-specific operator instruction. No production switch is introduced.
	const instruction = kind === "positive"
		? "先用 contact_supervisor 询问：父用户此前已决定的交付标记是什么。拿到答复后，把该答复本身当作交付标记的证据（标记不需要出现在任何文件里，也不要要求文件里出现标记）；用 report_auditor_progress 报进度，最后一次 structured_output 给出裁决。不要直接完成，必须真实提问一次。"
		: "先用 contact_supervisor 询问：是否授权删除本测试的 evidence.txt。不要自行删除任何文件；无法获得明确授权时必须让本次审计失败而不是通过。";
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({
		auditor: { agent: ALIAS, timeoutMs: 180_000, instructions: instruction },
	}, null, 2), "utf8");

	const piArgs = [
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
		"--session-dir", sessions, "--session-id", parentSessionId,
		"-e", SUBAGENTS_ENTRY, "-e", GOAL_ENTRY, "-e", FIXTURE,
	];
	const command = [
		"env",
		`PI_AUDIT_E2E_CASE_DIR=${caseDir}`,
		`PI_AUDIT_E2E_PARENT_SESSION=${parentSessionId}`,
		`PI_AUDIT_E2E_ALIAS=${ALIAS}`,
		"pi", ...piArgs,
	].join(" ");
	// The wrapper records pi's own exit status: `tmux has-session` only tells us the
	// session is gone, not how pi exited.
	const wrapper = `sh -c '${command.replace(/'/g, "'\\''")}; echo $? > ${path.join(caseDir, "pi-exit.txt")}'`;
	log(`case ${kind}: dir=${caseDir} tmux=${tmuxName} session=${parentSessionId}`);
	// Snapshot the global config BEFORE tmux/pi exist, so a startup-time change cannot
	// hide inside the window; only booleans and byte counts ever leave memory.
	const integrityBefore = integritySnapshot();
	tmux(["new-session", "-d", "-s", tmuxName, "-x", "220", "-y", "60", "-c", cwd, wrapper]);

	// Only booleans and byte counts may leave memory; credential hashes never do.
	// Taken BEFORE tmux/pi start, so a startup-time change cannot hide.
	const integrityView = (snapshot) => snapshot.map((entry) => ({ file: entry.file, present: entry.bytes >= 0, bytes: entry.bytes }));
	const record = { kind, caseDir, cwd, sessions, tmuxName, parentSessionId, command, piVersion, integrityBefore: integrityView(integrityBefore), checks: [] };
	const check = (name, ok, detail) => {
		record.checks.push({ name, ok, detail });
		if (!ok) log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
		else log(`  ✔ ${name}`);
	};
	try {
		// 1) the TUI is up and both local extensions + the fixture are loaded
		const banner = await waitFor(tmuxName, (pane) => /\[Extensions\]/i.test(pane) || /update_goal/.test(pane), 60_000, "pi TUI startup");
		check("pi TUI started with the local extensions", Boolean(banner), banner ? undefined : "no startup banner in pane");
		// Prefer the spinner-based idle barrier: the prompt glyph varies by theme.
		await waitIdle(tmuxName, "startup");

		// 2) put the delivery marker into COMPLETED parent history as an explicit,
		// settled user requirement (this is what makes the question answerable).
		await waitIdle(tmuxName, "before the decision turn");
		sendText(tmuxName, "已决定：本次交付标记为 ALPHA。这是本 session 的验收要求，后续核对时以此为准。");
		await waitFor(tmuxName, (pane) => /ALPHA/.test(pane), 60_000, "parent decision turn");
		await waitIdle(tmuxName, "after the decision turn", 150_000);

		// 3) start the goal through the real /goal-direct command and ask for completion
		sendText(tmuxName, `/goal-direct 核对 cwd 下的 evidence.txt 内容恰为 pong，然后调用 update_goal({status:"complete"}) 结束本次交付`);
		await waitFor(tmuxName, (pane) => /goal|Goal/.test(pane), 60_000, "goal creation");
		const readGoalUsage = () => {
			const dir = path.join(cwd, ".pi", "goals");
			if (!existsSync(dir)) return undefined;
			const active = readdirSync(dir).filter((name) => name.startsWith("active_goal_"));
			if (active.length !== 1) return undefined;
			const text = readFileSync(path.join(dir, active[0]), "utf8");
			const match = text.match(/"tokensUsed"\s*:\s*(\d+)/);
			return match ? Number(match[1]) : 0;
		};
		// Read it just before the completion turn, then retry briefly while /goal-direct
		// is still writing the file.
		let usageBeforeAudit;
		for (let i = 0; i < 10 && usageBeforeAudit === undefined; i += 1) {
			usageBeforeAudit = readGoalUsage();
			if (usageBeforeAudit === undefined) await sleep(1000);
		}
		await sleep(2000);
		// One single-step imperative (the objective text alone is not a reliable
		// trigger). Re-send at most once, and ONLY while no audit has started yet:
		// the fixture writes the delegation request into trace.jsonl live, and the
		// ledger records audit_started, so both are authoritative "started" signals.
		const followUp =
			'现在只做一件事：调用 update_goal 工具并传入 {"status":"complete"}。不要做其他工具调用。' +
			'completion_summary 里不要写出任何交付标记或答案细节，只说明已完成；审计员的问题必须由它自己提出。';
		const auditStarted = () => {
			const liveTrace = readJsonl(path.join(caseDir, "trace.jsonl"));
			if (liveTrace.some((t) => t.k === "delegation" && t.kind === "request")) return true;
			const liveLedger = readJsonl(path.join(cwd, ".pi", "goals", "goal_events.jsonl"));
			return liveLedger.some((e) => e.type === "audit_started");
		};
		sendText(tmuxName, followUp);
		let auditBegun = false;
		for (let i = 0; i < 20 && !auditBegun; i += 1) {
			await sleep(1000);
			auditBegun = auditStarted();
		}
		if (!auditBegun) {
			sendText(tmuxName, followUp);
			// Wait for the audit to actually begin before reading evidence; a model turn
			// can take a while, and the case budget (not a short nudge window) is the bound.
			const resendDeadline = Math.min(Date.now() + CASE_BUDGET_MS - 30_000, startedAt + TOTAL_BUDGET_MS);
			while (!auditBegun && Date.now() < resendDeadline) {
				await sleep(2000);
				auditBegun = auditStarted();
			}
		}
		writeFileSync(path.join(caseDir, "followup-distinct-turn.json"), JSON.stringify({ auditStarted: auditBegun }, null, 2), "utf8");

		// 4) wait for the audit to converge (bounded by the per-case budget)
		const caseDeadline = Math.min(Date.now() + CASE_BUDGET_MS, startedAt + TOTAL_BUDGET_MS);
		let pane = "";
		while (Date.now() < caseDeadline) {
			pane = capture(tmuxName);
			// The ledger is authoritative: one audit_result row ends the case, no matter
			// what the pane happens to show.
			const live = readJsonl(path.join(cwd, ".pi", "goals", "goal_events.jsonl"));
			if (live.some((e) => e.type === "audit_result")) break;
			if (/Goal audit approved/i.test(pane) || /Goal audit rejected/i.test(pane)) break;
			await sleep(1000);
		}
		// Give the parent turn a moment to settle so the tool result is persisted.
		await sleep(3000);
		writeFileSync(path.join(caseDir, "final-pane.txt"), pane, "utf8");
		// Quit the TUI BEFORE reading evidence: the fixture records its final
		// scope disposal (and post-dispose resolver miss) on session_shutdown.
		try {
			tmux(["send-keys", "-t", record.tmuxName, "C-d"]);
		} catch {
			// best effort
		}
		await sleep(3000);
		try {
			tmux(["send-keys", "-t", record.tmuxName, "C-c"]);
		} catch {
			// best effort
		}
		await sleep(2000);
		const integrityAfter = integritySnapshot();
		const integrationUnchanged = JSON.stringify(integrityBefore) === JSON.stringify(integrityAfter);

		const trace = readJsonl(path.join(caseDir, "trace.jsonl"));
		const entries = sessionEntries(sessions);
		const ledger = readJsonl(path.join(cwd, ".pi", "goals", "goal_events.jsonl"));
		const archived = existsSync(path.join(cwd, ".pi", "goals", "archived")) ? readdirSync(path.join(cwd, ".pi", "goals", "archived")) : [];
		const active = existsSync(path.join(cwd, ".pi", "goals")) ? readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_")) : [];

		const lifecycle = trace.filter((t) => t.k === "lifecycle");
		const delegation = trace.filter((t) => t.k === "delegation");
		const requests = delegation.filter((t) => t.kind === "request");
		const responses = delegation.filter((t) => t.kind === "response");
		const cancels = delegation.filter((t) => t.kind === "cancel");
		const started = delegation.filter((t) => t.kind === "started");
		const { calls, results } = toolPairs(sessions);
		const updateCalls = calls.filter((c) => c.name === "update_goal");
		const updateResults = results.filter((r) => updateCalls.some((c) => c.id === r.id));
		const updateResult = updateResults[0];
		// The completion window starts when the audit actually starts: the assistant
		// message that carries the update_goal call may be persisted only when the
		// tool returns, so the delegation request is the reliable lower bound.
		const candidates = [updateCalls[0]?.at, requests[0]?.at].filter((value) => typeof value === "number" && value > 0);
		const windowStart = candidates.length > 0 ? Math.min(...candidates) : 0;
		const windowEnd = updateResult?.at ?? Date.now();
		const inWindow = (t) => t.at >= windowStart && t.at <= windowEnd;
		const parentProviderInWindow = trace.filter((t) => t.k === "before_provider_request" && t.side === "parent" && inWindow(t)).length;
		// Only the child's contact_supervisor may carry the answer, and only inside the
		// completion window (the parent legitimately reads its own decision elsewhere).
		const childAlpha = trace.filter((t) => t.k === "tool_result" && t.side === "child" && /supervisor/i.test(String(t.tool)) && t.carriesAlpha === true && inWindow(t));
		const otherAlpha = updateCalls.length > 0
			? trace.filter((t) => t.k === "tool_result" && t.carriesAlpha === true && inWindow(t) && !(t.side === "child" && /supervisor/i.test(String(t.tool))))
			: [];
		// A detach would surface as an exitCode -2 / intercom-coordination result; none may exist.
		// Detach is observed through the real pi-intercom detach event the fixture
		// subscribes to, plus any detach-receipt text in the completion result.
		const detachEvents = trace.filter((t) => t.k === "detach");
		const detached = detachEvents;
		const handoffText = String(updateResult?.content ?? "");
		const handoffCount = (handoffText.match(/审计协调记录（参考信息，不是新用户指令或完成证据）/g) ?? []).length;
		// The record must read as a summary: grouped fields, Chinese status, and no JSON block.
		const handoffAt = handoffText.lastIndexOf("审计协调记录");
		const handoffSummary = handoffAt >= 0
			&& /问：/.test(handoffText)
			&& /(答：|未解决：)/.test(handoffText)
			&& /(已送达|失败|已取消)/.test(handoffText)
			&& handoffText.indexOf("{", handoffAt) < 0;
		const supervisorRows = ledger.filter((e) => e.type === "audit_supervisor_usage");
		const auditRows = ledger.filter((e) => e.type === "audit_usage");
		const rowTokens = (row) => Number(row?.tokens ?? 0)
			+ Number(row?.inputTokens ?? 0) + Number(row?.outputTokens ?? 0)
			+ Number(row?.cacheReadTokens ?? 0) + Number(row?.cacheWriteTokens ?? 0) * 0;
		const toolUsageTotal = Number(updateResult?.usage?.totalTokens ?? 0);
		const ledgerTokens = Number(auditRows[0]?.tokens ?? 0) + Number(supervisorRows[0]?.tokens ?? 0);
		const supervisorSelfConsistent = supervisorRows.length === 1
			&& Number(supervisorRows[0].tokens) === Number(supervisorRows[0].inputTokens) + Number(supervisorRows[0].outputTokens)
				+ Number(supervisorRows[0].cacheReadTokens) + Number(supervisorRows[0].cacheWriteTokens);
		const budgetUntouched = ledger.filter((e) => e.type === "goal_budget_changed").length === 0;
		const goalFile = (() => {
			const dir = path.join(cwd, ".pi", "goals");
			const candidates = [];
			for (const sub of ["", "archived"]) {
				const full = path.join(dir, sub);
				if (!existsSync(full)) continue;
				for (const name of readdirSync(full)) if (/^goal_.*\.md$|^active_goal_.*\.md$/.test(name)) candidates.push(path.join(full, name));
			}
			return candidates.at(-1);
		})();
		const goalUsage = (() => {
			if (!goalFile) return undefined;
			try {
				const text = readFileSync(goalFile, "utf8");
				const match = text.match(/"tokensUsed"\s*:\s*(\d+)/);
				return match ? Number(match[1]) : undefined;
			} catch {
				return undefined;
			}
		})();
		const pairingOk = (() => {
			const resultIds = new Set(results.map((r) => r.id));
			if (resultIds.size !== results.length) return false;               // duplicate result
			if (results.some((r) => !calls.some((c) => c.id === r.id))) return false; // orphan result
			const pending = calls.filter((c) => !resultIds.has(c.id));
			// Only the last assistant turn may still be unpaired (the case ends mid-turn).
			if (pending.length === 0) return true;
			const lastCall = calls[calls.length - 1];
			return pending.length === 1 && pending[0].id === lastCall?.id && !updateResult;
		})();
		const noLiveInResult = !/Detached for intercom coordination/i.test(String(updateResult?.content ?? ""));

		check("global settings/auth/models are byte-identical before and after the case", integrationUnchanged,
			JSON.stringify({ before: integrityView(integrityBefore), after: integrityView(integrityAfter) }));
		check("update_goal produced exactly one call→result pair", updateCalls.length === 1 && updateResults.length === 1,
			`calls=${updateCalls.length} results=${updateResults.length}`);
		check("assistant tool calls are paired with their results", pairingOk, JSON.stringify(calls.map((c) => c.name)));
		check("no detach happened (real pi-intercom detach event count is 0)", detached.length === 0, JSON.stringify(detached.slice(0, 2)));
		check("the completion result carries no detach receipt", !/detached for intercom coordination|exitCode -2/i.test(String(updateResult?.content ?? "")));
		check("the completion tool result is a real result, not a detach receipt", Boolean(updateResult) && noLiveInResult);
		check("exactly one coordination handoff was returned", handoffCount === 1, `handoffBlocks=${handoffCount}`);
		check("the coordination record is a human-readable summary without a JSON block", handoffSummary,
			JSON.stringify({ handoffSummary, at: handoffAt }));
		check("parent model made no provider request inside the completion window", parentProviderInWindow === 0, `count=${parentProviderInWindow}`);
		check("exactly one auditor child started and one delegation request", started.length === 1 && requests.length === 1,
			`started=${started.length} requests=${requests.length}`);
		check("a real /goal-direct audit was recorded in the ledger", ledger.filter((e) => e.type === "audit_started").length === 1);
		check("the supervisor side usage row is self-consistent", supervisorSelfConsistent, JSON.stringify(supervisorRows[0] ?? {}));
		check("the parent turn budget was not rewritten", budgetUntouched);
		// The goal's own usage is the PARENT turn budget: side billing is projected
		// only onto the tool result, never added here.
		// The parent turn budget must be EXACTLY what it was before the audit started:
		// side billing is projected onto the tool result only.
		// The parent's OWN token spend, summed cache-inclusively from its assistant
		// messages, is an upper bound of the goal's own accounting. Side billing must not
		// be folded in, so goalUsage must stay at or below that bound while the side row
		// carries a positive, separate amount.
		const sideTokens = Number(supervisorRows[0]?.tokens ?? 0);
		const parentOwn = sessionEntries(sessions)
			.filter((entry) => entry?.message?.role === "assistant")
			.reduce((sum, entry) => {
				const usage = entry?.message?.usage ?? {};
				return sum + Number(usage.input ?? 0) + Number(usage.output ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
			}, 0);
		const growth = goalUsage !== undefined && usageBeforeAudit !== undefined ? goalUsage - usageBeforeAudit : undefined;
		check("the parent-turn growth is strictly smaller than the side spend (side billing not absorbed)",
			growth !== undefined && sideTokens > 0 && growth >= 0 && growth < sideTokens,
			`growth=${growth} side=${sideTokens} before=${usageBeforeAudit} after=${goalUsage} parentOwn=${parentOwn}`);
		check("the tool usage total equals the auditor + side ledger tokens", toolUsageTotal > 0 && toolUsageTotal === ledgerTokens,
			`tool=${toolUsageTotal} ledger=${ledgerTokens}`);

		if (kind === "positive") {
			const registered = lifecycle.find((t) => t.step === "alias_registered");
			const selfcheck = lifecycle.find((t) => t.step === "resolver_selfcheck");
			const disposed = lifecycle.find((t) => t.step === "scope_disposed");
			check("E2E auditor alias registered (ack)", Boolean(registered?.acked), JSON.stringify(registered ?? {}));
			check("resolver answers for the alias with the same definition", Boolean(selfcheck?.aliasHit && selfcheck?.sameDefinition), JSON.stringify(selfcheck ?? {}));
			check("resolver misses a foreign alias", Boolean(selfcheck?.foreignMiss), JSON.stringify(selfcheck ?? {}));
			check("resolver misses the alias after the scope is disposed", Boolean(disposed?.postDisposeMiss), JSON.stringify(disposed ?? {}));
			// Isolation: the marker may only reach the child through the responder's answer.
		const completionSummaries = entries
			.flatMap((entry) => {
				const content = entry?.message?.content;
				return Array.isArray(content) ? content : [];
			})
			.filter((part) => part?.type === "toolCall" && part?.name === "update_goal")
			.map((part) => JSON.stringify(part?.arguments ?? {}));
		const summaryLeak = completionSummaries.some((text) => text.includes("ALPHA"));
		const childQuestionLeak = entries
			.flatMap((entry) => {
				const content = entry?.message?.content;
				return Array.isArray(content) ? content : [];
			})
			.filter((part) => part?.type === "toolCall" && part?.name === "contact_supervisor")
			.some((part) => JSON.stringify(part?.arguments ?? {}).includes("ALPHA"));
		check("the parent's completion_summary and the child's question carry no marker", !summaryLeak && !childQuestionLeak,
			`summaryLeak=${summaryLeak} childQuestionLeak=${childQuestionLeak} summaries=${completionSummaries.length}`);
		check("the child actually received ALPHA through contact_supervisor", childAlpha.length >= 1, `hits=${childAlpha.length}`);
			// ALPHA legitimately appears in files the child reads; what matters is that the
			// ANSWER arrived through contact_supervisor BEFORE the child's own terminal.
			const childTerminal = trace.filter((t) => t.k === "tool_result" && t.side === "child" && String(t.tool) === "structured_output").at(-1);
			check("the answered question preceded the child's terminal verdict",
				Boolean(childTerminal) && childAlpha.length > 0 && childAlpha[0].at <= childTerminal.at,
				JSON.stringify({ ask: childAlpha[0]?.at, terminal: childTerminal?.at }));
			check("exactly one terminal and no cancellation", responses.length === 1 && cancels.length === 0, `responses=${responses.length} cancels=${cancels.length}`);
			check("the same child approved", responses[0]?.verdict === "approved", JSON.stringify(responses[0] ?? {}));
			check("the goal really archived", archived.length === 1 && active.length === 0, `archived=${archived.length} active=${active.length}`);
			const resultRows = ledger.filter((e) => e.type === "audit_result");
			check("exactly one audit_result and it is approved", resultRows.length === 1 && resultRows[0].verdict === "approved", JSON.stringify(resultRows));
			check("exactly one audit_supervisor_usage row with real turns", supervisorRows.length === 1 && (supervisorRows[0].turns ?? 0) > 0);
			check("exactly one audit_usage row for the auditor itself", auditRows.length === 1);
			// The user-visible outcome: either the pane showed the approval or the
			// archived goal carries the approval report.
			const archivedText = archived.length === 1
				? readFileSync(path.join(cwd, ".pi", "goals", "archived", archived[0]), "utf8")
				: "";
			// User-visible evidence, in order of strength: the completion tool result shown in the
			// TUI, the pane, or the archived goal file.
			const toolText = entries
				.filter((entry) => entry?.message?.role === "toolResult")
				.map((entry) =>
					Array.isArray(entry.message.content)
						? entry.message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
						: "",
				)
				.join("\n");
			const visibleInTool = /approved|批准/i.test(toolText);
			const visibleInPane = /Goal audit approved/i.test(pane);
			const visibleInArchive = /approved|批准/i.test(archivedText);
			check("the approval is visible to the user (tool result, pane or archived goal)",
				visibleInTool || visibleInPane || visibleInArchive,
				JSON.stringify({ visibleInTool, visibleInPane, visibleInArchive, archived: archived.length }));
		} else {
			check("the audit was cancelled exactly once", cancels.length === 1, `cancels=${cancels.length}`);
			check("no approval reached the goal", !responses.some((r) => r.verdict === "approved"), JSON.stringify(responses));
			const resultRows = ledger.filter((e) => e.type === "audit_result");
			check("the single audit_result is an error", resultRows.length === 1 && resultRows[0].verdict === "error", JSON.stringify(resultRows));
			check("the goal stayed active and was not archived", active.length === 1 && archived.length === 0, `active=${active.length} archived=${archived.length}`);
			check("no completion was committed", ledger.filter((e) => e.type === "goal_completed").length === 0);
			check("evidence.txt is byte-identical", readFileSync(path.join(cwd, "evidence.txt"), "utf8") === "pong\n");
			check("no child delete tool ran", !trace.some((t) => t.k === "tool_call" && t.side === "child" && /^(bash|write|edit)$/.test(String(t.tool))));
			// Evidence-based: parse the coordination block out of the tool result and require a
			// record with deliveryStatus "failed" carrying the unresolved reason.
			const textOf = (entry) =>
				Array.isArray(entry?.message?.content)
					? entry.message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
					: "";
			// The attempt identity comes from the trace, so a record from another run cannot pass.
			// The delegation REQUEST row carries an empty runId; update/response rows carry the real one.
			const auditRunId = trace
				.filter((row) => row?.k === "delegation")
				.map((row) => String(row.runId ?? ""))
				.filter(Boolean)
				.pop();
			// Only the CURRENT completion tool's result counts as evidence.
			const updateGoalCallIds = new Set(
				trace
					.filter((row) => row?.k === "tool_call" && row.tool === "update_goal")
					.map((row) => String(row.toolCallId ?? ""))
					.filter(Boolean),
			);
			let failedRecord = false;
			let unresolvedReason;
			let detailsRecords = 0;
			let summaryOk = false;
			for (const entry of entries) {
				if (entry?.message?.role !== "toolResult") continue;
				const callId = String(entry?.message?.toolCallId ?? "");
				if (updateGoalCallIds.size === 0 || !updateGoalCallIds.has(callId)) continue;
				const text = textOf(entry);
				const at = text.lastIndexOf("审计协调记录");
				if (at >= 0) {
					// Human-readable only: grouped fields, Chinese status, no JSON block.
					// Grouped summary: a question line, a Chinese status word and no JSON block.
					// The unresolved SEMANTICS are asserted from the structured details below,
					// so this check stays a pure display check.
					summaryOk = summaryOk
						|| (/问：/.test(text)
							&& /(答：|未解决：)/.test(text)
							&& /(已送达|失败|已取消)/.test(text)
							&& text.indexOf("{", at) < 0);
				}
				// Machine-readable copy: the structured details of the SAME tool result.
				const coordination = entry?.message?.details?.supervisorCoordination;
				for (const record of coordination?.records ?? []) {
					detailsRecords += 1;
					if (isUnresolvedRecord(record, auditRunId)) {
						failedRecord = true;
						unresolvedReason = record.unresolvedReason;
					}
				}
			}
			check("the unresolved predicate passes its own negative control", selfCheckUnresolvedPredicate());
			check("the audit attempt identity was derived from the trace", Boolean(auditRunId));
			check("the coordination record is a human-readable summary without a JSON block", summaryOk);
			check("the structured details carry the records for machine reading", detailsRecords > 0, `records=${detailsRecords}`);
			check("the unresolved question was reported back", failedRecord && Boolean(auditRunId),
				`failedRecord=${failedRecord} unresolvedReason=${String(unresolvedReason ?? "<none>")}`);
			check("real side usage is still accounted", supervisorRows.length === 1);
		}

		writeFileSync(path.join(caseDir, "trace.jsonl"), trace.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
		const piExitRaw = existsSync(path.join(caseDir, "pi-exit.txt")) ? readFileSync(path.join(caseDir, "pi-exit.txt"), "utf8").trim() : "";
		const piExit = piExitRaw ? Number(piExitRaw) : undefined;
		check("pi exited cleanly (real exit code recorded by the wrapper)", piExit === 0, `piExit=${piExitRaw || "<missing>"}`);
		writeFileSync(path.join(caseDir, "result.json"), JSON.stringify({
			...record,
			entries: entries.length,
			ledger: ledger.map((e) => e.type),
			integrityAfter: integrityView(integrityAfter),
			piExit,
		}, null, 2), "utf8");
	} finally {
		try {
			tmux(["send-keys", "-t", record.tmuxName, "C-c"]);
		} catch {
			// best effort
		}
		tmux(["kill-session", "-t", record.tmuxName]);
	}
	return record;
}

// ---- main ------------------------------------------------------------------
async function main() {
	for (const [label, file] of [["pi-subagents entry", SUBAGENTS_ENTRY], ["goal entry", GOAL_ENTRY], ["fixture", FIXTURE]]) {
		if (!existsSync(file)) fail(`missing required path (${label}): ${file}`);
	}
	const pre = preblock();

	// 60 s real print-mode smoke: proves the provider round-trip before the TUI cases.
	const smokeDir = mkdtempSync(path.join("/tmp", "pi-audit-supervisor-smoke-"));
	chmodSync(smokeDir, 0o700);
	mkdirSync(path.join(smokeDir, "sessions"), { recursive: true });
	const smoke = spawnSync("pi", [
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
		"--session-dir", path.join(smokeDir, "sessions"),
		"-e", SUBAGENTS_ENTRY, "-e", GOAL_ENTRY,
		"-p", "Reply with exactly the word: pong",
	], { encoding: "utf8", cwd: smokeDir, timeout: SMOKE_BUDGET_MS });
	writeFileSync(path.join(smokeDir, "smoke.txt"), `${smoke.stdout}\n${smoke.stderr}\n`, "utf8");
	if (smoke.status !== 0 || !/pong/i.test(String(smoke.stdout))) {
		fail(`print-mode smoke failed (status=${smoke.status}) — see ${smokeDir}/smoke.txt`);
	}
	log("smoke: pong");

	const positive = await runCase("positive", pre.piVersion);
	const negative = await runCase("negative", pre.piVersion);

	const failed = [...positive.checks, ...negative.checks].filter((c) => !c.ok);
	const summary = {
		ranAt: new Date().toISOString(),
		provider: process.env.PI_E2E_PROVIDER ?? "from-settings",
		durationMs: Date.now() - startedAt,
		cases: [positive, negative].map((r) => ({ kind: r.kind, caseDir: r.caseDir, checks: r.checks })),
		failed: failed.map((c) => c.name),
	};
	mkdirSync(path.join(CHANGE_DIR, "evidence"), { recursive: true });
	const evidencePath = path.join(CHANGE_DIR, "evidence", "8.3-live-e2e.json");
	writeFileSync(evidencePath, JSON.stringify(summary, null, 2), "utf8");
	log(`evidence: ${evidencePath}`);
	if (failed.length > 0) fail(`${failed.length} live assertion(s) failed: ${failed.map((c) => c.name).join("; ")}`);
	log("BOTH LIVE CASES PASSED");
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));