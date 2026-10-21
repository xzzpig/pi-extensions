/**
 * Live-E2E fixture for the audit supervisor side channel (design D9).
 *
 * Loaded as an ordinary pi extension in BOTH the parent session and the auditor child.
 *
 * Parent role (only when the runtime session id equals PI_AUDIT_E2E_PARENT_SESSION):
 *   1. register ONE unique test auditor alias as a runtime agent (cloned from
 *      DEFAULT_AUDITOR_DEFINITION, read-only tools, this fixture as its only
 *      extension so the child can also observe);
 *   2. register an equivalent preflight resolver that answers for THAT alias only
 *      (this is the existing production escape hatch the disk-based preflight needs,
 *      because runtime-registered aliases are invisible to file discovery);
 *   3. self-check the resolver (alias hit, foreign alias miss) and record both;
 *   4. on a session switch / tree change / shutdown: invalidate the scope first,
 *      then dispose the resolver and the registration idempotently.
 *
 * Child role: observe only — it never registers anything.
 *
 * Everything written is a whitelist: counts, identities, timestamps, the known test
 * question/answer and result codes. No provider payload, header, auth state, raw
 * thinking or tool argument body is ever serialized.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { registerAgentViaEvents, type RuntimeAgentDefinition } from "@xzzpig/pi-subagents/agents";
import { registerAuditorAgentResolver, resolveExternalAuditorAgentDefinition } from "../../extensions/goal-auditor-agent-resolver.ts";
import { DEFAULT_AUDITOR_DEFINITION } from "../../extensions/goal-auditor-registration.ts";

const CASE_DIR = process.env.PI_AUDIT_E2E_CASE_DIR ?? "";
const PARENT_SESSION = process.env.PI_AUDIT_E2E_PARENT_SESSION ?? "";
const ALIAS = process.env.PI_AUDIT_E2E_ALIAS ?? "";
const SELF = "goal-audit-e2e-fixture";

type Record_ = Record<string, unknown>;

let tracePath = "";
function trace(entry: Record_): void {
	if (!CASE_DIR || !tracePath) return;
	try {
		appendFileSync(tracePath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, "utf8");
	} catch {
		// Evidence must never break the run under test.
	}
}

/** Clone the code-owned auditor definition into the read-only E2E shape. */
function e2eDefinition(): RuntimeAgentDefinition {
	const base = DEFAULT_AUDITOR_DEFINITION as unknown as Record<string, unknown>;
	const tools = Array.isArray(base.tools) ? (base.tools as string[]) : [];
	// Keep the package-provided progress tool provider and ADD this fixture as a
	// child-only extension so the auditor child can also be observed. Dropping the
	// progress extension would make the protocol tool unavailable in the child.
	const subagentOnlyExtensions = Array.isArray(base.subagentOnlyExtensions)
		? [...(base.subagentOnlyExtensions as string[]), import.meta.url]
		: [import.meta.url];
	return {
		...base,
		tools: tools.filter((name) => ["read", "grep", "find", "ls", "report_auditor_progress"].includes(name)),
		subagentOnlyExtensions,
		inheritProjectContext: false,
		inheritSkills: false,
	} as unknown as RuntimeAgentDefinition;
}

let activeScope: { invalidate(): void } | null = null;

export default function goalAuditE2EFixture(pi: ExtensionAPI): void {
	// SAFETY: ExtensionAPI.on is a typed overload set; this fixture deliberately
	// observes several event families with one uniform recorder.
	const on = (name: string, handler: (event: Record_, ctx: Record_) => void) =>
		(pi as unknown as { on: (n: string, h: (e: unknown, c: unknown) => void) => void }).on(name, handler as never);
	if (!CASE_DIR) return;
	mkdirSync(CASE_DIR, { recursive: true });
	tracePath = path.join(CASE_DIR, "trace.jsonl");

	// The runtime session id comes from the SDK context handed to every handler,
	// never from a file path or the display alias.
	let currentSessionId = "";
	const captureSession = (ctx: unknown) => {
		try {
			const id = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager?.getSessionId?.();
			if (typeof id === "string" && id) currentSessionId = id;
		} catch {
			// leave the previous value
		}
	};

	const parentScope = () => {
		const sessionId = currentSessionId;
		return {
			sessionId,
			isParent: Boolean(PARENT_SESSION) && sessionId === PARENT_SESSION,
			isChild: Boolean(PARENT_SESSION) && sessionId !== PARENT_SESSION,
		};
	};

	// ---- observer (both roles) -------------------------------------------
	const toolCalls = new Map<string, { name: string; at: number }>();
	on("tool_call", (event, ctx) => {
		captureSession(ctx);
		const role = parentScope();
		const name = String(event?.toolName ?? event?.name ?? "unknown");
		const id = String(event?.toolCallId ?? "");
		if (id) toolCalls.set(id, { name, at: Date.now() });
		trace({
			k: "tool_call",
			side: role.isParent ? "parent" : role.isChild ? "child" : "other",
			sessionId: role.sessionId,
			tool: name,
			toolCallId: id,
			// Argument BODIES are never serialized; only the presence of a command/path.
			hasArgs: Boolean(event?.args ?? event?.arguments),
			_ctx: undefined,
		});
		void ctx;
	});
	on("tool_result", (event, ctx) => {
		captureSession(ctx);
		const role = parentScope();
		const name = String(event?.toolName ?? event?.name ?? "unknown");
		const text = JSON.stringify(event?.content ?? event?.result ?? "");
		const marker = /TUI-ALPHA|pong/.test(text) ? "pong" : /unresolved/i.test(text) ? "unresolved" : undefined;
		trace({
			k: "tool_result",
			side: role.isParent ? "parent" : role.isChild ? "child" : "other",
			sessionId: role.sessionId,
			tool: name,
			toolCallId: String(event?.toolCallId ?? ""),
			isError: Boolean(event?.isError),
			carriesAlpha: text.includes("ALPHA"),
			marker,
		});
	});
	on("before_provider_request", (event, ctx) => {
		captureSession(ctx);
		const role = parentScope();
		trace({
			k: "before_provider_request",
			side: role.isParent ? "parent" : role.isChild ? "child" : "other",
			sessionId: role.sessionId,
			model: String((event as Record_)?.model ?? ""),
		});
	});

	// Real detach signal: pi-subagents emits this on the owner event bus when it is
	// about to detach a foreground child for intercom coordination.
	(pi.events as unknown as { on: (n: string, h: (v: unknown) => void) => void }).on(
		"pi-intercom:detach-request",
		((raw: Record_) => {
			trace({ k: "detach", requestId: String(raw?.requestId ?? ""), runId: String(raw?.runId ?? ""), agent: String(raw?.agent ?? "") });
		}) as never,
	);

	// ---- delegation lifecycle (parent side observability) ----------------
	for (const [event, kind] of [
		["prompt-template:subagent:request", "request"],
		["prompt-template:subagent:started", "started"],
		["prompt-template:subagent:update", "update"],
		["prompt-template:subagent:response", "response"],
		["prompt-template:subagent:cancel", "cancel"],
	] as const) {
		// SAFETY: pi.events.on is typed per event name; one uniform recorder is intended here.
		(pi.events as unknown as { on: (n: string, h: (v: unknown) => void) => void }).on(event, ((raw: Record_) => {
			trace({
				k: "delegation",
				kind,
				requestId: String(raw?.requestId ?? ""),
				ownerRunId: String(raw?.ownerRunId ?? ""),
				nodeId: String(raw?.nodeId ?? ""),
				runId: String(raw?.runId ?? ""),
				agent: String(raw?.agent ?? ""),
				status: typeof raw?.status === "string" ? raw.status : undefined,
				verdict:
					typeof (raw?.result as Record_ | undefined)?.value === "object"
						? String(((raw?.result as Record_)?.value as Record_)?.verdict ?? "")
						: undefined,
				currentTool: typeof raw?.currentTool === "string" ? raw.currentTool : undefined,
			});
		}) as never);
	}

	// ---- parent: alias + resolver registration ---------------------------
	const teardown = () => {
		const scope = activeScope;
		activeScope = null;
		if (!scope) return;
		// Invalidate FIRST (so a late resolution cannot win), then dispose.
		try {
			scope.invalidate();
		} catch {
			// best effort
		}
	};

	const register = () => {
		if (!ALIAS) {
			trace({ k: "lifecycle", step: "registration_skipped", reason: "no_alias" });
			return;
		}
		const definition = e2eDefinition();
		let registration: { dispose?: () => void } | undefined;
		try {
			registration = registerAgentViaEvents({ pi, name: ALIAS, definition });
			trace({
				k: "lifecycle",
				step: "alias_registered",
				alias: ALIAS,
				tools: (definition as unknown as { tools?: string[] }).tools ?? [],
				acked: true,
			});
		} catch (error) {
			trace({
				k: "lifecycle",
				step: "alias_registration_failed",
				alias: ALIAS,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		let disposed = false;
		let resolverActive = true;
		const disposeResolver = registerAuditorAgentResolver((name: string) => {
			if (!resolverActive) {
				trace({ k: "resolver_query", name, hit: false, by: SELF, inactive: true });
				return undefined;
			}
			const hit = name === ALIAS;
			trace({ k: "resolver_query", name, hit, by: SELF });
			return hit ? definition : undefined;
		});
		activeScope = {
			invalidate() {
				if (disposed) return;
				disposed = true;
				resolverActive = false;
				try {
					disposeResolver();
				} catch {
					// best effort
				}
				try {
					registration?.dispose?.();
				} catch {
					// best effort
				}
				// After disposal the production resolver must no longer answer for the alias.
				let postDisposeMiss = false;
				try {
					postDisposeMiss = resolveExternalAuditorAgentDefinition(ALIAS) === undefined;
				} catch {
					postDisposeMiss = true;
				}
				trace({ k: "lifecycle", step: "scope_disposed", alias: ALIAS, idempotent: true, postDisposeMiss });
			},
		};
		// Self-check: the alias resolves, a foreign name does not, and both
		// answers are the SAME definition object (one clone, not two).
		// Self-check through the SAME production query the preflight uses.
		const viaResolver = (() => {
			try {
				return resolveExternalAuditorAgentDefinition(ALIAS);
			} catch {
				return undefined;
			}
		})();
		const foreign = (() => {
			try {
				return resolveExternalAuditorAgentDefinition("__foreign_auditor__");
			} catch {
				return undefined;
			}
		})();
		trace({
			k: "lifecycle",
			step: "resolver_selfcheck",
			aliasHit: Boolean(viaResolver),
			sameDefinition: viaResolver === definition,
			foreignMiss: foreign === undefined,
		});
	};

	on("session_start", (event, ctx) => {
		captureSession(ctx);
		const role = parentScope();
		trace({
			k: "lifecycle",
			step: "session_start",
			side: role.isParent ? "parent" : role.isChild ? "child" : "other",
			sessionId: role.sessionId,
			reason: String((event as Record_)?.reason ?? ""),
		});
		if (role.isParent) {
			teardown();
			register();
		}
	});
	on("session_tree", () => teardown());
	on("session_shutdown", () => teardown());
}